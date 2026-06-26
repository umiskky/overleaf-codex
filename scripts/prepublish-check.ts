import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface PackFile {
  path: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PrepublishCheckInput {
  repoRoot?: string;
  runCommand?: (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;
  readTextFile?: (path: string) => Promise<string>;
  listScanFiles?: (repoRoot: string) => Promise<string[]>;
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
}

export interface PrepublishCheckResult {
  exitCode: number;
  failedStep?: string;
  message?: string;
}

export interface SensitiveFinding {
  path: string;
  reason: string;
}

const REQUIRED_PACKAGE_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "assets/olcx-mark.svg",
  "dist/cli.js",
  "dist/cli.d.ts",
  "docs/usage.md",
  "docs/auth.md",
  "docs/endpoint.md",
  "docs/sync.md",
  "docs/compile.md",
  "docs/troubleshooting.md",
  "docs/release-gates.md",
  "docs/npm-packaging.md",
  "docs/release-notes-v1.md",
  "examples/minimal-paper/README.md",
  "examples/minimal-paper/main.tex",
  "examples/minimal-paper/.olcx/config.json",
  "examples/minimal-paper/.olcx/auth.local.example.json",
  "src/backend/olcli/LICENSE",
  "src/backend/olcli/README.md",
] as const;

const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MPL-2.0",
]);

const REQUIRED_GITIGNORE_ENTRIES = [
  ".olcx/auth.local.json",
  ".olcx/*.local.json",
  ".olcx/*.secret.json",
  "*.local.json",
  "*.secret.json",
  ".env.*",
  "tmp/",
] as const;

const ALLOWED_FAKE_PROJECT_IDS = new Set(["0123456789abcdef01234567"]);

const ALLOWED_SYNTHETIC_SECRET_VALUES = new Set([
  "fake-session-value",
  "file-session",
  "file-session-value",
  "file-project-id",
  "process-session",
  "process-session-value",
  "live-cookie-placeholder",
  "redacted",
]);

const STABLE_APPROVED_DECISION = "Stable release decision: Approved for stable release";
const STABLE_NOT_APPROVED_DECISION = "Stable release decision: Not approved for stable release";
const STABLE_BLOCKED_STATUS = "Stable npm publish is blocked";
const CONCRETE_STABLE_E2E_ARTIFACT_PATTERN = /^Sanitized real E2E artifact: gh-release:\/\/\S+$/m;
const BLOCKED_STABLE_E2E_TEXT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /not recorded/i, reason: "not recorded" },
  { pattern: /placeholder/i, reason: "placeholder" },
  { pattern: /not evidence/i, reason: "not evidence" },
  { pattern: /Stable npm publish is blocked/i, reason: "blocked stable npm status" },
  { pattern: /Stable release decision: Not approved for stable release/i, reason: "not-approved stable release decision" },
];

const OLCLI_NOTICE = {
  packageName: "@aloth/olcli@0.5.0",
  repository: "https://github.com/aloth/olcli",
  tag: "v0.5.0",
  commit: "524c30b11328a847a9c0bcf4447d2b3468160f8c",
  tarball: "https://registry.npmjs.org/@aloth/olcli/-/olcli-0.5.0.tgz",
  integrity: "sha512-kFstYGK6htjDiOlX0H/nmjzugwRYN2RlBufK+bAA648h21GqQOVxeHr5po2ybwxetoccT9ky3YV2ch7c3b6GmQ==",
  copyright: "Copyright (c) 2026 Alexander Loth",
  license: "MIT",
  localFile: "src/backend/olcli/client.ts",
} as const;

const PACKAGE_ALLOWED_EXACT = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "src/backend/olcli/LICENSE",
  "src/backend/olcli/README.md",
]);

const PACKAGE_ALLOWED_PREFIXES = ["assets/", "dist/", "docs/", "examples/"] as const;

const SCAN_TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function normalizePackFiles(files: PackFile[]): string[] {
  return files.map((file) => normalizePackagePath(file.path)).sort();
}

