import { rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { resolveProjectAuth } from "../auth/projectAuth.js";
import {
  createOlcliOverleafBackend,
  type OverleafBackend,
  type OverleafBackendFactory,
} from "../backend/index.js";
import { redactSensitive } from "../cli-behavior.js";
import { readProjectConfig } from "../config/projectConfig.js";
import { findProjectRoot } from "../config/projectRoot.js";
import { createOlcxError } from "../errors.js";
import { applySyncPlan } from "../sync/apply.js";
import { createConflictReport } from "../sync/conflicts.js";
import { normalizeSyncPath } from "../sync/ignore.js";
import {
  formatTransferSummary,
  type SyncProgressEvent,
  type SyncTransferReport,
} from "../sync/output.js";
import { createLocalSnapshot, createRemoteSnapshot } from "../sync/snapshot.js";
import {
  buildNextSyncState,
  clearConflictReport,
  readSyncState,
  writeConflictReport,
  writeSyncState,
} from "../sync/state.js";
import {
  CONFLICT_REPORT_PATH,
  SYNC_STATE_PATH,
  type LocalFileSnapshot,
  type RemoteFileSnapshot,
  type SyncConflict,
  type SyncOperation,
  type SyncPlan,
  type SyncPlanSummary,
  type SyncStateEntry,
  type SyncStateFile,
} from "../sync/types.js";

export type PullMode = "reset" | "rebase";

export interface PullProjectOptions {
  cwd: string;
  mode?: PullMode;
  dryRun?: boolean;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  onProgress?: (event: SyncProgressEvent) => void;
}

export interface PullProjectResult {
  projectRoot: string;
  dryRun: boolean;
  mode: PullMode;
  plan: SyncPlan;
  keptLocalPaths: string[];
  transferReports: SyncTransferReport[];
  transferElapsedMs: number;
  output: string;
}

interface PullPlanResult {
  plan: SyncPlan;
  keptLocalPaths: string[];
  preservedStatePaths: string[];
}

export async function pullProject(options: PullProjectOptions): Promise<PullProjectResult> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const mode = options.mode ?? "rebase";
  const dryRun = options.dryRun === true;
  const projectRoot = await findProjectRoot(options.cwd);
  const config = await readProjectConfig(projectRoot);
  const auth = await resolveProjectAuth(projectRoot, { env: options.env, now });
  const state = await readSyncState(projectRoot, { now });
  const backend =
    options.backend ??
    (options.createBackend ?? createOlcliOverleafBackend)({ baseUrl: config.overleaf.baseUrl });
  const localFiles = await createLocalSnapshot({
    projectRoot,
    userIgnorePatterns: config.sync.ignore,
  });
  const remoteFiles = await createRemoteSnapshot({
    backend,
    projectId: config.projectId,
    auth,
    userIgnorePatterns: config.sync.ignore,
    downloadMissingHash: false,
  });
  const pullPlan = createPullPlan({
    projectId: config.projectId,
    createdAt,
    dryRun,
    mode,
    state,
    localFiles,
    remoteFiles,
  });

  if (pullPlan.plan.conflicts.length > 0) {
    let reportWritten = false;
    if (!dryRun) {
      await writeConflictReport(
        projectRoot,
        createConflictReport({
          generatedAt: createdAt,
          conflicts: pullPlan.plan.conflicts,
          watchPaused: true,
        })
      );
      reportWritten = true;
    }

    throw createOlcxError({
      code: "SYNC_CONFLICT",
      message: `Pull paused because ${pullPlan.plan.conflicts.length} conflict(s) were detected.`,
      hint: "Review the listed files, then run olcx pull --mode rebase --dry-run.",
      details: {
        conflicts: summarizeConflicts(pullPlan.plan.conflicts),
        ...(reportWritten ? { reportPath: CONFLICT_REPORT_PATH } : {}),
      },
    });
  }

  let transferReports: SyncTransferReport[] = [];
  let transferElapsedMs = 0;

  if (!dryRun) {
    const transferStartedAt = Date.now();
    const downloadPlan = planWithOnly(pullPlan.plan, ["download"]);
    const applyResult = await applySyncPlan({
      projectRoot,
      backend,
      projectId: config.projectId,
      auth,
      plan: downloadPlan,
      downloadConcurrency: config.sync.downloadConcurrency,
      uploadConcurrency: config.sync.uploadConcurrency,
      retry: config.sync.retry,
      timeout: config.sync.timeout,
      onProgress: options.onProgress,
    });
    transferReports = [...applyResult.transferReports];

    for (const operation of pullPlan.plan.operations.filter((item) => item.type === "deleteLocal")) {
      const startedAt = Date.now();
      const path = requireSafeSyncPath(operation.path);
      await rm(join(projectRoot, ...path.split("/")), { force: true });
      transferReports.push({
        status: "ok",
        operation: "deleteLocal",
        path,
        size: operation.local?.size,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        attempts: 1,
      });
    }

    transferElapsedMs = Math.max(0, Date.now() - transferStartedAt);
    const nextState = buildNextPullState({
      previous: state,
      plan: downloadPlan,
      appliedAt: createdAt,
      downloadResults: applyResult.downloadedSnapshots,
      preservedStatePaths: pullPlan.preservedStatePaths,
    });
    await writeSyncState(projectRoot, nextState);
    await clearConflictReport(projectRoot);
  }

  const result: PullProjectResult = {
    projectRoot,
    dryRun,
    mode,
    plan: pullPlan.plan,
    keptLocalPaths: pullPlan.keptLocalPaths,
    transferReports,
    transferElapsedMs,
    output: "",
  };
  result.output = formatPullOutput(result);
  return result;
}

