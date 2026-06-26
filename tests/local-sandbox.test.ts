import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProjectAuth } from "../src/auth/projectAuth";
import type { ProjectAuth } from "../src/auth/types";
import type { OverleafBackend } from "../src/backend";
import { EXIT_CODES } from "../src/cli-behavior";
import { run, type CliIo, type CliRuntime } from "../src/cli";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";
import { sha256Hex } from "../src/sync/plan";
import {
  getConflictReportPath,
  getSyncStatePath,
  readSyncState,
  writeSyncState,
} from "../src/sync/state";
import type { SyncStateFile } from "../src/sync/types";
import type {
  WatchAdapter,
  WatchAdapterInput,
  WatchChangeEvent,
  WatchHandle,
  WatchSignalName,
  WatchSignalRuntime,
} from "../src/watch/types";

const PROJECT_ID = "0123456789abcdef01234567";
const PROJECT_URL = `https://www.overleaf.com/project/${PROJECT_ID}`;
const FAKE_SESSION_COOKIE = "session=<fake-local-sandbox-cookie>";
const ACCOUNT_LABEL = "writer@example.test";
const NOW = "2026-06-25T08:00:00.000Z";
const LATER = "2026-06-25T09:00:00.000Z";
const WATCH_TEXT = "Updated intro from watch.\n";
const FAKE_PDF_BYTES = Buffer.from("%PDF-1.4\n% fake local sandbox pdf\n", "utf8");

const AUTH_FOR_BACKEND: ProjectAuth = {
  schemaVersion: 1,
  accountLabel: ACCOUNT_LABEL,
  sessionCookie: FAKE_SESSION_COOKIE,
  updatedAt: NOW,
  source: "env",
};

const tempRoots = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

function fixedNow(): Date {
  return new Date(NOW);
}

function laterNow(): Date {
  return new Date(LATER);
}

function createIo() {
  let exitCode = EXIT_CODES.SUCCESS;
  let stdout = "";
  let stderr = "";

  const io: CliIo = {
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
    setExitCode: (value) => {
      exitCode = value;
    },
  };

  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
    exitCode: () => exitCode,
  };
}

async function runCli(
  projectRoot: string,
  args: string[],
  runtime: Partial<CliRuntime> = {}
): Promise<{ exitCode: number; capturedExitCode: number; stdout: string; stderr: string }> {
  const capture = createIo();
  const exitCode = await run(["node", "olcx", ...args], capture.io, {
    cwd: () => projectRoot,
    env: {},
    stdinIsTTY: false,
    now: fixedNow,
    ...runtime,
  });

  return {
    exitCode,
    capturedExitCode: capture.exitCode(),
    stdout: capture.stdout(),
    stderr: capture.stderr(),
  };
}

async function withSandboxPaperRepo<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-local-sandbox-test-"));
  tempRoots.add(projectRoot);

  try {
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, ".gitignore"), "# existing paper repo rules\nprivate-notes.tex\n", "utf8");
    await writeFixture(
      projectRoot,
      "main.tex",
      "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n"
    );
    await writeFixture(projectRoot, "sections/intro.tex", "Hello from the local sandbox.\n");
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    tempRoots.delete(projectRoot);
  }
}

async function writeFixture(projectRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = join(projectRoot, ...path.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function readRemoteText(backend: OverleafBackend, path: string): Promise<string> {
  const bytes = await backend.downloadFile({ projectId: PROJECT_ID, auth: AUTH_FOR_BACKEND, path });
  return Buffer.from(bytes).toString("utf8");
}

function baseSyncState(files: Record<string, string>): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: NOW,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          path,
          contentHash: sha256Hex(content),
          size: Buffer.byteLength(content),
          localModifiedAt: NOW,
          remoteModifiedAt: NOW,
          remoteId: `remote-${path}`,
          remoteRevision: `rev-${path}`,
          syncedAt: NOW,
        },
      ])
    ),
  };
}

function assertNoSensitiveOutput(output: string): void {
  expect(output).not.toContain(PROJECT_ID);
  expect(output).not.toContain(PROJECT_URL);
  expect(output).not.toContain(FAKE_SESSION_COOKIE);
  expect(output).not.toContain(ACCOUNT_LABEL);
}

class ControlledWatchAdapter implements WatchAdapter {
  input?: WatchAdapterInput;
  closed = false;

