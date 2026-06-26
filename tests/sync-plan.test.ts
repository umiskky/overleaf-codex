import { describe, expect, it } from "vitest";
import { createConflictReport, formatConflictReport } from "../src/sync/conflicts";
import { createIgnoreMatcher } from "../src/sync/ignore";
import { createSyncPlan, sha256Hex } from "../src/sync/plan";
import type {
  LocalFileSnapshot,
  RemoteFileSnapshot,
  SyncOperationType,
  SyncPlan,
  SyncPlanInput,
  SyncStateFile,
} from "../src/sync/types";

const now = "2026-06-25T08:00:00.000Z";

function emptyState(): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: now,
    files: {},
  };
}

function stateWith(path: string, contentHash: string): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: now,
    files: {
      [path]: {
        path,
        contentHash,
        size: 4,
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
    modifiedAt: "2026-06-25T08:00:00.000Z",
  };
}

function localDeleted(path: string): LocalFileSnapshot {
  return {
    path,
    exists: false,
    modifiedAt: "2026-06-25T08:00:00.000Z",
  };
}

function remote(path: string, content: string): RemoteFileSnapshot {
  return {
    path,
    exists: true,
    contentHash: sha256Hex(content),
    size: Buffer.byteLength(content),
    modifiedAt: "2026-06-25T08:00:00.000Z",
    remoteId: `remote-${path}`,
    revision: `rev-${content}`,
  };
}

function remoteDeleted(path: string): RemoteFileSnapshot {
  return {
    path,
    exists: false,
    modifiedAt: "2026-06-25T08:00:00.000Z",
  };
}

function plan(
  input: {
    state?: SyncStateFile;
    localFiles?: LocalFileSnapshot[];
    remoteFiles?: RemoteFileSnapshot[];
    dryRun?: boolean;
    userIgnorePatterns?: string[];
    allowDeletes?: boolean;
  } = {}
): SyncPlan {
  return createSyncPlan({
    projectId: "project-alpha",
    createdAt: now,
    dryRun: input.dryRun ?? false,
    state: input.state ?? emptyState(),
    localFiles: input.localFiles ?? [],
    remoteFiles: input.remoteFiles ?? [],
    userIgnorePatterns: input.userIgnorePatterns,
    allowDeletes: input.allowDeletes,
  });
}

function operationTypes(result: SyncPlan): SyncOperationType[] {
  return result.operations.map((operation) => operation.type);
}

function expectSummaryMatchesOperations(result: SyncPlan): void {
  const expected = result.operations.reduce<Record<SyncOperationType, number>>(
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
  );

  expect(result.summary).toEqual(expected);
}

