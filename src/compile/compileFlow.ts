import { resolveProjectAuth } from "../auth/projectAuth.js";
import {
  createOlcliOverleafBackend,
  type BackendFastCompileSession,
  type BackendCompileInput,
  type BackendProjectInput,
  type CompileLogEntry,
  type CompileResult,
  type OverleafBackend,
  type OverleafBackendFactory,
} from "../backend/index.js";
import { readProjectConfig } from "../config/projectConfig.js";
import { findProjectRoot } from "../config/projectRoot.js";
import { MAX_FAST_FALLBACK_ATTEMPTS, type ProjectConfig } from "../config/types.js";
import { createOlcxError, isOlcxError, type OlcxError } from "../errors.js";
import { resolvePdfOutputTarget, writePdfOutput } from "./pdfOutput.js";

export interface CompileFastFallbackOverrides {
  enabled?: boolean;
  attempts?: number;
  timeoutMs?: number;
}

export interface CompileProjectInput {
  cwd: string;
  pdfPath?: string;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  fastFallback?: CompileFastFallbackOverrides;
}

export interface CompileProjectResult {
  projectRoot: string;
  pdfPath: string;
  absolutePdfPath: string;
  status: "success" | "fallback-success";
  warnings: string[];
  logs: CompileLogEntry[];
  elapsedMs: number;
  fallbackUsed: boolean;
  bytesWritten: number;
}

export async function compileProject(input: CompileProjectInput): Promise<CompileProjectResult> {
  const projectRoot = await findProjectRoot(input.cwd);
  const config = await readProjectConfig(projectRoot);
  const auth = await resolveProjectAuth(projectRoot, {
    env: input.env,
    now: input.now,
  });
  const outputTarget = resolvePdfOutputTarget(projectRoot, input.pdfPath ?? config.pdfPath);
  const backend =
    input.backend ??
    (input.createBackend ?? createOlcliOverleafBackend)({ baseUrl: config.overleaf.baseUrl });
  const fastFallback = resolveFastFallbackConfig(config.compile.fastFallback, input.fastFallback);
  const compileInput: BackendCompileInput = {
    projectId: config.projectId,
    auth,
    timeoutMs: config.compile.timeoutMs,
    rootDocument: config.rootDocument,
    fastMode: undefined,
  };
  const normal = await runCompilePhase(backend, compileInput, config.compile.timeoutMs);

  if (normal.ok) {
    return writeSuccessfulCompile({ projectRoot, outputTarget, backend, compileInput, compile: normal.compile });
  }

  if (!isRecoverableCompileFailure(normal) || !fastFallback.enabled || fastFallback.attempts === 0) {
    throw normal.error;
  }

  const fallback = await runFastFallback({
    projectRoot,
    outputTarget,
    backend,
    compileInput,
    normal,
    attempts: fastFallback.attempts,
    timeoutMs: fastFallback.timeoutMs,
  });

  return fallback;
}

type SuccessfulCompileResult = CompileResult & { status: "success" | "fallback-success" };

interface WriteSuccessfulCompileInput {
  projectRoot: string;
  outputTarget: ReturnType<typeof resolvePdfOutputTarget>;
  backend: OverleafBackend;
  compileInput: BackendProjectInput;
  compile: SuccessfulCompileResult;
}

async function writeSuccessfulCompile(input: WriteSuccessfulCompileInput): Promise<CompileProjectResult> {
  const { projectRoot, outputTarget, backend, compileInput, compile } = input;
  const pdfBytes = compile.pdfBytes ?? (await downloadPdfAfterSuccessfulCompile(backend, compileInput, compile));
  const written = await writePdfOutput(outputTarget, pdfBytes);

  return {
    projectRoot,
    pdfPath: written.relativePath,
    absolutePdfPath: written.absolutePath,
    status: compile.status,
    warnings: compile.warnings,
    logs: compile.logs,
    elapsedMs: compile.elapsedMs,
    fallbackUsed: compile.fallbackUsed,
    bytesWritten: written.bytesWritten,
  };
}

interface RunFastFallbackInput {
  projectRoot: string;
  outputTarget: ReturnType<typeof resolvePdfOutputTarget>;
  backend: OverleafBackend;
  compileInput: BackendCompileInput;
  normal: CompilePhaseOutcome;
  attempts: number;
  timeoutMs: number;
}

