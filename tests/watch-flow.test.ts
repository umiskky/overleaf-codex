import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeProjectAuth } from "../src/auth/projectAuth";
import type { ProjectAuth } from "../src/auth/types";
import type { OverleafBackend } from "../src/backend";
import { runWatchCommand } from "../src/commands/watch";
import { writeProjectConfig } from "../src/config/projectConfig";
import { createDefaultProjectConfig } from "../src/config/types";
import { EXIT_CODES, createOlcxError } from "../src/errors";
import { sha256Hex } from "../src/sync/plan";
import { getConflictReportPath, writeSyncState } from "../src/sync/state";
import type { SyncStateFile } from "../src/sync/types";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";
import { runWatchCycle } from "../src/watch/workflow";
import type {
  WatchAdapter,
  WatchAdapterInput,
  WatchChangeEvent,
  WatchHandle,
  WatchSignalName,
  WatchSignalRuntime,
} from "../src/watch/types";

const projectId = "<overleaf-project-id>";
const now = "2026-06-25T08:00:00.000Z";
const later = "2026-06-25T09:00:00.000Z";
const auth: ProjectAuth = {
  schemaVersion: 1,
  accountLabel: "work",
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: now,
  source: "env",
};

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
  private listeners = new Map<WatchSignalName, Set<() => void | Promise<void>>>();

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

function captureOutput() {
  let stdout = "";
  let stderr = "";
  return {
    writeOut: (value: string) => {
      stdout += value;
    },
    writeErr: (value: string) => {
      stderr += value;
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitForWatcherStart(watcher: ControlledWatchAdapter): Promise<void> {
  for (let attempt = 0; attempt < 5 && watcher.input === undefined; attempt += 1) {
    await Promise.resolve();
  }
  expect(watcher.input).toBeDefined();
}

async function writeWatchProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  await writeProjectConfig(
    projectRoot,
    createDefaultProjectConfig({
      projectId,
      sync: { ignore: [".olcx/config.json"] },
    })
  );
  await writeProjectAuth(projectRoot, auth);
}

async function writeFixture(projectRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = join(projectRoot, ...path.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function readRemoteText(backend: ReturnType<typeof createFakeOverleafBackend>, path: string): Promise<string> {
  const bytes = await backend.downloadFile({ projectId, auth, path });
  return Buffer.from(bytes).toString("utf8");
}

function baseSyncState(files: Record<string, string>): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: now,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          path,
          contentHash: sha256Hex(content),
          size: Buffer.byteLength(content),
          localModifiedAt: now,
          remoteModifiedAt: now,
          remoteId: `remote-${path}`,
          remoteRevision: `rev-${path}`,
          syncedAt: now,
        },
      ])
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watch workflow cycle", () => {
  it("passes the backend factory to sync and compile phases", async () => {
    const fakeBackend = createFakeOverleafBackend({ projects: [{ projectId }] });
    const createBackend = () => fakeBackend;
    const syncInputs: unknown[] = [];
    const compileInputs: unknown[] = [];

    await runWatchCycle({
      cwd: "/paper",
      env: {},
      createBackend,
      syncProject: async (input) => {
        syncInputs.push(input);
        return {
          projectRoot: "/paper",
          dryRun: false,
          plan: { summary: { upload: 0, download: 0, unchanged: 0, ignored: 0 } },
          output: "olcx sync\n",
        } as never;
      },
      runCompileCommand: async (input) => {
        compileInputs.push(input);
        return {
          projectRoot: "/paper",
          pdfPath: "build/overleaf/main.pdf",
          absolutePdfPath: "/paper/build/overleaf/main.pdf",
          status: "success",
          warnings: [],
          logs: [],
          elapsedMs: 12,
          fallbackUsed: false,
          bytesWritten: 25,
        };
      },
    });

    expect(syncInputs).toEqual([expect.objectContaining({ createBackend })]);
    expect(compileInputs).toEqual([expect.objectContaining({ createBackend })]);
  });

  it("runs sync before compile and returns both results", async () => {
    const calls: string[] = [];
    const result = await runWatchCycle({
      cwd: "/paper",
      env: {},
      syncProject: async () => {
        calls.push("sync");
        return {
          projectRoot: "/paper",
          dryRun: false,
          plan: { summary: { upload: 1, download: 0, unchanged: 0, ignored: 0 } },
          output: "olcx sync\n",
        } as never;
      },
      runCompileCommand: async () => {
        calls.push("compile");
        return {
          projectRoot: "/paper",
          pdfPath: "build/overleaf/main.pdf",
          absolutePdfPath: "/paper/build/overleaf/main.pdf",
          status: "success",
          warnings: [],
          logs: [],
          elapsedMs: 12,
          fallbackUsed: false,
          bytesWritten: 25,
        };
      },
    });

    expect(calls).toEqual(["sync", "compile"]);
    expect(result.compile.pdfPath).toBe("build/overleaf/main.pdf");
  });

  it("does not compile when sync fails and tags the failure phase", async () => {
    const syncFailure = createOlcxError({
      code: "SYNC_CONFLICT",
      message: "Sync paused because 1 conflict(s) were detected.",
      hint: "Run olcx sync --dry-run.",
    });
    let compileCalls = 0;

    await expect(
      runWatchCycle({
        cwd: "/paper",
        env: {},
        syncProject: async () => {
          throw syncFailure;
        },
        runCompileCommand: async () => {
          compileCalls += 1;
          throw new Error("compile should not run");
        },
      })
    ).rejects.toMatchObject({
      code: "SYNC_CONFLICT",
      details: { watchPhase: "sync" },
    });
    expect(compileCalls).toBe(0);
  });
});

