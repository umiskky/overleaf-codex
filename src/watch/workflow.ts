import { resolveProjectAuth } from "../auth/projectAuth.js";
import type { OverleafBackend, OverleafBackendFactory } from "../backend/index.js";
import { runCompileCommand, type RunCompileCommandInput } from "../commands/compile.js";
import { syncProject, type SyncProjectOptions, type SyncProjectResult } from "../commands/sync.js";
import { readProjectConfig } from "../config/projectConfig.js";
import { findProjectRoot } from "../config/projectRoot.js";
import type { ProjectConfig } from "../config/types.js";
import { createOlcxError, isOlcxError, type OlcxError } from "../errors.js";

export type WatchPhase = "sync" | "compile";

export interface PreparedWatchProject {
  projectRoot: string;
  config: ProjectConfig;
}

export interface WatchCycleInput {
  cwd: string;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  syncProject?: (options: SyncProjectOptions) => Promise<SyncProjectResult>;
  runCompileCommand?: (input: RunCompileCommandInput) => Promise<Awaited<ReturnType<typeof runCompileCommand>>>;
}

export interface WatchCycleResult {
  sync: SyncProjectResult;
  compile: Awaited<ReturnType<typeof runCompileCommand>>;
}

export async function prepareWatchProject(input: {
  cwd: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}): Promise<PreparedWatchProject> {
  const projectRoot = await findProjectRoot(input.cwd);
  const config = await readProjectConfig(projectRoot);
  await resolveProjectAuth(projectRoot, { env: input.env, now: input.now });
  return { projectRoot, config };
}

export async function runWatchCycle(input: WatchCycleInput): Promise<WatchCycleResult> {
  const runSync = input.syncProject ?? syncProject;
  const runCompile = input.runCompileCommand ?? runCompileCommand;

  let sync: SyncProjectResult;
  try {
    sync = await runSync({
      cwd: input.cwd,
      dryRun: false,
      backend: input.backend,
      createBackend: input.createBackend,
      env: input.env,
      now: input.now,
    });
  } catch (error) {
    throw tagWatchFailure(error, "sync");
  }

  try {
    const compile = await runCompile({
      cwd: input.cwd,
      backend: input.backend,
      createBackend: input.createBackend,
      env: input.env,
      now: input.now,
    });
    return { sync, compile };
  } catch (error) {
    throw tagWatchFailure(error, "compile");
  }
}

export function tagWatchFailure(error: unknown, phase: WatchPhase): OlcxError {
  if (isOlcxError(error)) {
    return createOlcxError({
      code: error.code,
      message: error.message,
      hint: error.hint,
      details: { ...(error.details ?? {}), watchPhase: phase },
      cause: error,
    });
  }

  return createOlcxError({
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unexpected watch workflow failure.",
    hint: "Stop olcx watch, inspect the error, and retry after fixing the issue.",
    details: { watchPhase: phase },
    cause: error,
  });
}
