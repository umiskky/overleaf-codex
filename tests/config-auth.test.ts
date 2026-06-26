import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readProjectAuth,
  resolveProjectAuth,
  summarizeProjectAuth,
  validateProjectAuth,
  writeProjectAuth,
} from "../src/auth/projectAuth";
import { redactForStatus } from "../src/auth/redact";
import { ensureGitignoreEntries } from "../src/config/ignoreRules";
import { findProjectRoot } from "../src/config/projectRoot";
import { createDefaultProjectConfig } from "../src/config/types";
import { readProjectConfig, validateProjectConfig, writeProjectConfig } from "../src/config/projectConfig";

const tempRoots: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olcx-config-auth-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project config and auth infrastructure", () => {
  it("writes and reads stable shareable project config", async () => {
    const projectRoot = await makeTempProject();
    const config = createDefaultProjectConfig({ projectId: "<overleaf-project-id>" });

    await writeProjectConfig(projectRoot, config);

    await expect(readProjectConfig(projectRoot)).resolves.toEqual({
      schemaVersion: 1,
      projectId: "<overleaf-project-id>",
      overleaf: { baseUrl: "https://www.overleaf.com" },
      rootDocument: "main.tex",
      pdfPath: "build/overleaf/main.pdf",
      sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
      compile: {
        timeoutMs: 120000,
        fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 },
      },
    });
    await expect(readFile(join(projectRoot, ".olcx", "config.json"), "utf8")).resolves.toMatch(/\n$/);
  });

  it("writes and reads the configured Overleaf base URL", async () => {
    const projectRoot = await makeTempProject();
    const config = createDefaultProjectConfig({
      projectId: "<overleaf-project-id>",
      overleaf: { baseUrl: "https://cn.overleaf.com" },
    });

    await writeProjectConfig(projectRoot, config);

    await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
      overleaf: { baseUrl: "https://cn.overleaf.com" },
    });
  });

  it("defaults legacy configs without overleaf.baseUrl to www", () => {
    expect(
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 } },
      })
    ).toMatchObject({ overleaf: { baseUrl: "https://www.overleaf.com" } });
  });

  it("rejects unsupported Overleaf base URLs and secret-like overleaf keys", () => {
    expect(() =>
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
        overleaf: { baseUrl: "https://evil.example" },
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 } },
      })
    ).toThrow(/overleaf\.baseUrl/i);

    expect(() =>
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
        overleaf: { baseUrl: "https://www.overleaf.com", cookie: "<fake-cookie>" },
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 } },
      })
    ).toThrow(/cookie/i);
  });

  it("validates bounded fast fallback attempts", () => {
    expect(() =>
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: true, attempts: 4, timeoutMs: 30000 } },
      })
    ).toThrow(/compile\.fastFallback\.attempts/i);

    expect(() =>
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: false, attempts: 0, timeoutMs: 30000 } },
      })
    ).not.toThrow();
  });

  it("rejects missing, corrupt, and unsafe config", async () => {
    const projectRoot = await makeTempProject();

    await expect(readProjectConfig(projectRoot)).rejects.toMatchObject({
      code: "PROJECT_CONFIG_NOT_FOUND",
      exitCode: 3,
    });

    await mkdir(join(projectRoot, ".olcx"), { recursive: true });
    await writeFile(join(projectRoot, ".olcx", "config.json"), "{not-json", "utf8");
    await expect(readProjectConfig(projectRoot)).rejects.toMatchObject({
      code: "PROJECT_CONFIG_INVALID",
      exitCode: 3,
    });

    expect(() =>
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "../main.tex",
        pdfPath: "build/overleaf/main.pdf",
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: false, attempts: 0, timeoutMs: 30000 } },
      })
    ).toThrow(/rootDocument/i);

    expect(() =>
      validateProjectConfig({
        schemaVersion: 1,
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
        sessionCookie: "<fake-session-cookie>",
        sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
        compile: { timeoutMs: 120000, fastFallback: { enabled: false, attempts: 0, timeoutMs: 30000 } },
      })
    ).toThrow(/sessionCookie/i);
  });

  it("discovers project root from nested directories", async () => {
    const projectRoot = await makeTempProject();
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    const nested = join(projectRoot, "sections", "draft");
    await mkdir(nested, { recursive: true });

    await expect(findProjectRoot(nested)).resolves.toBe(projectRoot);
  });

  it("prefers an existing olcx config marker over a higher package marker", async () => {
    const outer = await makeTempProject();
    await writeFile(join(outer, "package.json"), "{}", "utf8");
    const paper = join(outer, "paper");
    await mkdir(join(paper, ".olcx"), { recursive: true });
    await writeFile(
      join(paper, ".olcx", "config.json"),
      JSON.stringify(createDefaultProjectConfig({ projectId: "<overleaf-project-id>" })),
      "utf8"
    );
    const nested = join(paper, "chapters");
    await mkdir(nested, { recursive: true });

    await expect(findProjectRoot(nested)).resolves.toBe(paper);
  });

  it("preserves gitignore content and appends required local-only patterns", async () => {
    const projectRoot = await makeTempProject();
    await writeFile(join(projectRoot, ".gitignore"), "# user rules\nprivate-notes.tex\n.olcx/*.local.json\n", "utf8");

    const first = await ensureGitignoreEntries(projectRoot);
    const afterFirst = await readFile(join(projectRoot, ".gitignore"), "utf8");
    const second = await ensureGitignoreEntries(projectRoot);
    const afterSecond = await readFile(join(projectRoot, ".gitignore"), "utf8");

    expect(first.changed).toBe(true);
    expect(first.added).toEqual(expect.arrayContaining([".olcx/auth.local.json", ".olcx/*.secret.json"]));
    expect(afterFirst).toContain("# user rules\nprivate-notes.tex\n.olcx/*.local.json\n");
    expect(afterFirst).toContain(".olcx/auth.local.json");
    expect(afterFirst).toContain(".olcx/*.local.json");
    expect(afterFirst).toContain(".olcx/*.secret.json");
    expect(afterFirst).toContain("build/overleaf/");
    expect(afterFirst).toContain("*.synctex.gz");
    expect(second).toEqual({ changed: false, added: [] });
    expect(afterSecond).toBe(afterFirst);
  });

  it("writes and reads project-local auth independently per repository", async () => {
    const repoA = await makeTempProject();
    const repoB = await makeTempProject();

    await writeProjectAuth(repoA, {
      schemaVersion: 1,
      accountLabel: "Account A",
      sessionCookie: "<fake-session-cookie-a>",
      updatedAt: "2026-06-25T08:00:00.000Z",
      source: "cli-option",
    });
    await writeProjectAuth(repoB, {
      schemaVersion: 1,
      accountLabel: "Account B",
      sessionCookie: "<fake-session-cookie-b>",
      updatedAt: "2026-06-25T09:00:00.000Z",
      source: "interactive",
    });

    await expect(readProjectAuth(repoA)).resolves.toMatchObject({
      accountLabel: "Account A",
      sessionCookie: "<fake-session-cookie-a>",
    });
    await expect(readProjectAuth(repoB)).resolves.toMatchObject({
      accountLabel: "Account B",
      sessionCookie: "<fake-session-cookie-b>",
    });
    await expect(readFile(join(repoA, ".olcx", "auth.local.json"), "utf8")).resolves.toMatch(/\n$/);
  });

  it("rejects missing, corrupt, invalid, and password-bearing auth", async () => {
    const projectRoot = await makeTempProject();

    await expect(readProjectAuth(projectRoot)).rejects.toMatchObject({
      code: "PROJECT_AUTH_NOT_FOUND",
      exitCode: 4,
    });

    await mkdir(join(projectRoot, ".olcx"), { recursive: true });
    await writeFile(join(projectRoot, ".olcx", "auth.local.json"), "{not-json", "utf8");
    await expect(readProjectAuth(projectRoot)).rejects.toMatchObject({
      code: "PROJECT_AUTH_INVALID",
      exitCode: 4,
    });

    expect(() =>
      validateProjectAuth({
        schemaVersion: 1,
        sessionCookie: "<fake-session-cookie>",
        password: "<fake-password>",
        updatedAt: "2026-06-25T08:00:00.000Z",
        source: "env",
      })
    ).toThrow(/password/i);

    expect(() =>
      validateProjectAuth({
        schemaVersion: 1,
        sessionCookie: "<fake-session-cookie>",
        updatedAt: "not-a-date",
        source: "env",
      })
    ).toThrow(/updatedAt/i);

    expect(() =>
      validateProjectAuth({
        schemaVersion: 1,
        sessionCookie: "<fake-session-cookie>",
        updatedAt: "2026-06-25T08:00:00.000Z",
        source: "password",
      })
    ).toThrow(/source/i);
  });

  it("uses env auth override without writing it to disk", async () => {
    const projectRoot = await makeTempProject();

    const auth = await resolveProjectAuth(projectRoot, {
      env: { OLCX_OVERLEAF_SESSION: "<fake-env-session-cookie>" },
      now: () => new Date("2026-06-25T10:00:00.000Z"),
    });

    expect(auth).toEqual({
      schemaVersion: 1,
      sessionCookie: "<fake-env-session-cookie>",
      updatedAt: "2026-06-25T10:00:00.000Z",
      source: "env",
    });
    await expect(readProjectAuth(projectRoot)).rejects.toMatchObject({ code: "PROJECT_AUTH_NOT_FOUND" });
  });

  it("auth summaries never include raw session cookies or account labels", () => {
    const safeSummary = summarizeProjectAuth({
      schemaVersion: 1,
      accountLabel: "work",
      sessionCookie: "<fake-session-cookie-a>",
      updatedAt: "2026-06-25T08:00:00.000Z",
      source: "cli-option",
    });
    const redactedSummary = summarizeProjectAuth({
      schemaVersion: 1,
      accountLabel: "writer@example.test",
      sessionCookie: "<fake-session-cookie-a>",
      updatedAt: "2026-06-25T08:00:00.000Z",
      source: "cli-option",
    });

    expect(safeSummary.accountLabel).toBe("work");
    expect(redactedSummary).toEqual({
      schemaVersion: 1,
      accountLabel: "<redacted-account>",
      source: "cli-option",
      updatedAt: "2026-06-25T08:00:00.000Z",
      hasSessionCookie: true,
    });
    expect(JSON.stringify(safeSummary)).not.toContain("<fake-session-cookie-a>");
    expect(JSON.stringify(redactedSummary)).not.toContain("<fake-session-cookie-a>");
    expect(JSON.stringify(redactedSummary)).not.toContain("writer@example.test");
  });

  it("redacts status and error-shaped objects containing cookies, sessions, accounts, and project ids", () => {
    const raw = {
      auth: {
        sessionCookie: "<fake-session-cookie>",
        accountLabel: "writer@example.test",
      },
      config: {
        projectId: "0123456789abcdef01234567",
        projectUrl: "https://www.overleaf.com/project/0123456789abcdef01234567",
        cnProjectUrl: "https://cn.overleaf.com/project/0123456789abcdef01234567",
      },
      message: "session=<fake-session-cookie> for writer@example.test",
    };

    const redacted = redactForStatus(raw);

    expect(redacted).toContain("<redacted-secret>");
    expect(redacted).toContain("<redacted-account>");
    expect(redacted).toContain("<redacted-project-id>");
    expect(redacted).not.toContain("<fake-session-cookie>");
    expect(redacted).not.toContain("writer@example.test");
    expect(redacted).not.toContain("0123456789abcdef01234567");
    expect(redacted).not.toContain("cn.overleaf.com/project/0123456789abcdef01234567");
  });
});
