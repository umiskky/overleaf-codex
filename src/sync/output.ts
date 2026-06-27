export type SyncTransferStatus = "ok" | "failed" | "skipped";
export type SyncTransferOperation = "download" | "upload" | "deleteLocal" | "deleteRemote" | "unchanged";

export interface SyncProgressEvent {
  status: "start" | "ok" | "failed";
  operation: SyncTransferOperation;
  path: string;
  completed: number;
  total: number;
  elapsedMs: number;
  etaMs?: number;
}

export interface SyncTransferReport {
  status: SyncTransferStatus;
  operation: SyncTransferOperation;
  path: string;
  size?: number;
  elapsedMs: number;
  attempts: number;
  error?: string;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatTransferSummary(input: {
  title: string;
  reports: SyncTransferReport[];
  elapsedMs: number;
}): string {
  const ok = input.reports.filter((report) => report.status === "ok").length;
  const failed = input.reports.filter((report) => report.status === "failed").length;
  const skipped = input.reports.filter((report) => report.status === "skipped").length;
  const totalBytes = input.reports.reduce((sum, report) => sum + (report.size ?? 0), 0);
  const rows = input.reports.map((report) => ({
    Status: report.status,
    Op: report.operation,
    Path: report.path,
    Size: formatBytes(report.size),
    Time: formatDurationMs(report.elapsedMs),
    Attempts: String(report.attempts),
    Error: report.error ?? "",
  }));
  const visibleColumns = ["Status", "Op", "Path", "Size", "Time", "Attempts"] as const;
  const widths = Object.fromEntries(
    visibleColumns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => row[column].length)),
    ])
  ) as Record<(typeof visibleColumns)[number], number>;
  const lines = [
    input.title,
    `Summary: ${ok} ok, ${failed} failed, ${skipped} skipped, ${formatBytes(totalBytes)}, elapsed ${formatDurationMs(input.elapsedMs)}`,
    "",
    formatRow(Object.fromEntries(visibleColumns.map((column) => [column, column])), visibleColumns, widths),
    ...rows.map((row) => formatRow(row, visibleColumns, widths)),
  ];

  const errors = rows.filter((row) => row.Error.length > 0);
  if (errors.length > 0) {
    lines.push("", "Errors:", ...errors.map((row) => `- ${row.Path}: ${row.Error}`));
  }

  return `${lines.join("\n")}\n`;
}

export function formatTransferProgress(event: SyncProgressEvent): string {
  const total = Math.max(1, event.total);
  const completed = Math.min(Math.max(0, event.completed), total);
  const filled = Math.round((completed / total) * 10);
  const bar = `${"#".repeat(filled)}${"-".repeat(10 - filled)}`;
  const eta = event.etaMs === undefined ? "unknown" : formatDurationMs(event.etaMs);

  return `Progress [${bar}] ${completed}/${event.total} ${event.operation} ${event.path} ETA ${eta}\n`;
}

function formatRow(
  row: Record<string, string>,
  columns: readonly string[],
  widths: Record<string, number>
): string {
  return `| ${columns.map((column) => row[column].padEnd(widths[column])).join(" | ")} |`;
}
