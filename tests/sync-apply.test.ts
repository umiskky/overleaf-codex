import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAuth } from "../src/auth/types";
import type {
  BackendFileInput,
  BackendUploadInput,
  OverleafBackend,
  RemoteFile,
} from "../src/backend/types";
import { applySyncPlan } from "../src/sync/apply";
import { createSyncPlan, sha256Hex } from "../src/sync/plan";
import type { LocalFileSnapshot, RemoteFileSnapshot, SyncConflict, SyncOperation, SyncPlan } from "../src/sync/types";

const projectId = "<overleaf-project-id>";
const now = "2026-06-25T08:00:00.000Z";
const auth: ProjectAuth = {
  schemaVersion: 1,
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: now,
  source: "env",
};

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-sync-apply-test-"));
  try {
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function writeFixture(projectRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = join(projectRoot, ...path.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function local(path: string, content: string): LocalFileSnapshot {
  return {
    path,
    exists: true,
    contentHash: sha256Hex(content),
    size: Buffer.byteLength(content),
    modifiedAt: now,
  };
}

function remote(path: string, content: string): RemoteFileSnapshot {
  return {
    path,
    exists: true,
    contentHash: sha256Hex(content),
    size: Buffer.byteLength(content),
    modifiedAt: now,
    remoteId: `remote-${path}`,
    revision: `rev-${path}`,
  };
}

function plan(input: {
  dryRun?: boolean;
  localFiles?: LocalFileSnapshot[];
  remoteFiles?: RemoteFileSnapshot[];
}): SyncPlan {
  return createSyncPlan({
    projectId,
    createdAt: now,
    dryRun: input.dryRun ?? false,
    state: {
      schemaVersion: 1,
      hashAlgorithm: "sha256",
      updatedAt: now,
      files: {},
    },
    localFiles: input.localFiles ?? [],
    remoteFiles: input.remoteFiles ?? [],
  });
}

describe("safe sync apply", () => {
  it("uploads exact local bytes and returns uploaded remote metadata", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = recordingBackend();
      const syncPlan = plan({ localFiles: [local("main.tex", "local main\n")] });

      const result = await applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan });

      expect(backend.uploads).toEqual([
        expect.objectContaining({
          path: "main.tex",
          text: "local main\n",
        }),
      ]);
      expect(result.uploaded.get("main.tex")).toMatchObject({
        path: "main.tex",
        exists: true,
        contentHash: sha256Hex("local main\n"),
        remoteId: "uploaded-main.tex",
        revision: "rev-main.tex",
      });
    });
  });

  it("downloads exact remote bytes and creates parent directories", async () => {
    await withTempProject(async (projectRoot) => {
      const backend = recordingBackend({ downloadBytes: Buffer.from("remote intro\n", "utf8") });
      const syncPlan = plan({ remoteFiles: [remote("sections/intro.tex", "remote intro\n")] });

      const result = await applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan });

      await expect(readFile(join(projectRoot, "sections", "intro.tex"), "utf8")).resolves.toBe("remote intro\n");
      expect(backend.downloads).toEqual([expect.objectContaining({ path: "sections/intro.tex" })]);
      expect(result.downloaded).toEqual(["sections/intro.tex"]);
    });
  });

  it("downloads with a default concurrency limit of five", async () => {
    await withTempProject(async (projectRoot) => {
      let activeDownloads = 0;
      let maxActiveDownloads = 0;
      const remoteFiles = Array.from({ length: 6 }, (_value, index) =>
        remote(`sections/file-${index}.tex`, `sections/file-${index}.tex\n`)
      );
      const backend = recordingBackend({
        downloadFile: async (input) => {
          activeDownloads += 1;
          maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
          await delay(20);
          activeDownloads -= 1;
          return Buffer.from(`${input.path}\n`, "utf8");
        },
      });
      const syncPlan = plan({ remoteFiles });

      const result = await applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan });

      expect(maxActiveDownloads).toBe(5);
      expect(result.downloaded.sort()).toEqual(remoteFiles.map((file) => file.path).sort());
    });
  });

  it("retries transient download failures and records transfer reports", async () => {
    await withTempProject(async (projectRoot) => {
      const sleeps: number[] = [];
      let attempts = 0;
      const backend = recordingBackend({
        downloadFile: async (input) => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error(`temporary download failure for ${input.path}`);
          }
          return Buffer.from(`${input.path}\n`, "utf8");
        },
      });
      const syncPlan = plan({ remoteFiles: [remote("sections/intro.tex", "remote intro\n")] });

      const result = await applySyncPlan({
        projectRoot,
        backend,
        projectId,
        auth,
        plan: syncPlan,
        retry: { maxAttempts: 3, delayMs: 7 },
        timeout: {
          baseMs: 100,
          unknownSizeMs: 1000,
          minBytesPerSecond: 100,
          bufferRatio: 1,
          maxMs: 2000,
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      expect(attempts).toBe(3);
      expect(sleeps).toEqual([7, 7]);
      expect(result.downloaded).toEqual(["sections/intro.tex"]);
      expect(result.transferReports).toEqual([
        expect.objectContaining({
          status: "ok",
          operation: "download",
          path: "sections/intro.tex",
          attempts: 3,
          size: Buffer.byteLength("sections/intro.tex\n"),
        }),
      ]);
    });
  });

  it("retries transient upload failures and records transfer reports", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const sleeps: number[] = [];
      let attempts = 0;
      const backend = recordingBackend({
        uploadFile: async (input) => {
          attempts += 1;
          if (attempts < 2) {
            throw new Error(`temporary upload failure for ${input.path}`);
          }
          return {
            path: input.path,
            kind: "file",
            contentHash: sha256Hex(input.bytes),
            size: input.bytes.byteLength,
            modifiedAt: now,
            remoteId: `uploaded-${input.path}`,
            revision: `rev-${input.path}`,
          };
        },
      });
      const syncPlan = plan({ localFiles: [local("main.tex", "local main\n")] });

      const result = await applySyncPlan({
        projectRoot,
        backend,
        projectId,
        auth,
        plan: syncPlan,
        retry: { maxAttempts: 2, delayMs: 9 },
        timeout: {
          baseMs: 100,
          unknownSizeMs: 1000,
          minBytesPerSecond: 100,
          bufferRatio: 1,
          maxMs: 2000,
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      expect(attempts).toBe(2);
      expect(sleeps).toEqual([9]);
      expect(result.uploaded.get("main.tex")).toMatchObject({ remoteId: "uploaded-main.tex" });
      expect(result.transferReports).toEqual([
        expect.objectContaining({
          status: "ok",
          operation: "upload",
          path: "main.tex",
          attempts: 2,
          size: Buffer.byteLength("local main\n"),
        }),
      ]);
    });
  });

  it("fails hanging downloads with a bounded network error during apply", async () => {
    await withTempProject(async (projectRoot) => {
      const backend = recordingBackend({
        downloadFile: async () =>
          new Promise<Uint8Array>((_resolve, reject) => {
            setTimeout(() => reject(new Error("backend download did not time out")), 50);
          }),
      });
      const syncPlan = plan({ remoteFiles: [remote("sections/intro.tex", "remote intro\n")] });

      await expect(
        applySyncPlan({
          projectRoot,
          backend,
          projectId,
          auth,
          plan: syncPlan,
          downloadTimeoutMs: 10,
        })
      ).rejects.toMatchObject({
        code: "BACKEND_NETWORK_ERROR",
        details: { path: "sections/intro.tex" },
      });
    });
  });

  it("does not upload, download, or write local files for dry-run plans", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = recordingBackend({ downloadBytes: Buffer.from("remote refs\n", "utf8") });
      const syncPlan = plan({
        dryRun: true,
        localFiles: [local("main.tex", "local main\n")],
        remoteFiles: [remote("refs.bib", "remote refs\n")],
      });

      const result = await applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan });

      expect(result.uploaded.size).toBe(0);
      expect(result.downloaded).toEqual([]);
      expect(backend.uploads).toEqual([]);
      expect(backend.downloads).toEqual([]);
      await expect(readFile(join(projectRoot, "refs.bib"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects delete operations as unsafe in the CLI v1 apply path", async () => {
    await withTempProject(async (projectRoot) => {
      const backend = recordingBackend();
      const syncPlan = manualPlan([
        {
          type: "deleteLocal",
          path: "main.tex",
          reason: "remote deletion explicitly allowed",
        },
        {
          type: "deleteRemote",
          path: "refs.bib",
          reason: "local deletion explicitly allowed",
        },
      ]);

      await expect(applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan })).rejects.toMatchObject({
        code: "SYNC_UNSAFE_OPERATION",
        exitCode: 6,
      });
      expect(backend.uploads).toEqual([]);
      expect(backend.downloads).toEqual([]);
    });
  });

  it("rejects conflicts before any upload or download", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = recordingBackend({ downloadBytes: Buffer.from("remote refs\n", "utf8") });
      const uploadOperation: SyncOperation = {
        type: "upload",
        path: "main.tex",
        reason: "local-only file",
        local: local("main.tex", "local main\n"),
      };
      const conflict: SyncConflict = {
        path: "refs.bib",
        reason: "both-modified",
        recommendation: "Review both versions, merge manually, then run olcx sync --dry-run.",
      };
      const syncPlan = manualPlan([uploadOperation], [conflict]);

      await expect(applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan })).rejects.toMatchObject({
        code: "SYNC_CONFLICT",
        exitCode: 6,
      });
      expect(backend.uploads).toEqual([]);
      expect(backend.downloads).toEqual([]);
    });
  });

  it("rejects unsafe local paths before reading or writing files", async () => {
    await withTempProject(async (projectRoot) => {
      const backend = recordingBackend({ downloadBytes: Buffer.from("outside\n", "utf8") });
      const syncPlan = manualPlan([
        {
          type: "download",
          path: "../outside.tex",
          reason: "remote-only file",
          remote: remote("../outside.tex", "outside\n"),
        },
      ]);

      await expect(applySyncPlan({ projectRoot, backend, projectId, auth, plan: syncPlan })).rejects.toMatchObject({
        code: "SYNC_UNSAFE_OPERATION",
      });
      expect(backend.downloads).toEqual([]);
    });
  });
});

