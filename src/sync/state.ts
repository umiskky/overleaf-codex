import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSensitive } from "../cli-behavior.js";
import { createOlcxError } from "../errors.js";
import { normalizeSyncPath } from "./ignore.js";
import {
  CONFLICT_REPORT_PATH,
  CONTENT_DIGEST_ALGORITHM,
  SYNC_STATE_PATH,
  type ConflictReport,
  type RemoteFileSnapshot,
  type SyncOperation,
  type SyncPlan,
  type SyncStateEntry,
  type SyncStateFile,
} from "./types.js";

export function createEmptySyncState(updatedAt: string): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: CONTENT_DIGEST_ALGORITHM,
    updatedAt,
    files: {},
  };
}

export function getSyncStatePath(projectRoot: string): string {
  return join(projectRoot, SYNC_STATE_PATH);
}

export function getConflictReportPath(projectRoot: string): string {
  return join(projectRoot, CONFLICT_REPORT_PATH);
}

export async function readSyncState(
  projectRoot: string,
  options: { now?: () => Date } = {}
): Promise<SyncStateFile> {
  try {
    const raw = await readFile(getSyncStatePath(projectRoot), "utf8");
    return validateSyncState(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return createEmptySyncState((options.now ?? (() => new Date()))().toISOString());
    }

    if (error instanceof SyntaxError || error instanceof Error) {
      throw createOlcxError({
        code: "PROJECT_CONFIG_INVALID",
        message: "Sync state is invalid.",
        hint: "Remove .olcx/state/sync.json or run olcx sync after resolving the state issue.",
        details: {
          path: SYNC_STATE_PATH,
          reason: error.message,
        },
        cause: error,
      });
    }

    throw createOlcxError({
      code: "IO_ERROR",
      message: "Unable to read sync state.",
      hint: "Check permissions for .olcx/state/sync.json and try again.",
      details: { path: SYNC_STATE_PATH },
      cause: error,
    });
  }
}

export async function writeSyncState(projectRoot: string, state: SyncStateFile): Promise<void> {
  const validated = validateSyncState(state);
  const path = getSyncStatePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export async function writeConflictReport(projectRoot: string, report: ConflictReport): Promise<void> {
  const path = getConflictReportPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${redactSensitive(report)}\n`, "utf8");
}

export async function clearConflictReport(projectRoot: string): Promise<void> {
  try {
    await rm(getConflictReportPath(projectRoot));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

export function buildNextSyncState(input: {
  previous: SyncStateFile;
  plan: SyncPlan;
  appliedAt: string;
  uploadResults?: Map<string, RemoteFileSnapshot>;
}): SyncStateFile {
  const files: Record<string, SyncStateEntry> = {};

  for (const operation of input.plan.operations) {
    const entry = stateEntryForOperation(operation, input.appliedAt, input.uploadResults);
    if (entry) {
      files[entry.path] = entry;
    }
  }

  return validateSyncState({
    schemaVersion: 1,
    hashAlgorithm: input.previous.hashAlgorithm,
    updatedAt: input.appliedAt,
    files,
  });
}

function stateEntryForOperation(
  operation: SyncOperation,
  appliedAt: string,
  uploadResults: Map<string, RemoteFileSnapshot> | undefined
): SyncStateEntry | undefined {
  const path = normalizeSyncPath(operation.path);

  if (operation.type === "upload") {
    if (!operation.local?.contentHash) {
      return undefined;
    }
    const remote = uploadResults?.get(path) ?? operation.remote;
    return compactEntry({
      path,
      contentHash: operation.local.contentHash,
      size: operation.local.size ?? remote?.size,
      localModifiedAt: operation.local.modifiedAt,
      remoteModifiedAt: remote?.modifiedAt,
      remoteId: remote?.remoteId,
      remoteRevision: remote?.revision,
      syncedAt: appliedAt,
    });
  }

  if (operation.type === "download") {
    if (!operation.remote?.contentHash) {
      return undefined;
    }
    return compactEntry({
      path,
      contentHash: operation.remote.contentHash,
      size: operation.remote.size,
      localModifiedAt: appliedAt,
      remoteModifiedAt: operation.remote.modifiedAt,
      remoteId: operation.remote.remoteId,
      remoteRevision: operation.remote.revision,
      syncedAt: appliedAt,
    });
  }

  if (operation.type === "unchanged") {
    const contentHash = operation.local?.contentHash ?? operation.remote?.contentHash ?? operation.base?.contentHash;
    const exists = operation.local?.exists === true || operation.remote?.exists === true;
    if (!exists || !contentHash) {
      return undefined;
    }

    return compactEntry({
      path,
      contentHash,
      size: operation.local?.size ?? operation.remote?.size ?? operation.base?.size,
      localModifiedAt: operation.local?.modifiedAt ?? operation.base?.localModifiedAt,
      remoteModifiedAt: operation.remote?.modifiedAt ?? operation.base?.remoteModifiedAt,
      remoteId: operation.remote?.remoteId ?? operation.base?.remoteId,
      remoteRevision: operation.remote?.revision ?? operation.base?.remoteRevision,
      syncedAt: appliedAt,
    });
  }

  return undefined;
}

function compactEntry(entry: SyncStateEntry): SyncStateEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as SyncStateEntry;
}

function validateSyncState(value: unknown): SyncStateFile {
  assertRecord(value, "sync state");

  if (value.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  if (value.hashAlgorithm !== CONTENT_DIGEST_ALGORITHM) {
    throw new Error('hashAlgorithm must be "sha256"');
  }

  const updatedAt = requireNonEmptyString(value.updatedAt, "updatedAt");
  const rawFiles = requireRecord(value.files, "files");
  const files: Record<string, SyncStateEntry> = {};

  for (const [key, rawEntry] of Object.entries(rawFiles)) {
    const entry = validateSyncStateEntry(rawEntry, key);
    files[entry.path] = entry;
  }

  return {
    schemaVersion: 1,
    hashAlgorithm: CONTENT_DIGEST_ALGORITHM,
    updatedAt,
    files,
  };
}

function validateSyncStateEntry(value: unknown, key: string): SyncStateEntry {
  assertRecord(value, `files.${key}`);
  const path = normalizeSyncPath(requireNonEmptyString(value.path ?? key, `files.${key}.path`));
  const contentHash = requireNonEmptyString(value.contentHash, `files.${key}.contentHash`);
  const syncedAt = requireNonEmptyString(value.syncedAt, `files.${key}.syncedAt`);

  return compactEntry({
    path,
    contentHash,
    size: optionalNumber(value.size, `files.${key}.size`),
    localModifiedAt: optionalString(value.localModifiedAt, `files.${key}.localModifiedAt`),
    remoteModifiedAt: optionalString(value.remoteModifiedAt, `files.${key}.remoteModifiedAt`),
    remoteId: optionalString(value.remoteId, `files.${key}.remoteId`),
    remoteRevision: optionalString(value.remoteRevision, `files.${key}.remoteRevision`),
    syncedAt,
  });
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  assertRecord(value, field);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
