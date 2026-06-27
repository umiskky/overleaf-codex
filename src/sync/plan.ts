import { createHash } from "node:crypto";
import { createIgnoreMatcher, normalizeSyncPath } from "./ignore.js";
import type {
  LocalFileSnapshot,
  RemoteFileSnapshot,
  SyncConflict,
  SyncConflictReason,
  SyncOperation,
  SyncOperationType,
  SyncPlan,
  SyncPlanInput,
  SyncPlanSummary,
  SyncStateEntry,
} from "./types.js";

const RECOMMENDATIONS: Record<SyncConflictReason, string> = {
  "both-modified": "Review both versions, merge manually, then run olcx sync --dry-run.",
  "local-modified-remote-deleted":
    "Decide whether to keep the local file or accept the remote deletion, then run olcx sync --dry-run.",
  "remote-modified-local-deleted":
    "Decide whether to restore the local file or delete the remote version, then run olcx sync --dry-run.",
  "unsafe-delete": "Deletion is not applied automatically in v1. Confirm manually, then run olcx sync --dry-run.",
  unsupported: "Resolve this path manually, then run olcx sync --dry-run.",
};

export function sha256Hex(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return createHash("sha256").update(bytes).digest("hex");
}

export function createSyncPlan(input: SyncPlanInput): SyncPlan {
  const ignoreMatcher = createIgnoreMatcher(input.userIgnorePatterns);
  const stateByPath = createStateMap(input.state.files);
  const localByPath = createLocalMap(input.localFiles);
  const remoteByPath = createRemoteMap(input.remoteFiles);
  const paths = sortedUnion(stateByPath.keys(), localByPath.keys(), remoteByPath.keys());
  const operations: SyncOperation[] = [];
  const conflicts: SyncConflict[] = [];

  for (const path of paths) {
    const base = stateByPath.get(path);
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    const localIgnored = local?.ignored === true;

    if (localIgnored || ignoreMatcher.isIgnored(path)) {
      operations.push({
        type: "ignored",
        path,
        reason: "ignored by sync rules",
        local,
        remote,
        base,
      });
      continue;
    }

    const operation = planPath({
      path,
      base,
      local,
      remote,
      allowDeletes: input.allowDeletes === true,
    });

    operations.push(operation);

    if (operation.type === "conflict" && operation.conflictReason) {
      conflicts.push({
        path,
        reason: operation.conflictReason,
        local,
        remote,
        base,
        recommendation: RECOMMENDATIONS[operation.conflictReason],
      });
    }
  }

  return {
    projectId: input.projectId,
    createdAt: input.createdAt,
    dryRun: input.dryRun,
    operations,
    conflicts,
    summary: summarizeOperations(operations),
  };
}

