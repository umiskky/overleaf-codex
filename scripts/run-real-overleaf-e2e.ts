#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { run, type CliIo, type CliRuntime } from "../src/cli.js";
import type { ProjectAuth } from "../src/auth/types.js";
import { createOlcliOverleafBackend, type OverleafBackend } from "../src/backend/index.js";
import { readProjectConfig, writeProjectConfig } from "../src/config/projectConfig.js";
import { createOlcxError, EXIT_CODES, isOlcxError, type ExitCode } from "../src/errors.js";

export const REQUIRED_REAL_E2E_KEYS = [
  "OLCX_E2E_ENABLE_REAL",
  "OLCX_E2E_OVERLEAF_SESSION",
  "OLCX_E2E_PROJECT_ID",
] as const;

export interface RealE2eConfig {
  ready: boolean;
  enabled: boolean;
  missing: string[];
  skipMessage: string;
  sessionCookie?: string;
  projectId?: string;
  projectUrl?: string;
  accountLabel?: string;
  projectRef?: string;
  baseUrl: string;
}

export interface RealE2eLogger {
  outputBlocks: string[];
  logLine: (value: string) => void;
}

export interface RealE2eRunResult {
  outputBlocks: string[];
  capturedBlocks: string[];
}

type RealE2eEnv = Record<string, string | undefined>;

export interface RunRealOverleafE2eInput {
  repoRoot: string;
  config: RealE2eConfig;
  writeOut?: (value: string) => void;
  backend?: OverleafBackend;
  runCli?: (argv: string[], io: CliIo, runtime: CliRuntime) => Promise<ExitCode>;
  now?: () => Date;
  stepTimeoutMs?: number;
  verificationTimeoutMs?: number;
  verificationRetryDelayMs?: number;
}

export interface RunManualRealE2eInput {
  repoRoot?: string;
  processEnv?: RealE2eEnv;
  writeOut?: (value: string) => void;
  runRealOverleafE2e?: (input: RunRealOverleafE2eInput) => Promise<RealE2eRunResult>;
}

export interface RunManualRealE2eEntrypointInput extends RunManualRealE2eInput {
  beforeExit?: () => Promise<void> | void;
  exit?: (exitCode: number) => void;
}

const ENV_FILE_NAME = ".env.e2e.local";
const IGNORE_LOCAL_ENV_KEY = "OLCX_E2E_IGNORE_LOCAL_ENV";
const REDACTED_REAL_E2E_VALUE = "<redacted-real-e2e-value>";
const SKIP_MESSAGE =
  "skipped: set OLCX_E2E_ENABLE_REAL=1, OLCX_E2E_OVERLEAF_SESSION, OLCX_E2E_PROJECT_ID or .env.e2e.local";
const CONFIG_IGNORES = [".gitignore", ".olcx/config.json", ".vscode/"] as const;
const FALLBACK_LIMITATION =
  "documented limitation - normal real Overleaf compile did not time out; fake backend coverage remains required";
const DEFAULT_REAL_E2E_BASE_URL = "https://cn.overleaf.com";
const DEFAULT_REAL_E2E_STEP_TIMEOUT_MS = 180_000;
const DEFAULT_REAL_E2E_VERIFICATION_TIMEOUT_MS = 180_000;
const DEFAULT_REAL_E2E_VERIFICATION_RETRY_DELAY_MS = 1_000;

export function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (key.length === 0) {
      continue;
    }

    parsed[key] = unquoteDotEnvValue(rawValue);
  }

  return parsed;
}

