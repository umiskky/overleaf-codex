import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDurationMs,
  formatTransferProgress,
  formatTransferSummary,
  type SyncProgressEvent,
  type SyncTransferReport,
} from "../src/sync/output";

describe("sync output formatting", () => {
  it("formats byte and duration values for human-readable sync output", () => {
    expect(formatBytes(undefined)).toBe("unknown");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");

    expect(formatDurationMs(900)).toBe("0.9s");
    expect(formatDurationMs(65_000)).toBe("1m 05s");
  });

  it("formats a stable table for successful and failed transfer results", () => {
    const reports: SyncTransferReport[] = [
      {
        status: "ok",
        operation: "download",
        path: "main.tex",
        size: 4096,
        elapsedMs: 2300,
        attempts: 1,
      },
      {
        status: "failed",
        operation: "upload",
        path: "figures/large.pdf",
        size: undefined,
        elapsedMs: 300000,
        attempts: 5,
        error: "network timeout",
      },
    ];

    const output = formatTransferSummary({
      title: "olcx sync summary",
      reports,
      elapsedMs: 302300,
    });

    expect(output).toContain("olcx sync summary");
    expect(output).toContain("1 ok, 1 failed");
    expect(output).toContain("| Status | Op       | Path              | Size    | Time   | Attempts |");
    expect(output).toContain("| ok     | download | main.tex          | 4.0 KB  | 2.3s   | 1        |");
    expect(output).toContain("| failed | upload   | figures/large.pdf | unknown | 5m 00s | 5        |");
    expect(output).toContain("network timeout");
  });

  it("formats file-level progress with ETA", () => {
    const event: SyncProgressEvent = {
      status: "ok",
      operation: "download",
      path: "figures/large.pdf",
      completed: 2,
      total: 5,
      elapsedMs: 12000,
      etaMs: 18000,
    };

    expect(formatTransferProgress(event)).toBe(
      "Progress [####------] 2/5 download figures/large.pdf ETA 18.0s\n"
    );
  });
});
