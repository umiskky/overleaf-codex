import { describe, expect, it } from "vitest";
import {
  assertDependencyLicenses,
  assertGitignoreProtectsLocalSecrets,
  assertNpmPublishWorkflowSecurity,
  assertOlcliNoticeConsistency,
  assertPackageContents,
  assertStableReleaseNotesPublishEvidence,
  formatPrepublishFailure,
  normalizePackFiles,
  runPrepublishChecks,
  scanReleaseText,
} from "../scripts/prepublish-check";

const safeGitignore = [
  ".olcx/auth.local.json",
  ".olcx/*.local.json",
  ".olcx/*.secret.json",
  "*.local.json",
  "*.secret.json",
  ".env.*",
  "tmp/",
].join("\n");

const leakCookieValue = ["live", "cookie", "value"].join("-");
const leakProjectId = "abcdef".repeat(4);
const overleafSessionCookieKey = ["overleaf", "session2"].join("_");
const sessionCookieKey = ["session", "Cookie"].join("");
const e2eSessionKey = ["OLCX", "E2E", "OVERLEAF", "SESSION"].join("_");
const e2eProjectIdKey = ["OLCX", "E2E", "PROJECT", "ID"].join("_");

const safeNpmPublishWorkflow = [
  "name: Publish to npm",
  "on:",
  "  release:",
  "    types:",
  "      - published",
  "permissions:",
  "  contents: read",
  "  id-token: write",
  "jobs:",
  "  publish:",
  "    runs-on: ubuntu-latest",
  "    environment: npm-publish",
  "    steps:",
  "      - uses: actions/setup-node@v4",
  "        with:",
  "          node-version: \"22.14.0\"",
  "          registry-url: https://registry.npmjs.org",
  "      - run: npm install -g npm@^11.5.1",
  "      - run: npm run test:e2e:real",
  "        env:",
  "          OLCX_E2E_IGNORE_LOCAL_ENV: \"1\"",
  "          OLCX_E2E_ENABLE_REAL: \"0\"",
  "      - run: |",
  "          if grep -Ei \"not recorded|placeholder|not evidence\" docs/release-notes-v1.md; then",
  "            echo \"Concrete sanitized real E2E artifact reference is required for stable npm publish.\" >&2",
  "            exit 1",
  "          fi",
  "          if grep -F \"Stable npm publish is blocked\" docs/release-notes-v1.md; then",
  "            echo \"Stable npm publish is blocked until sanitized real Overleaf E2E is recorded.\" >&2",
  "            exit 1",
  "          fi",
  "          if grep -F \"Stable release decision: Not approved for stable release\" docs/release-notes-v1.md; then",
  "            echo \"Stable npm publish is blocked until stable release approval is recorded.\" >&2",
  "            exit 1",
  "          fi",
  "          grep -F \"Stable release decision: Approved for stable release\" docs/release-notes-v1.md",
  "          grep -E \"^Sanitized real E2E artifact: gh-release://[^[:space:]]+$\" docs/release-notes-v1.md",
  "      - run: npm run prepublish:check",
  "      - run: npm publish --tag \"$NPM_DIST_TAG\"",
].join("\n");

const approvedStableReleaseNotes = [
  "Stable release decision: Approved for stable release",
  "Sanitized real E2E artifact: gh-release://umiskky/overleaf-codex/v1.0.0/sanitized-real-e2e.md",
  "No raw cookie, session value, account label, private project id, or private paper content is recorded.",
].join("\n");

const examplePackageFiles = [
  "package/examples/minimal-paper/README.md",
  "package/examples/minimal-paper/main.tex",
  "package/examples/minimal-paper/.gitignore",
  "package/examples/minimal-paper/.olcx/config.json",
  "package/examples/minimal-paper/.olcx/auth.local.example.json",
] as const;

const requiredDocPackageFiles = [
  "package/docs/usage.md",
  "package/docs/auth.md",
  "package/docs/endpoint.md",
  "package/docs/sync.md",
  "package/docs/compile.md",
  "package/docs/troubleshooting.md",
  "package/docs/release-gates.md",
  "package/docs/npm-packaging.md",
  "package/docs/release-notes-v1.md",
] as const;

