import { redactSensitive } from "../cli-behavior.js";
import {
  CONFLICT_REPORT_PATH,
  SYNC_STATE_PATH,
  type ConflictReport,
  type ConflictReportEntry,
  type ConflictReportFileDigest,
  type SyncConflict,
  type SyncStateEntry,
} from "./types.js";

const REPORT_MANUAL_STEPS = [
  "Open each conflict path locally and in Overleaf.",
  "Choose local, remote, or a manual merge.",
  "Run olcx sync --dry-run.",
  "Run olcx sync after the dry run is clean.",
  "Restart olcx watch if you use the watcher.",
];

export function createConflictReport(input: {
  generatedAt: string;
  conflicts: SyncConflict[];
  watchPaused: boolean;
}): ConflictReport {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    reportPath: CONFLICT_REPORT_PATH,
    syncStatePath: SYNC_STATE_PATH,
    watch: {
      paused: input.watchPaused,
      reason: "sync-conflict",
      resumeCommand: "olcx watch",
    },
    conflicts: input.conflicts.map(toReportEntry),
    manualSteps: REPORT_MANUAL_STEPS,
  };
}

export function formatConflictReport(report: ConflictReport): string {
  return redactSensitive(JSON.stringify(report, null, 2));
}

function toReportEntry(conflict: SyncConflict): ConflictReportEntry {
  return {
    path: conflict.path,
    reason: conflict.reason,
    local: conflict.local ? toDigest(conflict.local) : undefined,
    remote: conflict.remote ? toDigest(conflict.remote) : undefined,
    base: conflict.base ? toBaseDigest(conflict.base) : undefined,
    suggestedCommands: ["olcx sync --dry-run", "olcx sync"],
    manualSteps: [
      `Review ${conflict.path} locally and in Overleaf.`,
      conflict.recommendation,
      "Run olcx sync --dry-run before applying changes.",
    ],
  };
}

function toDigest(input: {
  contentHash?: string;
  size?: number;
  modifiedAt?: string;
  remoteId?: string;
  revision?: string;
}): ConflictReportFileDigest {
  return {
    contentHash: input.contentHash,
    size: input.size,
    modifiedAt: input.modifiedAt,
    remoteId: input.remoteId,
    revision: input.revision,
  };
}

function toBaseDigest(base: SyncStateEntry): ConflictReportEntry["base"] {
  return {
    contentHash: base.contentHash,
    size: base.size,
    syncedAt: base.syncedAt,
  };
}
