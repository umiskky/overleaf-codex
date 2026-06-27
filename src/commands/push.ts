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
import { normalizeSyncPath } from "../sync/ignore.js";
import {
  formatTransferSummary,
  type SyncProgressEvent,
  type SyncTransferReport,
} from "../sync/output.js";
import { createLocalSnapshot, createRemoteSnapshot } from "../sync/snapshot.js";
import { buildNextSyncState, clearConflictReport, readSyncState, writeSyncState } from "../sync/state.js";
import { runTransferWithRetry } from "../sync/transfer.js";
import {
  SYNC_STATE_PATH,
  type LocalFileSnapshot,
  type RemoteFileSnapshot,
  type SyncOperation,
  type SyncPlan,
  type SyncPlanSummary,
} from "../sync/types.js";

export interface PushProjectOptions {
  cwd: string;
  dryRun?: boolean;
  prune?: boolean;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  onProgress?: (event: SyncProgressEvent) => void;
}

export interface PushProjectResult {
  projectRoot: string;
  dryRun: boolean;
  prune: boolean;
  plan: SyncPlan;
  transferReports: SyncTransferReport[];
  transferElapsedMs: number;
  output: string;
}

export async function pushProject(options: PushProjectOptions): Promise<PushProjectResult> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const dryRun = options.dryRun === true;
  const prune = options.prune !== false;
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
  const plan = createPushPlan({
    projectId: config.projectId,
    createdAt,
    dryRun,
    prune,
    localFiles,
    remoteFiles,
  });
  let transferReports: SyncTransferReport[] = [];
  let transferElapsedMs = 0;

  if (!dryRun) {
    const transferStartedAt = Date.now();
    const uploadPlan = planWithOnly(plan, ["upload"]);
    const applyResult = await applySyncPlan({
      projectRoot,
      backend,
      projectId: config.projectId,
      auth,
      plan: uploadPlan,
      downloadConcurrency: config.sync.downloadConcurrency,
      uploadConcurrency: config.sync.uploadConcurrency,
      retry: config.sync.retry,
      timeout: config.sync.timeout,
      onProgress: options.onProgress,
    });
    transferReports = [...applyResult.transferReports];

    for (const operation of plan.operations.filter((item) => item.type === "deleteRemote")) {
      const path = normalizeSyncPath(operation.path);
      const startedAt = Date.now();
      const transfer = await runTransferWithRetry({
        path,
        size: operation.remote?.size,
        retry: config.sync.retry,
        timeout: config.sync.timeout,
        operation: async () => {
          await backend.deleteFile({
            projectId: config.projectId,
            auth,
            path,
            remoteId: operation.remote?.remoteId,
          });
        },
      });
      transferReports.push({
        status: "ok",
        operation: "deleteRemote",
        path,
        size: operation.remote?.size,
        elapsedMs: Math.max(transfer.elapsedMs, Math.max(0, Date.now() - startedAt)),
        attempts: transfer.attempts,
      });
    }

    transferElapsedMs = Math.max(0, Date.now() - transferStartedAt);
    await writeSyncState(
      projectRoot,
      buildNextSyncState({
        previous: state,
        plan: uploadPlan,
        appliedAt: createdAt,
        uploadResults: applyResult.uploaded,
      })
    );
    await clearConflictReport(projectRoot);
  }

  const result: PushProjectResult = {
    projectRoot,
    dryRun,
    prune,
    plan,
    transferReports,
    transferElapsedMs,
    output: "",
  };
  result.output = formatPushOutput(result);
  return result;
}

function createPushPlan(input: {
  projectId: string;
  createdAt: string;
  dryRun: boolean;
  prune: boolean;
  localFiles: LocalFileSnapshot[];
  remoteFiles: RemoteFileSnapshot[];
}): SyncPlan {
  const localByPath = new Map(input.localFiles.filter((file) => file.exists).map((file) => [normalizeSyncPath(file.path), file]));
  const remoteByPath = new Map(input.remoteFiles.filter((file) => file.exists).map((file) => [normalizeSyncPath(file.path), file]));
  const operations: SyncOperation[] = [];

  for (const local of [...localByPath.values()].sort(comparePath)) {
    operations.push({
      type: "upload",
      path: local.path,
      reason: "push uploads local file",
      local,
      remote: remoteByPath.get(local.path),
    });
  }

  if (input.prune) {
    for (const remote of [...remoteByPath.values()].sort(comparePath)) {
      if (!localByPath.has(remote.path)) {
        operations.push({
          type: "deleteRemote",
          path: remote.path,
          reason: "push prunes remote-only file",
          remote,
        });
      }
    }
  }

  return {
    projectId: input.projectId,
    createdAt: input.createdAt,
    dryRun: input.dryRun,
    operations,
    conflicts: [],
    summary: summarizeOperations(operations),
  };
}

function planWithOnly(plan: SyncPlan, types: SyncOperation["type"][]): SyncPlan {
  const operations = plan.operations.filter((operation) => types.includes(operation.type));
  return {
    ...plan,
    operations,
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

function formatPushOutput(result: PushProjectResult): string {
  const lines = [
    `olcx push${result.dryRun ? " --dry-run" : ""}${result.prune ? "" : " --no-prune"}`,
    `Plan: upload ${result.plan.summary.upload}, delete remote ${result.plan.summary.deleteRemote}`,
  ];
  appendPathSection(lines, "Uploads:", operationPaths(result.plan, "upload"));
  appendPathSection(lines, "Delete remote:", operationPaths(result.plan, "deleteRemote"));

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
        title: "olcx push summary",
        reports: result.transferReports,
        elapsedMs: result.transferElapsedMs,
      }).trimEnd()
    );
  }
  lines.push(`State: ${SYNC_STATE_PATH}`, "Next: olcx compile");
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

function comparePath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}