function createPullPlan(input: {
  projectId: string;
  createdAt: string;
  dryRun: boolean;
  mode: PullMode;
  state: SyncStateFile;
  localFiles: LocalFileSnapshot[];
  remoteFiles: RemoteFileSnapshot[];
}): PullPlanResult {
  const stateByPath = new Map(Object.entries(input.state.files).map(([path, entry]) => [normalizeSyncPath(path), entry]));
  const localByPath = new Map(input.localFiles.filter((file) => file.exists).map((file) => [normalizeSyncPath(file.path), file]));
  const remoteByPath = new Map(input.remoteFiles.filter((file) => file.exists).map((file) => [normalizeSyncPath(file.path), file]));
  const operations: SyncOperation[] = [];
  const conflicts: SyncConflict[] = [];
  const keptLocalPaths: string[] = [];
  const preservedStatePaths: string[] = [];

  if (input.mode === "reset") {
    for (const remote of [...remoteByPath.values()].sort(comparePath)) {
      operations.push({ type: "download", path: remote.path, reason: "pull reset downloads remote file", remote });
    }
    for (const local of [...localByPath.values()].sort(comparePath)) {
      if (!remoteByPath.has(local.path)) {
        operations.push({ type: "deleteLocal", path: local.path, reason: "pull reset removes local-only file", local });
      }
    }
  } else {
    const paths = [...new Set([...stateByPath.keys(), ...localByPath.keys(), ...remoteByPath.keys()])].sort();
    for (const path of paths) {
      const base = stateByPath.get(path);
      const local = localByPath.get(path);
      const remote = remoteByPath.get(path);
      const localChanged = hasLocalChange(local, base);
      const remoteChanged = hasRemoteChange(remote, base);

      if (localChanged && remoteChanged && !sameContent(local, remote)) {
        const reason = conflictReason(local, remote);
        conflicts.push({
          path,
          reason,
          local,
          remote,
          base,
          recommendation: "Review both versions, merge manually, then run olcx pull --mode rebase --dry-run.",
        });
        operations.push({
          type: "conflict",
          path,
          reason: "local and remote both changed before pull rebase",
          local,
          remote,
          base,
          conflictReason: reason,
        });
        continue;
      }

      if (localChanged) {
        keptLocalPaths.push(path);
        if (base) {
          preservedStatePaths.push(path);
        }
        continue;
      }

      if (remote && (!base || remoteChanged || !local)) {
        operations.push({ type: "download", path, reason: "pull rebase applies remote file", local, remote, base });
      } else if (local && base) {
        if (!remote) {
          operations.push({ type: "deleteLocal", path, reason: "pull rebase applies remote deletion", local, base });
        } else {
          preservedStatePaths.push(path);
        }
      }
    }
  }

  const plan: SyncPlan = {
    projectId: input.projectId,
    createdAt: input.createdAt,
    dryRun: input.dryRun,
    operations,
    conflicts,
    summary: summarizeOperations(operations),
  };

  return {
    plan,
    keptLocalPaths: keptLocalPaths.sort(),
    preservedStatePaths: preservedStatePaths.sort(),
  };
}

function hasLocalChange(local: LocalFileSnapshot | undefined, base: SyncStateEntry | undefined): boolean {
  if (!local) {
    return false;
  }
  return !base || local.contentHash !== base.contentHash;
}

function hasRemoteChange(remote: RemoteFileSnapshot | undefined, base: SyncStateEntry | undefined): boolean {
  if (!remote) {
    return false;
  }
  if (!base) {
    return true;
  }
  if (remote.contentHash) {
    return remote.contentHash !== base.contentHash;
  }
  if (remote.revision && base.remoteRevision) {
    return remote.revision !== base.remoteRevision;
  }
  if (remote.modifiedAt && base.remoteModifiedAt) {
    return remote.modifiedAt !== base.remoteModifiedAt;
  }
  return true;
}