export function assertPackageContents(rawFiles: string[] | PackFile[]): void {
  const files = rawFiles.map((entry) =>
    normalizePackagePath(typeof entry === "string" ? entry : entry.path)
  );
  const fileSet = new Set(files);

  for (const file of files) {
    const reason = packageDisallowReason(file);
    if (reason) {
      throw new Error(`npm package contains disallowed path (${reason}): ${file}`);
    }
    if (!isAllowedPackagePath(file)) {
      throw new Error(`npm package contains path outside the release allowlist: ${file}`);
    }
  }

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!fileSet.has(required)) {
      throw new Error(`npm package is missing required file: ${required}`);
    }
  }
}

export function assertDependencyLicenses(lockfile: unknown): { checked: number; licenses: string[] } {
  const packages = readLockfilePackages(lockfile);
  const licenses = new Set<string>();
  let checked = 0;

  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (packagePath === "") continue;

    const name = packageNameFromLockfilePath(packagePath, metadata);
    const version = readStringField(metadata, "version") ?? "unknown";
    const license = readStringField(metadata, "license");

    if (!license) {
      throw new Error(`${name}@${version} has no license metadata in package-lock.json`);
    }
    if (!ALLOWED_LICENSES.has(license)) {
      throw new Error(`${name}@${version} uses disallowed license ${license}`);
    }

    checked += 1;
    licenses.add(license);
  }

  return { checked, licenses: [...licenses].sort() };
}

export function assertGitignoreProtectsLocalSecrets(contents: string): void {
  const entries = new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  );
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(`missing required gitignore entry for local secrets: ${missing.join(", ")}`);
  }
}