export function createFastLocalSyncPlan(input: SyncPlanInput): SyncPlan {
  const ignoreMatcher = createIgnoreMatcher(input.userIgnorePatterns);
  const stateByPath = createStateMap(input.state.files);
  const localByPath = createLocalMap(input.localFiles);
  const remoteByPath = createRemoteMap(input.remoteFiles);
  const paths = sortedUnion(stateByPath.keys(), localByPath.keys());
  const operations: SyncOperation[] = [];
  const conflicts: SyncConflict[] = [];

  for (const path of paths) {
    const base = stateByPath.get(path);
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    const localPresent = isPresentLocal(local);

    if (local?.ignored === true || ignoreMatcher.isIgnored(path)) {
      operations.push({
        type: "ignored",
        path,
        reason: "ignored by sync rules",
        local,
        remote,
        base,
      });
      continue;
    }

    let operationForPath: SyncOperation;
    if (localPresent && !local.contentHash) {
      operationForPath = conflictOperation(path, "unsupported", "present local file is missing a content hash", local, remote, base);
    } else if (localPresent && !base) {
      operationForPath = operation("upload", path, "local-only file", local, remote);
    } else if (localPresent && base && local.contentHash !== base.contentHash) {
      if (!remote || remoteMetadataChanged(remote, base)) {
        operationForPath = conflictOperation(
          path,
          remote ? "both-modified" : "local-modified-remote-deleted",
          remote
            ? "local changed and remote metadata changed from baseline"
            : "local changed while remote file is missing",
          local,
          remote,
          base
        );
      } else {
        operationForPath = operation("upload", path, "local changed from baseline", local, remote, base);
      }
    } else if (localPresent && base) {
      operationForPath = operation("unchanged", path, "local matches baseline", local, remote, base);
    } else if (!localPresent && base) {
      operationForPath = conflictOperation(
        path,
        "unsafe-delete",
        "local deletion is not applied automatically by fast sync",
        local,
        remote,
        base
      );
    } else {
      operationForPath = operation("unchanged", path, "path has no local change", local, remote, base);
    }

    operations.push(operationForPath);
    if (operationForPath.type === "conflict" && operationForPath.conflictReason) {
      conflicts.push({
        path,
        reason: operationForPath.conflictReason,
        local,
        remote,
        base,
        recommendation: RECOMMENDATIONS[operationForPath.conflictReason],
      });
    }
  }

  return {
    projectId: input.projectId,
    createdAt: input.createdAt,
    dryRun: input.dryRun,
    operations,
    conflicts,
    summary: summarizeOperations(operations),
  };
}

function createStateMap(files: Record<string, SyncStateEntry>): Map<string, SyncStateEntry> {
  return new Map(
    Object.entries(files).map(([path, entry]) => {
      const normalizedPath = normalizeSyncPath(entry.path || path);
      return [normalizedPath, { ...entry, path: normalizedPath }];
    })
  );
}

function createLocalMap(files: LocalFileSnapshot[]): Map<string, LocalFileSnapshot> {
  return new Map(
    files.map((file) => {
      const path = normalizeSyncPath(file.path);
      return [path, { ...file, path }];
    })
  );
}

function createRemoteMap(files: RemoteFileSnapshot[]): Map<string, RemoteFileSnapshot> {
  return new Map(
    files.map((file) => {
      const path = normalizeSyncPath(file.path);
      return [path, { ...file, path }];
    })
  );
}

function sortedUnion(...keySets: IterableIterator<string>[]): string[] {
  return [...new Set(keySets.flatMap((keys) => [...keys]))].sort();
}

function planPath(input: {
  path: string;
  base?: SyncStateEntry;
  local?: LocalFileSnapshot;
  remote?: RemoteFileSnapshot;
  allowDeletes: boolean;
}): SyncOperation {
  const { path, base, local, remote, allowDeletes } = input;
  const localPresent = isPresentLocal(local);
  const remotePresent = isPresentRemote(remote);

  if (!base) {
    if (localPresent && !remotePresent) {
      return operation("upload", path, "local-only file", local, remote);
    }

    if (!localPresent && remotePresent) {
      return operation("download", path, "remote-only file", local, remote);
    }
  }

  if (!localPresent && !remotePresent) {
    return operation("unchanged", path, "both-deleted", local, remote, base);
  }

  if ((localPresent && !local?.contentHash) || (remotePresent && !remote?.contentHash)) {
    return conflictOperation(path, "unsupported", "present file is missing a content hash", local, remote, base);
  }

  if (!base) {
    if (localPresent && remotePresent && local.contentHash === remote.contentHash) {
      return operation("unchanged", path, "local and remote hashes match", local, remote);
    }

    return conflictOperation(path, "both-modified", "local and remote differ without a baseline", local, remote);
  }

  if (localPresent && remotePresent) {
    return planPresentOnBothSides(path, base, local, remote);
  }

  if (localPresent) {
    return planRemoteAbsent(path, base, local, remote, allowDeletes);
  }

  if (remotePresent) {
    return planLocalAbsent(path, base, local, remote, allowDeletes);
  }

  return conflictOperation(path, "unsupported", "path state could not be classified", local, remote, base);
}