async function runFastFallback(input: RunFastFallbackInput): Promise<CompileProjectResult> {
  let session: BackendFastCompileSession | undefined;
  let restoreStatus = "restore-not-started";
  let restoreWarning: string | undefined;
  let fallback: CompilePhaseOutcome | undefined;

  try {
    session = await beginFastCompileSession(input.backend, {
      projectId: input.compileInput.projectId,
      auth: input.compileInput.auth,
    });

    for (let attempt = 0; attempt < input.attempts; attempt += 1) {
      const fallbackInput: BackendCompileInput = {
        ...input.compileInput,
        ...session.compileOptions,
        timeoutMs: input.timeoutMs,
      };
      fallback = await runCompilePhase(input.backend, fallbackInput, input.timeoutMs);
      if (fallback.ok) {
        break;
      }
    }
  } catch (error) {
    if (!isOlcxError(error)) {
      throw error;
    }
    fallback = { ok: false, error };
  } finally {
    if (session) {
      try {
        const restore = await session.restore();
        restoreStatus = restore.status;
        restoreWarning = restore.warning;
      } catch (error) {
        restoreStatus = "restore-failed";
        restoreWarning = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (fallback?.ok) {
    const warnings = [...fallback.compile.warnings];
    if (restoreWarning) {
      warnings.push(`Fast/draft compile settings restore warning: ${restoreWarning}`);
    }
    return writeSuccessfulCompile({
      projectRoot: input.projectRoot,
      outputTarget: input.outputTarget,
      backend: input.backend,
      compileInput: input.compileInput,
      compile: { ...fallback.compile, warnings },
    });
  }

  throw createFallbackFailure({
    normal: input.normal,
    fallback,
    restoreStatus,
    restoreWarning,
  });
}

type CompilePhaseOutcome =
  | { ok: true; compile: SuccessfulCompileResult }
  | { ok: false; error: OlcxError; compile?: CompileResult };

async function runCompilePhase(
  backend: OverleafBackend,
  input: BackendCompileInput,
  timeoutMs: number
): Promise<CompilePhaseOutcome> {
  try {
    const compile = await runCompileWithTimeout(() => backend.compile(input), timeoutMs);
    if (isSuccessfulCompile(compile)) {
      return { ok: true, compile };
    }
    return { ok: false, error: createCompileFailure(compile), compile };
  } catch (error) {
    if (isOlcxError(error)) {
      return { ok: false, error };
    }
    throw error;
  }
}

function isSuccessfulCompile(compile: CompileResult): compile is SuccessfulCompileResult {
  return compile.status === "success" || compile.status === "fallback-success";
}

const RECOVERABLE_COMPILE_FAILURE_PATTERN = /timeout|timed out|compile timeout|time limit|upgrade required/i;

function isRecoverableCompileFailure(outcome: CompilePhaseOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.error.code === "COMPILE_TIMEOUT") return true;
  if (outcome.compile?.status === "timeout") return true;
  const haystack = [
    outcome.error.message,
    outcome.error.hint,
    ...summarizeCompileLogs(outcome.compile?.logs ?? []),
    ...Object.values(outcome.error.details ?? {}).map((value) => (typeof value === "string" ? value : "")),
  ].join("\n");
  return RECOVERABLE_COMPILE_FAILURE_PATTERN.test(haystack);
}

function resolveFastFallbackConfig(
  config: ProjectConfig["compile"]["fastFallback"],
  overrides: CompileFastFallbackOverrides | undefined
) {
  const effective = {
    enabled: overrides?.enabled ?? config.enabled,
    attempts: overrides?.attempts ?? config.attempts,
    timeoutMs: overrides?.timeoutMs ?? config.timeoutMs,
  };

  if (!Number.isInteger(effective.attempts) || effective.attempts < 0 || effective.attempts > MAX_FAST_FALLBACK_ATTEMPTS) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: `Fast fallback attempts must be an integer from 0 to ${MAX_FAST_FALLBACK_ATTEMPTS}.`,
      hint: "Use --fast-fallback-attempts with a value from 0 through 3.",
    });
  }
  if (!Number.isInteger(effective.timeoutMs) || effective.timeoutMs <= 0) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: "Fast fallback timeout must be a positive integer in milliseconds.",
      hint: "Use --fast-fallback-timeout with a positive millisecond value.",
    });
  }

  return effective;
}