export function resolveRealE2eConfig(input: {
  fileEnv: RealE2eEnv;
  processEnv: RealE2eEnv;
}): RealE2eConfig {
  const enable = readMergedEnvValue(input, "OLCX_E2E_ENABLE_REAL");
  const sessionCookie = readMergedEnvValue(input, "OLCX_E2E_OVERLEAF_SESSION");
  const projectId = readMergedEnvValue(input, "OLCX_E2E_PROJECT_ID");
  const projectUrl = normalizeOptionalProjectUrl(readMergedEnvValue(input, "OLCX_E2E_PROJECT_URL"));
  const accountLabel = readMergedEnvValue(input, "OLCX_E2E_ACCOUNT_LABEL");
  const baseUrl = normalizeOptionalBaseUrl(readMergedEnvValue(input, "OLCX_E2E_OVERLEAF_BASE_URL"));
  const missing: string[] = [];

  if (enable !== "1") {
    missing.push("OLCX_E2E_ENABLE_REAL");
  }
  if (!sessionCookie) {
    missing.push("OLCX_E2E_OVERLEAF_SESSION");
  }
  if (!projectId) {
    missing.push("OLCX_E2E_PROJECT_ID");
  }

  return {
    ready: missing.length === 0,
    enabled: enable === "1",
    missing,
    skipMessage: SKIP_MESSAGE,
    ...(sessionCookie ? { sessionCookie } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectUrl ? { projectUrl } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(projectUrl || projectId ? { projectRef: projectUrl ?? projectId } : {}),
    baseUrl: baseUrl ?? DEFAULT_REAL_E2E_BASE_URL,
  };
}

export async function loadRealE2eConfig(input: {
  repoRoot: string;
  processEnv?: RealE2eEnv;
}): Promise<RealE2eConfig> {
  const processEnv = input.processEnv ?? process.env;
  const fileEnv =
    processEnv[IGNORE_LOCAL_ENV_KEY]?.trim() === "1" ? {} : await readRealE2eEnvFile(input.repoRoot);
  return resolveRealE2eConfig({
    fileEnv,
    processEnv,
  });
}

export function sanitizeRealE2eOutput(output: string, config: RealE2eConfig): string {
  return sensitiveConfigValues(config).reduce(
    (sanitized, value) => sanitized.replaceAll(value, REDACTED_REAL_E2E_VALUE),
    output
  );
}

export function assertNoRealE2eSensitiveOutput(output: string, config: RealE2eConfig): void {
  if (sensitiveConfigValues(config).some((value) => output.includes(value))) {
    throw new Error("Output leaked a configured real E2E sensitive value.");
  }
}

export function formatRealE2eStep(step: string, status: string): string {
  return `[real-e2e] ${step}: ${status}\n`;
}

export function createRealE2eLogger(input: {
  config: RealE2eConfig;
  writeOut?: (value: string) => void;
}): RealE2eLogger {
  const outputBlocks: string[] = [];
  const writeOut = input.writeOut ?? ((value: string) => process.stdout.write(value));

  return {
    outputBlocks,
    logLine: (value) => {
      const sanitized = sanitizeRealE2eOutput(value, input.config);
      assertNoRealE2eSensitiveOutput(sanitized, input.config);
      outputBlocks.push(sanitized);
      writeOut(sanitized);
    },
  };
}

export async function runRealOverleafE2e(input: RunRealOverleafE2eInput): Promise<RealE2eRunResult> {
  const logger = createRealE2eLogger({ config: input.config, writeOut: input.writeOut });
  const capturedBlocks: string[] = [];

  if (!input.config.ready) {
    logger.logLine(`[real-e2e] ${input.config.skipMessage}\n`);
    return { outputBlocks: logger.outputBlocks, capturedBlocks };
  }

  const sessionCookie = requireConfiguredValue(input.config.sessionCookie, "OLCX_E2E_OVERLEAF_SESSION");
  const projectId = requireConfiguredValue(input.config.projectId, "OLCX_E2E_PROJECT_ID");
  const projectRef = requireConfiguredValue(input.config.projectRef, "OLCX_E2E_PROJECT_ID");
  const now = input.now ?? (() => new Date());
  const stepTimeoutMs = input.stepTimeoutMs ?? DEFAULT_REAL_E2E_STEP_TIMEOUT_MS;
  const verificationTimeoutMs = input.verificationTimeoutMs ?? DEFAULT_REAL_E2E_VERIFICATION_TIMEOUT_MS;
  const verificationRetryDelayMs =
    input.verificationRetryDelayMs ?? DEFAULT_REAL_E2E_VERIFICATION_RETRY_DELAY_MS;
  const backend = createBoundedBackend(
    input.backend ?? createOlcliOverleafBackend({ baseUrl: input.config.baseUrl }),
    stepTimeoutMs
  );
  const runCli = input.runCli ?? run;
  const auth = createRealE2eAuth(input.config, now);
  const tempRepo = await mkdtemp(join(tmpdir(), "olcx-real-e2e-"));
  const runId = createRunId(now());
  const sentinelPath = `olcx-e2e-upload-${runId}.txt`;
  const cliBackend = createSentinelScopedBackend(backend, sentinelPath);
  const sentinelBytes = Buffer.from(sentinelContent(runId), "utf8");
  const remoteConflictBytes = Buffer.from(remoteConflictContent(runId), "utf8");
  const localConflictText = localConflictContent(runId);

  try {
    await mkdir(join(tempRepo, ".git"), { recursive: true });
    await validateRealBackendAccess({ backend, auth, projectId });
    logger.logLine(formatRealE2eStep("auth validation", "ok"));

    await runCliCommand({
      step: "init",
      args: ["init", "--project", projectRef],
      tempRepo,
      sessionCookie,
      backend: cliBackend,
      runCli,
      config: input.config,
      capturedBlocks,
      stepTimeoutMs,
    });
    await ensureRealE2eConfigIgnores(tempRepo);
    logger.logLine(formatRealE2eStep("init", "ok"));

    await runCliCommand({
      step: "auth file",
      args: authArgs(input.config),
      tempRepo,
      sessionCookie,
      backend: cliBackend,
      runCli,
      config: input.config,
      capturedBlocks,
      stepTimeoutMs,
    });
    await access(join(tempRepo, ".olcx", "auth.local.json"));
    logger.logLine(formatRealE2eStep("auth file", "ok"));

    await runCliCommand({
      step: "initial sync",
      args: ["sync"],
      tempRepo,
      sessionCookie,
      backend: cliBackend,
      runCli,
      config: input.config,
      capturedBlocks,
      stepTimeoutMs,
    });
    logger.logLine(formatRealE2eStep("initial sync", "ok"));

    await writeGeneratedFile(tempRepo, sentinelPath, sentinelBytes);
    await runCliCommand({
      step: "sentinel upload sync",
      args: ["sync"],
      tempRepo,
      sessionCookie,
      backend: cliBackend,
      runCli,
      config: input.config,
      capturedBlocks,
      stepTimeoutMs,
    });
    await verifyRemoteBytes({
      backend,
      auth,
      projectId,
      path: sentinelPath,
      expected: sentinelBytes,
      timeoutMs: verificationTimeoutMs,
      retryDelayMs: verificationRetryDelayMs,
    });
    logger.logLine(formatRealE2eStep("upload verification", "ok"));

    const compile = await runCliCommand({
      step: "compile/pdf",
      args: ["compile"],
      tempRepo,
      sessionCookie,
      backend: cliBackend,
      runCli,
      config: input.config,
      capturedBlocks,
      blockOnFailure: "Provided Overleaf E2E project must compile successfully.",
      stepTimeoutMs,
    });
    if (!compile.stdout.includes("Status: success")) {
      if (!compile.stdout.includes("Status: fallback-success")) {
        throw new Error("Real Overleaf E2E failed during compile/pdf.");
      }
    }
    await verifyPdf(join(tempRepo, "build", "overleaf", "main.pdf"));
    logger.logLine(formatRealE2eStep("compile/pdf", "ok"));

    if (compile.stdout.includes("Status: fallback-success")) {
      await verifyFallbackOutcome(compile.stdout, tempRepo, logger);
    } else {
      const fallback = await runCliCommand({
        step: "fallback",
        args: ["compile", "--fast-fallback-attempts", "1"],
        tempRepo,
        sessionCookie,
        backend: cliBackend,
        runCli,
        config: input.config,
        capturedBlocks,
        blockOnFailure: "Provided Overleaf E2E project must compile successfully.",
        stepTimeoutMs,
      });
      await verifyFallbackOutcome(fallback.stdout, tempRepo, logger);
    }

    await backend.uploadFile({
      projectId,
      auth,
      path: sentinelPath,
      bytes: remoteConflictBytes,
    });
    await writeGeneratedFile(tempRepo, sentinelPath, Buffer.from(localConflictText, "utf8"));
    const conflict = await runCliCommand({
      step: "conflict safety",
      args: ["sync"],
      tempRepo,
      sessionCookie,
      backend: cliBackend,
      runCli,
      config: input.config,
      capturedBlocks,
      expectedExitCode: EXIT_CODES.SYNC_CONFLICT,
      stepTimeoutMs,
    });
    await verifyConflictSafety({
      tempRepo,
      stderr: conflict.stderr,
      backend,
      auth,
      projectId,
      sentinelPath,
      localConflictText,
      remoteConflictBytes,
      verificationTimeoutMs,
      verificationRetryDelayMs,
    });

    return { outputBlocks: logger.outputBlocks, capturedBlocks };
  } finally {
    try {
      await rm(tempRepo, { recursive: true, force: true });
    } finally {
      await deleteRemoteSentinelBestEffort({ backend, auth, projectId, path: sentinelPath });
    }
  }
}

export class RealE2eBlockedError extends Error {
  constructor(readonly category: string) {
    super(`Real Overleaf E2E blocked: ${category}`);
    this.name = "RealE2eBlockedError";
  }
}

function readMergedEnvValue(input: { fileEnv: RealE2eEnv; processEnv: RealE2eEnv }, key: string): string | undefined {
  const value =
    Object.prototype.hasOwnProperty.call(input.processEnv, key) && input.processEnv[key] !== undefined
      ? input.processEnv[key]
      : input.fileEnv[key];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function readRealE2eEnvFile(repoRoot: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(join(repoRoot, ENV_FILE_NAME), "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {};
    }
    throw error;
  }
}

function unquoteDotEnvValue(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === "\"") && value[value.length - 1] === quote) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function normalizeOptionalProjectUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol === "https:" &&
      (host === "www.overleaf.com" || host === "overleaf.com") &&
      segments.length === 2 &&
      segments[0] === "project" &&
      /^[A-Za-z0-9_-]{6,128}$/.test(segments[1] ?? "")
    ) {
      return `https://www.overleaf.com/project/${segments[1]}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeOptionalBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname.replace(/\/+$/, "") === "" &&
      (host === "www.overleaf.com" || host === "overleaf.com" || host === "cn.overleaf.com")
    ) {
      return `https://${host === "overleaf.com" ? "www.overleaf.com" : host}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function sensitiveConfigValues(config: RealE2eConfig): string[] {
  return [
    config.sessionCookie,
    config.projectUrl,
    config.projectRef,
    config.projectId,
    config.accountLabel,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function runCliCommand(input: {
  step: string;
  args: string[];
  tempRepo: string;
  sessionCookie: string;
  backend: OverleafBackend;
  runCli: (argv: string[], io: CliIo, runtime: CliRuntime) => Promise<ExitCode>;
  config: RealE2eConfig;
  capturedBlocks: string[];
  expectedExitCode?: ExitCode;
  blockOnFailure?: string;
  stepTimeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: ExitCode }> {
  let stdout = "";
  let stderr = "";
  let ioExitCode: ExitCode = EXIT_CODES.SUCCESS;
  const io: CliIo = {
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
    setExitCode: (value) => {
      ioExitCode = value;
    },
  };
  const runtime: CliRuntime = {
    cwd: () => input.tempRepo,
    env: { OLCX_E2E_OVERLEAF_SESSION: input.sessionCookie },
    stdinIsTTY: false,
    backend: input.backend,
  };

  const exitCode = await withStepTimeout(
    () => input.runCli(["node", "olcx", ...input.args], io, runtime),
    input.stepTimeoutMs
  );
  const sanitizedStdout = sanitizeRealE2eOutput(stdout, input.config);
  const sanitizedStderr = sanitizeRealE2eOutput(stderr, input.config);
  assertNoRealE2eSensitiveOutput(sanitizedStdout, input.config);
  assertNoRealE2eSensitiveOutput(sanitizedStderr, input.config);
  if (sanitizedStdout.length > 0) input.capturedBlocks.push(sanitizedStdout);
  if (sanitizedStderr.length > 0) input.capturedBlocks.push(sanitizedStderr);

  const actualExitCode = exitCode ?? ioExitCode;
  const expectedExitCode = input.expectedExitCode ?? EXIT_CODES.SUCCESS;
  if (actualExitCode !== expectedExitCode) {
    throw blockForCliFailure(input.step, actualExitCode, input.blockOnFailure);
  }

  return { stdout: sanitizedStdout, stderr: sanitizedStderr, exitCode: actualExitCode };
}

function blockForCliFailure(step: string, exitCode: ExitCode, blockOnFailure: string | undefined): Error {
  if (blockOnFailure) {
    return new RealE2eBlockedError(blockOnFailure);
  }
  if (exitCode === EXIT_CODES.AUTH_ERROR) {
    return new RealE2eBlockedError("OLCX_E2E_OVERLEAF_SESSION");
  }
  if (exitCode === EXIT_CODES.NETWORK_ERROR) {
    return new RealE2eBlockedError("network/backend availability");
  }
  return new Error(`Real Overleaf E2E failed during ${step}.`);
}

async function validateRealBackendAccess(input: {
  backend: OverleafBackend;
  auth: ProjectAuth;
  projectId: string;
}): Promise<void> {
  try {
    await input.backend.validateAuth({ auth: input.auth });
    await input.backend.listFiles({ projectId: input.projectId, auth: input.auth });
  } catch (error) {
    throw blockForBackendError(error, "OLCX_E2E_PROJECT_ID");
  }
}

function blockForBackendError(error: unknown, protocolCategory: string): RealE2eBlockedError {
  if (isOlcxError(error)) {
    if (error.code === "BACKEND_AUTH_FAILED" || error.code === "PROJECT_AUTH_INVALID") {
      return new RealE2eBlockedError("OLCX_E2E_OVERLEAF_SESSION");
    }
    if (error.code === "BACKEND_NETWORK_ERROR") {
      return new RealE2eBlockedError("network/backend availability");
    }
    if (error.code === "BACKEND_PROTOCOL_ERROR") {
      return new RealE2eBlockedError(protocolCategory);
    }
  }

  return new RealE2eBlockedError("network/backend availability");
}

function createRealE2eAuth(config: RealE2eConfig, now: () => Date): ProjectAuth {
  return {
    schemaVersion: 1,
    sessionCookie: requireConfiguredValue(config.sessionCookie, "OLCX_E2E_OVERLEAF_SESSION"),
    updatedAt: now().toISOString(),
    source: "env",
    ...(config.accountLabel ? { accountLabel: config.accountLabel } : {}),
  };
}

function authArgs(config: RealE2eConfig): string[] {
  return [
    "auth",
    "--from-env",
    "OLCX_E2E_OVERLEAF_SESSION",
    ...(config.accountLabel ? ["--account", config.accountLabel] : []),
  ];
}

async function ensureRealE2eConfigIgnores(projectRoot: string): Promise<void> {
  const config = await readProjectConfig(projectRoot);
  const ignore = [...new Set([...config.sync.ignore, ...CONFIG_IGNORES])];
  await writeProjectConfig(projectRoot, {
    ...config,
    sync: { ...config.sync, ignore },
  });
}

async function writeGeneratedFile(projectRoot: string, path: string, bytes: Uint8Array): Promise<void> {
  const absolutePath = join(projectRoot, ...path.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, bytes);
}

async function verifyRemoteBytes(input: {
  backend: OverleafBackend;
  auth: ProjectAuth;
  projectId: string;
  path: string;
  expected: Uint8Array;
  timeoutMs: number;
  retryDelayMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  let lastError: unknown;

  do {
    try {
      const remoteFiles = await input.backend.listFiles({
        projectId: input.projectId,
        auth: input.auth,
      });
      if (!remoteFiles.some((file) => file.path === input.path)) {
        lastError = new Error("Remote sentinel is not listed yet.");
        if (Date.now() >= deadline) {
          break;
        }
        await sleep(Math.min(input.retryDelayMs, Math.max(0, deadline - Date.now())));
        continue;
      }

      const actual = await input.backend.downloadFile({
        projectId: input.projectId,
        auth: input.auth,
        path: input.path,
      });
      if (bytesEqual(actual, input.expected)) {
        return;
      }
      lastError = new Error("Remote bytes did not match the generated sentinel yet.");
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(input.retryDelayMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);

  void lastError;
  throw new RealE2eBlockedError("network/backend availability");
}

async function verifyPdf(path: string): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.byteLength <= 100 || !bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new RealE2eBlockedError("Provided Overleaf E2E project must compile successfully.");
  }
}

async function verifyFallbackOutcome(stdout: string, tempRepo: string, logger: RealE2eLogger): Promise<void> {
  if (stdout.includes("Status: fallback-success")) {
    if (!stdout.includes("Fallback: fast/draft")) {
      throw new Error("Real Overleaf E2E failed during fallback verification.");
    }
    await verifyPdf(join(tempRepo, "build", "overleaf", "main.pdf"));
    logger.logLine(formatRealE2eStep("fallback", "ok"));
    return;
  }

  if (stdout.includes("Status: success")) {
    await verifyPdf(join(tempRepo, "build", "overleaf", "main.pdf"));
    logger.logLine(formatRealE2eStep("fallback", FALLBACK_LIMITATION));
    return;
  }

  throw new Error("Real Overleaf E2E failed during fallback verification.");
}

async function verifyConflictSafety(input: {
  tempRepo: string;
  stderr: string;
  backend: OverleafBackend;
  auth: ProjectAuth;
  projectId: string;
  sentinelPath: string;
  localConflictText: string;
  remoteConflictBytes: Uint8Array;
  verificationTimeoutMs: number;
  verificationRetryDelayMs: number;
}): Promise<void> {
  if (!input.stderr.includes("Sync paused because") || !input.stderr.includes("both-modified")) {
    throw new Error("Real Overleaf E2E failed during conflict safety verification.");
  }

  const localBytes = await readFile(join(input.tempRepo, ...input.sentinelPath.split("/")));
  if (localBytes.toString("utf8") !== input.localConflictText) {
    throw new Error("Real Overleaf E2E failed during conflict local preservation verification.");
  }

  await verifyRemoteBytes({
    backend: input.backend,
    auth: input.auth,
    projectId: input.projectId,
    path: input.sentinelPath,
    expected: input.remoteConflictBytes,
    timeoutMs: input.verificationTimeoutMs,
    retryDelayMs: input.verificationRetryDelayMs,
  });
  await access(join(input.tempRepo, ".olcx", "state", "conflicts.json"));
}

async function deleteRemoteSentinelBestEffort(input: {
  backend: OverleafBackend;
  auth: ProjectAuth;
  projectId: string;
  path: string;
}): Promise<void> {
  try {
    await input.backend.deleteFile({
      projectId: input.projectId,
      auth: input.auth,
      path: input.path,
    });
  } catch {
    // Cleanup is best-effort; never print backend errors because they may include service details.
  }
}

function sentinelContent(runId: string): string {
  return `% olcx real e2e generated sentinel\n% run ${runId}\n% no paper content\n`;
}

function remoteConflictContent(runId: string): string {
  return `% olcx real e2e generated sentinel\n% run ${runId}\nremote conflict side\n`;
}

function localConflictContent(runId: string): string {
  return `% olcx real e2e generated sentinel\n% run ${runId}\nlocal conflict side\n`;
}

function createRunId(date: Date): string {
  return `${date.toISOString().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}`;
}

function requireConfiguredValue(value: string | undefined, key: string): string {
  if (!value) {
    throw new RealE2eBlockedError(key);
  }
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function createBoundedBackend(backend: OverleafBackend, timeoutMs: number): OverleafBackend {
  return {
    validateAuth: (input) => withBackendTimeout(() => backend.validateAuth(input), timeoutMs),
    listFiles: (input) => withBackendTimeout(() => backend.listFiles(input), timeoutMs),
    downloadFile: (input) => withBackendTimeout(() => backend.downloadFile(input), timeoutMs),
    uploadFile: (input) => withBackendTimeout(() => backend.uploadFile(input), timeoutMs),
    deleteFile: (input) => withBackendTimeout(() => backend.deleteFile(input), timeoutMs),
    compile: (input) => withBackendTimeout(() => backend.compile(input), timeoutMs),
    downloadPdf: (input) => withBackendTimeout(() => backend.downloadPdf(input), timeoutMs),
    ...(backend.beginFastCompile
      ? {
          beginFastCompile: (input) => withBackendTimeout(() => backend.beginFastCompile!(input), timeoutMs),
        }
      : {}),
  };
}

function createSentinelScopedBackend(backend: OverleafBackend, sentinelPath: string): OverleafBackend {
  return {
    validateAuth: (input) => backend.validateAuth(input),
    listFiles: async (input) => (await backend.listFiles(input)).filter((file) => file.path === sentinelPath),
    downloadFile: (input) => backend.downloadFile(input),
    uploadFile: (input) => backend.uploadFile(input),
    deleteFile: (input) => backend.deleteFile(input),
    compile: (input) => backend.compile(input),
    downloadPdf: (input) => backend.downloadPdf(input),
    ...(backend.beginFastCompile
      ? {
          beginFastCompile: (input) => backend.beginFastCompile!(input),
        }
      : {}),
  };
}

async function withStepTimeout<T>(runStep: () => Promise<T>, timeoutMs: number): Promise<T> {
  return withTimeout(runStep, timeoutMs, () => new RealE2eBlockedError("network/backend availability"));
}

async function withBackendTimeout<T>(runStep: () => Promise<T>, timeoutMs: number): Promise<T> {
  return withTimeout(runStep, timeoutMs, () =>
    createOlcxError({
      code: "BACKEND_NETWORK_ERROR",
      message: "Overleaf real E2E backend operation timed out.",
      hint: "Check network access to Overleaf and retry the real E2E command.",
    })
  );
}

async function withTimeout<T>(runStep: () => Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      runStep(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runManualRealE2e(input: RunManualRealE2eInput = {}): Promise<number> {
  const repoRoot = input.repoRoot ?? process.cwd();
  const processEnv = input.processEnv ?? process.env;
  const config = await loadRealE2eConfig({ repoRoot, processEnv });
  const logger = createRealE2eLogger({ config, writeOut: input.writeOut });

  if (!config.ready) {
    logger.logLine(`[real-e2e] ${config.skipMessage}\n`);
    return 0;
  }

  try {
    const runE2e = input.runRealOverleafE2e ?? runRealOverleafE2e;
    await runE2e({
      repoRoot,
      config,
      ...(input.writeOut ? { writeOut: input.writeOut } : {}),
    });
    return 0;
  } catch (error) {
    const category = error instanceof RealE2eBlockedError ? error.category : "unexpected runner failure";
    logger.logLine(formatRealE2eStep("blocked", category));
    return 1;
  }
}

export async function runManualRealE2eEntrypoint(input: RunManualRealE2eEntrypointInput = {}): Promise<void> {
  const exitCode = await runManualRealE2e(input);
  await (input.beforeExit ?? waitForOutputFlush)();
  const exit = input.exit ?? ((code: number) => process.exit(code));
  exit(exitCode);
}

function waitForOutputFlush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runManualRealE2eEntrypoint();
}
