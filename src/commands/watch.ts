import { type OverleafBackend, type OverleafBackendFactory } from "../backend/index.js";
import { EXIT_CODES, type ExitCode, isOlcxError, redactSensitive } from "../cli-behavior.js";
import { createWatchQueue } from "../watch/queue.js";
import { createChokidarWatchAdapter, createWatchIgnoredPredicate } from "../watch/watcher.js";
import {
  prepareWatchProject,
  runWatchCycle,
  type PreparedWatchProject,
  type WatchCycleInput,
  type WatchCycleResult,
} from "../watch/workflow.js";
import type { WatchAdapter, WatchCommandResult, WatchSignalRuntime } from "../watch/types.js";

export interface RunWatchCommandInput {
  cwd: string;
  debounceMs: number;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  watchAdapter?: WatchAdapter;
  signals?: WatchSignalRuntime;
  writeOut: (value: string) => void;
  writeErr: (value: string) => void;
  prepareProject?: (input: {
    cwd: string;
    env?: Record<string, string | undefined>;
    now?: () => Date;
  }) => Promise<PreparedWatchProject>;
  runCycle?: (input: WatchCycleInput) => Promise<WatchCycleResult>;
}

export async function runWatchCommand(input: RunWatchCommandInput): Promise<WatchCommandResult> {
  const prepare = input.prepareProject ?? prepareWatchProject;
  const cycle = input.runCycle ?? runWatchCycle;
  const adapter = input.watchAdapter ?? createChokidarWatchAdapter();
  const signals = input.signals ?? processSignals();
  const prepared = await prepare({ cwd: input.cwd, env: input.env, now: input.now });
  const ignored = createWatchIgnoredPredicate({
    projectRoot: prepared.projectRoot,
    userIgnorePatterns: prepared.config.sync.ignore,
  });
  let resolved = false;
  let resolveDone!: (result: WatchCommandResult) => void;
  const done = new Promise<WatchCommandResult>((resolve) => {
    resolveDone = resolve;
  });

  let lastExitCode: ExitCode = EXIT_CODES.SUCCESS;
  let paused = false;

  const queue = createWatchQueue({
    debounceMs: input.debounceMs,
    run: async () => {
      input.writeOut("Running: olcx sync\n");
      const result = await cycle({
        cwd: prepared.projectRoot,
        backend: input.backend,
        createBackend: input.createBackend,
        env: input.env,
        now: input.now,
      });
      input.writeOut(formatWatchCycleSuccess(result));
    },
    onFailure: async (error) => {
      paused = true;
      lastExitCode = isOlcxError(error) ? error.exitCode : EXIT_CODES.INTERNAL_ERROR;
      input.writeErr(formatWatchFailure(error));
    },
  });

  const handle = await adapter.watch({
    projectRoot: prepared.projectRoot,
    ignored,
    onChange: (event) => {
      queue.trigger(event);
    },
    onError: (error) => {
      queue.pause(error);
      paused = true;
      lastExitCode = EXIT_CODES.INTERNAL_ERROR;
      input.writeErr(formatWatchFailure(error));
    },
  });

  const cleanupCallbacks: Array<() => void> = [];
  async function shutdown(): Promise<void> {
    if (resolved) return;
    resolved = true;
    for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
    await queue.shutdown();
    await handle.close();
    input.writeOut("Stopped: olcx watch\n");
    const lastError = queue.status().lastError;
    resolveDone(lastError === undefined ? { exitCode: lastExitCode, paused } : { exitCode: lastExitCode, paused, lastError });
  }

  cleanupCallbacks.push(signals.on("SIGINT", shutdown));
  cleanupCallbacks.push(signals.on("SIGTERM", shutdown));

  input.writeOut(formatWatchStarted({ projectRoot: prepared.projectRoot, debounceMs: input.debounceMs }));
  return done;
}

export function formatWatchStarted(input: { projectRoot: string; debounceMs: number }): string {
  return redactSensitive(
    [
      "olcx watch",
      `Watching: ${input.projectRoot}`,
      `Debounce: ${input.debounceMs}ms`,
      "Next: edit local files; press Ctrl-C to stop.",
    ].join("\n") + "\n"
  );
}

export function formatWatchCycleSuccess(result: WatchCycleResult): string {
  return redactSensitive(
    [
      "Synced: olcx sync",
      `Compiled PDF: ${result.compile.pdfPath}`,
      `Bytes: ${result.compile.bytesWritten}`,
      "Waiting for changes.",
    ].join("\n") + "\n"
  );
}

export function formatWatchFailure(error: unknown): string {
  if (isOlcxError(error)) {
    const phase = readWatchPhase(error.details);
    return redactSensitive(
      [`Error: Watch paused after ${phase} failed: ${error.message}`, `Next: ${nextStepForFailure(error.code)}`].join(
        "\n"
      ) + "\n"
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected watch failure.";
  return redactSensitive(
    `Error: Watch paused after workflow failed: ${message}\nNext: stop olcx watch, inspect the error, then restart olcx watch.\n`
  );
}

function readWatchPhase(details: unknown): "sync" | "compile" | "workflow" {
  if (details && typeof details === "object" && (details as { watchPhase?: unknown }).watchPhase === "sync") return "sync";
  if (details && typeof details === "object" && (details as { watchPhase?: unknown }).watchPhase === "compile") {
    return "compile";
  }
  return "workflow";
}

function nextStepForFailure(code: string): string {
  if (code === "SYNC_CONFLICT" || code === "SYNC_UNSAFE_OPERATION") {
    return "review conflicts, run olcx sync --dry-run, run olcx sync after it is clean, then restart olcx watch.";
  }
  if (code === "COMPILE_FAILED" || code === "COMPILE_TIMEOUT") {
    return "run olcx compile, fix the compile issue, then restart olcx watch.";
  }
  return "fix the reported issue, then restart olcx watch.";
}

function processSignals(): WatchSignalRuntime {
  return {
    on(signal, listener) {
      const wrapped = () => {
        void listener();
      };
      process.once(signal, wrapped);
      return () => process.off(signal, wrapped);
    },
  };
}
