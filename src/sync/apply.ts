import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { type ProjectAuth } from "../auth/types.js";
import { type OverleafBackend } from "../backend/types.js";
import {
  DEFAULT_SYNC_DOWNLOAD_CONCURRENCY,
  DEFAULT_SYNC_UPLOAD_CONCURRENCY,
  MAX_SYNC_DOWNLOAD_CONCURRENCY,
  MAX_SYNC_UPLOAD_CONCURRENCY,
} from "../config/types.js";
import { createOlcxError, isOlcxError } from "../errors.js";
import { normalizeSyncPath } from "./ignore.js";
import { type SyncProgressEvent, type SyncTransferReport } from "./output.js";
import { sha256Hex } from "./plan.js";
import { DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS, withRemoteDownloadTimeout } from "./remoteDownload.js";
import {
  runTransferWithRetry,
  type SyncRetryConfig,
  type SyncTimeoutConfig,
  type TransferFailure,
} from "./transfer.js";
import { type RemoteFileSnapshot, type SyncOperation, type SyncPlan } from "./types.js";

export interface ApplySyncPlanResult {
  uploaded: Map<string, RemoteFileSnapshot>;
  downloaded: string[];
  downloadedSnapshots: Map<string, RemoteFileSnapshot>;
  transferReports: SyncTransferReport[];
}

export async function applySyncPlan(input: {
  projectRoot: string;
  backend: OverleafBackend;
  projectId: string;
  auth: ProjectAuth;
  plan: SyncPlan;
  downloadTimeoutMs?: number;
  downloadConcurrency?: number;
  uploadConcurrency?: number;
  retry?: SyncRetryConfig;
  timeout?: SyncTimeoutConfig;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  onProgress?: (event: SyncProgressEvent) => void;
}): Promise<ApplySyncPlanResult> {
  if (input.plan.conflicts.length > 0 || input.plan.operations.some((operation) => operation.type === "conflict")) {
    throw createOlcxError({
      code: "SYNC_CONFLICT",
      message: "Sync plan contains conflicts.",
      hint: "Review conflicts, then run olcx sync --dry-run.",
    });
  }

  if (input.plan.operations.some((operation) => operation.type === "deleteLocal" || operation.type === "deleteRemote")) {
    throw createOlcxError({
      code: "SYNC_UNSAFE_OPERATION",
      message: "Sync plan contains delete operations that are not applied automatically.",
      hint: "Confirm deletions manually before running olcx sync again.",
    });
  }

  const result: ApplySyncPlanResult = {
    uploaded: new Map(),
    downloaded: [],
    downloadedSnapshots: new Map(),
    transferReports: [],
  };

  if (input.plan.dryRun) {
    return result;
  }

  const uploadOperations: SyncOperation[] = [];
  const downloadOperations: SyncOperation[] = [];
  for (const operation of input.plan.operations) {
    if (operation.type === "upload") {
      uploadOperations.push(operation);
      continue;
    }

    if (operation.type === "download") {
      downloadOperations.push(operation);
    }
  }

  const totalTransfers = uploadOperations.length + downloadOperations.length;
  let completedTransfers = 0;
  const progressStartedAt = (input.nowMs ?? (() => Date.now()))();
  const emitProgress = (report: SyncTransferReport): void => {
    completedTransfers += 1;
    if (!input.onProgress) {
      return;
    }
    const elapsedMs = Math.max(0, (input.nowMs ?? (() => Date.now()))() - progressStartedAt);
    input.onProgress({
      status: report.status === "failed" ? "failed" : "ok",
      operation: report.operation,
      path: report.path,
      completed: completedTransfers,
      total: totalTransfers,
      elapsedMs,
      etaMs: estimateEtaMs({ completed: completedTransfers, total: totalTransfers, elapsedMs }),
    });
  };

  const uploadedResults = await mapWithConcurrency(
    uploadOperations,
    normalizeUploadConcurrency(input.uploadConcurrency),
    async (operation) => {
      const applied = await applyUpload(input, operation);
      emitProgress(applied.report);
      return applied;
    }
  );
  for (const uploaded of uploadedResults) {
    result.uploaded.set(uploaded.snapshot.path, uploaded.snapshot);
    result.transferReports.push(uploaded.report);
  }

  const downloadedSnapshots = await mapWithConcurrency(
    downloadOperations,
    normalizeDownloadConcurrency(input.downloadConcurrency),
    async (operation) => {
      const applied = await applyDownload(input, operation);
      emitProgress(applied.report);
      return applied;
    }
  );
  for (const downloaded of downloadedSnapshots) {
    result.downloaded.push(downloaded.snapshot.path);
    result.downloadedSnapshots.set(downloaded.snapshot.path, downloaded.snapshot);
    result.transferReports.push(downloaded.report);
  }

  return result;
}

