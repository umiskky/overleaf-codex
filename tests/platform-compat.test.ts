import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectAuth, resolveProjectAuth } from "../src/auth/projectAuth";
import { authenticateProject } from "../src/commands/auth";
import { ensureGitignoreEntries } from "../src/config/ignoreRules";
import { validateProjectConfig } from "../src/config/projectConfig";
import { createIgnoreMatcher } from "../src/sync/ignore";
import { createWatchIgnoredPredicate } from "../src/watch/watcher";

const tempRoots = new Set<string>();
const now = "2026-06-25T08:00:00.000Z";

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

async function makeTempProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

function fixedNow(): Date {
  return new Date(now);
}

function configWithPaths(paths: { rootDocument?: string; pdfPath?: string } = {}) {
  return {
    schemaVersion: 1,
    projectId: "<overleaf-project-id>",
    rootDocument: paths.rootDocument ?? "main.tex",
    pdfPath: paths.pdfPath ?? "build/overleaf/main.pdf",
    sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
    compile: { timeoutMs: 120000, fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 } },
  };
}

describe("cross-platform path compatibility", () => {
  it("normalizes Windows and POSIX relative config paths while rejecting absolute paths", () => {
    expect(validateProjectConfig(configWithPaths({
      rootDocument: "sections\\intro.tex",
      pdfPath: "build\\overleaf\\main.pdf",
    }))).toMatchObject({
      rootDocument: "sections/intro.tex",
      pdfPath: "build/overleaf/main.pdf",
    });

    expect(validateProjectConfig(configWithPaths({
      rootDocument: "sections/intro.tex",
      pdfPath: "build/overleaf/main.pdf",
    }))).toMatchObject({
      rootDocument: "sections/intro.tex",
      pdfPath: "build/overleaf/main.pdf",
    });

    expect(() => validateProjectConfig(configWithPaths({
      rootDocument: "C:\\Users\\writer\\paper\\main.tex",
    }))).toThrow(/safe relative path/i);

    expect(() => validateProjectConfig(configWithPaths({
      pdfPath: "/tmp/paper/main.pdf",
    }))).toThrow(/safe relative path/i);
  });

  it("matches ignore rules for POSIX and Windows-style relative paths", () => {
    const matcher = createIgnoreMatcher(["drafts/**"]);

    expect(matcher.isIgnored("build/overleaf/main.pdf")).toBe(true);
    expect(matcher.isIgnored("build\\overleaf\\main.pdf")).toBe(true);
    expect(matcher.isIgnored(".olcx/auth.local.json")).toBe(true);
    expect(matcher.isIgnored(".olcx\\auth.local.json")).toBe(true);
    expect(matcher.isIgnored("drafts/private.tex")).toBe(true);
    expect(matcher.isIgnored("drafts\\private.tex")).toBe(true);
    expect(matcher.isIgnored("sections/intro.tex")).toBe(false);
    expect(matcher.isIgnored("sections\\intro.tex")).toBe(false);
    expect(matcher.isIgnored("../outside.tex")).toBe(true);
    expect(matcher.isIgnored("..\\outside.tex")).toBe(true);
  });

  it("treats Windows absolute watch event paths as project-relative before applying ignore rules", () => {
    const projectRoot = win32.join("C:\\", "Users", "writer", "paper");
    const ignored = createWatchIgnoredPredicate({
      projectRoot,
      userIgnorePatterns: ["drafts/**"],
    });

    expect(ignored(win32.join(projectRoot, "build", "overleaf", "main.pdf"))).toBe(true);
    expect(ignored(win32.join(projectRoot, ".olcx", "auth.local.json"))).toBe(true);
    expect(ignored(win32.join(projectRoot, "drafts", "private.tex"))).toBe(true);
    expect(ignored(win32.join(projectRoot, "sections", "intro.tex"))).toBe(false);
    expect(ignored(win32.join("C:\\", "Users", "writer", "outside.tex"))).toBe(true);
  });

  it("keeps POSIX absolute watch event paths project-relative before applying ignore rules", () => {
    const projectRoot = "/tmp/olcx-paper";
    const ignored = createWatchIgnoredPredicate({
      projectRoot,
      userIgnorePatterns: ["drafts/**"],
    });

    expect(ignored("/tmp/olcx-paper/build/overleaf/main.pdf")).toBe(true);
    expect(ignored("/tmp/olcx-paper/.olcx/auth.local.json")).toBe(true);
    expect(ignored("/tmp/olcx-paper/drafts/private.tex")).toBe(true);
    expect(ignored("/tmp/olcx-paper/sections/intro.tex")).toBe(false);
    expect(ignored("/tmp/outside.tex")).toBe(true);
  });
});

