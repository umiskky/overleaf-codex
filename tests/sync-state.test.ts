import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConflictReport } from "../src/sync/conflicts";
import { createSyncPlan, sha256Hex } from "../src/sync/plan";
import {
  buildNextSyncState,
  clearConflictReport,
  createEmptySyncState,
  getConflictReportPath,
  getSyncStatePath,
  readSyncState,
  writeConflictReport,
  writeSyncState,
} from "../src/sync/state";
import type { LocalFileSnapshot, RemoteFileSnapshot, SyncStateFile } from "../src/sync/types";

const now = "2026-06-25T08:00:00.000Z";
const later = "2026-06-25T09:00:00.000Z";

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-sync-state-test-"));
  try {
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function stateWith(path: string, content: string): SyncStateFile {
  const contentHash = sha256Hex(content);
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: now,
    files: {
      [path]: {
        path,
        contentHash,
        size: Buffer.byteLength(content),
        localModifiedAt: "2026-06-25T07:00:00.000Z",
        remoteModifiedAt: "2026-06-25T07:00:00.000Z",
        remoteId: "remote-main",
        remoteRevision: "rev-base",
        syncedAt: "2026-06-25T07:00:00.000Z",
      },
    },
  };
}

function local(path: string, content: string): LocalFileSnapshot {
  return {
    path,
    exists: true,
    contentHash: sha256Hex(content),
    size: Buffer.byteLength(content),
    modifiedAt: "2026-06-25T08:30:00.000Z",
  };
}

function remote(path: string, content: string): RemoteFileSnapshot {
  return {
    path,
    exists: true,
    contentHash: sha256Hex(content),
    size: Buffer.byteLength(content),
    modifiedAt: "2026-06-25T08:45:00.000Z",
    remoteId: `remote-${path}`,
    revision: `rev-${path}`,
  };
}

describe("sync state persistence", () => {
  it("returns an empty schema version 1 state when sync state is missing", async () => {
    await withTempProject(async (projectRoot) => {
      await expect(readSyncState(projectRoot, { now: () => new Date(now) })).resolves.toEqual(
        createEmptySyncState(now)
      );
    });
  });

  it("reads a valid sync state unchanged", async () => {
    await withTempProject(async (projectRoot) => {
      const state = stateWith("main.tex", "base\n");
      await mkdir(join(projectRoot, ".olcx", "state"), { recursive: true });
      await writeFile(getSyncStatePath(projectRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");

      await expect(readSyncState(projectRoot)).resolves.toEqual(state);
    });
  });

  it("throws an actionable redacted config error for invalid sync state", async () => {
    await withTempProject(async (projectRoot) => {
      await mkdir(join(projectRoot, ".olcx", "state"), { recursive: true });
      await writeFile(getSyncStatePath(projectRoot), "{\"schemaVersion\":2}\n", "utf8");

      await expect(readSyncState(projectRoot)).rejects.toMatchObject({
        name: "OlcxError",
        code: "PROJECT_CONFIG_INVALID",
        message: "Sync state is invalid.",
        hint: "Remove .olcx/state/sync.json or run olcx sync after resolving the state issue.",
        details: {
          path: ".olcx/state/sync.json",
        },
      });
    });
  });

  it("writes sync state with a trailing newline and creates the state directory", async () => {
    await withTempProject(async (projectRoot) => {
      const state = stateWith("main.tex", "base\n");

      await writeSyncState(projectRoot, state);

      const raw = await readFile(getSyncStatePath(projectRoot), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toEqual(state);
    });
  });

  it("writes a conflict report with only conflict metadata", async () => {
    await withTempProject(async (projectRoot) => {
      const base = stateWith("main.tex", "base\n");
      const plan = createSyncPlan({
        projectId: "<overleaf-project-id>",
        createdAt: later,
        dryRun: false,
        state: base,
        localFiles: [local("main.tex", "local change\n")],
        remoteFiles: [remote("main.tex", "remote change\n")],
      });
      const report = createConflictReport({
        generatedAt: later,
        conflicts: plan.conflicts,
        watchPaused: true,
      });

      await writeConflictReport(projectRoot, report);

      const raw = await readFile(getConflictReportPath(projectRoot), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).not.toContain("<fake-env-session-cookie>");
      expect(raw).not.toContain("<overleaf-project-id>");
      expect(raw).not.toContain("local change");
      expect(raw).not.toContain("remote change");
      expect(JSON.parse(raw)).toMatchObject({
        schemaVersion: 1,
        generatedAt: later,
        conflicts: [
          {
            path: "main.tex",
            reason: "both-modified",
            local: {
              contentHash: sha256Hex("local change\n"),
              size: Buffer.byteLength("local change\n"),
            },
            remote: {
              contentHash: sha256Hex("remote change\n"),
              size: Buffer.byteLength("remote change\n"),
              remoteId: "remote-main.tex",
              revision: "rev-main.tex",
            },
            base: {
              contentHash: sha256Hex("base\n"),
              size: Buffer.byteLength("base\n"),
            },
          },
        ],
      });
    });
  });

  it("clears stale conflict reports and ignores missing reports", async () => {
    await withTempProject(async (projectRoot) => {
      await mkdir(join(projectRoot, ".olcx", "state"), { recursive: true });
      await writeFile(getConflictReportPath(projectRoot), "{}\n", "utf8");

      await clearConflictReport(projectRoot);
      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await expect(clearConflictReport(projectRoot)).resolves.toBeUndefined();
    });
  });

  it("builds the next state from safe upload, download, and unchanged operations only", () => {
    const base = stateWith("unchanged.tex", "same\n");
    const upload = local("local.tex", "local change\n");
    const download = remote("remote.tex", "remote change\n");
    const sameLocal = local("unchanged.tex", "same\n");
    const sameRemote = remote("unchanged.tex", "same\n");
    const ignored = local("main.aux", "ignored\n");
    const plan = createSyncPlan({
      projectId: "<overleaf-project-id>",
      createdAt: later,
      dryRun: false,
      state: base,
      localFiles: [upload, sameLocal, ignored],
      remoteFiles: [download, sameRemote],
    });
    const uploadedRemote = new Map<string, RemoteFileSnapshot>([
      [
        "local.tex",
        {
          path: "local.tex",
          exists: true,
          contentHash: upload.contentHash,
          size: upload.size,
          modifiedAt: later,
          remoteId: "remote-upload",
          revision: "rev-upload",
        },
      ],
    ]);

    const next = buildNextSyncState({
      previous: base,
      plan,
      appliedAt: later,
      uploadResults: uploadedRemote,
    });

    expect(Object.keys(next.files).sort()).toEqual(["local.tex", "remote.tex", "unchanged.tex"]);
    expect(next.files["local.tex"]).toMatchObject({
      path: "local.tex",
      contentHash: sha256Hex("local change\n"),
      localModifiedAt: upload.modifiedAt,
      remoteModifiedAt: later,
      remoteId: "remote-upload",
      remoteRevision: "rev-upload",
      syncedAt: later,
    });
    expect(next.files["remote.tex"]).toMatchObject({
      path: "remote.tex",
      contentHash: sha256Hex("remote change\n"),
      localModifiedAt: later,
      remoteModifiedAt: download.modifiedAt,
      remoteId: "remote-remote.tex",
      remoteRevision: "rev-remote.tex",
      syncedAt: later,
    });
    expect(next.files["unchanged.tex"]).toMatchObject({
      path: "unchanged.tex",
      contentHash: sha256Hex("same\n"),
      syncedAt: later,
    });
    expect(next.files["main.aux"]).toBeUndefined();
  });
});
