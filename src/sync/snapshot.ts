import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ProjectAuth } from "../auth/types.js";
import { type OverleafBackend } from "../backend/types.js";
import { createIgnoreMatcher, normalizeSyncPath } from "./ignore.js";
import { sha256Hex } from "./plan.js";
import { type LocalFileSnapshot, type RemoteFileSnapshot } from "./types.js";

export async function createLocalSnapshot(input: {
  projectRoot: string;
  userIgnorePatterns?: string[];
}): Promise<LocalFileSnapshot[]> {
  const ignoreMatcher = createIgnoreMatcher(input.userIgnorePatterns);
  const files: LocalFileSnapshot[] = [];

  async function visit(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = relativeDirectory
      ? join(input.projectRoot, ...relativeDirectory.split("/"))
      : input.projectRoot;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = normalizeSyncPath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      if (ignoreMatcher.isIgnored(relativePath)) {
        continue;
      }

      const absolutePath = join(input.projectRoot, ...relativePath.split("/"));
      const linkStats = await lstat(absolutePath);
      if (linkStats.isSymbolicLink()) {
        continue;
      }

      if (linkStats.isDirectory()) {
        await visit(relativePath);
        continue;
      }

      if (!linkStats.isFile()) {
        continue;
      }

      const bytes = await readFile(absolutePath);
      const fileStats = await stat(absolutePath);
      files.push({
        path: relativePath,
        exists: true,
        contentHash: sha256Hex(bytes),
        size: bytes.byteLength,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
  }

  await visit("");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function createRemoteSnapshot(_input: {
  backend: OverleafBackend;
  projectId: string;
  auth: ProjectAuth;
  userIgnorePatterns?: string[];
}): Promise<RemoteFileSnapshot[]> {
  const input = _input;
  const ignoreMatcher = createIgnoreMatcher(input.userIgnorePatterns);
  const files = await input.backend.listFiles({ projectId: input.projectId, auth: input.auth });
  const snapshots: RemoteFileSnapshot[] = [];

  for (const file of files) {
    const path = normalizeSyncPath(file.path);
    if (file.kind !== "file" || ignoreMatcher.isIgnored(path)) {
      continue;
    }

    let contentHash = isValidSha256(file.contentHash) ? file.contentHash : undefined;
    let size = file.size;

    if (!contentHash) {
      const bytes = await input.backend.downloadFile({
        projectId: input.projectId,
        auth: input.auth,
        path,
        remoteId: file.remoteId,
      });
      contentHash = sha256Hex(bytes);
      size = size ?? bytes.byteLength;
    }

    snapshots.push({
      path,
      exists: true,
      contentHash,
      size,
      modifiedAt: file.modifiedAt,
      remoteId: file.remoteId,
      revision: file.revision,
      binary: file.binary,
    });
  }

  return snapshots.sort((a, b) => a.path.localeCompare(b.path));
}

function isValidSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
