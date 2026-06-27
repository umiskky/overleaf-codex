import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAuth } from "../src/auth/types";
import { writeProjectAuth } from "../src/auth/projectAuth";
import { writeProjectConfig } from "../src/config/projectConfig";
import { createDefaultProjectConfig } from "../src/config/types";
import { syncProject } from "../src/commands/sync";
import { sha256Hex } from "../src/sync/plan";
import { createLocalSnapshot, createRemoteSnapshot } from "../src/sync/snapshot";
import {
  getConflictReportPath,
  getSyncStatePath,
  readSyncState,
  writeSyncState,
} from "../src/sync/state";
import type { OverleafBackend } from "../src/backend/types";
import type { SyncStateFile } from "../src/sync/types";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";

const projectId = "<overleaf-project-id>";
const now = "2026-06-25T08:00:00.000Z";
const later = "2026-06-25T09:00:00.000Z";
const auth: ProjectAuth = {
  schemaVersion: 1,
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: now,
  source: "env",
};

async function withTempProject<T>(
  fn: (projectRoot: string) => Promise<T>,
  options: {
    writeConfig?: boolean;
    writeAuth?: boolean;
    ignore?: string[];
    downloadConcurrency?: number;
    uploadConcurrency?: number;
    retry?: { maxAttempts?: number; delayMs?: number };
    remoteCheck?: "local-baseline" | "strict";
  } = {}
): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-sync-flow-test-"));
  try {
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    if (options.writeConfig !== false) {
      await writeProjectConfig(
        projectRoot,
        createDefaultProjectConfig({
          projectId,
          sync: {
            ignore: [".olcx/config.json", ...(options.ignore ?? [])],
            downloadConcurrency: options.downloadConcurrency,
            uploadConcurrency: options.uploadConcurrency,
            retry: options.retry,
            remoteCheck: options.remoteCheck,
          },
        })
      );
    }
    if (options.writeAuth !== false) {
      await writeProjectAuth(projectRoot, auth);
    }
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

async function readRemoteText(backend: ReturnType<typeof createFakeOverleafBackend>, path: string): Promise<string> {
  const bytes = await backend.downloadFile({ projectId, auth, path });
  return Buffer.from(bytes).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseState(files: Record<string, string>): SyncStateFile {
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

describe("sync workflow", () => {
  it("creates the backend with the configured Overleaf base URL", async () => {
    await withTempProject(async (projectRoot) => {
      await writeProjectConfig(
        projectRoot,
        createDefaultProjectConfig({
          projectId,
          overleaf: { baseUrl: "https://cn.overleaf.com" },
          sync: { ignore: [".olcx/config.json"] },
        })
      );
      const capturedOptions: unknown[] = [];
      const fakeBackend = createFakeOverleafBackend({ projects: [{ projectId }] });

      await syncProject({
        cwd: projectRoot,
        dryRun: true,
        env: {},
        createBackend: (options) => {
          capturedOptions.push(options);
          return fakeBackend;
        },
      });

      expect(capturedOptions).toEqual([{ baseUrl: "https://cn.overleaf.com" }]);
    });
  });

  it("uploads a local-only file and writes sync state after apply", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({ projects: [{ projectId }] });

      const result = await syncProject({
        cwd: projectRoot,
        backend,
        env: {},
        now: () => new Date(later),
      });

      expect(result.output).toContain("olcx sync");
      expect(result.output).toContain("Plan: upload 1, download 0");
      expect(result.output).toContain("Uploaded:\n- main.tex");
      expect(result.output).toContain("olcx sync summary");
      expect(result.output).toContain("Summary: 1 ok, 0 failed, 0 skipped");
      expect(result.output).toContain("| Status | Op     | Path     | Size");
      expect(result.output).not.toContain(projectId);
      expect(result.output).not.toContain(auth.sessionCookie);
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("local main\n");
      const state = await readSyncState(projectRoot);
      expect(state.files["main.tex"]).toMatchObject({
        contentHash: sha256Hex("local main\n"),
        syncedAt: later,
      });
    });
  });

  it("downloads a remote-only file and writes sync state after apply", async () => {
    await withTempProject(async (projectRoot) => {
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "main.tex", text: "remote main\n" }] }],
      });

      const result = await syncProject({
        cwd: projectRoot,
        backend,
        env: {},
        now: () => new Date(later),
        strict: true,
      });

      expect(result.output).toContain("Plan: upload 0, download 1");
      expect(result.output).toContain("Downloaded:\n- main.tex");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("remote main\n");
      const state = await readSyncState(projectRoot);
      expect(state.files["main.tex"]).toMatchObject({
        contentHash: sha256Hex("remote main\n"),
        syncedAt: later,
      });
    });
  });

  it("uploads and downloads different files from an existing baseline in one run", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      await writeFixture(projectRoot, "refs.bib", "base\n");
      await writeSyncState(projectRoot, baseState({ "main.tex": "base\n", "refs.bib": "base\n" }));
      const backend = createFakeOverleafBackend({
        projects: [
          {
            projectId,
            files: [
              { path: "main.tex", text: "base\n" },
              { path: "refs.bib", text: "remote change\n" },
            ],
          },
        ],
      });

      const result = await syncProject({
        cwd: projectRoot,
        backend,
        env: {},
        now: () => new Date(later),
        strict: true,
      });

      expect(result.plan.summary).toMatchObject({ upload: 1, download: 1, conflict: 0 });
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("local change\n");
      await expect(readFile(join(projectRoot, "refs.bib"), "utf8")).resolves.toBe("remote change\n");
      const state = await readSyncState(projectRoot);
      expect(Object.keys(state.files).sort()).toEqual(["main.tex", "refs.bib"]);
      expect(state.files["main.tex"].contentHash).toBe(sha256Hex("local change\n"));
      expect(state.files["refs.bib"].contentHash).toBe(sha256Hex("remote change\n"));
    });
  });

  it("fast sync uploads local baseline changes without downloading remote hashes", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      await writeSyncState(projectRoot, baseState({ "main.tex": "base\n" }));
      let downloads = 0;
      let uploadedText = "";
      const backend: OverleafBackend = {
        validateAuth: async () => ({ authenticated: true }),
        listFiles: async () => [{ path: "main.tex", kind: "file", remoteId: "remote-main" }],
        downloadFile: async () => {
          downloads += 1;
          throw new Error("fast sync should not download remote files for hash checks");
        },
        uploadFile: async (input) => {
          uploadedText = Buffer.from(input.bytes).toString("utf8");
          return {
            path: input.path,
            kind: "file",
            contentHash: sha256Hex(input.bytes),
            size: input.bytes.byteLength,
            remoteId: "remote-main",
            revision: "rev-main",
          };
        },
        deleteFile: async () => {
          throw new Error("not used");
        },
        compile: async () => {
          throw new Error("not used");
        },
        downloadPdf: async () => {
          throw new Error("not used");
        },
      };

      const result = await syncProject({ cwd: projectRoot, backend, env: {}, now: () => new Date(later) });

      expect(downloads).toBe(0);
      expect(uploadedText).toBe("local change\n");
      expect(result.plan.summary).toMatchObject({ upload: 1, download: 0, conflict: 0 });
      const state = await readSyncState(projectRoot);
      expect(state.files["main.tex"].contentHash).toBe(sha256Hex("local change\n"));
    });
  });

  it("strict sync downloads remote hashes and pauses on same-file conflicts", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      await writeSyncState(projectRoot, baseState({ "main.tex": "base\n" }));
      let downloads = 0;
      const backend: OverleafBackend = {
        validateAuth: async () => ({ authenticated: true }),
        listFiles: async () => [{ path: "main.tex", kind: "file", remoteId: "remote-main" }],
        downloadFile: async () => {
          downloads += 1;
          return Buffer.from("remote change\n", "utf8");
        },
        uploadFile: async () => {
          throw new Error("conflict should stop uploads");
        },
        deleteFile: async () => {
          throw new Error("not used");
        },
        compile: async () => {
          throw new Error("not used");
        },
        downloadPdf: async () => {
          throw new Error("not used");
        },
      };

      await expect(
        syncProject({
          cwd: projectRoot,
          backend,
          env: {},
          now: () => new Date(later),
          strict: true,
        })
      ).rejects.toMatchObject({
        code: "SYNC_CONFLICT",
        details: { conflicts: [{ path: "main.tex", reason: "both-modified" }] },
      });
      expect(downloads).toBe(1);
    });
  });

  it("pauses on same-file conflicts without applying upload or download", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      const previous = baseState({ "main.tex": "base\n" });
      await writeSyncState(projectRoot, previous);
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "main.tex", text: "remote change\n" }] }],
      });

      await expect(
        syncProject({
          cwd: projectRoot,
          backend,
          env: {},
          now: () => new Date(later),
          strict: true,
        })
      ).rejects.toMatchObject({
          code: "SYNC_CONFLICT",
          exitCode: 6,
          details: {
            conflicts: [{ path: "main.tex", reason: "both-modified" }],
            reportPath: ".olcx/state/conflicts.json",
          },
        }
      );

      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("local change\n");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("remote change\n");
      await expect(readSyncState(projectRoot)).resolves.toEqual(previous);
      const report = JSON.parse(await readFile(getConflictReportPath(projectRoot), "utf8"));
      expect(report.conflicts).toEqual([expect.objectContaining({ path: "main.tex", reason: "both-modified" })]);
    });
  });

  it("dry-run conflicts do not write or clear conflict reports", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      await mkdir(join(projectRoot, ".olcx", "state"), { recursive: true });
      await writeFile(getConflictReportPath(projectRoot), "stale conflict report\n", "utf8");
      const previous = baseState({ "main.tex": "base\n" });
      await writeSyncState(projectRoot, previous);
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "main.tex", text: "remote change\n" }] }],
      });

      await expect(
        syncProject({
          cwd: projectRoot,
          backend,
          env: {},
          dryRun: true,
          now: () => new Date(later),
          strict: true,
        })
      ).rejects.toMatchObject({
        code: "SYNC_CONFLICT",
        exitCode: 6,
        details: {
          conflicts: [{ path: "main.tex", reason: "both-modified" }],
        },
      });

      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).resolves.toBe("stale conflict report\n");
      await expect(readSyncState(projectRoot)).resolves.toEqual(previous);
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("local change\n");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("remote change\n");
    });
  });

  it("dry-run plans uploads and downloads without local, remote, state, or conflict-report mutation", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "refs.bib", text: "@article{fake,title={Fake}}\n" }] }],
      });

      const result = await syncProject({
        cwd: projectRoot,
        backend,
        env: {},
        dryRun: true,
        now: () => new Date(later),
        strict: true,
      });

      expect(result.output).toContain("olcx sync --strict --dry-run");
      expect(result.output).toContain("Uploads:\n- main.tex");
      expect(result.output).toContain("Downloads:\n- refs.bib");
      expect(result.output).toContain("No files changed.");
      await expect(readFile(join(projectRoot, "refs.bib"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(backend.downloadFile({ projectId, auth, path: "main.tex" })).rejects.toMatchObject({
        code: "BACKEND_PROTOCOL_ERROR",
      });
      await expect(readFile(getSyncStatePath(projectRoot), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not upload, download, delete, or persist ignored paths", async () => {
    await withTempProject(
      async (projectRoot) => {
        await writeFixture(projectRoot, "main.aux", "ignored\n");
        await writeFixture(projectRoot, "drafts/private.tex", "ignored\n");
        const backend = createFakeOverleafBackend({
          projects: [
            {
              projectId,
              files: [
                { path: "build/overleaf/main.pdf", text: "ignored\n" },
                { path: "main.log", text: "ignored\n" },
                { path: "drafts/remote.tex", text: "ignored\n" },
              ],
            },
          ],
        });

        const result = await syncProject({ cwd: projectRoot, backend, env: {}, now: () => new Date(later) });

        expect(result.plan.summary).toMatchObject({ upload: 0, download: 0, ignored: 0, conflict: 0 });
        const state = await readSyncState(projectRoot);
        expect(state.files).toEqual({});
        await expect(readRemoteText(backend, "build/overleaf/main.pdf")).resolves.toBe("ignored\n");
        await expect(readFile(join(projectRoot, "drafts", "remote.tex"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { ignore: ["drafts/**"] }
    );
  });

  it("keeps generated local olcx, git, and editor metadata out of local snapshots", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, ".gitignore", "build/overleaf/\n");
      await writeFixture(projectRoot, ".olcx/config.json", "{}\n");
      await writeFixture(projectRoot, ".olcx/auth.local.json", "{}\n");
      await writeFixture(projectRoot, ".vscode/settings.json", "{}\n");
      await writeFixture(projectRoot, "main.tex", "local main\n");

      const snapshot = await createLocalSnapshot({ projectRoot });

      expect(snapshot.map((file) => file.path)).toEqual(["main.tex"]);
    });
  });

  it("fails remote hash downloads with a bounded network error instead of hanging", async () => {
    const hangingBackend: OverleafBackend = {
      validateAuth: async () => ({ authenticated: true }),
      listFiles: async () => [{ path: "main.tex", kind: "file", remoteId: "remote-main" }],
      downloadFile: async () => new Promise<Uint8Array>(() => {}),
      uploadFile: async () => {
        throw new Error("not used");
      },
      deleteFile: async () => {
        throw new Error("not used");
      },
      compile: async () => {
        throw new Error("not used");
      },
      downloadPdf: async () => {
        throw new Error("not used");
      },
    };

    await expect(
      createRemoteSnapshot({
        backend: hangingBackend,
        projectId,
        auth,
        downloadTimeoutMs: 10,
      })
    ).rejects.toMatchObject({
      code: "BACKEND_NETWORK_ERROR",
      details: { path: "main.tex" },
    });
  });

  it("dry-runs remote-only files without downloading them for hash metadata", async () => {
    await withTempProject(async (projectRoot) => {
      let downloads = 0;
      const backend: OverleafBackend = {
        validateAuth: async () => ({ authenticated: true }),
        listFiles: async () => [
          {
            path: "main.tex",
            kind: "file",
            remoteId: "remote-main",
            binary: false,
          },
          {
            path: "figures/ablation_scenario_settings.pdf",
            kind: "file",
            remoteId: "remote-pdf",
            binary: true,
          },
        ],
        downloadFile: async () => {
          downloads += 1;
          throw new Error("dry-run should not download remote-only files");
        },
        uploadFile: async () => {
          throw new Error("not used");
        },
        deleteFile: async () => {
          throw new Error("not used");
        },
        compile: async () => {
          throw new Error("not used");
        },
        downloadPdf: async () => {
          throw new Error("not used");
        },
      };

      const result = await syncProject({
        cwd: projectRoot,
        backend,
        env: {},
        dryRun: true,
        now: () => new Date(later),
        strict: true,
      });

      expect(downloads).toBe(0);
      expect(result.plan.summary).toMatchObject({ download: 2, conflict: 0 });
      expect(result.output).toContain("Downloads:\n- figures/ablation_scenario_settings.pdf");
      expect(result.output).toContain("- main.tex");
      await expect(readFile(join(projectRoot, "figures", "ablation_scenario_settings.pdf"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("downloads a remote-only binary file once during apply and records the downloaded hash", async () => {
    await withTempProject(async (projectRoot) => {
      const pdfBytes = Buffer.from("%PDF-1.4\nfake pdf bytes\n", "utf8");
      let downloads = 0;
      const backend: OverleafBackend = {
        validateAuth: async () => ({ authenticated: true }),
        listFiles: async () => [
          {
            path: "figures/ablation_scenario_settings.pdf",
            kind: "file",
            remoteId: "remote-pdf",
            revision: "rev-pdf",
            binary: true,
          },
        ],
        downloadFile: async () => {
          downloads += 1;
          return pdfBytes;
        },
        uploadFile: async () => {
          throw new Error("not used");
        },
        deleteFile: async () => {
          throw new Error("not used");
        },
        compile: async () => {
          throw new Error("not used");
        },
        downloadPdf: async () => {
          throw new Error("not used");
        },
      };

      const result = await syncProject({
        cwd: projectRoot,
        backend,
        env: {},
        now: () => new Date(later),
        strict: true,
      });

      expect(downloads).toBe(1);
      expect(result.plan.summary).toMatchObject({ download: 1, conflict: 0 });
      await expect(readFile(join(projectRoot, "figures", "ablation_scenario_settings.pdf"))).resolves.toEqual(
        pdfBytes
      );
      const state = await readSyncState(projectRoot);
      expect(state.files["figures/ablation_scenario_settings.pdf"]).toMatchObject({
        path: "figures/ablation_scenario_settings.pdf",
        contentHash: sha256Hex(pdfBytes),
        size: pdfBytes.byteLength,
        remoteId: "remote-pdf",
        remoteRevision: "rev-pdf",
        syncedAt: later,
      });
    });
  });

  it("uses configured retry settings when applying downloads", async () => {
    await withTempProject(
      async (projectRoot) => {
        let attempts = 0;
        const backend: OverleafBackend = {
          validateAuth: async () => ({ authenticated: true }),
          listFiles: async () => [{ path: "main.tex", kind: "file", remoteId: "remote-main" }],
          downloadFile: async () => {
            attempts += 1;
            if (attempts < 2) {
              throw new Error("temporary download failure");
            }
            return Buffer.from("remote main\n", "utf8");
          },
          uploadFile: async () => {
            throw new Error("not used");
          },
          deleteFile: async () => {
            throw new Error("not used");
          },
          compile: async () => {
            throw new Error("not used");
          },
          downloadPdf: async () => {
            throw new Error("not used");
          },
        };

        const result = await syncProject({
          cwd: projectRoot,
          backend,
          env: {},
          now: () => new Date(later),
          strict: true,
        });

        expect(attempts).toBe(2);
        expect(result.plan.summary).toMatchObject({ download: 1, conflict: 0 });
        await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("remote main\n");
      },
      { retry: { maxAttempts: 2, delayMs: 0 } }
    );
  });

  it("uses configured sync download concurrency during apply", async () => {
    await withTempProject(
      async (projectRoot) => {
        const paths = ["a.tex", "b.tex", "c.tex", "d.tex"];
        let activeDownloads = 0;
        let maxActiveDownloads = 0;
        const backend: OverleafBackend = {
          validateAuth: async () => ({ authenticated: true }),
          listFiles: async () => paths.map((path) => ({ path, kind: "file" })),
          downloadFile: async (input) => {
            activeDownloads += 1;
            maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
            await delay(20);
            activeDownloads -= 1;
            return Buffer.from(`${input.path}\n`, "utf8");
          },
          uploadFile: async () => {
            throw new Error("not used");
          },
          deleteFile: async () => {
            throw new Error("not used");
          },
          compile: async () => {
            throw new Error("not used");
          },
          downloadPdf: async () => {
            throw new Error("not used");
          },
        };

        const result = await syncProject({
          cwd: projectRoot,
          backend,
          env: {},
          now: () => new Date(later),
          strict: true,
        });

        expect(maxActiveDownloads).toBe(2);
        expect(result.plan.summary).toMatchObject({ download: 4, conflict: 0 });
        const state = await readSyncState(projectRoot);
        expect(Object.keys(state.files).sort()).toEqual(paths);
      },
      { downloadConcurrency: 2 }
    );
  });

  it("clears stale conflict reports after a successful non-dry-run sync", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      await mkdir(join(projectRoot, ".olcx", "state"), { recursive: true });
      await writeFile(getConflictReportPath(projectRoot), "stale conflict report\n", "utf8");
      const backend = createFakeOverleafBackend({ projects: [{ projectId }] });

      await syncProject({ cwd: projectRoot, backend, env: {}, now: () => new Date(later) });

      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("fails with PROJECT_CONFIG_NOT_FOUND when config is missing", async () => {
    await withTempProject(
      async (projectRoot) => {
        const backend = createFakeOverleafBackend({ projects: [{ projectId }] });

        await expect(syncProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          code: "PROJECT_CONFIG_NOT_FOUND",
          exitCode: 3,
        });
      },
      { writeConfig: false }
    );
  });

  it("fails with PROJECT_AUTH_NOT_FOUND when auth is missing", async () => {
    await withTempProject(
      async (projectRoot) => {
        const backend = createFakeOverleafBackend({ projects: [{ projectId }] });

        await expect(syncProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          code: "PROJECT_AUTH_NOT_FOUND",
          exitCode: 4,
        });
      },
      { writeAuth: false }
    );
  });
});