async function applyUpload(
  input: {
    projectRoot: string;
    backend: OverleafBackend;
    projectId: string;
    auth: ProjectAuth;
    retry?: SyncRetryConfig;
    timeout?: SyncTimeoutConfig;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
    downloadTimeoutMs?: number;
  },
  operation: SyncOperation
): Promise<{ snapshot: RemoteFileSnapshot; report: SyncTransferReport }> {
  const path = requireSafeSyncPath(operation.path);
  const bytes = await readFile(toAbsolutePath(input.projectRoot, path));
  const transfer = await runApplyTransfer({
    path,
    size: bytes.byteLength,
    input,
    operation: () =>
      input.backend.uploadFile({
        projectId: input.projectId,
        auth: input.auth,
        path,
        bytes,
      }),
  });
  const uploaded = transfer.value;
  const snapshot = {
    path,
    exists: true,
    contentHash: uploaded.contentHash ?? operation.local?.contentHash,
    size: uploaded.size ?? bytes.byteLength,
    modifiedAt: uploaded.modifiedAt,
    remoteId: uploaded.remoteId,
    revision: uploaded.revision,
    binary: uploaded.binary,
  };

  return {
    snapshot,
    report: {
      status: "ok",
      operation: "upload",
      path,
      size: bytes.byteLength,
      elapsedMs: transfer.elapsedMs,
      attempts: transfer.attempts,
    },
  };
}

async function applyDownload(
  input: {
    projectRoot: string;
    backend: OverleafBackend;
    projectId: string;
    auth: ProjectAuth;
    downloadTimeoutMs?: number;
    retry?: SyncRetryConfig;
    timeout?: SyncTimeoutConfig;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
  },
  operation: SyncOperation
): Promise<{ snapshot: RemoteFileSnapshot; report: SyncTransferReport }> {
  const path = requireSafeSyncPath(operation.path);
  const transfer = await runApplyTransfer({
    path,
    size: operation.remote?.size,
    input,
    operation: ({ timeoutMs }) =>
      withRemoteDownloadTimeout(
        () =>
          input.backend.downloadFile({
            projectId: input.projectId,
            auth: input.auth,
            path,
            remoteId: operation.remote?.remoteId,
          }),
        {
          path,
          timeoutMs,
          message: "Timed out downloading a remote file while applying the sync plan.",
          hint: "Retry olcx sync. If it repeats, inspect this file in Overleaf or add it to sync.ignore intentionally.",
        }
      ),
  });
  const bytes = transfer.value;
  const absolutePath = toAbsolutePath(input.projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  const snapshot = {
    path,
    exists: true,
    contentHash: sha256Hex(bytes),
    size: operation.remote?.size ?? bytes.byteLength,
    modifiedAt: operation.remote?.modifiedAt,
    remoteId: operation.remote?.remoteId,
    revision: operation.remote?.revision,
    binary: operation.remote?.binary,
  };

  return {
    snapshot,
    report: {
      status: "ok",
      operation: "download",
      path,
      size: bytes.byteLength,
      elapsedMs: transfer.elapsedMs,
      attempts: transfer.attempts,
    },
  };
}

function requireSafeSyncPath(path: string): string {
  const normalized = normalizeSyncPath(path);
  const segments = normalized.split("/").filter(Boolean);

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    win32.isAbsolute(path) ||
    segments.includes("..")
  ) {
    throw createOlcxError({
      code: "SYNC_UNSAFE_OPERATION",
      message: "Sync operation contains an unsafe path.",
      hint: "Resolve the unsafe path manually, then run olcx sync --dry-run.",
      details: { path: normalized },
    });
  }

  return normalized;
}

