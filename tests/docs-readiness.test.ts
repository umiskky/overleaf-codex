import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanReleaseText } from "../scripts/prepublish-check";
import { buildCli } from "../src/cli";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const userDocFiles = [
  "README.md",
  "docs/usage.md",
  "docs/auth.md",
  "docs/endpoint.md",
  "docs/sync.md",
  "docs/compile.md",
  "docs/cli-behavior.md",
  "docs/troubleshooting.md",
  "docs/release-gates.md",
  "docs/npm-packaging.md",
  "docs/release-notes-v1.md",
] as const;

function readRequired(relativePath: string): string {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${relativePath} is required for v1 docs readiness`);
  }
  return readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
}

function expectContainsAll(contents: string, values: string[]): void {
  for (const value of values) {
    expect(contents).toContain(value);
  }
}

describe("v1 user documentation readiness", () => {
  it("README gives a complete first-run workflow without stale scaffold language", () => {
    const readme = readRequired("README.md");

    expectContainsAll(readme, [
      "npm install -g overleaf-codex",
      "olcx --help",
      "git init",
      "olcx init --project https://www.overleaf.com/project/<overleaf-project-id>",
      "olcx auth",
      "olcx auth --from-env OLCX_OVERLEAF_SESSION",
      "olcx status",
      "olcx doctor",
      "olcx sync --dry-run",
      "olcx sync",
      "olcx compile",
      "olcx watch",
      "SYNC_CONFLICT",
      "build/overleaf/main.pdf",
      ".olcx/auth.local.json",
      "headless",
      "@aloth/olcli@0.5.0",
      "MIT",
      "not an official Overleaf project",
      "not an official `olcli` project",
    ]);

    expect(readme).not.toMatch(/planned CLI tool/i);
    expect(readme).not.toMatch(/scaffold/i);
    expect(readme).not.toMatch(/backend is not implemented/i);
  });

  it("focused docs cover auth, sync, compile, troubleshooting, release, and packaging", () => {
    const expectations: Record<(typeof userDocFiles)[number], string[]> = {
      "README.md": [
        "docs/auth.md",
        "docs/endpoint.md",
        "docs/sync.md",
        "docs/compile.md",
        "olcx endpoint status",
        "olcx endpoint test",
        "olcx endpoint set cn",
        "olcx endpoint test --apply",
        "overleaf.baseUrl",
        "https://cn.overleaf.com",
        "docs/npm-packaging.md",
        "docs/release-notes-v1.md",
      ],
      "docs/usage.md": [
        "Install",
        "Bind",
        "Authorize",
        "Watch",
        "Manual Sync",
        "Manual Compile",
        "olcx endpoint status",
        "olcx endpoint test",
        "olcx endpoint set cn",
        "olcx endpoint test --apply",
        "overleaf.baseUrl",
        "https://cn.overleaf.com",
        "Headless Use",
        "Conflict Handling",
        "More Detail",
      ],
      "docs/cli-behavior.md": [
        "olcx endpoint status",
        "olcx endpoint test",
        "olcx endpoint set cn",
        "olcx endpoint test --apply",
        "overleaf.baseUrl",
        "https://cn.overleaf.com",
      ],
      "docs/auth.md": [
        "olcx auth",
        "olcx auth --from-env OLCX_OVERLEAF_SESSION",
        "olcx auth --cookie '<copied-session-cookie>'",
        ".olcx/auth.local.json",
        "OLCX_NON_INTERACTIVE=1",
        "must not store Overleaf passwords",
        "OLCX_NON_INTERACTIVE=1 olcx auth --from-env OLCX_OVERLEAF_SESSION",
      ],
      "docs/endpoint.md": [
        "Endpoint Management",
        "olcx endpoint status",
        "olcx endpoint test",
        "olcx endpoint set cn",
        "olcx endpoint set www",
        "olcx endpoint test --apply",
        "overleaf.baseUrl",
        "https://www.overleaf.com",
        "https://cn.overleaf.com",
        "does not sync, upload, compile, validate auth",
      ],
      "docs/sync.md": [
        "olcx sync --dry-run",
        "olcx sync",
        "SYNC_CONFLICT",
        ".olcx/state/conflicts.json",
        "must not silently overwrite",
        "cat .olcx/state/conflicts.json",
        "metadata and paths only",
      ],
      "docs/compile.md": [
        "olcx compile",
        "olcx compile --pdf build/overleaf/main.pdf",
        "olcx compile --disable-fast-fallback",
        "olcx compile --fast-fallback-timeout 60000",
        "build/overleaf/main.pdf",
        "does not require local LaTeX",
        "Status:\nfallback-success",
        "Fallback: fast/draft",
      ],
      "docs/troubleshooting.md": [
        "Auth Failure",
        "Project Binding Failure",
        "Sync Conflict",
        "Compile Failure",
        "Watch Loop",
        "Network Problems",
        "olcx endpoint status",
        "olcx endpoint test",
        "olcx endpoint set cn",
        "olcx endpoint test --apply",
        "overleaf.baseUrl",
        "https://cn.overleaf.com",
      ],
      "docs/release-gates.md": [
        "npm run prepublish:check",
        "npm run test:e2e:real",
        "OLCX_E2E_IGNORE_LOCAL_ENV=1",
        "npm audit --audit-level=high",
        "npm pack --dry-run --json --ignore-scripts",
        "docs/release-notes-v1.md",
        ".github/workflows/npm-publish.yml",
        "npm-publish",
        "vX.Y.Z",
        "vX.Y.Z-rc.1",
        "latest",
        "next",
        "Stable npm publish is blocked",
        "gh-release://umiskky/overleaf-codex/vX.Y.Z/sanitized-real-e2e.md",
        "Concrete sanitized real E2E artifact reference",
        "forced skip smoke is allowed but is not a stable substitute",
        "Stable release is not approved until a sanitized disposable real Overleaf E2E pass is recorded",
      ],
      "docs/npm-packaging.md": [
        "npm login",
        "npm whoami",
        "npm view overleaf-codex version",
        "npm pack --dry-run --json --ignore-scripts",
        "npm publish --dry-run",
        "npm publish",
        "2FA",
        "OTP",
        "Trusted Publisher",
        "owner: umiskky",
        "repository: overleaf-codex",
        "workflow filename: npm-publish.yml",
        "environment: npm-publish",
        "package: overleaf-codex",
        "allowed action: npm publish",
        "OIDC",
        "id-token: write",
        "provenance",
        "NPM_TOKEN",
        ".npmrc",
        "gh-release://umiskky/overleaf-codex/vX.Y.Z/sanitized-real-e2e.md",
        "Concrete sanitized real E2E artifact reference",
        "Stable release is not approved until a sanitized disposable real Overleaf E2E pass is recorded",
        "forced skip smoke is not a stable-release substitute",
        "npm deprecate overleaf-codex@<version>",
        "npm unpublish overleaf-codex@<version>",
        "dist/",
        "docs/",
        "docs/endpoint.md",
        "docs/release-notes-v1.md",
        "README.md",
        "LICENSE",
        "NOTICE.md",
        "assets/",
      ],
      "docs/release-notes-v1.md": [
        "v1 Release Notes",
        "Release candidate status",
        "Stable release decision",
        "Stable release decision: Approved for stable release",
        "not an official Overleaf project",
        "not an official `olcli` project",
        "Overleaf private interfaces",
        "npm run build",
        "npm run typecheck",
        "npm test",
        "OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real",
        "npm audit --audit-level=high",
        "npm pack --dry-run --json --ignore-scripts",
        "npm run prepublish:check",
        ".github/workflows/npm-publish.yml",
        "npm-publish",
        "vX.Y.Z",
        "vX.Y.Z-rc.1",
        "latest",
        "next",
        "Stable npm publishing is approved",
        "Sanitized real E2E artifact:",
        "gh-release://umiskky/overleaf-codex/v0.1.1/sanitized-real-e2e.md",
        "forced skip smoke is allowed but is not a stable substitute",
        "build/overleaf/main.pdf",
        "SYNC_CONFLICT",
        "Known limitations",
        "Post-v1 roadmap",
      ],
    };

    for (const [file, values] of Object.entries(expectations)) {
      expectContainsAll(readRequired(file), values);
    }
  });

  it("documented command names stay aligned with Commander command registration", () => {
    const allDocs = userDocFiles.map((file) => readRequired(file)).join("\n");
    const commandNames = buildCli().commands.map((command) => command.name()).sort();

    expect(commandNames).toEqual([
      "auth",
      "compile",
      "doctor",
      "endpoint",
      "init",
      "pull",
      "push",
      "status",
      "sync",
      "watch",
    ]);
    expect(allDocs).not.toContain("--vscode");
    for (const commandName of commandNames) {
      expect(allDocs).toContain(`olcx ${commandName}`);
    }
  });

  it("release notes make the stable-release decision explicit and reference sanitized real E2E", () => {
    const notes = readRequired("docs/release-notes-v1.md");
    const approvedDecision =
      notes.includes("Stable release decision: Approved for stable release") &&
      notes.includes("Sanitized real E2E artifact: gh-release://umiskky/overleaf-codex/v0.1.1/sanitized-real-e2e.md") &&
      notes.includes(
        "No raw cookie, session value, account label, private project id, or private paper content is recorded."
      );

    expect(approvedDecision).toBe(true);
    expect(notes).not.toContain("Stable npm publish is blocked");
    expect(notes).not.toContain("Stable release decision: Not approved for stable release");
    expect(notes).not.toMatch(/not recorded|placeholder|not evidence/i);
    expect(notes).toContain("Sanitized real E2E artifact:");
    expect(notes).toContain(".github/workflows/npm-publish.yml");
    expect(notes).toContain("vX.Y.Z");
    expect(notes).toContain("vX.Y.Z-rc.1");
    expect(notes).toContain("latest");
    expect(notes).toContain("next");
    expect(notes).toContain("forced skip smoke is allowed but is not a stable substitute");
  });

  it("release-facing status docs present stable v1 release state", () => {
    const readme = readRequired("README.md");
    const roadmap = readRequired("ROADMAP.md");

    expect(readme).toContain("status-v1--stable--released");
    expect(readme).not.toContain("status-v1--rc--local--gates");
    expect(roadmap).toContain("v1 Stable");
    expect(roadmap).toContain("Stable v1 is released");
    expect(roadmap).not.toContain("Stable release remains blocked");
    expect(roadmap).not.toContain("Implement `olcx auth`.");
    expect(roadmap).not.toContain("Prepare npm package publishing.");
  });

  it("contributor and community files document checks, skip flow, and safe reporting", () => {
    const contributing = readRequired("CONTRIBUTING.md");
    expectContainsAll(contributing, [
      "npm ci",
      "npm run build",
      "npm run typecheck",
      "npm test",
      "npm audit --audit-level=high",
      "OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real",
      "npm run prepublish:check",
    ]);

    const prTemplate = readRequired(".github/pull_request_template.md");
    expectContainsAll(prTemplate, [
      "npm run build",
      "npm run typecheck",
      "npm test",
      "npm audit --audit-level=high",
      "OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real",
      "npm run prepublish:check",
    ]);

    const bugTemplate = readRequired(".github/ISSUE_TEMPLATE/bug_report.md");
    expectContainsAll(bugTemplate, ["olcx status", "olcx doctor", "cookies", "project IDs"]);
  });

  it("CI runs matrix tests, release gate, and forced E2E skip smoke without local env", () => {
    const workflow = readRequired(".github/workflows/ci.yml");

    expectContainsAll(workflow, [
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
      "node-version",
      "20",
      "22",
      "npm run build",
      "npm run typecheck",
      "npm test",
      "npm run test:e2e:real",
      "OLCX_E2E_IGNORE_LOCAL_ENV",
      "OLCX_E2E_ENABLE_REAL",
      "npm run prepublish:check",
    ]);
  });

  it("release-facing docs remain sanitized", () => {
    const scannedFiles = [
      ...userDocFiles,
      "CONTRIBUTING.md",
      ".github/pull_request_template.md",
      ".github/ISSUE_TEMPLATE/bug_report.md",
    ];

    const findings = scannedFiles.flatMap((file) => scanReleaseText(file, readRequired(file)));

    expect(findings).toEqual([]);
  });
});