function manualPlan(operations: SyncOperation[], conflicts: SyncConflict[] = []): SyncPlan {
  return {
    projectId,
    createdAt: now,
    dryRun: false,
    operations,
    conflicts,
    summary: operations.reduce(
      (summary, operation) => ({
        ...summary,
        [operation.type]: summary[operation.type] + 1,
      }),
      {
        upload: 0,
        download: 0,
        deleteLocal: 0,
        deleteRemote: 0,
        unchanged: 0,
        conflict: 0,
        ignored: 0,
      }
    ),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordingBackend(
  options: {
    downloadBytes?: Uint8Array;
    downloadFile?: (input: BackendFileInput) => Promise<Uint8Array>;
    uploadFile?: (input: BackendUploadInput) => Promise<RemoteFile>;
  } = {}
): OverleafBackend & {
  uploads: { path: string; text: string }[];
  downloads: BackendFileInput[];
} {
  const uploads: { path: string; text: string }[] = [];
  const downloads: BackendFileInput[] = [];
  return {
    uploads,
    downloads,
    validateAuth: async () => ({ authenticated: true }),
    listFiles: async () => [],
    downloadFile: async (input) => {
      downloads.push(input);
      if (options.downloadFile) {
        return options.downloadFile(input);
      }
      return new Uint8Array(options.downloadBytes ?? Buffer.from("", "utf8"));
    },
    uploadFile: async (input: BackendUploadInput): Promise<RemoteFile> => {
      if (options.uploadFile) {
        return options.uploadFile(input);
      }
      const text = Buffer.from(input.bytes).toString("utf8");
      uploads.push({ path: input.path, text });
      return {
        path: input.path,
        kind: "file",
        contentHash: sha256Hex(input.bytes),
        size: input.bytes.byteLength,
        modifiedAt: now,
        remoteId: `uploaded-${input.path}`,
        revision: `rev-${input.path}`,
      };
    },
    deleteFile: async () => {
      throw new Error("deleteFile should not be called by applySyncPlan");
    },
    compile: async () => {
      throw new Error("compile is not used by apply tests");
    },
    downloadPdf: async () => {
      throw new Error("downloadPdf is not used by apply tests");
    },
  };
}