function toAbsolutePath(projectRoot: string, path: string): string {
  return join(projectRoot, ...path.split("/"));
}

function normalizeDownloadConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SYNC_DOWNLOAD_CONCURRENCY;
  }
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SYNC_DOWNLOAD_CONCURRENCY;
  }
  return Math.min(value, MAX_SYNC_DOWNLOAD_CONCURRENCY);
}

function normalizeUploadConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SYNC_UPLOAD_CONCURRENCY;
  }
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_SYNC_UPLOAD_CONCURRENCY;
  }
  return Math.min(value, MAX_SYNC_UPLOAD_CONCURRENCY);
}

function estimateEtaMs(input: { completed: number; total: number; elapsedMs: number }): number | undefined {
  if (input.completed <= 0 || input.total <= input.completed) {
    return 0;
  }

  return Math.max(0, Math.round((input.elapsedMs / input.completed) * (input.total - input.completed)));
}

async function runApplyTransfer<T>(input: {
  path: string;
  size?: number;
  input: {
    retry?: SyncRetryConfig;
    timeout?: SyncTimeoutConfig;
    downloadTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
  };
  operation: (attempt: { attempt: number; timeoutMs: number }) => Promise<T>;
}) {
  try {
    return await runTransferWithRetry({
      path: input.path,
      size: input.size,
      retry: normalizeRetry(input.input.retry),
      timeout: input.input.timeout ?? fixedTimeoutConfig(input.input.downloadTimeoutMs ?? DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS),
      operation: input.operation,
      sleep: input.input.sleep,
      nowMs: input.input.nowMs,
    });
  } catch (error) {
    throw normalizeTransferError(error);
  }
}

function normalizeRetry(retry: SyncRetryConfig | undefined): SyncRetryConfig {
  if (
    retry === undefined ||
    !Number.isInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    !Number.isFinite(retry.delayMs) ||
    retry.delayMs < 0
  ) {
    return { maxAttempts: 1, delayMs: 0 };
  }

  return retry;
}

function fixedTimeoutConfig(timeoutMs: number): SyncTimeoutConfig {
  return {
    baseMs: timeoutMs,
    unknownSizeMs: timeoutMs,
    minBytesPerSecond: Number.MAX_SAFE_INTEGER,
    bufferRatio: 0,
    maxMs: timeoutMs,
  };
}

function normalizeTransferError(error: unknown): unknown {
  if (!isTransferFailure(error)) {
    return error;
  }

  if (isOlcxError(error.cause)) {
    throw createOlcxError({
      code: error.cause.code,
      message: error.cause.message,
      hint: error.cause.hint,
      details: {
        ...(error.cause.details ?? {}),
        attempts: error.attempts,
        timeoutMs: error.timeoutMs,
      },
      cause: error.cause,
    });
  }

  throw createOlcxError({
    code: "BACKEND_NETWORK_ERROR",
    message: error.message,
    hint: "Retry olcx sync. If it repeats, inspect the file in Overleaf or add it to sync.ignore intentionally.",
    details: {
      path: error.path,
      attempts: error.attempts,
      timeoutMs: error.timeoutMs,
    },
    cause: error.cause,
  });
}

function isTransferFailure(error: unknown): error is TransferFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { path?: unknown }).path === "string" &&
    typeof (error as { attempts?: unknown }).attempts === "number" &&
    typeof (error as { timeoutMs?: unknown }).timeoutMs === "number" &&
    "cause" in error
  );
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await fn(items[index]);
      } catch (error) {
        failure = error;
        return;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure !== undefined) {
    throw failure;
  }
  return results;
}