describe("sync planning", () => {
  it("plans an upload for a local-only non-ignored path", () => {
    const result = plan({ localFiles: [local("main.tex", "local body")] });

    expect(operationTypes(result)).toEqual(["upload"]);
    expect(result.operations[0]).toMatchObject({
      type: "upload",
      path: "main.tex",
    });
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toMatchObject({ upload: 1, conflict: 0 });
    expectSummaryMatchesOperations(result);
  });

  it("plans a download for a remote-only non-ignored path", () => {
    const result = plan({ remoteFiles: [remote("refs.bib", "remote body")] });

    expect(operationTypes(result)).toEqual(["download"]);
    expect(result.operations[0]).toMatchObject({
      type: "download",
      path: "refs.bib",
    });
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toMatchObject({ download: 1, conflict: 0 });
    expectSummaryMatchesOperations(result);
  });

  it("keeps matching local and remote hashes unchanged", () => {
    const content = "same body";
    const result = plan({
      localFiles: [local("main.tex", content)],
      remoteFiles: [remote("main.tex", content)],
    });

    expect(operationTypes(result)).toEqual(["unchanged"]);
    expect(result.operations[0]).toMatchObject({
      type: "unchanged",
      path: "main.tex",
    });
    expect(result.conflicts).toEqual([]);
    expectSummaryMatchesOperations(result);
  });

  it("turns built-in ignored paths into ignored operations", () => {
    const result = plan({
      localFiles: [
        local(".git/config", "git"),
        local("node_modules/pkg/index.js", "module"),
        local(".olcx/auth.local.json", "auth"),
        local("build/overleaf/main.pdf", "pdf"),
        local("main.aux", "aux"),
      ],
    });

    expect(operationTypes(result)).toEqual(["ignored", "ignored", "ignored", "ignored", "ignored"]);
    expect(result.operations.map((operation) => operation.path)).toEqual([
      ".git/config",
      ".olcx/auth.local.json",
      "build/overleaf/main.pdf",
      "main.aux",
      "node_modules/pkg/index.js",
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.summary).toMatchObject({ ignored: 5, upload: 0, conflict: 0 });
    expectSummaryMatchesOperations(result);
  });

  it("applies user ignore patterns after built-in ignores", () => {
    const matcher = createIgnoreMatcher(["drafts/**"]);

    expect(matcher.isIgnored(".git/config")).toBe(true);
    expect(matcher.isIgnored("drafts/private.tex")).toBe(true);
    expect(matcher.isIgnored("main.tex")).toBe(false);

    const result = plan({
      localFiles: [local("drafts/private.tex", "draft")],
      userIgnorePatterns: ["drafts/**"],
    });

    expect(operationTypes(result)).toEqual(["ignored"]);
    expect(result.operations[0]).toMatchObject({
      type: "ignored",
      path: "drafts/private.tex",
    });
    expect(result.conflicts).toEqual([]);
  });

  it("flags both sides modified differently from the baseline", () => {
    const baseHash = sha256Hex("base");
    const result = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [local("main.tex", "local body")],
      remoteFiles: [remote("main.tex", "remote body")],
    });

    expect(operationTypes(result)).toEqual(["conflict"]);
    expect(result.operations[0]).toMatchObject({
      type: "conflict",
      path: "main.tex",
      conflictReason: "both-modified",
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "main.tex",
      reason: "both-modified",
    });
    expectSummaryMatchesOperations(result);
  });

  it("flags remote deletion when local changed from the baseline", () => {
    const baseHash = sha256Hex("base");
    const result = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [local("main.tex", "local body")],
      remoteFiles: [remoteDeleted("main.tex")],
    });

    expect(operationTypes(result)).toEqual(["conflict"]);
    expect(result.conflicts[0]).toMatchObject({
      path: "main.tex",
      reason: "local-modified-remote-deleted",
    });
    expect(result.operations[0].type).not.toBe("deleteLocal");
  });

  it("flags local deletion when remote changed from the baseline", () => {
    const baseHash = sha256Hex("base");
    const result = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [localDeleted("main.tex")],
      remoteFiles: [remote("main.tex", "remote body")],
    });

    expect(operationTypes(result)).toEqual(["conflict"]);
    expect(result.conflicts[0]).toMatchObject({
      path: "main.tex",
      reason: "remote-modified-local-deleted",
    });
    expect(result.operations[0].type).not.toBe("deleteRemote");
  });

  it("downgrades default baseline deletes to unsafe-delete conflicts", () => {
    const baseHash = sha256Hex("base");
    const remoteDelete = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [local("main.tex", "base")],
      remoteFiles: [remoteDeleted("main.tex")],
    });
    const localDelete = plan({
      state: stateWith("refs.bib", baseHash),
      localFiles: [localDeleted("refs.bib")],
      remoteFiles: [remote("refs.bib", "base")],
    });

    expect(operationTypes(remoteDelete)).toEqual(["conflict"]);
    expect(operationTypes(localDelete)).toEqual(["conflict"]);
    expect(remoteDelete.conflicts[0]).toMatchObject({ reason: "unsafe-delete" });
    expect(localDelete.conflicts[0]).toMatchObject({ reason: "unsafe-delete" });
    expect(remoteDelete.operations[0].type).not.toBe("deleteLocal");
    expect(localDelete.operations[0].type).not.toBe("deleteRemote");
  });

  it("keeps delete operations reserved for explicit allowDeletes mode", () => {
    const baseHash = sha256Hex("base");
    const remoteDelete = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [local("main.tex", "base")],
      remoteFiles: [remoteDeleted("main.tex")],
      allowDeletes: true,
    });
    const localDelete = plan({
      state: stateWith("refs.bib", baseHash),
      localFiles: [localDeleted("refs.bib")],
      remoteFiles: [remote("refs.bib", "base")],
      allowDeletes: true,
    });

    expect(operationTypes(remoteDelete)).toEqual(["deleteLocal"]);
    expect(operationTypes(localDelete)).toEqual(["deleteRemote"]);
    expect(remoteDelete.conflicts).toEqual([]);
    expect(localDelete.conflicts).toEqual([]);
  });

  it("retains dry-run mode without changing planned operations", () => {
    const result = plan({
      dryRun: true,
      localFiles: [local("main.tex", "local body")],
    });

    expect(result.dryRun).toBe(true);
    expect(operationTypes(result)).toEqual(["upload"]);
    expectSummaryMatchesOperations(result);
  });
});