  watch(input: WatchAdapterInput): WatchHandle {
    this.input = input;
    return {
      close: async () => {
        this.closed = true;
      },
    };
  }

  emit(event: WatchChangeEvent): void {
    if (!this.input) throw new Error("watcher was not started");
    if (!this.input.ignored(event.path)) {
      this.input.onChange(event);
    }
  }
}

class ManualSignals implements WatchSignalRuntime {
  private readonly listeners = new Map<WatchSignalName, Set<() => void | Promise<void>>>();

  on(signal: WatchSignalName, listener: () => void | Promise<void>): () => void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void | Promise<void>>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
    return () => listeners.delete(listener);
  }

  async emit(signal: WatchSignalName): Promise<void> {
    const listeners = [...(this.listeners.get(signal) ?? [])];
    await Promise.all(listeners.map((listener) => listener()));
  }

  count(signal: WatchSignalName): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function withBackendCounters(backend: OverleafBackend): {
  backend: OverleafBackend;
  counts: { listFiles: number; compile: number };
} {
  const counts = { listFiles: 0, compile: 0 };
  const countedBackend: OverleafBackend = {
    validateAuth: backend.validateAuth.bind(backend),
    listFiles: async (input) => {
      counts.listFiles += 1;
      return backend.listFiles(input);
    },
    downloadFile: backend.downloadFile.bind(backend),
    uploadFile: backend.uploadFile.bind(backend),
    deleteFile: backend.deleteFile.bind(backend),
    compile: async (input) => {
      counts.compile += 1;
      return backend.compile(input);
    },
    beginFastCompile: backend.beginFastCompile?.bind(backend),
    downloadPdf: backend.downloadPdf.bind(backend),
  };

  return { backend: countedBackend, counts };
}

