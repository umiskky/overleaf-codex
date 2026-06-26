import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { type ProjectAuth } from "../auth/types.js";
import { type OverleafBackend } from "../backend/types.js";
import { createOlcxError } from "../errors.js";
import { normalizeSyncPath } from "./ignore.js";
import { type RemoteFileSnapshot, type SyncOperation, type SyncPlan } from "./types.js";

export interface ApplySyncPlanResult {
  uploaded: Map<string, RemoteFileSnapshot>;
  downloaded: string[];
}

export async function applySyncPlan(input: {
  projectRoot: string;
  backend: OverleafBackend;
  projectId: string;
  auth: ProjectAuth;
  plan: SyncPlan;
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
  };

  if (input.plan.dryRun) {
    return result;
  }

  for (const operation of input.plan.operations) {
    if (operation.type === "upload") {
      const uploaded = await applyUpload(input, operation);
      result.uploaded.set(uploaded.path, uploaded);
      continue;
    }

    if (operation.type === "download") {
      const downloadedPath = await applyDownload(input, operation);
      result.downloaded.push(downloadedPath);
    }
  }

  return result;
}

async function applyUpload(
  input: {
    projectRoot: string;
    backend: OverleafBackend;
    projectId: string;
    auth: ProjectAuth;
  },
  operation: SyncOperation
): Promise<RemoteFileSnapshot> {
  const path = requireSafeSyncPath(operation.path);
  const bytes = await readFile(toAbsolutePath(input.projectRoot, path));
  const uploaded = await input.backend.uploadFile({
    projectId: input.projectId,
    auth: input.auth,
    path,
    bytes,
  });

  return {
    path,
    exists: true,
    contentHash: uploaded.contentHash ?? operation.local?.contentHash,
    size: uploaded.size ?? bytes.byteLength,
    modifiedAt: uploaded.modifiedAt,
    remoteId: uploaded.remoteId,
    revision: uploaded.revision,
    binary: uploaded.binary,
  };
}

async function applyDownload(
  input: {
    projectRoot: string;
    backend: OverleafBackend;
    projectId: string;
    auth: ProjectAuth;
  },
  operation: SyncOperation
): Promise<string> {
  const path = requireSafeSyncPath(operation.path);
  const bytes = await input.backend.downloadFile({
    projectId: input.projectId,
    auth: input.auth,
    path,
    remoteId: operation.remote?.remoteId,
  });
  const absolutePath = toAbsolutePath(input.projectRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return path;
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