function defaultFastCompileSession(): BackendFastCompileSession {
  return {
    strategy: "request-draft",
    compileOptions: { fastMode: true },
    async restore() {
      return { status: "restore-not-needed" };
    },
  };
}

async function beginFastCompileSession(backend: OverleafBackend, input: BackendProjectInput) {
  return backend.beginFastCompile ? backend.beginFastCompile(input) : defaultFastCompileSession();
}

function summarizeFailure(error: OlcxError, compile?: CompileResult) {
  return {
    code: error.code,
    message: error.message,
    logSummary: summarizeCompileLogs(compile?.logs ?? []),
  };
}

function createFallbackFailure(input: {
  normal: CompilePhaseOutcome;
  fallback: CompilePhaseOutcome | undefined;
  restoreStatus: string;
  restoreWarning?: string;
}) {
  return createOlcxError({
    code: "COMPILE_FAILED",
    message: "Overleaf compile failed and fast/draft fallback also failed.",
    hint: "Inspect the normal compile logs and fallback compile logs, then retry olcx compile.",
    details: {
      normalFailure: input.normal.ok ? undefined : summarizeFailure(input.normal.error, input.normal.compile),
      fallbackFailure:
        input.fallback && !input.fallback.ok ? summarizeFailure(input.fallback.error, input.fallback.compile) : undefined,
      restoreStatus: input.restoreStatus,
      restoreWarning: input.restoreWarning,
      logSummary: input.fallback && !input.fallback.ok ? summarizeCompileLogs(input.fallback.compile?.logs ?? []) : [],
    },
  });
}

export async function runCompileWithTimeout(
  run: () => Promise<CompileResult>,
  timeoutMs: number
): Promise<CompileResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run(),
      new Promise<CompileResult>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            createOlcxError({
              code: "COMPILE_TIMEOUT",
              message: `Overleaf compile timed out after ${timeoutMs}ms.`,
              hint: "Increase compile.timeoutMs in .olcx/config.json or inspect the project on Overleaf.",
              details: { timeoutMs },
            })
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function createCompileFailure(compile: CompileResult) {
  const code = compile.status === "timeout" ? "COMPILE_TIMEOUT" : "COMPILE_FAILED";
  const primaryLog = compile.logs.find((log) => log.level === "error") ?? compile.logs[0];
  const fallbackMessage = compile.error?.message ?? (compile.status === "timeout" ? "Compile timed out." : "Compile failed.");
  const primaryMessage = primaryLog?.message ?? fallbackMessage;
  const message =
    compile.status === "timeout"
      ? `Overleaf compile timed out: ${primaryMessage}`
      : `Overleaf compile failed: ${primaryMessage}`;

  return createOlcxError({
    code,
    message,
    hint:
      compile.status === "timeout"
        ? "Increase compile.timeoutMs in .olcx/config.json or inspect the project on Overleaf."
        : "Inspect the Overleaf compile logs before retrying.",
    details: {
      status: compile.status,
      logs: compile.logs,
      warnings: compile.warnings,
      elapsedMs: compile.elapsedMs,
      fallbackUsed: compile.fallbackUsed,
      logSummary: summarizeCompileLogs(compile.logs),
    },
    cause: compile.error,
  });
}

export async function downloadPdfAfterSuccessfulCompile(
  backend: OverleafBackend,
  input: BackendProjectInput,
  compile: CompileResult
): Promise<Uint8Array> {
  try {
    return await backend.downloadPdf({
      projectId: input.projectId,
      auth: input.auth,
    });
  } catch (error) {
    if (isOlcxError(error)) {
      throw error;
    }

    throw createOlcxError({
      code: "COMPILE_FAILED",
      message: "Compiled PDF could not be downloaded after a successful Overleaf compile.",
      hint: "Retry olcx compile; if it repeats, inspect the Overleaf compile output in the browser.",
      details: {
        operation: "downloadPdf",
        status: compile.status,
        logs: compile.logs,
        warnings: compile.warnings,
        logSummary: summarizeCompileLogs(compile.logs),
        causeCode: isOlcxError(error) ? error.code : "unknown",
      },
    });
  }
}

export function summarizeCompileLogs(logs: CompileLogEntry[], limit = 8): string[] {
  return logs.slice(0, limit).map((log) => {
    const location = [log.file, log.line].filter((entry) => entry !== undefined).join(":");
    return [log.level, location, log.message].filter((entry) => entry !== undefined && entry !== "").join(" ");
  });
}
