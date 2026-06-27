import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { VERSION, buildCli, isDirectCliInvocation, run } from "../src/cli";
import { readProjectAuth, writeProjectAuth } from "../src/auth/projectAuth";
import type { BackendCompileInput, CompileResult, OverleafBackend } from "../src/backend";
import { readProjectConfig, writeProjectConfig } from "../src/config/projectConfig";
import { createDefaultProjectConfig } from "../src/config/types";
import { sha256Hex } from "../src/sync/plan";
import { getConflictReportPath, getSyncStatePath, writeSyncState } from "../src/sync/state";
import type { SyncStateFile } from "../src/sync/types";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";
import {
  ERROR_CODE_EXIT_CODES,
  EXIT_CODES,
  createOlcxError,
  formatCliFailure,
  isNonInteractive,
  mapErrorCodeToExitCode,
  plannedCommandFailure,
  redactSensitive,
} from "../src/cli-behavior";

function createIo() {
  let exitCode = EXIT_CODES.SUCCESS;
  let stdout = "";
  let stderr = "";

  return {
    io: {
      writeOut: (value: string) => {
        stdout += value;
      },
      writeErr: (value: string) => {
        stderr += value;
      },
      setExitCode: (value: number) => {
        exitCode = value;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    exitCode: () => exitCode,
  };
}

function sequenceNowMs(values: number[]) {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("clock exhausted");
    return value;
  };
}

function createEndpointFetch(
  handlers: Record<string, () => Promise<{ status: number; ok: boolean }> | Promise<never>>
) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler();
  };
  return { fetchImpl, calls };
}

const syncProjectId = "<overleaf-project-id>";
const syncAuth = {
  schemaVersion: 1 as const,
  accountLabel: "work",
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: "2026-06-25T08:00:00.000Z",
  source: "env" as const,
};

async function writeCliProject(root: string, options: { auth?: boolean; ignore?: string[] } = {}): Promise<void> {
  await mkdir(join(root, ".git"), { recursive: true });
  await writeProjectConfig(
    root,
    createDefaultProjectConfig({
      projectId: syncProjectId,
      sync: { ignore: [".olcx/config.json", ...(options.ignore ?? [])] },
    })
  );
  if (options.auth !== false) {
    await writeProjectAuth(root, syncAuth);
  }
}

function createCliCompileBackend(
  options: {
    compileResult?: (input: BackendCompileInput) => CompileResult;
    compileReject?: (input: BackendCompileInput) => Promise<CompileResult>;
  } = {}
): { backend: OverleafBackend; compileInputs: BackendCompileInput[] } {
  const compileInputs: BackendCompileInput[] = [];
  const backend: OverleafBackend = {
    async validateAuth() {
      return { authenticated: true };
    },
    async listFiles() {
      return [];
    },
    async downloadFile() {
      return new Uint8Array();
    },
    async uploadFile() {
      throw new Error("uploadFile is not used by CLI compile tests");
    },
    async deleteFile() {},
    async compile(input) {
      compileInputs.push(input);
      if (options.compileReject) {
        return options.compileReject(input);
      }
      return (
        options.compileResult?.(input) ?? {
          status: "success",
          projectId: input.projectId,
          pdfBytes: Buffer.from("%PDF-1.4\n% fake cli compile pdf\n", "utf8"),
          logs: [{ level: "info", message: "Fake CLI compile succeeded." }],
          warnings: [],
          elapsedMs: 41,
          fallbackUsed: false,
        }
      );
    },
    async downloadPdf() {
      return Buffer.from("%PDF-1.4\n% fake cli downloaded pdf\n", "utf8");
    },
  };

  return { backend, compileInputs };
}

async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, ...path.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function readRemoteText(
  backend: ReturnType<typeof createFakeOverleafBackend>,
  path: string
): Promise<string> {
  const bytes = await backend.downloadFile({ projectId: syncProjectId, auth: syncAuth, path });
  return Buffer.from(bytes).toString("utf8");
}

function baseSyncState(files: Record<string, string>): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: "2026-06-25T08:00:00.000Z",
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          path,
          contentHash: sha256Hex(content),
          size: Buffer.byteLength(content),
          localModifiedAt: "2026-06-25T08:00:00.000Z",
          remoteModifiedAt: "2026-06-25T08:00:00.000Z",
          remoteId: `remote-${path}`,
          remoteRevision: `rev-${path}`,
          syncedAt: "2026-06-25T08:00:00.000Z",
        },
      ])
    ),
  };
}

function readmeCommandSurface(): string[] {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const match = readme.match(/## Current Status\s+[\s\S]*?```bash\s+([\s\S]*?)```/);

  if (!match) {
    throw new Error("README current command surface block not found");
  }

  const commandNames = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("olcx "))
    .map((line) => line.replace(/^olcx\s+/, "").split(/\s+/)[0]);
  return [...new Set(commandNames)];
}