const exampleReleaseFiles: Record<string, string> = {
  "examples/minimal-paper/README.md": [
    "# Minimal Paper Example",
    ".olcx/config.json",
    ".olcx/auth.local.json",
    "build/overleaf/main.pdf",
    "olcx watch",
    "<overleaf-project-id>",
  ].join("\n"),
  "examples/minimal-paper/main.tex": "Generic example paper content.\n",
  "examples/minimal-paper/.gitignore": [".olcx/auth.local.json", "*.local.json", "*.secret.json"].join("\n"),
  "examples/minimal-paper/.olcx/config.json": JSON.stringify({
    schemaVersion: 1,
    projectId: "<overleaf-project-id>",
    projectUrl: "https://www.overleaf.com/project/<overleaf-project-id>",
  }),
  "examples/minimal-paper/.olcx/auth.local.example.json": JSON.stringify({
    schemaVersion: 1,
    accountLabel: "example-account",
    sessionCookie: "<replace-with-your-overleaf-session-cookie>",
    updatedAt: "2026-06-25T00:00:00.000Z",
    source: "env",
  }),
};

const olcliFiles = {
  "package.json": JSON.stringify({
    files: [
      "assets",
      "dist",
      "README.md",
      "LICENSE",
      "NOTICE.md",
      "docs",
      "examples",
      "src/backend/olcli/LICENSE",
      "src/backend/olcli/README.md",
    ],
    dependencies: { commander: "^12.1.0" },
    devDependencies: { tsx: "^4.7.0" },
  }),
  "README.md": [
    "@aloth/olcli@0.5.0",
    "https://github.com/aloth/olcli",
    "v0.5.0",
    "524c30b11328a847a9c0bcf4447d2b3468160f8c",
    "src/backend/olcli/client.ts",
    "MIT",
    "not an official Overleaf project",
    "not an official `olcli` project",
  ].join("\n"),
  "NOTICE.md": [
    "@aloth/olcli@0.5.0",
    "https://github.com/aloth/olcli",
    "v0.5.0",
    "524c30b11328a847a9c0bcf4447d2b3468160f8c",
    "https://registry.npmjs.org/@aloth/olcli/-/olcli-0.5.0.tgz",
    "src/backend/olcli/client.ts",
    "Copyright (c) 2026 Alexander Loth",
    "License: MIT",
    "not affiliated with, endorsed by, or maintained by Overleaf or `olcli`",
    "not an official Overleaf project",
    "not an official `olcli` project",
  ].join("\n"),
  LICENSE: "MIT License\nCopyright (c) 2026 overleaf-codex contributors\n",
  "src/backend/olcli/README.md": [
    "@aloth/olcli@0.5.0",
    "https://github.com/aloth/olcli",
    "v0.5.0",
    "524c30b11328a847a9c0bcf4447d2b3468160f8c",
    "https://registry.npmjs.org/@aloth/olcli/-/olcli-0.5.0.tgz",
    "sha512-kFstYGK6htjDiOlX0H/nmjzugwRYN2RlBufK+bAA648h21GqQOVxeHr5po2ybwxetoccT9ky3YV2ch7c3b6GmQ==",
    "src/backend/olcli/client.ts",
    "Only backend adapter modules may import",
    "MIT",
    "not an official `olcli` project",
  ].join("\n"),
  "src/backend/olcli/LICENSE": "MIT License\nCopyright (c) 2026 Alexander Loth\n",
  "src/backend/olcli/client.ts": [
    "Adapted from @aloth/olcli v0.5.0 src/client.ts",
    "524c30b11328a847a9c0bcf4447d2b3468160f8c",
    "Copyright (c) 2026 Alexander Loth",
    "Licensed under the MIT License",
  ].join("\n"),
};

function normalizeInjectedPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function injectedRelativePath(filePath: string): string {
  return normalizeInjectedPath(filePath).replace(/^\/repo\//, "");
}

function normalizeRecordedCommand(command: string): string {
  return command.replace(/^npm\.cmd\b/, "npm");
}

describe("prepublish package contents gate", () => {
  it("accepts the intended package surface", () => {
    expect(() =>
      assertPackageContents([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/NOTICE.md",
        "package/assets/olcx-mark.svg",
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        "package/docs/security.md",
        ...requiredDocPackageFiles,
        ...examplePackageFiles,
        "package/src/backend/olcli/LICENSE",
        "package/src/backend/olcli/README.md",
      ])
    ).not.toThrow();
  });

  it.each([
    ["package/examples/minimal-paper/.olcx/auth.local.json", "local auth"],
    ["package/examples/minimal-paper/.olcx/state/sync.json", "local auth"],
    ["package/examples/minimal-paper/build/overleaf/main.pdf", "generated build output"],
  ])("rejects unsafe example package path %s", (path, reason) => {
    expect(() =>
      assertPackageContents([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/NOTICE.md",
        "package/assets/olcx-mark.svg",
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        "package/docs/security.md",
        ...requiredDocPackageFiles,
        "package/examples/minimal-paper/README.md",
        "package/examples/minimal-paper/main.tex",
        "package/examples/minimal-paper/.olcx/config.json",
        "package/src/backend/olcli/LICENSE",
        "package/src/backend/olcli/README.md",
        path,
      ])
    ).toThrow(new RegExp(`npm package contains disallowed path.*${reason}`, "i"));
  });

  it("requires focused user docs in the npm package", () => {
    expect(() =>
      assertPackageContents([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/NOTICE.md",
        "package/assets/olcx-mark.svg",
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        "package/docs/usage.md",
        "package/docs/auth.md",
        "package/docs/endpoint.md",
        "package/docs/sync.md",
        "package/docs/compile.md",
        "package/docs/troubleshooting.md",
        "package/docs/release-gates.md",
        ...examplePackageFiles,
        "package/src/backend/olcli/LICENSE",
        "package/src/backend/olcli/README.md",
      ])
    ).toThrow(/npm package is missing required file: docs\/npm-packaging\.md/);
  });

  it("requires endpoint docs in the npm package", () => {
    expect(() =>
      assertPackageContents([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/NOTICE.md",
        "package/assets/olcx-mark.svg",
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        "package/docs/usage.md",
        "package/docs/auth.md",
        "package/docs/sync.md",
        "package/docs/compile.md",
        "package/docs/troubleshooting.md",
        "package/docs/release-gates.md",
        "package/docs/npm-packaging.md",
        "package/docs/release-notes-v1.md",
        ...examplePackageFiles,
        "package/src/backend/olcli/LICENSE",
        "package/src/backend/olcli/README.md",
      ])
    ).toThrow(/npm package is missing required file: docs\/endpoint\.md/);
  });

  it("requires v1 release notes in the npm package", () => {
    expect(() =>
      assertPackageContents([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/NOTICE.md",
        "package/assets/olcx-mark.svg",
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        "package/docs/usage.md",
        "package/docs/auth.md",
        "package/docs/endpoint.md",
        "package/docs/sync.md",
        "package/docs/compile.md",
        "package/docs/troubleshooting.md",
        "package/docs/release-gates.md",
        "package/docs/npm-packaging.md",
        ...examplePackageFiles,
        "package/src/backend/olcli/LICENSE",
        "package/src/backend/olcli/README.md",
      ])
    ).toThrow(/npm package is missing required file: docs\/release-notes-v1\.md/);
  });

  it.each([
    ["package/node_modules/adm-zip/index.js", "node_modules"],
    ["package/tmp/task/00-task.md", "tmp handoff"],
    ["package/.olcx/auth.local.json", "local auth"],
    ["package/tests/e2e/real-output.log", "test or E2E output"],
    ["package/build/overleaf/main.pdf", "generated build output"],
    ["package/debug.log", "log file"],
    ["package/.env.production", "environment file"],
  ])("rejects disallowed package path %s", (path, reason) => {
    expect(() => assertPackageContents(["package/package.json", path])).toThrow(
      new RegExp(`npm package contains disallowed path.*${reason}`, "i")
    );
  });

  it.each([
    ["package/.npmrc", "npm auth config"],
    ["package/scripts/prepublish-check.ts", "scripts"],
    ["package/tests/npm-publish-workflow.test.ts", "test or E2E output"],
    ["package/tmp/20260626-164425-522084-plan/10-plan.md", "tmp handoff"],
    ["package/.olcx/auth.local.json", "local auth"],
    ["package/e2e-output.log", "test or E2E output"],
  ])("rejects publishing-unsafe package path %s", (path, reason) => {
    expect(() => assertPackageContents(["package/package.json", path])).toThrow(
      new RegExp(`npm package contains disallowed path.*${reason}`, "i")
    );
  });

  it.each([
    ["package/docs/node_modules/pkg/index.js", "node_modules"],
    ["package/docs/tmp/task.md", "tmp handoff"],
    ["package/docs/.olcx/auth.local.json", "local auth"],
    ["package/docs/.env.local", "environment file"],
    ["package/assets/debug.log", "log file"],
    ["package/dist/build/overleaf/main.pdf", "generated build output"],
    ["package/docs/nested/secret.secret.json", "secret JSON"],
    ["package/docs/nested/auth.local.json", "local JSON"],
  ])("rejects nested disallowed package path %s", (path, reason) => {
    expect(() =>
      assertPackageContents([
        "package/package.json",
        "package/README.md",
        "package/LICENSE",
        "package/NOTICE.md",
        "package/assets/olcx-mark.svg",
        "package/dist/cli.js",
        "package/dist/cli.d.ts",
        ...requiredDocPackageFiles,
        "package/src/backend/olcli/LICENSE",
        "package/src/backend/olcli/README.md",
        path,
      ])
    ).toThrow(new RegExp(`npm package contains disallowed path.*${reason}`, "i"));
  });

  it("normalizes npm pack json paths with and without package prefix", () => {
    expect(
      normalizePackFiles([
        { path: "package/README.md" },
        { path: "dist/cli.js" },
      ])
    ).toEqual(["README.md", "dist/cli.js"]);
  });
});

describe("npm trusted publishing workflow gate", () => {
  it("accepts a token-free release-only OIDC workflow", () => {
    expect(() => assertNpmPublishWorkflowSecurity(safeNpmPublishWorkflow)).not.toThrow();
  });

  it("requires OIDC id-token write permission", () => {
    expect(() =>
      assertNpmPublishWorkflowSecurity(
        safeNpmPublishWorkflow.replace("id-token: write", "id-token: none")
      )
    ).toThrow(/id-token: write/);
  });

  it.each([
    ["pull_request:"],
    ["push:\n    branches:\n      - main"],
    ["NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}"],
    ["NPM_TOKEN: ${{ secrets.NPM_TOKEN }}"],
    ["run: npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN"],
    ["run: echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > .npmrc"],
    ["run: npm token create --read-only=false"],
    ["run: echo 'npm automation token'"],
  ])("rejects unsafe workflow content %s", (unsafeLine) => {
    expect(() => assertNpmPublishWorkflowSecurity(`${safeNpmPublishWorkflow}\n${unsafeLine}\n`)).toThrow(
      /publish workflow|token|trigger|npmrc|automation/i
    );
  });

  it.each([
    [
      "concrete artifact reference check",
      'grep -E "^Sanitized real E2E artifact: gh-release://[^[:space:]]+$" docs/release-notes-v1.md',
      'grep -F "Sanitized real E2E artifact:" docs/release-notes-v1.md',
    ],
    ["placeholder rejection", "not recorded|placeholder|not evidence", "not recorded"],
    ["blocked status rejection", "Stable npm publish is blocked", "Stable npm publish pending"],
  ])("requires stronger stable release gate: %s", (_label, requiredText, weakText) => {
    expect(() =>
      assertNpmPublishWorkflowSecurity(safeNpmPublishWorkflow.replace(requiredText, weakText))
    ).toThrow(/stable|artifact|placeholder|blocked|gh-release/i);
  });
});

describe("stable release notes publish evidence gate", () => {
  it("accepts approved stable notes with a concrete gh-release artifact reference", () => {
    expect(() => assertStableReleaseNotesPublishEvidence(approvedStableReleaseNotes)).not.toThrow();
  });

  it("rejects approved notes that keep placeholder artifact and blocked publish text", () => {
    const notes = [
      "Stable release decision: Approved for stable release",
      "Stable npm publish is blocked.",
      "Sanitized real E2E artifact: not recorded for this release candidate.",
      "This line is a placeholder and is not evidence of a completed real E2E run.",
    ].join("\n");

    expect(() => assertStableReleaseNotesPublishEvidence(notes)).toThrow(
      /concrete sanitized real E2E artifact|blocked|placeholder|not recorded|not evidence/i
    );
  });

  it.each([
    ["not recorded"],
    ["placeholder"],
    ["not evidence"],
    ["Stable npm publish is blocked"],
    ["Stable release decision: Not approved for stable release"],
  ])("rejects approved notes containing blocked-state text %s", (blockedText) => {
    expect(() =>
      assertStableReleaseNotesPublishEvidence(`${approvedStableReleaseNotes}\n${blockedText}\n`)
    ).toThrow(/blocked|placeholder|not recorded|not evidence|not approved/i);
  });
});

describe("prepublish dependency license gate", () => {
  it("accepts current compatible license families", () => {
    const lockfile = {
      packages: {
        "": { name: "overleaf-codex", license: "MIT" },
        "node_modules/adm-zip": { version: "0.5.16", license: "MIT" },
        "node_modules/detect-libc": { version: "2.1.2", license: "Apache-2.0" },
        "node_modules/entities": { version: "4.5.0", license: "BSD-2-Clause" },
        "node_modules/picocolors": { version: "1.1.1", license: "ISC" },
        "node_modules/tslib": { version: "2.8.1", license: "0BSD" },
        "node_modules/lightningcss": { version: "1.32.0", license: "MPL-2.0" },
      },
    };

    expect(assertDependencyLicenses(lockfile)).toEqual({
      checked: 6,
      licenses: ["0BSD", "Apache-2.0", "BSD-2-Clause", "ISC", "MIT", "MPL-2.0"],
    });
  });

  it("fails with package, version, and license when a dependency is incompatible", () => {
    const lockfile = {
      packages: {
        "node_modules/bad-lib": { version: "1.0.0", license: "GPL-3.0-only" },
      },
    };

    expect(() => assertDependencyLicenses(lockfile)).toThrow(
      /bad-lib@1\.0\.0 uses disallowed license GPL-3\.0-only/
    );
  });

  it("fails when lockfile license metadata is missing", () => {
    const lockfile = {
      packages: {
        "node_modules/unknown-lib": { version: "2.0.0" },
      },
    };

    expect(() => assertDependencyLicenses(lockfile)).toThrow(
      /unknown-lib@2\.0\.0 has no license metadata/
    );
  });
});

describe("prepublish sensitive value gate", () => {
  it("allows placeholders and known fake project ids used in tests", () => {
    expect(scanReleaseText("tests/example.test.ts", "<fake-env-session-cookie>")).toEqual([]);
    expect(scanReleaseText("tests/example.test.ts", "0123456789abcdef01234567")).toEqual([]);
    expect(scanReleaseText("docs/example.md", "projectId: <overleaf-project-id>")).toEqual([]);
  });

  it.each([
    ["docs/leak.md", `${overleafSessionCookieKey}=${leakCookieValue}`],
    ["docs/leak.md", `${sessionCookieKey}: "${leakCookieValue}"`],
    ["docs/leak.md", `"${sessionCookieKey}": "${leakCookieValue}"`],
    ["docs/leak.md", `${e2eSessionKey}=${leakCookieValue}`],
    ["docs/leak.md", `${e2eProjectIdKey}=${leakProjectId}`],
    ["docs/leak.md", `https://www.overleaf.com/project/${leakProjectId}`],
  ])("flags likely sensitive release text in %s", (path, text) => {
    expect(scanReleaseText(path, text)).toEqual([
      expect.objectContaining({ path, reason: expect.stringMatching(/sensitive|project id|cookie/i) }),
    ]);
  });

  it("does not allow arbitrary sensitive values only because they contain the word secret", () => {
    const secretNamedCookieValue = ["live", "secret", "value"].join("-");

    expect(scanReleaseText("docs/leak.md", `${overleafSessionCookieKey}=${secretNamedCookieValue}`)).toEqual([
      expect.objectContaining({
        path: "docs/leak.md",
        reason: expect.stringMatching(/sensitive|cookie/i),
      }),
    ]);
  });

  it("allows empty env example assignments without reading across lines", () => {
    expect(scanReleaseText(".env.e2e.example", `${e2eSessionKey}=\n${e2eProjectIdKey}=\n`)).toEqual([]);
  });

  it("requires root ignore rules for local auth, local json, secret json, local env, and tmp handoff files", () => {
    expect(() => assertGitignoreProtectsLocalSecrets(safeGitignore)).not.toThrow();

    expect(() => assertGitignoreProtectsLocalSecrets("node_modules/\n")).toThrow(
      /missing required gitignore entry/i
    );
  });
});

describe("prepublish third-party source consistency gate", () => {
  it("accepts consistent olcli attribution across README, NOTICE, license, and source", () => {
    expect(() => assertOlcliNoticeConsistency(olcliFiles)).not.toThrow();
  });

  it("fails with the file and missing value when attribution drifts", () => {
    expect(() =>
      assertOlcliNoticeConsistency({
        ...olcliFiles,
        "NOTICE.md": olcliFiles["NOTICE.md"].replace("524c30b11328a847a9c0bcf4447d2b3468160f8c", ""),
      })
    ).toThrow(/NOTICE\.md.*524c30b11328a847a9c0bcf4447d2b3468160f8c/);
  });
});

describe("prepublish command orchestration", () => {
  it("formats step failures without leaking command internals as the primary message", () => {
    expect(formatPrepublishFailure("npm audit high", "exit code 1")).toBe(
      "Prepublish gate failed at npm audit high: exit code 1"
    );
  });

  it("stops at the first failing external command with a clear step name", async () => {
    const result = await runPrepublishChecks({
      repoRoot: "/repo",
      runCommand: async (_command, args) => {
        if (args.includes("audit")) {
          return { exitCode: 1, stdout: "found high vulnerability", stderr: "" };
        }
        if (args.includes("pack")) {
          return { exitCode: 0, stdout: JSON.stringify([{ files: [{ path: "package/package.json" }] }]), stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readTextFile: async (path) => {
        const normalizedPath = normalizeInjectedPath(path);
        if (normalizedPath.endsWith("package-lock.json")) return JSON.stringify({ packages: {} });
        if (normalizedPath.endsWith("package.json")) return olcliFiles["package.json"];
        if (normalizedPath.endsWith(".gitignore")) return safeGitignore;
        if (normalizedPath.endsWith(".github/workflows/npm-publish.yml")) return safeNpmPublishWorkflow;
        const relativePath = injectedRelativePath(path);
        return olcliFiles[relativePath as keyof typeof olcliFiles] ?? "";
      },
      listScanFiles: async () => [],
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStep).toBe("npm audit high");
    expect(result.message).toMatch(/Prepublish gate failed at npm audit high/);
  });

  it("fails static metadata when npm publish workflow uses a long-lived token", async () => {
    const commands: string[] = [];
    const result = await runPrepublishChecks({
      repoRoot: "/repo",
      runCommand: async (command, args) => {
        commands.push([command, ...args].join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readTextFile: async (path) => {
        const normalizedPath = normalizeInjectedPath(path);
        if (normalizedPath.endsWith(".gitignore")) return safeGitignore;
        if (normalizedPath.endsWith("package-lock.json")) return JSON.stringify({ packages: {} });
        if (normalizedPath.endsWith("package.json")) return olcliFiles["package.json"];
        if (normalizedPath.endsWith(".github/workflows/npm-publish.yml")) {
          return "permissions:\n  id-token: write\nsteps:\n  - env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n";
        }
        const relativePath = injectedRelativePath(path);
        return olcliFiles[relativePath as keyof typeof olcliFiles] ?? "";
      },
      listScanFiles: async () => [".github/workflows/npm-publish.yml"],
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStep).toBe("static release metadata");
    expect(result.message).toMatch(/npm publish workflow|token/i);
    expect(commands).toEqual([]);
  });

  it("scans only injected release files and validates dry-run package contents", async () => {
    const commands: string[] = [];
    const result = await runPrepublishChecks({
      repoRoot: "/repo",
      runCommand: async (command, args) => {
        commands.push([command, ...args].join(" "));
        if (args.includes("pack")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                files: [
                  { path: "package/package.json" },
                  { path: "package/README.md" },
                  { path: "package/LICENSE" },
                  { path: "package/NOTICE.md" },
                  { path: "package/assets/olcx-mark.svg" },
                  { path: "package/dist/cli.js" },
                  { path: "package/dist/cli.d.ts" },
                  { path: "package/docs/security.md" },
                  ...requiredDocPackageFiles.map((path) => ({ path })),
                  ...examplePackageFiles.map((path) => ({ path })),
                  { path: "package/src/backend/olcli/LICENSE" },
                  { path: "package/src/backend/olcli/README.md" },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readTextFile: async (path) => {
        const normalizedPath = normalizeInjectedPath(path);
        if (normalizedPath.endsWith("package-lock.json")) return JSON.stringify({ packages: {} });
        if (normalizedPath.endsWith(".gitignore")) return safeGitignore;
        if (normalizedPath.endsWith(".github/workflows/npm-publish.yml")) return safeNpmPublishWorkflow;
        if (normalizedPath.endsWith("docs/security.md")) return "projectId: <overleaf-project-id>";
        if (normalizedPath.includes("/docs/")) return "safe docs placeholder";
        const relativePath = injectedRelativePath(path);
        if (relativePath in exampleReleaseFiles) return exampleReleaseFiles[relativePath];
        return olcliFiles[relativePath as keyof typeof olcliFiles] ?? "";
      },
      listScanFiles: async () => [
        "README.md",
        "docs/security.md",
        ...Object.keys(exampleReleaseFiles),
        ".olcx/auth.local.json",
        "tmp/task/00-task.md",
      ],
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(commands.map(normalizeRecordedCommand)).toEqual([
      "npm run build",
      "npm run typecheck",
      "npm test",
      "npm audit --audit-level=high",
      "npm pack --dry-run --json --ignore-scripts",
    ]);
  });

  it("scans tracked env examples while excluding local env files", async () => {
    const readPaths: string[] = [];
    const result = await runPrepublishChecks({
      repoRoot: "/repo",
      runCommand: async (_command, args) => {
        if (args.includes("pack")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                files: [
                  { path: "package/package.json" },
                  { path: "package/README.md" },
                  { path: "package/LICENSE" },
                  { path: "package/NOTICE.md" },
                  { path: "package/assets/olcx-mark.svg" },
                  { path: "package/dist/cli.js" },
                  { path: "package/dist/cli.d.ts" },
                  { path: "package/docs/security.md" },
                  ...requiredDocPackageFiles.map((path) => ({ path })),
                  ...examplePackageFiles.map((path) => ({ path })),
                  { path: "package/src/backend/olcli/LICENSE" },
                  { path: "package/src/backend/olcli/README.md" },
                ],
              },
            ]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readTextFile: async (path) => {
        const normalizedPath = normalizeInjectedPath(path);
        readPaths.push(path);
        if (normalizedPath.endsWith(".env.example")) return `${e2eSessionKey}=${leakCookieValue}`;
        if (normalizedPath.endsWith(".env.e2e.example")) return "OLCX_E2E_ENABLE_REAL=0";
        if (normalizedPath.endsWith(".env.local") || normalizedPath.endsWith(".env.e2e.local")) {
          throw new Error(`local env file must not be read: ${path}`);
        }
        if (normalizedPath.endsWith("package-lock.json")) return JSON.stringify({ packages: {} });
        if (normalizedPath.endsWith(".gitignore")) return safeGitignore;
        if (normalizedPath.endsWith(".github/workflows/npm-publish.yml")) return safeNpmPublishWorkflow;
        if (normalizedPath.endsWith("docs/security.md")) return "projectId: <overleaf-project-id>";
        if (normalizedPath.includes("/docs/")) return "safe docs placeholder";
        const relativePath = injectedRelativePath(path);
        if (relativePath in exampleReleaseFiles) return exampleReleaseFiles[relativePath];
        return olcliFiles[relativePath as keyof typeof olcliFiles] ?? "";
      },
      listScanFiles: async () => [".env.example", ".env.e2e.example", ".env.local", ".env.e2e.local"],
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/sensitive release text found in \.env\.example/);
    const normalizedReadPaths = readPaths.map(normalizeInjectedPath);
    expect(normalizedReadPaths).toContain("/repo/.env.example");
    expect(normalizedReadPaths).toContain("/repo/.env.e2e.example");
    expect(normalizedReadPaths).not.toContain("/repo/.env.local");
    expect(normalizedReadPaths).not.toContain("/repo/.env.e2e.local");
  });
});