describe("headless environment auth compatibility", () => {
  it("reads default env auth without writing project-local auth", async () => {
    const projectRoot = await makeTempProject("olcx-platform-auth-default-");

    const auth = await resolveProjectAuth(projectRoot, {
      env: { OLCX_OVERLEAF_SESSION: "<fake-default-env-session-cookie>" },
      now: fixedNow,
    });

    expect(auth).toEqual({
      schemaVersion: 1,
      sessionCookie: "<fake-default-env-session-cookie>",
      updatedAt: now,
      source: "env",
    });
    await expect(readProjectAuth(projectRoot)).rejects.toMatchObject({ code: "PROJECT_AUTH_NOT_FOUND" });
  });

  it("writes project auth from a named env var with digits and underscores", async () => {
    const projectRoot = await makeTempProject("olcx-platform-auth-named-");
    await mkdir(join(projectRoot, ".git"), { recursive: true });

    const result = await authenticateProject({
      cwd: projectRoot,
      fromEnv: "OLCX_OVERLEAF_SESSION_2",
      env: { OLCX_OVERLEAF_SESSION_2: "<fake-named-env-session-cookie>" },
      stdinIsTTY: false,
      now: fixedNow,
    });

    expect(result.auth).toMatchObject({
      sessionCookie: "<fake-named-env-session-cookie>",
      source: "env",
      updatedAt: now,
    });
    await expect(readProjectAuth(projectRoot)).resolves.toMatchObject({
      sessionCookie: "<fake-named-env-session-cookie>",
      source: "env",
    });
  });
});

describe("cross-platform ignore file compatibility", () => {
  it("preserves CRLF gitignore files while adding required local-only patterns idempotently", async () => {
    const projectRoot = await makeTempProject("olcx-platform-gitignore-");
    await writeFile(
      join(projectRoot, ".gitignore"),
      "# paper rules\r\nprivate-notes.tex\r\n.olcx/*.local.json\r\n",
      "utf8"
    );

    const first = await ensureGitignoreEntries(projectRoot);
    const afterFirst = await readFile(join(projectRoot, ".gitignore"), "utf8");
    const second = await ensureGitignoreEntries(projectRoot);
    const afterSecond = await readFile(join(projectRoot, ".gitignore"), "utf8");

    expect(first.changed).toBe(true);
    expect(first.added).toEqual(expect.arrayContaining([
      ".olcx/auth.local.json",
      ".olcx/*.secret.json",
      ".olcx/state/",
      "build/overleaf/",
    ]));
    expect(afterFirst).toContain("# paper rules\r\nprivate-notes.tex\r\n.olcx/*.local.json\r\n");
    expect(afterFirst).toContain("\r\n.olcx/auth.local.json\r\n");
    expect(afterFirst).toContain("\r\n.olcx/*.secret.json\r\n");
    expect(afterFirst).toContain("\r\nbuild/overleaf/\r\n");
    expect(afterFirst.split("\n").filter((line) => line.trim() === ".olcx/*.local.json")).toHaveLength(1);
    expect(second).toEqual({ changed: false, added: [] });
    expect(afterSecond).toBe(afterFirst);
  });
});