describe("local sandbox CLI regression", () => {
  it("creates an isolated paper repo fixture", async () => {
    await withSandboxPaperRepo(async (projectRoot) => {
      const result = await runCli(projectRoot, ["status"]);

      expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(result.capturedExitCode).toBe(EXIT_CODES.SUCCESS);
      expect(result.stdout).toContain("olcx status");
      expect(result.stdout).toContain("Project binding: missing");
      expect(result.stdout).toContain("Auth: missing");
      expect(result.stderr).toBe("");
      assertNoSensitiveOutput(result.stdout);
    });
  });

  it("runs init, auth, status, sync, compile, and watch through the public CLI", async () => {
    await withSandboxPaperRepo(async (projectRoot) => {
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: PROJECT_ID, pdfBytes: FAKE_PDF_BYTES }],
      });

      const init = await runCli(projectRoot, ["init", "--project", PROJECT_URL]);
      expect(init.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(init.capturedExitCode).toBe(EXIT_CODES.SUCCESS);
      expect(init.stderr).toBe("");
      expect(init.stdout).toContain("Initialized olcx project binding.");
      expect(init.stdout).toContain("Config: .olcx/config.json");
      expect(init.stdout).toContain("PDF path: build/overleaf/main.pdf");
      assertNoSensitiveOutput(init.stdout);

      const config = JSON.parse(await readFile(join(projectRoot, ".olcx", "config.json"), "utf8"));
      expect(config).toMatchObject({
        schemaVersion: 1,
        projectId: PROJECT_ID,
        projectUrl: `https://www.overleaf.com/project/${PROJECT_ID}`,
        rootDocument: "main.tex",
        pdfPath: "build/overleaf/main.pdf",
      });
      const gitignore = await readFile(join(projectRoot, ".gitignore"), "utf8");
      expect(gitignore).toContain("private-notes.tex");
      expect(gitignore).toContain(".olcx/auth.local.json");
      expect(gitignore).toContain(".olcx/*.local.json");
      expect(gitignore).toContain(".olcx/*.secret.json");
      expect(gitignore).toContain("build/overleaf/");

      const auth = await runCli(
        projectRoot,
        ["auth", "--from-env", "OLCX_OVERLEAF_SESSION", "--account", ACCOUNT_LABEL],
        { env: { OLCX_OVERLEAF_SESSION: FAKE_SESSION_COOKIE }, stdinIsTTY: false, now: fixedNow }
      );
      expect(auth.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(auth.capturedExitCode).toBe(EXIT_CODES.SUCCESS);
      expect(auth.stderr).toBe("");
      expect(auth.stdout).toContain("Stored project-local Overleaf auth.");
      expect(auth.stdout).toContain("Account: <redacted-account>");
      expect(auth.stdout).toContain("Next: olcx status");
      assertNoSensitiveOutput(auth.stdout);
      await expect(readProjectAuth(projectRoot)).resolves.toMatchObject({
        sessionCookie: FAKE_SESSION_COOKIE,
        accountLabel: ACCOUNT_LABEL,
        source: "env",
        updatedAt: NOW,
      });

      const status = await runCli(projectRoot, ["status"]);
      expect(status.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(status.stderr).toBe("");
      expect(status.stdout).toContain("olcx status");
      expect(status.stdout).toContain("Project binding: configured");
      expect(status.stdout).toContain("Project id: present");
      expect(status.stdout).toContain("Auth: present");
      expect(status.stdout).toContain("Account: <redacted-account>");
      assertNoSensitiveOutput(status.stdout);

      const dryRun = await runCli(projectRoot, ["sync", "--dry-run"], {
        backend,
        env: {},
        now: laterNow,
      });
      expect(dryRun.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(dryRun.stderr).toBe("");
      expect(dryRun.stdout).toContain("olcx sync --dry-run");
      expect(dryRun.stdout).toContain("Uploads:");
      expect(dryRun.stdout).toContain("- main.tex");
      expect(dryRun.stdout).toContain("- sections/intro.tex");
      expect(dryRun.stdout).toContain("No files changed.");
      assertNoSensitiveOutput(dryRun.stdout);
      await expect(readFile(getSyncStatePath(projectRoot), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const sync = await runCli(projectRoot, ["sync"], {
        backend,
        env: {},
        now: laterNow,
      });
      expect(sync.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(sync.capturedExitCode).toBe(EXIT_CODES.SUCCESS);
      expect(sync.stderr).toBe("");
      expect(sync.stdout).toContain("olcx sync");
      expect(sync.stdout).toContain("Uploaded:");
      expect(sync.stdout).toContain("- main.tex");
      expect(sync.stdout).toContain("- sections/intro.tex");
      expect(sync.stdout).toContain("State: .olcx/state/sync.json");
      expect(sync.stdout).toContain("Next: olcx compile");
      assertNoSensitiveOutput(sync.stdout);
      await expect(readRemoteText(backend, "main.tex")).resolves.toContain("\\documentclass{article}");
      await expect(readRemoteText(backend, "sections/intro.tex")).resolves.toBe("Hello from the local sandbox.\n");
      const syncState = await readSyncState(projectRoot);
      expect(syncState.files["main.tex"].contentHash).toBe(
        sha256Hex("\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n")
      );

      const compile = await runCli(projectRoot, ["compile", "--disable-fast-fallback"], {
        backend,
        env: {},
        now: laterNow,
      });
      expect(compile.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(compile.capturedExitCode).toBe(EXIT_CODES.SUCCESS);
      expect(compile.stderr).toBe("");
      expect(compile.stdout).toContain("olcx compile");
      expect(compile.stdout).toContain("Status: success");
      expect(compile.stdout).toContain("PDF: build/overleaf/main.pdf");
      expect(compile.stdout).toContain("Next: open build/overleaf/main.pdf");
      assertNoSensitiveOutput(compile.stdout);
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake local sandbox pdf\n"
      );

      vi.useFakeTimers();
      const watcher = new ControlledWatchAdapter();
      const signals = new ManualSignals();
      const capture = createIo();
      const counted = withBackendCounters(backend);
      const watchSession = run(["node", "olcx", "watch", "--debounce", "10"], capture.io, {
        cwd: () => projectRoot,
        env: {},
        backend: counted.backend,
        watchAdapter: watcher,
        watchSignals: signals,
        now: laterNow,
      });

      await vi.waitFor(() => expect(watcher.input).toBeDefined());
      await writeFixture(projectRoot, "sections/intro.tex", WATCH_TEXT);
      watcher.emit({ event: "change", path: "sections/intro.tex" });
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(async () => {
        await expect(readRemoteText(backend, "sections/intro.tex")).resolves.toBe(WATCH_TEXT);
      });
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).resolves.toContain("%PDF-1.4");
      expect(capture.stdout()).toContain("olcx watch");
      expect(capture.stdout()).toContain("Running: olcx sync");
      expect(capture.stdout()).toContain("Compiled PDF: build/overleaf/main.pdf");
      expect(capture.stderr()).toBe("");
      assertNoSensitiveOutput(capture.stdout());

      watcher.emit({ event: "change", path: "build/overleaf/main.pdf" });
      await vi.advanceTimersByTimeAsync(50);
      expect(counted.counts.compile).toBe(1);

      await signals.emit("SIGINT");
      await expect(watchSession).resolves.toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stdout()).toContain("Stopped: olcx watch");
      expect(watcher.closed).toBe(true);
      expect(signals.count("SIGINT")).toBe(0);
    });
  });

  it("reports missing config and missing auth through CLI exit codes", async () => {
    await withSandboxPaperRepo(async (projectRoot) => {
      const backend = createFakeOverleafBackend({ projects: [{ projectId: PROJECT_ID }] });

      const status = await runCli(projectRoot, ["status"]);
      expect(status.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(status.stdout).toContain("Project binding: missing");
      expect(status.stdout).toContain("Auth: missing");
      expect(status.stderr).toBe("");

      const syncMissingConfig = await runCli(projectRoot, ["sync"], { backend, env: {} });
      expect(syncMissingConfig.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(syncMissingConfig.capturedExitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(syncMissingConfig.stdout).toBe("");
      expect(syncMissingConfig.stderr).toContain("Project config was not found.");
      assertNoSensitiveOutput(syncMissingConfig.stderr);

      const compileMissingConfig = await runCli(projectRoot, ["compile"], { backend, env: {} });
      expect(compileMissingConfig.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(compileMissingConfig.capturedExitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(compileMissingConfig.stdout).toBe("");
      expect(compileMissingConfig.stderr).toContain("Project config was not found.");
      assertNoSensitiveOutput(compileMissingConfig.stderr);
    });

    await withSandboxPaperRepo(async (projectRoot) => {
      const backend = createFakeOverleafBackend({ projects: [{ projectId: PROJECT_ID }] });
      const init = await runCli(projectRoot, ["init", "--project", PROJECT_URL]);
      expect(init.exitCode).toBe(EXIT_CODES.SUCCESS);

      const syncMissingAuth = await runCli(projectRoot, ["sync"], { backend, env: {} });
      expect(syncMissingAuth.exitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(syncMissingAuth.capturedExitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(syncMissingAuth.stdout).toBe("");
      expect(syncMissingAuth.stderr).toContain("Project auth was not found.");
      assertNoSensitiveOutput(syncMissingAuth.stderr);

      const compileMissingAuth = await runCli(projectRoot, ["compile"], { backend, env: {} });
      expect(compileMissingAuth.exitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(compileMissingAuth.capturedExitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(compileMissingAuth.stdout).toBe("");
      expect(compileMissingAuth.stderr).toContain("Project auth was not found.");
      assertNoSensitiveOutput(compileMissingAuth.stderr);
    });
  });

  it("pauses sync on conflicts without overwriting local or remote changes", async () => {
    await withSandboxPaperRepo(async (projectRoot) => {
      const init = await runCli(projectRoot, ["init", "--project", PROJECT_URL]);
      expect(init.exitCode).toBe(EXIT_CODES.SUCCESS);
      const auth = await runCli(
        projectRoot,
        ["auth", "--from-env", "OLCX_OVERLEAF_SESSION", "--account", ACCOUNT_LABEL],
        { env: { OLCX_OVERLEAF_SESSION: FAKE_SESSION_COOKIE }, stdinIsTTY: false, now: fixedNow }
      );
      expect(auth.exitCode).toBe(EXIT_CODES.SUCCESS);

      await writeFixture(projectRoot, "main.tex", "local change\n");
      const previousState = baseSyncState({ "main.tex": "base\n" });
      await writeSyncState(projectRoot, previousState);
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: PROJECT_ID, files: [{ path: "main.tex", text: "remote change\n" }] }],
      });

      const conflict = await runCli(projectRoot, ["sync"], {
        backend,
        env: {},
        now: laterNow,
      });

      expect(conflict.exitCode).toBe(EXIT_CODES.SYNC_CONFLICT);
      expect(conflict.capturedExitCode).toBe(EXIT_CODES.SYNC_CONFLICT);
      expect(conflict.stdout).toBe("");
      expect(conflict.stderr).toContain("Error: Sync paused because 1 conflict(s) were detected.");
      expect(conflict.stderr).toContain("Conflicts:");
      expect(conflict.stderr).toContain("- main.tex (both-modified)");
      expect(conflict.stderr).toContain("Conflict report: .olcx/state/conflicts.json");
      assertNoSensitiveOutput(conflict.stderr);
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("local change\n");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("remote change\n");
      await expect(readSyncState(projectRoot)).resolves.toEqual(previousState);
      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).resolves.toContain('"paused":true');
    });
  });

  it("reports compile failures without writing a PDF or leaking sensitive values", async () => {
    await withSandboxPaperRepo(async (projectRoot) => {
      const init = await runCli(projectRoot, ["init", "--project", PROJECT_URL]);
      expect(init.exitCode).toBe(EXIT_CODES.SUCCESS);
      const auth = await runCli(
        projectRoot,
        ["auth", "--from-env", "OLCX_OVERLEAF_SESSION", "--account", ACCOUNT_LABEL],
        { env: { OLCX_OVERLEAF_SESSION: FAKE_SESSION_COOKIE }, stdinIsTTY: false, now: fixedNow }
      );
      expect(auth.exitCode).toBe(EXIT_CODES.SUCCESS);
      const backend = createFakeOverleafBackend({
        projects: [
          {
            projectId: PROJECT_ID,
            compileStatus: "failure",
            fastCompileStatus: "failure",
          },
        ],
      });

      const failure = await runCli(projectRoot, ["compile", "--disable-fast-fallback"], {
        backend,
        env: {},
        now: laterNow,
      });

      expect(failure.exitCode).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(failure.capturedExitCode).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toContain("Error: Overleaf compile failed: Fake Overleaf compile failed.");
      expect(failure.stderr).toContain("Compile log summary:");
      expect(failure.stderr).toContain("Next:");
      assertNoSensitiveOutput(failure.stderr);
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("pauses the watch queue after a workflow failure and ignores later changes", async () => {
    vi.useFakeTimers();

    await withSandboxPaperRepo(async (projectRoot) => {
      const init = await runCli(projectRoot, ["init", "--project", PROJECT_URL]);
      expect(init.exitCode).toBe(EXIT_CODES.SUCCESS);
      const auth = await runCli(
        projectRoot,
        ["auth", "--from-env", "OLCX_OVERLEAF_SESSION", "--account", ACCOUNT_LABEL],
        { env: { OLCX_OVERLEAF_SESSION: FAKE_SESSION_COOKIE }, stdinIsTTY: false, now: fixedNow }
      );
      expect(auth.exitCode).toBe(EXIT_CODES.SUCCESS);
      const fakeBackend = createFakeOverleafBackend({
        projects: [
          {
            projectId: PROJECT_ID,
            compileStatus: "failure",
            fastCompileStatus: "failure",
          },
        ],
      });
      const counted = withBackendCounters(fakeBackend);
      const watcher = new ControlledWatchAdapter();
      const signals = new ManualSignals();
      const capture = createIo();

      const watchSession = run(["node", "olcx", "watch", "--debounce", "10"], capture.io, {
        cwd: () => projectRoot,
        env: {},
        backend: counted.backend,
        watchAdapter: watcher,
        watchSignals: signals,
        now: laterNow,
      });

      await vi.waitFor(() => expect(watcher.input).toBeDefined());
      watcher.emit({ event: "change", path: "main.tex" });
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(() => {
        expect(capture.stderr()).toContain("Error: Watch paused after compile failed: Overleaf compile failed");
      });
      expect(capture.stderr()).toContain("Next: run olcx compile, fix the compile issue, then restart olcx watch.");
      assertNoSensitiveOutput(capture.stdout());
      assertNoSensitiveOutput(capture.stderr());
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      watcher.emit({ event: "change", path: "sections/intro.tex" });
      await vi.advanceTimersByTimeAsync(50);
      expect(counted.counts.compile).toBe(1);

      await signals.emit("SIGINT");
      await expect(watchSession).resolves.toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.exitCode()).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.stdout()).toContain("Stopped: olcx watch");
      expect(watcher.closed).toBe(true);
    });
  });
});
