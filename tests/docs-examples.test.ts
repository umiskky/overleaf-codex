import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateProjectAuth } from "../src/auth/projectAuth";
import { REQUIRED_GITIGNORE_ENTRIES } from "../src/config/ignoreRules";
import { validateProjectConfig } from "../src/config/projectConfig";
import { scanReleaseText } from "../scripts/prepublish-check";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function extractSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe("minimal paper example", () => {
  it("contains a valid placeholder project config and no default local auth", () => {
    const config = validateProjectConfig(
      JSON.parse(readRepo("examples/minimal-paper/.olcx/config.json"))
    );

    expect(config).toEqual({
      schemaVersion: 1,
      projectId: "<overleaf-project-id>",
      projectUrl: "https://www.overleaf.com/project/<overleaf-project-id>",
      overleaf: { baseUrl: "https://www.overleaf.com" },
      rootDocument: "main.tex",
      pdfPath: "build/overleaf/main.pdf",
      sync: {
        mode: "bidirectional",
        conflictPolicy: "pause",
        ignore: [],
        remoteCheck: "local-baseline",
        downloadConcurrency: 5,
        uploadConcurrency: 3,
        retry: { maxAttempts: 5, delayMs: 6000 },
        timeout: {
          baseMs: 30000,
          unknownSizeMs: 600000,
          minBytesPerSecond: 25000,
          bufferRatio: 2.5,
          maxMs: 1800000,
        },
      },
      compile: {
        timeoutMs: 120000,
        fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 },
      },
    });
    expect(existsSync(join(repoRoot, "examples/minimal-paper/.olcx/auth.local.json"))).toBe(false);
  });

  it("contains a valid auth example without creating usable credentials", () => {
    const auth = validateProjectAuth(
      JSON.parse(readRepo("examples/minimal-paper/.olcx/auth.local.example.json"))
    );

    expect(auth).toEqual({
      schemaVersion: 1,
      accountLabel: "example-account",
      sessionCookie: "<replace-with-your-overleaf-session-cookie>",
      updatedAt: "2026-06-25T00:00:00.000Z",
      source: "env",
    });
  });

  it("documents required local ignore rules and generated output ignores", () => {
    const gitignore = readRepo("examples/minimal-paper/.gitignore");

    for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
      expect(gitignore).toContain(entry);
    }
    for (const entry of [
      "*.bbl",
      "*.bcf",
      "*.blg",
      "*.fdb_latexmk",
      "*.fls",
      "*.out",
      "*.run.xml",
      "*.toc",
    ]) {
      expect(gitignore).toContain(entry);
    }
  });

  it("explains config, auth, PDF output, and watch flow from the example", () => {
    const exampleReadme = readRepo("examples/minimal-paper/README.md");

    expect(exampleReadme).toContain(".olcx/config.json");
    expect(exampleReadme).toContain(".olcx/auth.local.json");
    expect(exampleReadme).toContain("auth.local.example.json");
    expect(exampleReadme).toContain("build/overleaf/main.pdf");
    expect(exampleReadme).toContain("olcx watch");
    expect(exampleReadme).toContain("does not contact Overleaf");
    expect(exampleReadme).toContain("<overleaf-project-id>");
  });
});

describe("README docs links", () => {
  it("links the example and troubleshooting docs with safe replacement guidance", () => {
    const readme = readRepo("README.md");

    expect(readme).toContain("examples/minimal-paper/README.md");
    expect(readme).toContain("docs/troubleshooting.md");
    expect(readme).toContain("<overleaf-project-id>");
    expect(readme).toContain(".olcx/auth.local.json");
    expect(readme).toContain("build/overleaf/main.pdf");
    expect(readme).toMatch(/replace/i);
  });
});

describe("troubleshooting documentation", () => {
  const troubleshootingSections = [
    {
      heading: "Auth Failure",
      commands: ["olcx status", "olcx doctor", "olcx auth --from-env OLCX_OVERLEAF_SESSION"],
    },
    {
      heading: "Project Binding Failure",
      commands: ["olcx status", "olcx init --project"],
    },
    {
      heading: "Sync Conflict",
      commands: ["olcx sync --dry-run", "cat .olcx/state/conflicts.json", "olcx sync"],
    },
    {
      heading: "Compile Failure",
      commands: ["olcx compile", "olcx compile --disable-fast-fallback"],
    },
    {
      heading: "PDF Not Updated",
      commands: ["olcx compile", "ls -l build/overleaf/main.pdf", "olcx status"],
    },
    {
      heading: "Watch Loop",
      commands: ["olcx watch --debounce 2500", "olcx sync --dry-run", "olcx compile"],
    },
    {
      heading: "Network Problems",
      commands: ["olcx endpoint status", "olcx endpoint test", "olcx endpoint set cn", "olcx doctor"],
    },
  ];

  for (const { heading, commands } of troubleshootingSections) {
    it(`${heading} includes executable checks or next actions`, () => {
      const section = extractSection(readRepo("docs/troubleshooting.md"), heading);

      expect(section).toMatch(/```(?:bash|powershell|text)\n[\s\S]*?\n```/);
      for (const command of commands) {
        expect(section).toContain(command);
      }
    });
  }
});

describe("sanitized release text", () => {
  it("does not include real Overleaf ids, cookies, account data, or local auth files", () => {
    const releaseFiles = [
      "README.md",
      "docs/endpoint.md",
      "docs/troubleshooting.md",
      "examples/minimal-paper/README.md",
      "examples/minimal-paper/main.tex",
      "examples/minimal-paper/.gitignore",
      "examples/minimal-paper/.olcx/config.json",
      "examples/minimal-paper/.olcx/auth.local.example.json",
    ];

    const findings = releaseFiles.flatMap((file) => scanReleaseText(file, readRepo(file)));

    expect(findings).toEqual([]);
    for (const file of releaseFiles) {
      const contents = readRepo(file);
      expect(contents).not.toContain("overleaf_session2=");
      expect(contents).not.toContain("writer@example");
      expect(contents).not.toMatch(/https:\/\/www\.overleaf\.com\/project\/[a-f0-9]{24}\b/i);
      expect(contents).not.toMatch(/https:\/\/cn\.overleaf\.com\/project\/[a-f0-9]{24}\b/i);
    }
  });
});