function planPresentOnBothSides(
  path: string,
  base: SyncStateEntry,
  local: LocalFileSnapshot,
  remote: RemoteFileSnapshot
): SyncOperation {
  const localHash = local.contentHash;
  const remoteHash = remote.contentHash;
  const baseHash = base.contentHash;

  if (localHash === baseHash && remoteHash === baseHash) {
    return operation("unchanged", path, "matches baseline", local, remote, base);
  }

  if (localHash !== baseHash && remoteHash === baseHash) {
    return operation("upload", path, "local changed from baseline", local, remote, base);
  }

  if (localHash === baseHash && remoteHash !== baseHash) {
    return operation("download", path, "remote changed from baseline", local, remote, base);
  }

  if (localHash === remoteHash) {
    return operation("unchanged", path, "local and remote already share the same changed hash", local, remote, base);
  }

  return conflictOperation(path, "both-modified", "local and remote both changed from baseline", local, remote, base);
}

function remoteMetadataChanged(remote: RemoteFileSnapshot, base: SyncStateEntry): boolean {
  if (remote.contentHash && remote.contentHash !== base.contentHash) {
    return true;
  }
  if (remote.revision && base.remoteRevision && remote.revision !== base.remoteRevision) {
    return true;
  }
  if (remote.modifiedAt && base.remoteModifiedAt && remote.modifiedAt !== base.remoteModifiedAt) {
    return true;
  }
  return false;
}

function planRemoteAbsent(
  path: string,
  base: SyncStateEntry,
  local: LocalFileSnapshot,
  remote: RemoteFileSnapshot | undefined,
  allowDeletes: boolean
): SyncOperation {
  if (local.contentHash !== base.contentHash) {
    return conflictOperation(path, "local-modified-remote-deleted", "remote deleted while local changed", local, remote, base);
  }

  if (allowDeletes) {
    return operation("deleteLocal", path, "remote deletion explicitly allowed", local, remote, base);
  }

  return conflictOperation(path, "unsafe-delete", "remote deletion requires explicit confirmation", local, remote, base);
}

function planLocalAbsent(
  path: string,
  base: SyncStateEntry,
  local: LocalFileSnapshot | undefined,
  remote: RemoteFileSnapshot,
  allowDeletes: boolean
): SyncOperation {
  if (remote.contentHash !== base.contentHash) {
    return conflictOperation(path, "remote-modified-local-deleted", "local deleted while remote changed", local, remote, base);
  }

  if (allowDeletes) {
    return operation("deleteRemote", path, "local deletion explicitly allowed", local, remote, base);
  }

  return conflictOperation(path, "unsafe-delete", "local deletion requires explicit confirmation", local, remote, base);
}

function operation(
  type: SyncOperationType,
  path: string,
  reason: string,
  local?: LocalFileSnapshot,
  remote?: RemoteFileSnapshot,
  base?: SyncStateEntry
): SyncOperation {
  return {
    type,
    path,
    reason,
    local,
    remote,
    base,
  };
}

function conflictOperation(
  path: string,
  conflictReason: SyncConflictReason,
  reason: string,
  local?: LocalFileSnapshot,
  remote?: RemoteFileSnapshot,
  base?: SyncStateEntry
): SyncOperation {
  return {
    type: "conflict",
    path,
    reason,
    local,
    remote,
    base,
    conflictReason,
  };
}

function isPresentLocal(snapshot: LocalFileSnapshot | undefined): snapshot is LocalFileSnapshot {
  return snapshot?.exists === true;
}

function isPresentRemote(snapshot: RemoteFileSnapshot | undefined): snapshot is RemoteFileSnapshot {
  return snapshot?.exists === true;
}

function summarizeOperations(operations: SyncOperation[]): SyncPlanSummary {
  return operations.reduce<SyncPlanSummary>(
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
}