describe("watch command session", () => {
  it("debounces multiple accepted changes into one sync and compile cycle", async () => {
    vi.useFakeTimers();
    const watcher = new ControlledWatchAdapter();
    const signals = new ManualSignals();
    const output = captureOutput();
    const calls: string[] = [];

    const session = runWatchCommand({
      cwd: "/paper",
      debounceMs: 20,
      env: {},
      watchAdapter: watcher,
      signals,
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      prepareProject: async () => ({
        projectRoot: "/paper",
        config: {
          schemaVersion: 1,
          projectId: "<overleaf-project-id>",
          rootDocument: "main.tex",
          pdfPath: "build/overleaf/main.pdf",
          sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
          compile: {
            timeoutMs: 120000,
            fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 },
          },
        },
      }),
      runCycle: async () => {
        calls.push("cycle");
        return {
          sync: { output: "olcx sync\n" } as never,
          compile: { pdfPath: "build/overleaf/main.pdf", bytesWritten: 25, status: "success" } as never,
        };
      },
    });

    await waitForWatcherStart(watcher);
    watcher.emit({ event: "change", path: "main.tex" });
    watcher.emit({ event: "change", path: "sections/intro.tex" });
    await vi.advanceTimersByTimeAsync(20);

    expect(calls).toEqual(["cycle"]);
    expect(output.stdout()).toContain("olcx watch");
    expect(output.stdout()).toContain("Compiled PDF: build/overleaf/main.pdf");

    await signals.emit("SIGINT");
    await expect(session).resolves.toEqual({ exitCode: EXIT_CODES.SUCCESS, paused: false });
    expect(watcher.closed).toBe(true);
    expect(signals.count("SIGINT")).toBe(0);
  });

  it("ignores generated PDF events so downloads do not trigger loops", async () => {
    vi.useFakeTimers();
    const watcher = new ControlledWatchAdapter();
    const signals = new ManualSignals();
    const output = captureOutput();
    let runs = 0;

    const session = runWatchCommand({
      cwd: "/paper",
      debounceMs: 10,
      env: {},
      watchAdapter: watcher,
      signals,
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      prepareProject: async () => ({
        projectRoot: "/paper",
        config: {
          schemaVersion: 1,
          projectId: "<overleaf-project-id>",
          rootDocument: "main.tex",
          pdfPath: "build/overleaf/main.pdf",
          sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
          compile: {
            timeoutMs: 120000,
            fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 },
          },
        },
      }),
      runCycle: async () => {
        runs += 1;
        return {
          sync: { output: "olcx sync\n" } as never,
          compile: { pdfPath: "build/overleaf/main.pdf", bytesWritten: 25, status: "success" } as never,
        };
      },
    });

    await waitForWatcherStart(watcher);
    watcher.emit({ event: "change", path: "build/overleaf/main.pdf" });
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toBe(0);

    await signals.emit("SIGTERM");
    await session;
  });

  it("pauses after workflow failure and does not retry later events", async () => {
    vi.useFakeTimers();
    const watcher = new ControlledWatchAdapter();
    const signals = new ManualSignals();
    const output = captureOutput();
    let runs = 0;

    const session = runWatchCommand({
      cwd: "/paper",
      debounceMs: 10,
      env: {},
      watchAdapter: watcher,
      signals,
      writeOut: output.writeOut,
      writeErr: output.writeErr,
      prepareProject: async () => ({
        projectRoot: "/paper",
        config: {
          schemaVersion: 1,
          projectId: "<overleaf-project-id>",
          rootDocument: "main.tex",
          pdfPath: "build/overleaf/main.pdf",
          sync: { mode: "bidirectional", conflictPolicy: "pause", ignore: [] },
          compile: {
            timeoutMs: 120000,
            fastFallback: { enabled: true, attempts: 1, timeoutMs: 30000 },
          },
        },
      }),
      runCycle: async () => {
        runs += 1;
        throw createOlcxError({
          code: "COMPILE_FAILED",
          message: "Fake compile failure.",
          hint: "Run olcx compile.",
          details: { watchPhase: "compile" },
        });
      },
    });

    await waitForWatcherStart(watcher);
    watcher.emit({ event: "change", path: "main.tex" });
    await vi.advanceTimersByTimeAsync(10);
    watcher.emit({ event: "change", path: "refs.bib" });
    await vi.advanceTimersByTimeAsync(50);

    expect(runs).toBe(1);
    expect(output.stderr()).toContain("Error: Watch paused after compile failed: Fake compile failure.");
    expect(output.stderr()).toContain("Next: run olcx compile, fix the compile issue, then restart olcx watch.");

    await signals.emit("SIGINT");
    await expect(session).resolves.toMatchObject({ exitCode: EXIT_CODES.COMPILE_FAILED, paused: true });
  });
});

