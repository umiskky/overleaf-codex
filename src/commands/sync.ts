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
import { createSyncPlan } from "../sync/plan.js";
import { createLocalSnapshot, createRemoteSnapshot } from "../sync/snapshot.js";
import {
  buildNextSyncState,
  clearConflictReport,
  readSyncState,
  writeConflictReport,
  writeSyncState,
} from "../sync/state.js";
import { CONFLICT_REPORT_PATH, SYNC_STATE_PATH, type SyncConflict, type SyncPlan } from "../sync/types.js";

export interface SyncProjectOptions {
  cwd: string;
  dryRun?: boolean;
  backend?: OverleafBackend;
  createBackend?: OverleafBackendFactory;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface SyncProjectResult {
  projectRoot: string;
  dryRun: boolean;
  plan: SyncPlan;
  output: string;
}

export async function syncProject(options: SyncProjectOptions): Promise<SyncProjectResult> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
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
  });
  const plan = createSyncPlan({
    projectId: config.projectId,
    createdAt,
    dryRun,
    state,
    localFiles,
    remoteFiles,
    userIgnorePatterns: config.sync.ignore,
    allowDeletes: false,
  });

  if (plan.conflicts.length > 0) {
    let reportWritten = false;
    if (!dryRun) {
      await writeConflictReport(
        projectRoot,
        createConflictReport({
          generatedAt: createdAt,
          conflicts: plan.conflicts,
          watchPaused: true,
        })
      );
      reportWritten = true;
    }

    throw createOlcxError({
      code: "SYNC_CONFLICT",
      message: `Sync paused because ${plan.conflicts.length} conflict(s) were detected.`,
      hint: "Review the listed files, then run olcx sync --dry-run.",
      details: {
        conflicts: summarizeConflicts(plan.conflicts),
        ...(reportWritten ? { reportPath: CONFLICT_REPORT_PATH } : {}),
      },
    });
  }

  if (!dryRun) {
    const applyResult = await applySyncPlan({
      projectRoot,
      backend,
      projectId: config.projectId,
      auth,
      plan,
    });
    await writeSyncState(
      projectRoot,
      buildNextSyncState({
        previous: state,
        plan,
        appliedAt: createdAt,
        uploadResults: applyResult.uploaded,
      })
    );
    await clearConflictReport(projectRoot);
  }

  const result: SyncProjectResult = {
    projectRoot,
    dryRun,
    plan,
    output: "",
  };
  result.output = formatSyncPlanOutput(result);
  return result;
}

export function formatSyncPlanOutput(result: SyncProjectResult): string {
  const uploadPaths = operationPaths(result.plan, "upload");
  const downloadPaths = operationPaths(result.plan, "download");
  const lines = [
    result.dryRun ? "olcx sync --dry-run" : "olcx sync",
    `Plan: upload ${result.plan.summary.upload}, download ${result.plan.summary.download}, unchanged ${result.plan.summary.unchanged}, ignored ${result.plan.summary.ignored}`,
  ];

  if (result.dryRun) {
    appendPathSection(lines, "Uploads:", uploadPaths);
    appendPathSection(lines, "Downloads:", downloadPaths);
    lines.push("No files changed.");
    return redactSensitive(`${lines.join("\n")}\n`);
  }

  appendPathSection(lines, "Uploaded:", uploadPaths);
  appendPathSection(lines, "Downloaded:", downloadPaths);
  if (uploadPaths.length === 0 && downloadPaths.length === 0) {
    lines.push("No file changes to apply.");
  }
  lines.push(`State: ${SYNC_STATE_PATH}`, "Next: olcx compile");
  return redactSensitive(`${lines.join("\n")}\n`);
}

export function formatSyncConflictFailure(input: {
  conflicts: { path: string; reason: string }[];
  dryRun: boolean;
  reportWritten: boolean;
}): string {
  const lines = [
    `Error: Sync paused because ${input.conflicts.length} conflict(s) were detected.`,
    "Conflicts:",
    ...input.conflicts.map((conflict) => `- ${conflict.path} (${conflict.reason})`),
    "Next: review the listed files, then run olcx sync --dry-run.",
  ];

  if (!input.dryRun && input.reportWritten) {
    lines.push(`Conflict report: ${CONFLICT_REPORT_PATH}`);
  }

  return redactSensitive(`${lines.join("\n")}\n`);
}

function operationPaths(plan: SyncPlan, type: "upload" | "download"): string[] {
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