describe("olcx cli", () => {
  it("recognizes npm bin symlink invocation as the direct CLI entrypoint", () => {
    const target = join(tmpdir(), "olcx-entry", "dist", "cli.js");
    const binLink = join(tmpdir(), "olcx-entry", "node_modules", ".bin", "olcx");
    const realpath = (value: string) => (value === binLink ? target : value);

    expect(isDirectCliInvocation(pathToFileURL(target).href, binLink, realpath)).toBe(true);
    expect(isDirectCliInvocation(pathToFileURL(target).href, join(tmpdir(), "other.js"), realpath)).toBe(false);
  });

  it("reports the package version from package.json", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };

    expect(VERSION).toBe(packageJson.version);
  });

  it("uses a Node-resolvable local ESM import for the built CLI", () => {
    const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

    expect(source).toContain('} from "./cli-behavior.js";');
  });

  it("keeps Commander commands aligned with the README command list", () => {
    const program = buildCli();
    const commanderCommands = program.commands.map((command) => command.name());

    expect(commanderCommands).toEqual(readmeCommandSurface());
  });

  it("keeps init help aligned with the README init example", () => {
    const init = buildCli().commands.find((command) => command.name() === "init");

    expect(init?.helpInformation()).toContain("--project <url-or-id>");
    expect(init?.helpInformation()).not.toContain("--vscode");
  });

  it("keeps auth help aligned with project-local auth setup", () => {
    const auth = buildCli().commands.find((command) => command.name() === "auth");

    expect(auth?.helpInformation()).toContain("--cookie <value>");
    expect(auth?.helpInformation()).toContain("--from-env <name>");
    expect(auth?.helpInformation()).toContain("--account <label>");
  });

  it("shows endpoint subcommands in help", () => {
    const endpoint = buildCli().commands.find((command) => command.name() === "endpoint");

    expect(endpoint?.helpInformation()).toContain("status");
    expect(endpoint?.helpInformation()).toContain("test");
    expect(endpoint?.helpInformation()).toContain("set");
  });

  it("shows fast fallback options in compile help", () => {
    const compile = buildCli().commands.find((command) => command.name() === "compile");

    expect(compile?.helpInformation()).toContain("--disable-fast-fallback");
    expect(compile?.helpInformation()).toContain("--fast-fallback-attempts <count>");
    expect(compile?.helpInformation()).toContain("--fast-fallback-timeout <ms>");
  });

  it("defines stable exit code numbers", () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      INTERNAL_ERROR: 1,
      USER_INPUT_ERROR: 2,
      CONFIG_ERROR: 3,
      AUTH_ERROR: 4,
      NETWORK_ERROR: 5,
      SYNC_CONFLICT: 6,
      COMPILE_FAILED: 7,
    });
  });

  it("maps architecture error categories to stable exit codes", () => {
    expect(mapErrorCodeToExitCode("USER_INPUT_ERROR")).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(mapErrorCodeToExitCode("PROJECT_CONFIG_NOT_FOUND")).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(mapErrorCodeToExitCode("PROJECT_CONFIG_INVALID")).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(mapErrorCodeToExitCode("PROJECT_AUTH_NOT_FOUND")).toBe(EXIT_CODES.AUTH_ERROR);
    expect(mapErrorCodeToExitCode("PROJECT_AUTH_INVALID")).toBe(EXIT_CODES.AUTH_ERROR);
    expect(mapErrorCodeToExitCode("BACKEND_AUTH_FAILED")).toBe(EXIT_CODES.AUTH_ERROR);
    expect(mapErrorCodeToExitCode("BACKEND_NETWORK_ERROR")).toBe(EXIT_CODES.NETWORK_ERROR);
    expect(mapErrorCodeToExitCode("BACKEND_PROTOCOL_ERROR")).toBe(EXIT_CODES.NETWORK_ERROR);
    expect(mapErrorCodeToExitCode("SYNC_CONFLICT")).toBe(EXIT_CODES.SYNC_CONFLICT);
    expect(mapErrorCodeToExitCode("SYNC_UNSAFE_OPERATION")).toBe(EXIT_CODES.SYNC_CONFLICT);
    expect(mapErrorCodeToExitCode("COMPILE_FAILED")).toBe(EXIT_CODES.COMPILE_FAILED);
    expect(mapErrorCodeToExitCode("COMPILE_TIMEOUT")).toBe(EXIT_CODES.COMPILE_FAILED);
    expect(mapErrorCodeToExitCode("IO_ERROR")).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(mapErrorCodeToExitCode("INTERNAL_ERROR")).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(ERROR_CODE_EXIT_CODES.PROJECT_AUTH_NOT_FOUND).toBe(EXIT_CODES.AUTH_ERROR);
  });

  it("shows watch debounce help", () => {
    const watch = buildCli().commands.find((command) => command.name() === "watch");

    expect(watch?.helpInformation()).toContain("--debounce <ms>");
  });

  it("rejects invalid watch debounce values", async () => {
    const capture = createIo();

    const exitCode = await run(["node", "olcx", "watch", "--debounce", "0"], capture.io, {
      cwd: () => process.cwd(),
      env: {},
    });

    expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("debounce must be a positive integer");
  });

  it("reports endpoint status without probing or writing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-status-test-"));
    const capture = createIo();
    try {
      await writeCliProject(root);
      const before = await readFile(join(root, ".olcx", "config.json"), "utf8");

      const exitCode = await run(["node", "olcx", "endpoint", "status"], capture.io, {
        cwd: () => root,
        env: {},
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx endpoint status");
      expect(capture.stdout()).toContain("Current: www");
      expect(capture.stdout()).toContain("https://www.overleaf.com");
      expect(await readFile(join(root, ".olcx", "config.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a config error for endpoint status when config is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-status-missing-test-"));
    const capture = createIo();
    try {
      await mkdir(join(root, ".git"), { recursive: true });

      const exitCode = await run(["node", "olcx", "endpoint", "status"], capture.io, {
        cwd: () => root,
        env: {},
      });

      expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Project config was not found.");
      expect(capture.stderr()).toContain("olcx init");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sets the endpoint manually without probing", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-set-test-"));
    const capture = createIo();
    try {
      await writeCliProject(root);

      const exitCode = await run(["node", "olcx", "endpoint", "set", "cn"], capture.io, {
        cwd: () => root,
        env: {},
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Set: cn");
      await expect(readProjectConfig(root)).resolves.toMatchObject({
        overleaf: { baseUrl: "https://cn.overleaf.com" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid endpoint aliases without changing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-set-invalid-test-"));
    const capture = createIo();
    try {
      await writeCliProject(root);
      const before = await readFile(join(root, ".olcx", "config.json"), "utf8");

      const exitCode = await run(["node", "olcx", "endpoint", "set", "europe"], capture.io, {
        cwd: () => root,
        env: {},
      });

      expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("www or cn");
      expect(await readFile(join(root, ".olcx", "config.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tests endpoints with injected probes without writing config", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-test-test-"));
    const capture = createIo();
    const fake = createEndpointFetch({
      "https://www.overleaf.com/project": async () => ({ status: 200, ok: true }),
      "https://cn.overleaf.com/project": async () => ({ status: 302, ok: false }),
    });
    try {
      await writeCliProject(root);
      const before = await readFile(join(root, ".olcx", "config.json"), "utf8");

      const exitCode = await run(["node", "olcx", "endpoint", "test"], capture.io, {
        cwd: () => root,
        env: {},
        endpointFetch: fake.fetchImpl,
        endpointNowMs: sequenceNowMs([0, 100, 100, 250]),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx endpoint test");
      expect(capture.stdout()).toContain("www https://www.overleaf.com available 100ms status 200");
      expect(capture.stdout()).toContain("cn https://cn.overleaf.com available 150ms status 302");
      expect(capture.stdout()).toContain("Applied: no");
      expect(fake.calls).toEqual(["https://www.overleaf.com/project", "https://cn.overleaf.com/project"]);
      expect(await readFile(join(root, ".olcx", "config.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid endpoint test timeouts", async () => {
    const capture = createIo();

    const exitCode = await run(["node", "olcx", "endpoint", "test", "--timeout", "0"], capture.io, {
      cwd: () => process.cwd(),
      env: {},
    });

    expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("endpoint timeout must be a positive integer");
  });

  it("applies the fastest endpoint only when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-apply-test-"));
    const capture = createIo();
    const fake = createEndpointFetch({
      "https://www.overleaf.com/project": async () => ({ status: 200, ok: true }),
      "https://cn.overleaf.com/project": async () => ({ status: 200, ok: true }),
    });
    try {
      await writeCliProject(root);

      const exitCode = await run(["node", "olcx", "endpoint", "test", "--apply"], capture.io, {
        cwd: () => root,
        env: {},
        endpointFetch: fake.fetchImpl,
        endpointNowMs: sequenceNowMs([0, 200, 200, 250]),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Applied: cn");
      await expect(readProjectConfig(root)).resolves.toMatchObject({
        overleaf: { baseUrl: "https://cn.overleaf.com" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the current endpoint when it is already fastest", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-apply-current-test-"));
    const capture = createIo();
    const fake = createEndpointFetch({
      "https://www.overleaf.com/project": async () => ({ status: 200, ok: true }),
      "https://cn.overleaf.com/project": async () => ({ status: 200, ok: true }),
    });
    try {
      await writeCliProject(root);

      const exitCode = await run(["node", "olcx", "endpoint", "test", "--apply"], capture.io, {
        cwd: () => root,
        env: {},
        endpointFetch: fake.fetchImpl,
        endpointNowMs: sequenceNowMs([0, 40, 40, 140]),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Applied: www");
      await expect(readProjectConfig(root)).resolves.toMatchObject({
        overleaf: { baseUrl: "https://www.overleaf.com" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not apply when both endpoint probes fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-apply-fail-test-"));
    const capture = createIo();
    const fake = createEndpointFetch({
      "https://www.overleaf.com/project": async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      "https://cn.overleaf.com/project": async () => {
        throw new Error("network failed for cookie=secret");
      },
    });
    try {
      await writeCliProject(root);
      const before = await readFile(join(root, ".olcx", "config.json"), "utf8");

      const exitCode = await run(["node", "olcx", "endpoint", "test", "--apply"], capture.io, {
        cwd: () => root,
        env: {},
        endpointFetch: fake.fetchImpl,
        endpointNowMs: sequenceNowMs([0, 1000, 1000, 1200]),
      });

      expect(exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Error: No Overleaf endpoint is reachable.");
      expect(capture.stderr()).toContain("timeout");
      expect(capture.stderr()).toContain("network failed");
      expect(capture.stderr()).not.toContain("secret");
      expect(await readFile(join(root, ".olcx", "config.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts endpoint probe output before printing", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-endpoint-redaction-test-"));
    const capture = createIo();
    const fake = createEndpointFetch({
      "https://www.overleaf.com/project": async () => {
        throw new Error(
          "network failed for accountLabel=work account=lab cookie=<fake-session-cookie> project 0123456789abcdef01234567"
        );
      },
      "https://cn.overleaf.com/project": async () => {
        throw new Error("https://cn.overleaf.com/project/0123456789abcdef01234567");
      },
    });
    try {
      await writeCliProject(root);

      const exitCode = await run(["node", "olcx", "endpoint", "test"], capture.io, {
        cwd: () => root,
        env: {},
        endpointFetch: fake.fetchImpl,
        endpointNowMs: sequenceNowMs([0, 10, 10, 20]),
      });

      expect(exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Error: No Overleaf endpoint is reachable.");
      expect(capture.stderr()).not.toContain("accountLabel=work");
      expect(capture.stderr()).not.toContain("account=lab");
      expect(capture.stderr()).not.toContain("<fake-session-cookie>");
      expect(capture.stderr()).not.toContain("0123456789abcdef01234567");
      expect(capture.stderr()).not.toContain(syncProjectId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts and stops watch through injected signal runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-watch-test-"));
    const capture = createIo();

    class CliWatchAdapter {
      closed = false;
      watch() {
        return {
          close: async () => {
            this.closed = true;
          },
        };
      }
    }

    class CliSignals {
      listeners: Array<() => void | Promise<void>> = [];
      on(_signal: "SIGINT" | "SIGTERM", listener: () => void | Promise<void>) {
        this.listeners.push(listener);
        return () => {
          this.listeners = this.listeners.filter((entry) => entry !== listener);
        };
      }
      async emit() {
        await Promise.all(this.listeners.map((listener) => listener()));
      }
    }

    try {
      await writeCliProject(root);
      const watcher = new CliWatchAdapter();
      const signals = new CliSignals();
      const backend = createFakeOverleafBackend({ projects: [{ projectId: syncProjectId }] });

      const running = run(["node", "olcx", "watch", "--debounce", "5"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        watchAdapter: watcher,
        watchSignals: signals,
      });

      await vi.waitFor(() => expect(signals.listeners.length).toBeGreaterThan(0));
      await signals.emit();
      const exitCode = await running;

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx watch");
      expect(capture.stdout()).toContain("Debounce: 5ms");
      expect(capture.stdout()).toContain("Stopped: olcx watch");
      expect(watcher.closed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs compile successfully and writes the default PDF path", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend } = createCliCompileBackend();

      const exitCode = await run(["node", "olcx", "compile", "--disable-fast-fallback"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx compile");
      expect(capture.stdout()).toContain("Status: success");
      expect(capture.stdout()).toContain("PDF: build/overleaf/main.pdf");
      expect(capture.stdout()).toContain("Bytes: 32");
      expect(capture.stdout()).toContain("Warnings: 0");
      expect(capture.stdout()).toContain("Next: open build/overleaf/main.pdf");
      expect(capture.stdout()).not.toContain(syncProjectId);
      expect(capture.stdout()).not.toContain(syncAuth.sessionCookie);
      await expect(readFile(join(root, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake cli compile pdf\n"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses configured pdfPath when --pdf is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-configured-pdf-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      await writeProjectConfig(root, createDefaultProjectConfig({ projectId: syncProjectId, pdfPath: "configured/out.pdf" }));
      await writeProjectAuth(root, syncAuth);
      const { backend } = createCliCompileBackend();

      const exitCode = await run(["node", "olcx", "compile", "--disable-fast-fallback"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("PDF: configured/out.pdf");
      await expect(readFile(join(root, "configured", "out.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake cli compile pdf\n"
      );
      await expect(readFile(join(root, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs compile with a --pdf override", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-pdf-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend } = createCliCompileBackend();

      const exitCode = await run(["node", "olcx", "compile", "--pdf", "artifacts/paper.pdf"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("PDF: artifacts/paper.pdf");
      expect(capture.stdout()).toContain("Status: success");
      expect(capture.stdout()).toContain("Warnings: 0");
      expect(capture.stdout()).toContain("Next: open artifacts/paper.pdf");
      await expect(readFile(join(root, "artifacts", "paper.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake cli compile pdf\n"
      );
      await expect(readFile(join(root, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints explicit fallback output when fast draft fallback succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-fast-fallback-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend } = createCliCompileBackend({
        compileResult: (input) =>
          input.fastMode
            ? {
                status: "fallback-success",
                projectId: input.projectId,
                pdfBytes: Buffer.from("%PDF-1.4\n% fake cli fast fallback pdf\n", "utf8"),
                logs: [{ level: "info", message: "Fast fallback succeeded." }],
                warnings: ["Fast/draft fallback PDF: images may be omitted."],
                elapsedMs: 25,
                fallbackUsed: true,
              }
            : {
                status: "timeout",
                projectId: input.projectId,
                logs: [{ level: "error", message: "Compile timed out." }],
                warnings: [],
                elapsedMs: 120000,
                fallbackUsed: false,
              },
      });

      const exitCode = await run(["node", "olcx", "compile", "--fast-fallback-timeout", "16000"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Status: fallback-success");
      expect(capture.stdout()).toContain("Fallback: fast/draft");
      expect(capture.stdout()).toContain("Fast/draft fallback PDF: images may be omitted.");
      await expect(readFile(join(root, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake cli fast fallback pdf\n"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints readable compile failure output with a log summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-failure-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend } = createCliCompileBackend({
        compileResult: (input) => ({
          status: "failure",
          projectId: input.projectId,
          logs: [
            { level: "error", message: "LaTeX Error: Undefined control sequence.", file: "main.tex", line: 7 },
            { level: "warning", message: "LaTeX Warning: Citation `smith' undefined." },
          ],
          warnings: ["Citation `smith' undefined."],
          elapsedMs: 90,
          fallbackUsed: false,
        }),
      });

      const exitCode = await run(["node", "olcx", "compile", "--disable-fast-fallback"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.exitCode()).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Error: Overleaf compile failed: LaTeX Error: Undefined control sequence.");
      expect(capture.stderr()).toContain("Compile log summary:");
      expect(capture.stderr()).not.toContain("Logs:");
      expect(capture.stderr()).toContain("- error main.tex:7 LaTeX Error: Undefined control sequence.");
      expect(capture.stderr()).toContain("- warning LaTeX Warning: Citation `smith' undefined.");
      expect(capture.stderr()).toContain("Next:");
      expect(capture.stderr()).not.toContain(syncProjectId);
      expect(capture.stderr()).not.toContain(syncAuth.sessionCookie);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("disables fallback with --disable-fast-fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-disable-fallback-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend, compileInputs } = createCliCompileBackend({
        compileResult: (input) => ({
          status: "timeout",
          projectId: input.projectId,
          logs: [{ level: "error", message: "Compile timed out." }],
          warnings: [],
          elapsedMs: 120000,
          fallbackUsed: false,
        }),
      });

      const exitCode = await run(["node", "olcx", "compile", "--disable-fast-fallback"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("timed out");
      expect(compileInputs).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid fast fallback CLI numbers", async () => {
    const capture = createIo();

    const exitCode = await run(["node", "olcx", "compile", "--fast-fallback-attempts", "4"], capture.io, {
      cwd: () => process.cwd(),
      env: {},
    });

    expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("fast fallback attempts");
  });

  it("prints normal, fallback, and restore details when fallback fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-fallback-failure-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend } = createCliCompileBackend({
        compileResult: (input) =>
          input.fastMode
            ? {
                status: "failure",
                projectId: input.projectId,
                logs: [{ level: "error", message: "Fast fallback failed." }],
                warnings: [],
                elapsedMs: 15000,
                fallbackUsed: true,
              }
            : {
                status: "timeout",
                projectId: input.projectId,
                logs: [{ level: "error", message: "Normal compile timed out." }],
                warnings: [],
                elapsedMs: 120000,
                fallbackUsed: false,
              },
      });

      const exitCode = await run(["node", "olcx", "compile"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Normal compile failure:");
      expect(capture.stderr()).toContain("Normal compile timed out.");
      expect(capture.stderr()).toContain("Fast/draft fallback failure:");
      expect(capture.stderr()).toContain("Fast fallback failed.");
      expect(capture.stderr()).toContain("Restore: restore-not-needed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps compile timeout to exit 7", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-timeout-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: syncProjectId, compileStatus: "timeout" }],
      });

      const exitCode = await run(["node", "olcx", "compile", "--disable-fast-fallback"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.COMPILE_FAILED);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("timed out");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps compile missing config to exit 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-missing-config-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      const { backend } = createCliCompileBackend();
      const exitCode = await run(["node", "olcx", "compile"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Project config was not found.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps compile missing auth to exit 4", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-missing-auth-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root, { auth: false });
      const { backend } = createCliCompileBackend();
      const exitCode = await run(["node", "olcx", "compile"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Project auth was not found.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps backend auth failures during compile to exit 4", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-backend-auth-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend } = createCliCompileBackend({
        compileReject: async () => {
          throw createOlcxError({
            code: "BACKEND_AUTH_FAILED",
            message: "Overleaf authentication was rejected.",
            hint: "Run olcx auth again with a fresh Overleaf session cookie.",
          });
        },
      });

      const exitCode = await run(["node", "olcx", "compile"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Overleaf authentication was rejected.");
      expect(capture.stderr()).not.toContain(syncAuth.sessionCookie);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps backend network failures during compile to exit 5", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-network-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: syncProjectId }],
        failures: { compile: "network" },
      });

      const exitCode = await run(["node", "olcx", "compile"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Fake backend network failure during compile.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe compile --pdf paths before contacting the backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-compile-unsafe-pdf-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      const { backend, compileInputs } = createCliCompileBackend();

      const exitCode = await run(["node", "olcx", "compile", "--pdf", "../main.pdf"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("PDF output path must be a safe relative path");
      expect(compileInputs).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs auth from an environment variable without leaking the value", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-auth-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      const exitCode = await run(
        ["node", "olcx", "auth", "--from-env", "OLCX_OVERLEAF_SESSION", "--account", "work"],
        capture.io,
        {
          cwd: () => root,
          env: { OLCX_OVERLEAF_SESSION: "<fake-env-session-cookie>" },
          stdinIsTTY: false,
          now: () => new Date("2026-06-25T08:00:00.000Z"),
        }
      );

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Stored project-local Overleaf auth.");
      expect(capture.stdout()).toContain("Account: work");
      expect(capture.stdout()).toContain("Next: olcx status");
      expect(capture.stdout()).not.toContain("<fake-env-session-cookie>");
      await expect(readProjectAuth(root)).resolves.toMatchObject({
        sessionCookie: "<fake-env-session-cookie>",
        accountLabel: "work",
        source: "env",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails auth in non-interactive mode when no source is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-auth-missing-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      const exitCode = await run(["node", "olcx", "auth"], capture.io, {
        cwd: () => root,
        env: {},
        stdinIsTTY: false,
      });

      expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
      expect(capture.exitCode()).toBe(EXIT_CODES.USER_INPUT_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Error:");
      expect(capture.stderr()).toContain("Next:");
      expect(capture.stderr()).not.toContain("<fake-env-session-cookie>");
      await expect(readProjectAuth(root)).rejects.toMatchObject({ code: "PROJECT_AUTH_NOT_FOUND" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs status as a redacted local summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-status-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      await writeProjectConfig(root, createDefaultProjectConfig({ projectId: "0123456789abcdef01234567" }));
      await writeProjectAuth(root, {
        schemaVersion: 1,
        accountLabel: "writer@example.test",
        sessionCookie: "<fake-env-session-cookie>",
        updatedAt: "2026-06-25T08:00:00.000Z",
        source: "env",
      });

      const exitCode = await run(["node", "olcx", "status"], capture.io, { cwd: () => root });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx status");
      expect(capture.stdout()).toContain("Project binding: configured");
      expect(capture.stdout()).toContain("Auth: present");
      expect(capture.stdout()).toContain("Account: <redacted-account>");
      expect(capture.stdout()).not.toContain("<fake-env-session-cookie>");
      expect(capture.stdout()).not.toContain("writer@example.test");
      expect(capture.stdout()).not.toContain("0123456789abcdef01234567");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs doctor diagnostics and writes failures to stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-doctor-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      await writeProjectConfig(root, createDefaultProjectConfig({ projectId: "0123456789abcdef01234567" }));
      await writeFile(
        join(root, ".gitignore"),
        [".olcx/auth.local.json", ".olcx/*.local.json", ".olcx/*.secret.json", ""].join("\n"),
        "utf8"
      );

      const exitCode = await run(["node", "olcx", "doctor"], capture.io, {
        cwd: () => root,
        nodeVersion: "22.0.0",
        backendAvailable: true,
      });

      expect(exitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(capture.exitCode()).toBe(EXIT_CODES.AUTH_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("olcx doctor");
      expect(capture.stderr()).toContain("[fail] Auth file: missing .olcx/auth.local.json");
      expect(capture.stderr()).toContain("Next: olcx auth --from-env OLCX_OVERLEAF_SESSION");
      expect(capture.stderr()).not.toContain("0123456789abcdef01234567");
      expect(capture.stderr()).not.toContain("<fake-env-session-cookie>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs fast sync dry-run without mutating local files, remote files, or state", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-sync-dry-run-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      await writeFixture(root, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: syncProjectId, files: [{ path: "refs.bib", text: "@article{fake,title={Fake}}\n" }] }],
      });

      const exitCode = await run(["node", "olcx", "sync", "--dry-run"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        now: () => new Date("2026-06-25T09:00:00.000Z"),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx sync --dry-run");
      expect(capture.stdout()).toContain("Uploads:\n- main.tex");
      expect(capture.stdout()).not.toContain("Downloads:");
      expect(capture.stdout()).toContain("No files changed.");
      expect(capture.stdout()).not.toContain(syncProjectId);
      expect(capture.stdout()).not.toContain(syncAuth.sessionCookie);
      await expect(readFile(join(root, "refs.bib"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(backend.downloadFile({ projectId: syncProjectId, auth: syncAuth, path: "main.tex" })).rejects.toMatchObject({
        code: "BACKEND_PROTOCOL_ERROR",
      });
      await expect(readFile(getSyncStatePath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs strict sync dry-run with remote download planning", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-sync-strict-dry-run-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      await writeFixture(root, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: syncProjectId, files: [{ path: "refs.bib", text: "@article{fake,title={Fake}}\n" }] }],
      });

      const exitCode = await run(["node", "olcx", "sync", "--strict", "--dry-run"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        now: () => new Date("2026-06-25T09:00:00.000Z"),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx sync --strict --dry-run");
      expect(capture.stdout()).toContain("Uploads:\n- main.tex");
      expect(capture.stdout()).toContain("Downloads:\n- refs.bib");
      expect(capture.stdout()).toContain("No files changed.");
      expect(capture.stdout()).not.toContain(syncProjectId);
      expect(capture.stdout()).not.toContain(syncAuth.sessionCookie);
      await expect(readFile(join(root, "refs.bib"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(getSyncStatePath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints progress and a summary table while applying sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-sync-progress-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      await writeFixture(root, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({ projects: [{ projectId: syncProjectId }] });

      const exitCode = await run(["node", "olcx", "sync"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        now: () => new Date("2026-06-25T09:00:00.000Z"),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Progress [##########] 1/1 upload main.tex ETA 0.0s");
      expect(capture.stdout()).toContain("olcx sync summary");
      expect(capture.stdout()).toContain("| ok     | upload | main.tex");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs pull reset from the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-pull-reset-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      await writeFixture(root, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: syncProjectId, files: [{ path: "main.tex", text: "remote main\n" }] }],
      });

      const exitCode = await run(["node", "olcx", "pull", "--mode", "reset"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        now: () => new Date("2026-06-25T09:00:00.000Z"),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx pull --mode reset");
      expect(capture.stdout()).toContain("olcx pull summary");
      await expect(readFile(join(root, "main.tex"), "utf8")).resolves.toBe("remote main\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs push from the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-push-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      await writeFixture(root, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({ projects: [{ projectId: syncProjectId }] });

      const exitCode = await run(["node", "olcx", "push"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        now: () => new Date("2026-06-25T09:00:00.000Z"),
      });

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("olcx push");
      expect(capture.stdout()).toContain("olcx push summary");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("local main\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs sync conflict path with exit 6, stderr details, and a conflict report", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-sync-conflict-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root);
      await writeFixture(root, "main.tex", "local change\n");
      await writeSyncState(root, baseSyncState({ "main.tex": "base\n" }));
      const backend = createFakeOverleafBackend({
        projects: [{ projectId: syncProjectId, files: [{ path: "main.tex", text: "remote change\n" }] }],
      });

      const exitCode = await run(["node", "olcx", "sync", "--strict"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
        now: () => new Date("2026-06-25T09:00:00.000Z"),
      });

      expect(exitCode).toBe(EXIT_CODES.SYNC_CONFLICT);
      expect(capture.exitCode()).toBe(EXIT_CODES.SYNC_CONFLICT);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Error: Sync paused because 1 conflict(s) were detected.");
      expect(capture.stderr()).toContain("Conflicts:\n- main.tex (both-modified)");
      expect(capture.stderr()).toContain("Conflict report: .olcx/state/conflicts.json");
      expect(capture.stderr()).not.toContain(syncProjectId);
      expect(capture.stderr()).not.toContain(syncAuth.sessionCookie);
      await expect(readFile(join(root, "main.tex"), "utf8")).resolves.toBe("local change\n");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("remote change\n");
      await expect(readFile(getConflictReportPath(root), "utf8")).resolves.toContain("both-modified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps sync missing config to exit 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-sync-missing-config-test-"));
    const capture = createIo();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      const backend = createFakeOverleafBackend({ projects: [{ projectId: syncProjectId }] });
      const exitCode = await run(["node", "olcx", "sync"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(capture.exitCode()).toBe(EXIT_CODES.CONFIG_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Project config was not found.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps sync missing auth to exit 4", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-sync-missing-auth-test-"));
    const capture = createIo();

    try {
      await writeCliProject(root, { auth: false });
      const backend = createFakeOverleafBackend({ projects: [{ projectId: syncProjectId }] });
      const exitCode = await run(["node", "olcx", "sync"], capture.io, {
        cwd: () => root,
        env: {},
        backend,
      });

      expect(exitCode).toBe(EXIT_CODES.AUTH_ERROR);
      expect(capture.exitCode()).toBe(EXIT_CODES.AUTH_ERROR);
      expect(capture.stdout()).toBe("");
      expect(capture.stderr()).toContain("Project auth was not found.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps Commander missing required options to user input errors", async () => {
    const capture = createIo();
    const exitCode = await run(["node", "olcx", "init"], capture.io);

    expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.exitCode()).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("required option '--project <url-or-id>'");
    expect(capture.stderr()).toContain("Next:");
  });

  it("runs init successfully and writes project config", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-init-test-"));
    const capture = createIo();
    const previous = process.cwd();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      process.chdir(root);
      const exitCode = await run(["node", "olcx", "init", "--project", "abc123def456"], capture.io);

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.exitCode()).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(capture.stdout()).toContain("Initialized olcx project binding.");
      expect(JSON.parse(await readFile(join(root, ".olcx", "config.json"), "utf8"))).toMatchObject({
        projectId: "abc123def456",
        pdfPath: "build/overleaf/main.pdf",
      });
      const tasks = JSON.parse(await readFile(join(root, ".vscode", "tasks.json"), "utf8")) as {
        tasks: Array<{ label?: string }>;
      };
      expect(JSON.parse(await readFile(join(root, ".vscode", "settings.json"), "utf8"))).toMatchObject({
        "olcx.pdfPath": "build/overleaf/main.pdf",
        "olcx.rootDocument": "main.tex",
      });
      expect(tasks.tasks).toContainEqual(expect.objectContaining({ label: "olcx: status" }));
      expect(tasks.tasks).toContainEqual(expect.objectContaining({ label: "olcx: watch" }));
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps deprecated init --vscode compatibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-cli-init-vscode-compat-test-"));
    const capture = createIo();
    const previous = process.cwd();

    try {
      await mkdir(join(root, ".git"), { recursive: true });
      process.chdir(root);
      const exitCode = await run(["node", "olcx", "init", "--project", "abc123def456", "--vscode"], capture.io);

      expect(exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(capture.stderr()).toBe("");
      expect(JSON.parse(await readFile(join(root, ".olcx", "config.json"), "utf8"))).toMatchObject({
        projectId: "abc123def456",
      });
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports invalid init project references as user input errors", async () => {
    const capture = createIo();
    const exitCode = await run(
      ["node", "olcx", "init", "--project", "https://example.com/project/abc123def456"],
      capture.io
    );

    expect(exitCode).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.exitCode()).toBe(EXIT_CODES.USER_INPUT_ERROR);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toContain("Error:");
    expect(capture.stderr()).toContain("Next:");
  });

  it("detects non-interactive mode without prompting", () => {
    expect(isNonInteractive({ OLCX_NON_INTERACTIVE: "1" }, true)).toBe(true);
    expect(isNonInteractive({ CI: "true" }, true)).toBe(true);
    expect(isNonInteractive({}, false)).toBe(true);
    expect(isNonInteractive({}, true)).toBe(false);
  });

  it("redacts cookie, session, password, account, and project-like values", () => {
    const raw = {
      sessionCookie: "<fake-session-cookie>",
      password: "<fake-password>",
      account: "author@example.test",
      projectId: "0123456789abcdef01234567",
      note: "https://www.overleaf.com/project/0123456789abcdef01234567?from=test",
    };

    const redacted = redactSensitive(raw);

    expect(redacted).toContain("<redacted-secret>");
    expect(redacted).toContain("<redacted-account>");
    expect(redacted).toContain("<redacted-project-id>");
    expect(redacted).not.toContain("<fake-session-cookie>");
    expect(redacted).not.toContain("<fake-password>");
    expect(redacted).not.toContain("author@example.test");
    expect(redacted).not.toContain("0123456789abcdef01234567");
  });

  it("redacts plain text account labels in failure strings", () => {
    const redacted = redactSensitive(
      "failure accountLabel=work account=lab cookie=secret https://cn.overleaf.com/project/0123456789abcdef01234567"
    );

    expect(redacted).toContain("<redacted-account>");
    expect(redacted).toContain("cookie=<redacted-secret>");
    expect(redacted).toContain("https://www.overleaf.com/project/<redacted-project-id>");
    expect(redacted).not.toContain("accountLabel=work");
    expect(redacted).not.toContain("account=lab");
    expect(redacted).not.toContain("work");
    expect(redacted).not.toContain("lab");
    expect(redacted).not.toContain("cookie=secret");
    expect(redacted).not.toContain("0123456789abcdef01234567");
  });

  it("formats CLI failures without leaking sensitive detail fields", () => {
    const formatted = formatCliFailure(
      plannedCommandFailure("auth", {
        sessionCookie: "<fake-session-cookie>",
        projectId: "0123456789abcdef01234567",
      })
    );

    expect(formatted).toContain("Error:");
    expect(formatted).toContain("Next:");
    expect(formatted).not.toContain("<fake-session-cookie>");
    expect(formatted).not.toContain("0123456789abcdef01234567");
  });
});