describe("conflict reports", () => {
  it("formats known metadata and redacts file contents and secret-like values", () => {
    const baseHash = sha256Hex("base");
    const localHash = sha256Hex("local body");
    const remoteHash = sha256Hex("remote body");
    const result = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [local("main.tex", "local body")],
      remoteFiles: [remote("main.tex", "remote body")],
    });

    const report = createConflictReport({
      generatedAt: now,
      conflicts: result.conflicts.map((conflict) => ({
        ...conflict,
        local: {
          ...conflict.local,
          content: "local body sessionCookie=<fake-session-cookie>",
        } as never,
      })),
      watchPaused: true,
    });

    const formatted = formatConflictReport(report);

    expect(formatted).toContain("main.tex");
    expect(formatted).toContain(baseHash);
    expect(formatted).toContain(localHash);
    expect(formatted).toContain(remoteHash);
    expect(formatted).toContain("olcx sync --dry-run");
    expect(formatted).toContain("olcx sync");
    expect(formatted).toContain("\"paused\": true");
    expect(formatted).toContain("2026-06-25T08:00:00.000Z");
    expect(formatted).not.toContain("local body");
    expect(formatted).not.toContain("<fake-session-cookie>");
    expect(formatted).not.toContain("sessionCookie");
    expect(formatted).not.toContain("project-alpha");
  });

  it("copies only known conflict report metadata fields", () => {
    const baseHash = sha256Hex("base");
    const result = plan({
      state: stateWith("main.tex", baseHash),
      localFiles: [local("main.tex", "local body")],
      remoteFiles: [remote("main.tex", "remote body")],
    });

    const report = createConflictReport({
      generatedAt: now,
      conflicts: result.conflicts.map((conflict) => ({
        ...conflict,
        local: {
          ...conflict.local,
          cookie: "<fake-cookie>",
          privateLog: "private log body",
        } as never,
        remote: {
          ...conflict.remote,
          authorization: "<fake-authorization>",
        } as never,
      })),
      watchPaused: true,
    });

    const formatted = formatConflictReport(report);

    expect(formatted).toContain("contentHash");
    expect(formatted).toContain("size");
    expect(formatted).toContain("modifiedAt");
    expect(formatted).toContain("remoteId");
    expect(formatted).toContain("revision");
    expect(formatted).not.toContain("<fake-cookie>");
    expect(formatted).not.toContain("private log body");
    expect(formatted).not.toContain("<fake-authorization>");
    expect(formatted).not.toContain("authorization");
  });
});