describe("watch automatic workflow integration", () => {
  it("uploads local changes, compiles remotely, downloads the PDF, and ignores the generated PDF event", async () => {
    vi.useFakeTimers();
    const projectRoot = await mkdtemp(join(tmpdir(), "olcx-watch-flow-test-"));
    const watcher = new ControlledWatchAdapter();
    const signals = new ManualSignals();
    const output = captureOutput();
    let compileCalls = 0;

    try {
      await writeWatchProject(projectRoot);
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({ projects: [{ projectId }] });
      const countingBackend: OverleafBackend = {
        validateAuth: backend.validateAuth.bind(backend),
        listFiles: backend.listFiles.bind(backend),
        downloadFile: backend.downloadFile.bind(backend),
        uploadFile: backend.uploadFile.bind(backend),
        deleteFile: backend.deleteFile.bind(backend),
        downloadPdf: backend.downloadPdf.bind(backend),
        beginFastCompile: backend.beginFastCompile?.bind(backend),
        compile: async (...args: Parameters<OverleafBackend["compile"]>) => {
          compileCalls += 1;
          return backend.compile(...args);
        },
      };

      const session = runWatchCommand({
        cwd: projectRoot,
        debounceMs: 10,
        env: {},
        now: () => new Date(later),
        backend: countingBackend,
        watchAdapter: watcher,
        signals,
        writeOut: output.writeOut,
        writeErr: output.writeErr,
      });

      await vi.waitFor(() => expect(watcher.input).toBeDefined());
      watcher.emit({ event: "change", path: "main.tex" });
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(async () => {
        expect(await readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).toContain("%PDF-1.4");
      });
      expect(await readRemoteText(backend, "main.tex")).toBe("local main\n");
      expect(output.stdout()).toContain("Compiled PDF: build/overleaf/main.pdf");
      expect(output.stderr()).toBe("");

      watcher.emit({ event: "change", path: "build/overleaf/main.pdf" });
      await vi.advanceTimersByTimeAsync(50);
      expect(compileCalls).toBe(1);

      await signals.emit("SIGINT");
      await expect(session).resolves.toEqual({ exitCode: EXIT_CODES.SUCCESS, paused: false });
      expect(watcher.closed).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("pauses on sync conflict and does not retry later events", async () => {
    vi.useFakeTimers();
    const projectRoot = await mkdtemp(join(tmpdir(), "olcx-watch-conflict-test-"));
    const watcher = new ControlledWatchAdapter();
    const signals = new ManualSignals();
    const output = captureOutput();
    let syncAttempts = 0;
    let compileCalls = 0;

    try {
      await writeWatchProject(projectRoot);
      await writeFixture(projectRoot, "main.tex", "local change\n");
      await writeSyncState(projectRoot, baseSyncState({ "main.tex": "base\n" }));
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "main.tex", text: "remote change\n" }] }],
      });
      const countingBackend: OverleafBackend = {
        validateAuth: backend.validateAuth.bind(backend),
        listFiles: async (...args: Parameters<OverleafBackend["listFiles"]>) => {
          syncAttempts += 1;
          return backend.listFiles(...args);
        },
        downloadFile: backend.downloadFile.bind(backend),
        uploadFile: backend.uploadFile.bind(backend),
        deleteFile: backend.deleteFile.bind(backend),
        downloadPdf: backend.downloadPdf.bind(backend),
        beginFastCompile: backend.beginFastCompile?.bind(backend),
        compile: async (...args: Parameters<OverleafBackend["compile"]>) => {
          compileCalls += 1;
          return backend.compile(...args);
        },
      };

      const session = runWatchCommand({
        cwd: projectRoot,
        debounceMs: 10,
        env: {},
        now: () => new Date(later),
        backend: countingBackend,
        watchAdapter: watcher,
        signals,
        writeOut: output.writeOut,
        writeErr: output.writeErr,
      });

      await vi.waitFor(() => expect(watcher.input).toBeDefined());
      watcher.emit({ event: "change", path: "main.tex" });
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(() => {
        expect(output.stderr()).toContain("Error: Watch paused after sync failed");
      });
      expect(output.stderr()).toContain(
        "Next: review conflicts, run olcx sync --dry-run, run olcx sync after it is clean, then restart olcx watch."
      );
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      watcher.emit({ event: "change", path: "refs.bib" });
      await vi.advanceTimersByTimeAsync(50);
      expect(syncAttempts).toBe(1);
      expect(compileCalls).toBe(0);
      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).resolves.toContain('"watch":{"paused":true');

      await signals.emit("SIGINT");
      await expect(session).resolves.toMatchObject({ exitCode: EXIT_CODES.SYNC_CONFLICT, paused: true });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
