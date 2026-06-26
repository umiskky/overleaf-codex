#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import {
  EXIT_CODES,
  type ExitCode,
  formatCliFailure,
  isOlcxError,
  redactSensitive,
} from "./cli-behavior.js";
import {
  authenticateProject,
  createSessionCookiePrompt,
  formatAuthSuccess,
  type AuthCookiePrompt,
} from "./commands/auth.js";
import { formatCompileFailure, formatCompileSuccess, runCompileCommand } from "./commands/compile.js";
import { getDoctorOutput } from "./commands/doctor.js";
import {
  getEndpointStatusOutput,
  setEndpoint,
  testEndpoint,
} from "./commands/endpoint.js";
import { initProject } from "./commands/init.js";
import { getStatusOutput } from "./commands/status.js";
import { formatSyncConflictFailure, syncProject } from "./commands/sync.js";
import { formatWatchFailure, runWatchCommand } from "./commands/watch.js";
import { type OverleafBackend, type OverleafBackendFactory } from "./backend/index.js";
import { MAX_FAST_FALLBACK_ATTEMPTS } from "./config/types.js";
import type { FetchLike } from "./endpoint/overleafEndpoint.js";
import type { WatchAdapter, WatchSignalRuntime } from "./watch/types.js";

export const VERSION = "0.1.0";

export interface CliIo {
  writeOut: (value: string) => void;
  writeErr: (value: string) => void;
  setExitCode: (value: ExitCode) => void;
}

export interface CliRuntime {
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  now?: () => Date;
  promptCookie?: AuthCookiePrompt;
  nodeVersion?: string;
  backendAvailable?: boolean;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  endpointFetch?: FetchLike;
  endpointNowMs?: () => number;
  watchAdapter?: WatchAdapter;
  watchSignals?: WatchSignalRuntime;
}

const defaultIo: CliIo = {
  writeOut: (value) => process.stdout.write(value),
  writeErr: (value) => process.stderr.write(value),
  setExitCode: (value) => {
    process.exitCode = value;
  },
};

function initAction(io: CliIo, runtime: CliRuntime) {
  return async (options: { project: string; vscode?: boolean }) => {
    try {
      const result = await initProject({
        cwd: runtime.cwd?.() ?? process.cwd(),
        project: options.project,
        vscode: Boolean(options.vscode),
      });

      io.writeOut(
        [
          "Initialized olcx project binding.",
          `Project root: ${result.projectRoot}`,
          "Config: .olcx/config.json",
          `PDF path: ${result.pdfPath}`,
          `VS Code: ${result.vscodeChanged ? "updated" : "unchanged"}`,
        ].join("\n") + "\n"
      );
      io.setExitCode(EXIT_CODES.SUCCESS);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      io.writeErr(
        formatCliFailure({
          code: error.code,
          exitCode: error.exitCode,
          message: error.message,
          hint: error.hint ?? "Fix the command input and try again.",
          details: error.details,
        })
      );
      io.setExitCode(error.exitCode);
    }
  };
}

function authAction(io: CliIo, runtime: CliRuntime) {
  return async (options: { cookie?: string; fromEnv?: string; account?: string }) => {
    try {
      const result = await authenticateProject({
        cwd: runtime.cwd?.() ?? process.cwd(),
        cookie: options.cookie,
        fromEnv: options.fromEnv,
        account: options.account,
        env: runtime.env ?? process.env,
        stdinIsTTY: runtime.stdinIsTTY ?? Boolean(process.stdin.isTTY),
        now: runtime.now,
        promptCookie: runtime.promptCookie ?? createSessionCookiePrompt(),
      });

      io.writeOut(formatAuthSuccess(result));
      io.setExitCode(EXIT_CODES.SUCCESS);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      io.writeErr(
        formatCliFailure({
          code: error.code,
          exitCode: error.exitCode,
          message: error.message,
          hint: error.hint ?? "Fix the command input and try again.",
          details: error.details,
        })
      );
      io.setExitCode(error.exitCode);
    }
  };
}