function sameContent(local: LocalFileSnapshot | undefined, remote: RemoteFileSnapshot | undefined): boolean {
  return Boolean(local?.contentHash && remote?.contentHash && local.contentHash === remote.contentHash);
}

function conflictReason(
  local: LocalFileSnapshot | undefined,
  remote: RemoteFileSnapshot | undefined
): SyncConflict["reason"] {
  if (local && !remote) {
    return "local-modified-remote-deleted";
  }
  if (!local && remote) {
    return "remote-modified-local-deleted";
  }
  return "both-modified";
}

function buildNextPullState(input: {
  previous: SyncStateFile;
  plan: SyncPlan;
  appliedAt: string;
  downloadResults: Map<string, RemoteFileSnapshot>;
  preservedStatePaths: string[];
}): SyncStateFile {
  const next = buildNextSyncState({
    previous: input.previous,
    plan: input.plan,
    appliedAt: input.appliedAt,
    downloadResults: input.downloadResults,
  });
  for (const path of input.preservedStatePaths) {
    const entry = input.previous.files[path];
    if (entry) {
      next.files[path] = entry;
    }
  }
  return next;
}

function planWithOnly(plan: SyncPlan, types: SyncOperation["type"][]): SyncPlan {
  const operations = plan.operations.filter((operation) => types.includes(operation.type));
  return {
    ...plan,
    operations,
    conflicts: [],
    summary: summarizeOperations(operations),
  };
}

function summarizeOperations(operations: SyncOperation[]): SyncPlanSummary {
  return operations.reduce(
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

function formatPullOutput(result: PullProjectResult): string {
  const lines = [
    `olcx pull --mode ${result.mode}${result.dryRun ? " --dry-run" : ""}`,
    `Plan: download ${result.plan.summary.download}, delete local ${result.plan.summary.deleteLocal}, kept local ${result.keptLocalPaths.length}`,
  ];
  appendPathSection(lines, "Downloads:", operationPaths(result.plan, "download"));
  appendPathSection(lines, "Delete local:", operationPaths(result.plan, "deleteLocal"));
  appendPathSection(lines, "Kept local changes:", result.keptLocalPaths);

  if (result.dryRun) {
    lines.push("No files changed.");
    return redactSensitive(`${lines.join("\n")}\n`);
  }

  if (result.transferReports.length === 0) {
    lines.push("No file changes to apply.");
  } else {
    lines.push(
      "",
      formatTransferSummary({
        title: "olcx pull summary",
        reports: result.transferReports,
        elapsedMs: result.transferElapsedMs,
      }).trimEnd()
    );
  }
  lines.push(`State: ${SYNC_STATE_PATH}`, "Next: olcx compile");
  return redactSensitive(`${lines.join("\n")}\n`);
}

export function formatPullConflictFailure(input: {
  conflicts: { path: string; reason: string }[];
  dryRun: boolean;
  reportWritten: boolean;
}): string {
  const lines = [
    `Error: Pull paused because ${input.conflicts.length} conflict(s) were detected.`,
    "Conflicts:",
    ...input.conflicts.map((conflict) => `- ${conflict.path} (${conflict.reason})`),
    "Next: review the listed files, then run olcx pull --mode rebase --dry-run.",
  ];

  if (!input.dryRun && input.reportWritten) {
    lines.push(`Conflict report: ${CONFLICT_REPORT_PATH}`);
  }

  return redactSensitive(`${lines.join("\n")}\n`);
}

function operationPaths(plan: SyncPlan, type: SyncOperation["type"]): string[] {
  return plan.operations
    .filter((operation) => operation.type === type)
    .map((operation) => operation.path)
    .sort();
}

function appendPathSection(lines: string[], title: string, paths: string[]): void {
  if (paths.length === 0) {
    return;
  }
  lines.push(title, ...paths.map((path) => `- ${path}`));
}

function summarizeConflicts(conflicts: SyncConflict[]): { path: string; reason: SyncConflict["reason"] }[] {
  return conflicts.map((conflict) => ({
    path: conflict.path,
    reason: conflict.reason,
  }));
}

function requireSafeSyncPath(path: string): string {
  const normalized = normalizeSyncPath(path);
  const segments = normalized.split("/").filter(Boolean);

  if (normalized.length === 0 || normalized.startsWith("/") || win32.isAbsolute(path) || segments.includes("..")) {
    throw createOlcxError({
      code: "SYNC_UNSAFE_OPERATION",
      message: "Pull operation contains an unsafe path.",
      hint: "Resolve the unsafe path manually, then run olcx pull --dry-run.",
      details: { path: normalized },
    });
  }

  return normalized;
}

function comparePath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}