export function assertNpmPublishWorkflowSecurity(contents: string): void {
  const requiredSnippets = [
    ["release publication trigger", /^\s*release:\s*$/m],
    ["published release type", /^\s*-\s*published\s*$/m],
    ["contents: read permission", /^\s*contents:\s*read\s*$/m],
    ["id-token: write permission", /^\s*id-token:\s*write\s*$/m],
    ["GitHub-hosted ubuntu-latest runner", /^\s*runs-on:\s*ubuntu-latest\s*$/m],
    ["npm-publish environment", /^\s*environment:\s*npm-publish\s*$/m],
    ["actions/setup-node@v4", /actions\/setup-node@v4/],
    ["npm registry URL", /registry-url:\s*https:\/\/registry\.npmjs\.org\b/],
    ["trusted publishing capable npm CLI", /npm\s+install\s+-g\s+npm@\^11\.5\.1\b/],
    ["forced real E2E skip env", /^\s*OLCX_E2E_IGNORE_LOCAL_ENV:\s*["']?1["']?\s*$/m],
    ["forced real E2E disable env", /^\s*OLCX_E2E_ENABLE_REAL:\s*["']?0["']?\s*$/m],
    ["prepublish check before publish", /npm\s+run\s+prepublish:check\b/],
    ["dist-tag publish command", /npm\s+publish\s+--tag\s+["']?\$NPM_DIST_TAG["']?/],
    ["stable approval gate", /Stable release decision: Approved for stable release/],
    ["concrete stable E2E artifact gate", /grep\s+-E\s+["'][^"']*Sanitized real E2E artifact: gh-release:\/\//],
    ["placeholder stable E2E rejection", /not recorded\|placeholder\|not evidence/],
    ["blocked stable npm status rejection", /grep\s+-F\s+["']Stable npm publish is blocked["']/],
    ["not-approved stable release rejection", /Stable release decision: Not approved for stable release/],
    [
      "concrete stable artifact failure message",
      /Concrete sanitized real E2E artifact reference is required for stable npm publish\./,
    ],
  ] as const;

  for (const [description, pattern] of requiredSnippets) {
    if (!pattern.test(contents)) {
      throw new Error(`npm publish workflow is missing required ${description}`);
    }
  }

  if (!hasTrustedPublishingNodeVersion(contents)) {
    throw new Error("npm publish workflow must use node-version: 22.14.0 or newer");
  }

  const forbiddenPatterns = [
    [/^\s*pull_request\s*:/m, "pull_request trigger"],
    [/^\s*push\s*:/m, "ordinary push trigger"],
    [/^\s*workflow_dispatch\s*:/m, "manual workflow_dispatch trigger"],
    [/\.npmrc/i, "npmrc auth config"],
    [/_authToken/i, "npm auth token config"],
    /\bNPM_TOKEN\b/,
    /\bNODE_AUTH_TOKEN\b/,
    /\bnpm\s+token\b/i,
    /\bautomation token\b/i,
    /\bsecrets\.NPM\b/i,
  ] as const;

  for (const entry of forbiddenPatterns) {
    const pattern = Array.isArray(entry) ? entry[0] : entry;
    const label = Array.isArray(entry) ? entry[1] : "long-lived npm token material";
    if (pattern.test(contents)) {
      throw new Error(`npm publish workflow contains forbidden ${label}`);
    }
  }
}

export function assertStableReleaseNotesPublishEvidence(contents: string): void {
  if (!contents.includes(STABLE_APPROVED_DECISION)) {
    throw new Error("stable release notes must record explicit stable release approval before npm publish");
  }

  for (const { pattern, reason } of BLOCKED_STABLE_E2E_TEXT_PATTERNS) {
    if (pattern.test(contents)) {
      throw new Error(`stable release notes contain blocked-state text (${reason})`);
    }
  }

  if (!CONCRETE_STABLE_E2E_ARTIFACT_PATTERN.test(contents)) {
    throw new Error(
      "Concrete sanitized real E2E artifact reference is required: Sanitized real E2E artifact: gh-release://..."
    );
  }
}

export function scanReleaseText(filePath: string, contents: string): SensitiveFinding[] {
  const normalizedPath = normalizeRepoPath(filePath);
  if (isProtectedLocalPath(normalizedPath)) {
    return [];
  }

  const findings: SensitiveFinding[] = [];
  addCookieFindings(findings, normalizedPath, contents);
  addProjectIdFindings(findings, normalizedPath, contents);
  return findings;
}

export function assertOlcliNoticeConsistency(files: Record<string, string>): void {
  requireFileContainsAll(files, "README.md", [
    OLCLI_NOTICE.packageName,
    OLCLI_NOTICE.repository,
    OLCLI_NOTICE.tag,
    OLCLI_NOTICE.commit,
    OLCLI_NOTICE.localFile,
    OLCLI_NOTICE.license,
  ]);
  requireFileMatches(files, "README.md", /not an official Overleaf project/i);
  requireFileMatches(files, "README.md", /not an official `?olcli`? project/i);

  requireFileContainsAll(files, "NOTICE.md", [
    OLCLI_NOTICE.packageName,
    OLCLI_NOTICE.repository,
    OLCLI_NOTICE.tag,
    OLCLI_NOTICE.commit,
    OLCLI_NOTICE.tarball,
    OLCLI_NOTICE.localFile,
    OLCLI_NOTICE.copyright,
    OLCLI_NOTICE.license,
  ]);
  requireFileMatches(files, "NOTICE.md", /not (?:affiliated|an official).*Overleaf/i);
  requireFileMatches(files, "NOTICE.md", /(?:not affiliated|not an official).*`?olcli`?/i);

  requireFileContainsAll(files, "src/backend/olcli/README.md", [
    OLCLI_NOTICE.packageName,
    OLCLI_NOTICE.repository,
    OLCLI_NOTICE.tag,
    OLCLI_NOTICE.commit,
    OLCLI_NOTICE.tarball,
    OLCLI_NOTICE.integrity,
    OLCLI_NOTICE.localFile,
    OLCLI_NOTICE.license,
    "Only backend adapter modules may import",
  ]);
  requireFileMatches(files, "src/backend/olcli/README.md", /not an official .*`?olcli`? project/i);

  requireFileContainsAll(files, "src/backend/olcli/LICENSE", [
    "MIT License",
    OLCLI_NOTICE.copyright,
  ]);
  requireFileContainsAll(files, "src/backend/olcli/client.ts", [
    "Adapted from @aloth/olcli v0.5.0 src/client.ts",
    OLCLI_NOTICE.commit,
    OLCLI_NOTICE.copyright,
    "Licensed under the MIT License",
  ]);
  requireFileContainsAll(files, "LICENSE", ["MIT License"]);

  const packageJson = parsePackageJson(files["package.json"]);
  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies,
  };
  if (Object.prototype.hasOwnProperty.call(allDependencies, "@aloth/olcli")) {
    throw new Error("package.json must not list @aloth/olcli as a dependency");
  }

  const packageFiles = packageJson.files ?? [];
  for (const required of ["src/backend/olcli/LICENSE", "src/backend/olcli/README.md"]) {
    if (!packageFiles.includes(required)) {
      throw new Error(`package.json files must include ${required}`);
    }
  }
}

export function formatPrepublishFailure(step: string, reason: string): string {
  return `Prepublish gate failed at ${step}: ${reason}`;
}

export async function runPrepublishChecks(input: PrepublishCheckInput = {}): Promise<PrepublishCheckResult> {
  const repoRoot = input.repoRoot ?? process.cwd();
  const runCommand = input.runCommand ?? defaultRunCommand;
  const readTextFile = input.readTextFile ?? ((filePath) => readFile(filePath, "utf8"));
  const listScanFiles = input.listScanFiles ?? defaultListScanFiles;
  const writeOut = input.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = input.writeErr ?? ((value) => process.stderr.write(value));

  try {
    await runStaticChecks({ repoRoot, readTextFile, listScanFiles });
    writeOut("[prepublish] static release metadata: ok\n");

    await runExternalStep("build", ["run", "build"], { repoRoot, runCommand, writeOut });
    await runExternalStep("typecheck", ["run", "typecheck"], { repoRoot, runCommand, writeOut });
    await runExternalStep("test", ["test"], { repoRoot, runCommand, writeOut });
    await runExternalStep("npm audit high", ["audit", "--audit-level=high"], {
      repoRoot,
      runCommand,
      writeOut,
    });

    const packResult = await runExternalStep("npm pack dry-run", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      repoRoot,
      runCommand,
      writeOut,
    });
    const packFiles = parseNpmPackFiles(packResult.stdout);
    assertPackageContents(packFiles);
    await scanPackageFiles({ repoRoot, packFiles, readTextFile });
    writeOut("[prepublish] package contents: ok\n");

    return { exitCode: 0 };
  } catch (error) {
    const failure = normalizePrepublishError(error);
    const message = formatPrepublishFailure(failure.step, failure.reason);
    writeErr(`${message}\n`);
    return { exitCode: 1, failedStep: failure.step, message };
  }
}

function normalizePackagePath(filePath: string): string {
  return normalizeRepoPath(filePath).replace(/^package\//, "");
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function packageDisallowReason(filePath: string): string | undefined {
  const normalized = normalizePackagePath(filePath);
  const basename = path.posix.basename(normalized);
  const segments = normalized.split("/");

  if (basename === ".npmrc") return "npm auth config";
  if (segments.includes("node_modules")) return "node_modules";
  if (segments.includes("tmp")) return "tmp handoff";
  if (segments.includes(".olcx") && !isAllowedExampleOlcxPath(normalized)) return "local auth";
  if (segments.includes(".git")) return "git metadata";
  if (segments.includes(".github")) return "GitHub workflow metadata";
  if (segments.includes("tests") || segments.includes("test")) return "test or E2E output";
  if (segments.includes("scripts")) return "scripts";
  if (hasAdjacentSegments(segments, "build", "overleaf")) return "generated build output";
  if (/(^|\/)[^/]+\.local\.json$/i.test(normalized)) return "local JSON";
  if (/(^|\/)[^/]+\.secret\.json$/i.test(normalized)) return "secret JSON";
  if (basename === ".env" || basename.startsWith(".env.")) return "environment file";
  if (/(^|\/)(?:real-overleaf|e2e|e2e-output)[^/]*\.(?:json|log|out|txt)$/i.test(normalized)) {
    return "test or E2E output";
  }
  if (basename === "npm-debug.log" || basename.endsWith(".log")) return "log file";
  return undefined;
}

function isAllowedExampleOlcxPath(filePath: string): boolean {
  return (
    filePath === "examples/minimal-paper/.olcx/config.json" ||
    filePath === "examples/minimal-paper/.olcx/auth.local.example.json"
  );
}

function hasAdjacentSegments(segments: string[], first: string, second: string): boolean {
  return segments.some((segment, index) => segment === first && segments[index + 1] === second);
}

function isAllowedPackagePath(filePath: string): boolean {
  const normalized = normalizePackagePath(filePath);
  return (
    PACKAGE_ALLOWED_EXACT.has(normalized) ||
    PACKAGE_ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function readLockfilePackages(lockfile: unknown): Record<string, unknown> {
  if (!isRecord(lockfile) || !isRecord(lockfile.packages)) {
    throw new Error("package-lock.json is missing a packages object");
  }
  return lockfile.packages;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function packageNameFromLockfilePath(packagePath: string, metadata: unknown): string {
  const explicitName = readStringField(metadata, "name");
  if (explicitName) return explicitName;

  const nodeModulesParts = packagePath.split("node_modules/");
  return nodeModulesParts[nodeModulesParts.length - 1] || packagePath;
}

function addCookieFindings(findings: SensitiveFinding[], filePath: string, contents: string): void {
  const patterns: Array<{ regex: RegExp; reason: string }> = [
    {
      regex: /\boverleaf_session2[^\S\r\n]*=[^\S\r\n]*("?)([^"'\s;,)]+)\1/gi,
      reason: "likely sensitive Overleaf session cookie",
    },
    {
      regex: /(?:\bsessionCookie\b|["']sessionCookie["'])[^\S\r\n]*:[^\S\r\n]*(["'])([^"']+)\1/gi,
      reason: "likely sensitive sessionCookie value",
    },
    {
      regex: /\bOLCX_E2E_OVERLEAF_SESSION[^\S\r\n]*=[^\S\r\n]*(["']?)([^"'\s;,)]+)\1/gi,
      reason: "likely sensitive real E2E cookie value",
    },
  ];

  for (const { regex, reason } of patterns) {
    for (const match of contents.matchAll(regex)) {
      const value = match[2];
      if (!isAllowedSyntheticSecret(value)) {
        findings.push({ path: filePath, reason });
      }
    }
  }
}

function addProjectIdFindings(findings: SensitiveFinding[], filePath: string, contents: string): void {
  const envPattern = /\bOLCX_E2E_PROJECT_ID[^\S\r\n]*=[^\S\r\n]*(["']?)([a-f0-9]{24})\1/gi;
  for (const match of contents.matchAll(envPattern)) {
    const projectId = match[2].toLowerCase();
    if (!ALLOWED_FAKE_PROJECT_IDS.has(projectId)) {
      findings.push({ path: filePath, reason: "likely sensitive Overleaf project id" });
    }
  }

  const urlPattern = /https:\/\/(?:www\.|cn\.)?overleaf\.com\/project\/([a-f0-9]{24})\b/gi;
  for (const match of contents.matchAll(urlPattern)) {
    const projectId = match[1].toLowerCase();
    if (!ALLOWED_FAKE_PROJECT_IDS.has(projectId)) {
      findings.push({ path: filePath, reason: "likely sensitive Overleaf project id in URL" });
    }
  }
}

function isAllowedSyntheticSecret(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  if (!normalized) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  if (ALLOWED_SYNTHETIC_SECRET_VALUES.has(normalized)) return true;
  if (/(?:fake|placeholder|redacted|example|test|dummy|mock|fixture)/i.test(normalized)) return true;
  return false;
}

function requireFileContainsAll(files: Record<string, string>, filePath: string, values: string[]): void {
  const contents = files[filePath];
  if (typeof contents !== "string") {
    throw new Error(`${filePath} is required for olcli notice validation`);
  }

  for (const value of values) {
    if (!contents.includes(value)) {
      throw new Error(`${filePath} is missing required olcli notice value: ${value}`);
    }
  }
}

function requireFileMatches(files: Record<string, string>, filePath: string, pattern: RegExp): void {
  const contents = files[filePath];
  if (typeof contents !== "string") {
    throw new Error(`${filePath} is required for olcli notice validation`);
  }
  if (!pattern.test(contents)) {
    throw new Error(`${filePath} is missing required olcli notice pattern: ${pattern}`);
  }
}

interface PackageJsonForNotice {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
}

function parsePackageJson(contents: string | undefined): PackageJsonForNotice {
  if (typeof contents !== "string") {
    throw new Error("package.json is required for olcli notice validation");
  }
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) {
    throw new Error("package.json must contain an object");
  }
  return parsed as PackageJsonForNotice;
}

async function runStaticChecks(input: {
  repoRoot: string;
  readTextFile: (path: string) => Promise<string>;
  listScanFiles: (repoRoot: string) => Promise<string[]>;
}): Promise<void> {
  const gitignore = await input.readTextFile(path.join(input.repoRoot, ".gitignore"));
  assertGitignoreProtectsLocalSecrets(gitignore);

  const lockfile = JSON.parse(await input.readTextFile(path.join(input.repoRoot, "package-lock.json"))) as unknown;
  assertDependencyLicenses(lockfile);

  const olcliFiles = await readOlcliNoticeFiles(input.repoRoot, input.readTextFile);
  assertOlcliNoticeConsistency(olcliFiles);

  const npmPublishWorkflow = await input.readTextFile(path.join(input.repoRoot, ".github/workflows/npm-publish.yml"));
  assertNpmPublishWorkflowSecurity(npmPublishWorkflow);

  const releaseNotes = await input.readTextFile(path.join(input.repoRoot, "docs/release-notes-v1.md"));
  if (releaseNotes.includes(STABLE_APPROVED_DECISION)) {
    assertStableReleaseNotesPublishEvidence(releaseNotes);
  }

  const scanFiles = await input.listScanFiles(input.repoRoot);
  const findings: SensitiveFinding[] = [];
  for (const filePath of scanFiles) {
    const relativePath = normalizeRepoPath(path.isAbsolute(filePath) ? path.relative(input.repoRoot, filePath) : filePath);
    if (!shouldScanTextFile(relativePath)) continue;
    const contents = await input.readTextFile(path.join(input.repoRoot, relativePath));
    findings.push(...scanReleaseText(relativePath, contents));
  }
  assertNoSensitiveFindings(findings);
}

async function readOlcliNoticeFiles(
  repoRoot: string,
  readTextFile: (path: string) => Promise<string>
): Promise<Record<string, string>> {
  const files = [
    "package.json",
    "README.md",
    "NOTICE.md",
    "LICENSE",
    "src/backend/olcli/README.md",
    "src/backend/olcli/LICENSE",
    "src/backend/olcli/client.ts",
  ];
  const entries = await Promise.all(
    files.map(async (filePath) => [filePath, await readTextFile(path.join(repoRoot, filePath))] as const)
  );
  return Object.fromEntries(entries);
}

async function runExternalStep(
  step: string,
  args: string[],
  input: {
    repoRoot: string;
    runCommand: (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;
    writeOut: (value: string) => void;
  }
): Promise<CommandResult> {
  const result = await input.runCommand(npmCommand(), args, { cwd: input.repoRoot });
  if (result.exitCode !== 0) {
    throw new StepFailure(step, summarizeCommandFailure(result));
  }
  input.writeOut(`[prepublish] ${step}: ok\n`);
  return result;
}

function summarizeCommandFailure(result: CommandResult): string {
  const details = firstUsefulLine(result.stderr) ?? firstUsefulLine(result.stdout);
  return details ? `exit code ${result.exitCode} (${details})` : `exit code ${result.exitCode}`;
}

function firstUsefulLine(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line?.slice(0, 300);
}

function parseNpmPackFiles(stdout: string): PackFile[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0 || !isRecord(parsed[0]) || !Array.isArray(parsed[0].files)) {
    throw new Error("npm pack dry-run did not return a files list");
  }

  return parsed[0].files.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw new Error("npm pack dry-run returned a file entry without a path");
    }
    return { path: entry.path };
  });
}

async function scanPackageFiles(input: {
  repoRoot: string;
  packFiles: PackFile[];
  readTextFile: (path: string) => Promise<string>;
}): Promise<void> {
  const findings: SensitiveFinding[] = [];
  for (const filePath of normalizePackFiles(input.packFiles)) {
    if (!shouldScanTextFile(filePath)) continue;
    const contents = await input.readTextFile(path.join(input.repoRoot, filePath));
    findings.push(...scanReleaseText(filePath, contents));
  }
  assertNoSensitiveFindings(findings);
}

function assertNoSensitiveFindings(findings: SensitiveFinding[]): void {
  if (findings.length === 0) return;
  const first = findings[0];
  throw new Error(`sensitive release text found in ${first.path}: ${first.reason}`);
}

async function defaultRunCommand(command: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: error.message,
      });
    });
  });
}

async function defaultListScanFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(repoRoot, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = normalizeRepoPath(path.join(relativeDir, entry.name));
      if (shouldSkipScanPath(relativePath, entry.isDirectory())) continue;

      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (shouldScanTextFile(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  await walk("");
  return files.sort();
}

function hasTrustedPublishingNodeVersion(contents: string): boolean {
  const match = contents.match(/node-version:\s*["']?(\d+)(?:\.(\d+))?(?:\.(\d+))?["']?/);
  if (!match) return false;

  const major = Number(match[1]);
  const minor = Number(match[2] ?? "0");
  const patch = Number(match[3] ?? "0");

  return major > 22 || (major === 22 && (minor > 14 || (minor === 14 && patch >= 0)));
}

function shouldSkipScanPath(filePath: string, isDirectory: boolean): boolean {
  const normalized = normalizeRepoPath(filePath);
  const firstSegment = normalized.split("/")[0];
  if (
    firstSegment === ".git" ||
    firstSegment === ".olcx" ||
    firstSegment === ".worktrees" ||
    firstSegment === "coverage" ||
    firstSegment === "dist" ||
    firstSegment === "node_modules" ||
    firstSegment === "tmp"
  ) {
    return true;
  }
  if (normalized.startsWith("build/overleaf/")) return true;
  if (isDirectory) return false;
  return isProtectedLocalPath(normalized);
}

function shouldScanTextFile(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const basename = path.posix.basename(normalized);
  if (isProtectedLocalPath(normalized)) return false;
  if (packageDisallowReason(normalized) === "node_modules") return false;
  if (normalized === ".gitignore") return true;
  if (/^\.env(?:\..*)?\.example$/i.test(basename)) return true;
  return SCAN_TEXT_EXTENSIONS.has(path.posix.extname(normalized));
}

function isProtectedLocalPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const basename = path.posix.basename(normalized);
  return (
    normalized.startsWith(".olcx/") ||
    normalized.startsWith("tmp/") ||
    basename === ".env" ||
    /^\.env(?:\..*)?\.(?:local|secret)$/i.test(basename) ||
    /\.local\.json$/i.test(basename) ||
    /\.secret\.json$/i.test(basename)
  );
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly reason: string
  ) {
    super(reason);
  }
}

function normalizePrepublishError(error: unknown): { step: string; reason: string } {
  if (error instanceof StepFailure) {
    return { step: error.step, reason: error.reason };
  }
  if (error instanceof Error) {
    return { step: "static release metadata", reason: error.message };
  }
  return { step: "static release metadata", reason: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runPrepublishChecks();
  process.exitCode = result.exitCode;
}