function statusAction(io: CliIo, runtime: CliRuntime) {
  return async () => {
    const output = await getStatusOutput({ cwd: runtime.cwd?.() ?? process.cwd() });
    io.writeOut(output);
    io.setExitCode(EXIT_CODES.SUCCESS);
  };
}

function syncAction(io: CliIo, runtime: CliRuntime) {
  return async (options: { dryRun?: boolean }) => {
    try {
      const result = await syncProject({
        cwd: runtime.cwd?.() ?? process.cwd(),
        dryRun: Boolean(options.dryRun),
        backend: runtime.backend,
        createBackend: runtime.createBackend,
        env: runtime.env ?? process.env,
        now: runtime.now,
      });

      io.writeOut(result.output);
      io.setExitCode(EXIT_CODES.SUCCESS);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      if (error.code === "SYNC_CONFLICT") {
        io.writeErr(
          formatSyncConflictFailure({
            conflicts: readConflictDetails(error.details),
            dryRun: Boolean(options.dryRun),
            reportWritten:
              typeof error.details === "object" &&
              error.details !== null &&
              "reportPath" in error.details,
          })
        );
        io.setExitCode(error.exitCode);
        return;
      }

      io.writeErr(
        formatCliFailure({
          code: error.code,
          exitCode: error.exitCode,
          message: error.message,
          hint: error.hint ?? "Fix the sync issue and try again.",
          details: error.details,
        })
      );
      io.setExitCode(error.exitCode);
    }
  };
}

function endpointStatusAction(io: CliIo, runtime: CliRuntime) {
  return async () => {
    try {
      const output = await getEndpointStatusOutput({ cwd: runtime.cwd?.() ?? process.cwd() });
      io.writeOut(output);
      io.setExitCode(EXIT_CODES.SUCCESS);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      io.writeErr(
        formatCliFailure({
          code: error.code,
          exitCode: error.exitCode,
          message: error.message,
          hint: error.hint ?? "Run olcx init before managing endpoints.",
          details: error.details,
        })
      );
      io.setExitCode(error.exitCode);
    }
  };
}

function endpointSetAction(io: CliIo, runtime: CliRuntime) {
  return async (endpoint: string) => {
    try {
      const output = await setEndpoint({
        cwd: runtime.cwd?.() ?? process.cwd(),
        endpoint,
      });
      io.writeOut(output);
      io.setExitCode(EXIT_CODES.SUCCESS);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      io.writeErr(
        formatCliFailure({
          code: error.code,
          exitCode: error.exitCode,
          message: error.message,
          hint: error.hint ?? "Use endpoint alias www or cn.",
          details: error.details,
        })
      );
      io.setExitCode(error.exitCode);
    }
  };
}

function endpointTestAction(io: CliIo, runtime: CliRuntime) {
  return async (options: { timeout?: number; apply?: boolean }) => {
    try {
      const result = await testEndpoint({
        cwd: runtime.cwd?.() ?? process.cwd(),
        timeoutMs: options.timeout,
        apply: Boolean(options.apply),
        fetchImpl: runtime.endpointFetch,
        nowMs: runtime.endpointNowMs,
      });

      if (result.exitCode === EXIT_CODES.SUCCESS) {
        io.writeOut(result.output);
      } else {
        io.writeErr(result.output);
      }
      io.setExitCode(result.exitCode);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      io.writeErr(
        formatCliFailure({
          code: error.code,
          exitCode: error.exitCode,
          message: error.message,
          hint: error.hint ?? "Fix the endpoint command input and try again.",
          details: error.details,
        })
      );
      io.setExitCode(error.exitCode);
    }
  };
}

function parseFastFallbackAttempts(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_FAST_FALLBACK_ATTEMPTS) {
    throw new InvalidArgumentError(`fast fallback attempts must be an integer from 0 to ${MAX_FAST_FALLBACK_ATTEMPTS}`);
  }
  return parsed;
}

function parsePositiveMilliseconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("fast fallback timeout must be a positive integer in milliseconds");
  }
  return parsed;
}

function parsePositiveDebounce(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("debounce must be a positive integer in milliseconds");
  }
  return parsed;
}

function parseEndpointTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("endpoint timeout must be a positive integer in milliseconds");
  }
  return parsed;
}

function compileAction(io: CliIo, runtime: CliRuntime) {
  return async (options: {
    pdf?: string;
    disableFastFallback?: boolean;
    fastFallbackAttempts?: number;
    fastFallbackTimeout?: number;
  }) => {
    try {
      const result = await runCompileCommand({
        cwd: runtime.cwd?.() ?? process.cwd(),
        pdfPath: options.pdf,
        backend: runtime.backend,
        createBackend: runtime.createBackend,
        env: runtime.env ?? process.env,
        now: runtime.now,
        fastFallback: {
          enabled: options.disableFastFallback ? false : undefined,
          attempts: options.fastFallbackAttempts,
          timeoutMs: options.fastFallbackTimeout,
        },
      });

      io.writeOut(formatCompileSuccess(result));
      io.setExitCode(EXIT_CODES.SUCCESS);
    } catch (error) {
      if (!isOlcxError(error)) {
        throw error;
      }

      io.writeErr(formatCompileFailure(error));
      io.setExitCode(error.exitCode);
    }
  };
}

function doctorAction(io: CliIo, runtime: CliRuntime) {
  return async () => {
    const result = await getDoctorOutput({
      cwd: runtime.cwd?.() ?? process.cwd(),
      nodeVersion: runtime.nodeVersion,
      backendAvailable: runtime.backendAvailable,
    });

    if (result.exitCode === EXIT_CODES.SUCCESS) {
      io.writeOut(result.output);
    } else {
      io.writeErr(result.output);
    }
    io.setExitCode(result.exitCode);
  };
}

function watchAction(io: CliIo, runtime: CliRuntime) {
  return async (options: { debounce?: number }) => {
    try {
      const result = await runWatchCommand({
        cwd: runtime.cwd?.() ?? process.cwd(),
        debounceMs: options.debounce ?? 2500,
        backend: runtime.backend,
        createBackend: runtime.createBackend,
        env: runtime.env ?? process.env,
        now: runtime.now,
        watchAdapter: runtime.watchAdapter,
        signals: runtime.watchSignals,
        writeOut: io.writeOut,
        writeErr: io.writeErr,
      });
      io.setExitCode(result.exitCode);
    } catch (error) {
      io.writeErr(formatWatchFailure(error));
      io.setExitCode(isOlcxError(error) ? error.exitCode : EXIT_CODES.INTERNAL_ERROR);
    }
  };
}

function isCommanderError(error: unknown): error is CommanderError {
  return (
    error instanceof CommanderError ||
    (typeof error === "object" &&
      error !== null &&
      "exitCode" in error &&
      typeof (error as { exitCode?: unknown }).exitCode === "number")
  );
}

function enableExitOverride(command: Command): void {
  command.exitOverride();
  command.commands.forEach((child) => enableExitOverride(child));
}

