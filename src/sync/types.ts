export const SYNC_STATE_PATH = ".olcx/state/sync.json" as const;
export const CONFLICT_REPORT_PATH = ".olcx/state/conflicts.json" as const;
export const CONTENT_DIGEST_ALGORITHM = "sha256" as const;

export type SyncOperationType =
  | "upload"
  | "download"
  | "deleteLocal"
  | "deleteRemote"
  | "unchanged"
  | "conflict"
  | "ignored";

export type SyncConflictReason =
  | "both-modified"
  | "local-modified-remote-deleted"
  | "remote-modified-local-deleted"
  | "unsafe-delete"
  | "unsupported";

export interface SyncSideSnapshot {
  path: string;
  exists: boolean;
  contentHash?: string;
  size?: number;
  modifiedAt?: string;
}

export interface LocalFileSnapshot extends SyncSideSnapshot {
  ignored?: boolean;
}

export interface RemoteFileSnapshot extends SyncSideSnapshot {
  remoteId?: string;
  revision?: string;
  binary?: boolean;
}

export interface SyncStateEntry {
  path: string;
  contentHash: string;
  size?: number;
  localModifiedAt?: string;
  remoteModifiedAt?: string;
  remoteId?: string;
  remoteRevision?: string;
  syncedAt: string;
}

export interface SyncStateFile {
  schemaVersion: 1;
  hashAlgorithm: typeof CONTENT_DIGEST_ALGORITHM;
  updatedAt: string;
  files: Record<string, SyncStateEntry>;
}

export interface SyncOperation {
  type: SyncOperationType;
  path: string;
  reason: string;
  local?: LocalFileSnapshot;
  remote?: RemoteFileSnapshot;
  base?: SyncStateEntry;
  conflictReason?: SyncConflictReason;
}

export interface SyncConflict {
  path: string;
  reason: SyncConflictReason;
  local?: LocalFileSnapshot;
  remote?: RemoteFileSnapshot;
  base?: SyncStateEntry;
  recommendation: string;
}

export interface SyncPlanSummary {
  upload: number;
  download: number;
  deleteLocal: number;
  deleteRemote: number;
  unchanged: number;
  conflict: number;
  ignored: number;
}

export interface SyncPlan {
  projectId: string;
  createdAt: string;
  dryRun: boolean;
  operations: SyncOperation[];
  conflicts: SyncConflict[];
  summary: SyncPlanSummary;
}

export interface SyncPlanInput {
  projectId: string;
  createdAt: string;
  dryRun: boolean;
  state: SyncStateFile;
  localFiles: LocalFileSnapshot[];
  remoteFiles: RemoteFileSnapshot[];
  userIgnorePatterns?: string[];
  allowDeletes?: boolean;
}

export interface ConflictReportFileDigest {
  contentHash?: string;
  size?: number;
  modifiedAt?: string;
  remoteId?: string;
  revision?: string;
}

export interface ConflictReportEntry {
  path: string;
  reason: SyncConflictReason;
  local?: ConflictReportFileDigest;
  remote?: ConflictReportFileDigest;
  base?: {
    contentHash: string;
    size?: number;
    syncedAt: string;
  };
  suggestedCommands: string[];
  manualSteps: string[];
}

export interface ConflictReport {
  schemaVersion: 1;
  generatedAt: string;
  reportPath: typeof CONFLICT_REPORT_PATH;
  syncStatePath: typeof SYNC_STATE_PATH;
  watch: {
    paused: boolean;
    reason: "sync-conflict";
    resumeCommand: "olcx watch";
  };
  conflicts: ConflictReportEntry[];
  manualSteps: string[];
}