export function buildCli(io: CliIo = defaultIo, runtime: CliRuntime = {}): Command {
  const program = new Command();

  program
    .name("olcx")
    .description("Bridge local Git, VS Code, and Codex workflows with Overleaf compilation.")
    .version(VERSION)
    .configureOutput({
      writeOut: io.writeOut,
      writeErr: io.writeErr,
      outputError: (message, write) => write(redactSensitive(message)),
    })
    .showHelpAfterError("Next: run the command with --help for usage.");

  program
    .command("auth")
    .description("Store project-local Overleaf authorization for the current paper repository.")
    .option("--cookie <value>", "Overleaf session cookie value")
    .option("--from-env <name>", "Read the session cookie from an environment variable")
    .option("--account <label>", "Optional account label shown in redacted local status")
    .action(authAction(io, runtime));

  program
    .command("init")
    .description("Bind the current paper repository to one Overleaf project.")
    .requiredOption("--project <url-or-id>", "Overleaf project URL or project id")
    .addOption(
      new Option(
        "--vscode",
        "Deprecated compatibility flag; VS Code settings and tasks are generated by default."
      ).hideHelp()
    )
    .action(initAction(io, runtime));

  const endpoint = program
    .command("endpoint")
    .description("Manage the Overleaf endpoint for this paper repository.");

  endpoint
    .command("status")
    .description("Show the configured Overleaf endpoint.")
    .action(endpointStatusAction(io, runtime));

  endpoint
    .command("test")
    .description("Probe www and cn Overleaf endpoints without changing remote projects.")
    .option("--timeout <ms>", "Probe timeout in milliseconds", parseEndpointTimeout, 5000)
    .option("--apply", "Write the fastest available endpoint to .olcx/config.json")
    .action(endpointTestAction(io, runtime));

  endpoint
    .command("set")
    .description("Set the Overleaf endpoint manually.")
    .argument("<endpoint>", "Endpoint alias: www or cn")
    .action(endpointSetAction(io, runtime));

  program
    .command("sync")
    .description("Synchronize local files and the bound Overleaf project without silent overwrites.")
    .option("--dry-run", "Show planned sync operations without changing files")
    .action(syncAction(io, runtime));

  program
    .command("compile")
    .description("Compile the bound Overleaf project and download the PDF artifact.")
    .option("--pdf <path>", "PDF output path")
    .option("--disable-fast-fallback", "Disable fast/draft fallback for this compile")
    .option("--fast-fallback-attempts <count>", "Fast/draft fallback attempt count, 0-3", parseFastFallbackAttempts)
    .option("--fast-fallback-timeout <ms>", "Timeout for each fast/draft fallback attempt in milliseconds", parsePositiveMilliseconds)
    .action(compileAction(io, runtime));

  program
    .command("watch")
    .description("Watch local source changes, debounce them, then sync and compile.")
    .option("--debounce <ms>", "Debounce window in milliseconds", parsePositiveDebounce, 2500)
    .action(watchAction(io, runtime));

  program
    .command("status")
    .description("Show binding, authorization, and sync state for the current paper repository.")
    .action(statusAction(io, runtime));

  program
    .command("doctor")
    .description("Check the local olcx environment and project configuration.")
    .action(doctorAction(io, runtime));

  return program;
}

export async function run(
  argv = process.argv,
  io: CliIo = defaultIo,
  runtime: CliRuntime = {}
): Promise<ExitCode> {
  let exitCode: ExitCode = EXIT_CODES.SUCCESS;
  const trackingIo: CliIo = {
    ...io,
    setExitCode: (value) => {
      exitCode = value;
      io.setExitCode(value);
    },
  };

  const program = buildCli(trackingIo, runtime);
  enableExitOverride(program);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isCommanderError(error)) {
      const commanderExitCode =
        error.exitCode === EXIT_CODES.SUCCESS ? EXIT_CODES.SUCCESS : EXIT_CODES.USER_INPUT_ERROR;
      trackingIo.setExitCode(commanderExitCode);
      return commanderExitCode;
    }

    trackingIo.writeErr(
      formatCliFailure({
        code: "INTERNAL_ERROR",
        exitCode: EXIT_CODES.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : "Unexpected internal error.",
        hint: "Run the command again with --help or report this olcx error with the command you ran.",
      })
    );
    trackingIo.setExitCode(EXIT_CODES.INTERNAL_ERROR);
    return EXIT_CODES.INTERNAL_ERROR;
  }

  return exitCode;
}

function readConflictDetails(details: unknown): { path: string; reason: string }[] {
  if (!details || typeof details !== "object" || !("conflicts" in details)) {
    return [];
  }

  const conflicts = (details as { conflicts?: unknown }).conflicts;
  if (!Array.isArray(conflicts)) {
    return [];
  }

  return conflicts
    .filter(
      (conflict): conflict is { path: string; reason: string } =>
        typeof conflict === "object" &&
        conflict !== null &&
        typeof (conflict as { path?: unknown }).path === "string" &&
        typeof (conflict as { reason?: unknown }).reason === "string"
    )
    .map((conflict) => ({
      path: conflict.path,
      reason: conflict.reason,
    }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run();
}
