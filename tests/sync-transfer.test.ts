import { describe, expect, it } from "vitest";
import {
  calculateFileTimeoutMs,
  runTransferWithRetry,
  type SyncRetryConfig,
  type SyncTimeoutConfig,
} from "../src/sync/transfer";

const retry: SyncRetryConfig = {
  maxAttempts: 3,
  delayMs: 25,
};

const timeout: SyncTimeoutConfig = {
  baseMs: 1000,
  unknownSizeMs: 60000,
  minBytesPerSecond: 25000,
  bufferRatio: 2,
  maxMs: 120000,
};

describe("sync transfer helpers", () => {
  it("calculates a conservative per-file timeout from known or unknown size", () => {
    expect(calculateFileTimeoutMs(100000, timeout)).toBe(9000);
    expect(calculateFileTimeoutMs(undefined, timeout)).toBe(60000);
    expect(calculateFileTimeoutMs(10_000_000, timeout)).toBe(120000);
  });

  it("retries failed transfers with the configured delay and reports attempts", async () => {
    const sleeps: number[] = [];
    let attempts = 0;

    const result = await runTransferWithRetry({
      path: "main.tex",
      size: 10,
      retry,
      timeout,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      operation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary failure");
        }
        return Buffer.from("ok", "utf8");
      },
    });

    expect(result.value.toString()).toBe("ok");
    expect(result.attempts).toBe(3);
    expect(result.timeoutMs).toBe(1001);
    expect(sleeps).toEqual([25, 25]);
  });

  it("fails after the configured retry budget is exhausted", async () => {
    let attempts = 0;

    await expect(
      runTransferWithRetry({
        path: "main.tex",
        retry: { maxAttempts: 2, delayMs: 0 },
        timeout,
        operation: async () => {
          attempts += 1;
          throw new Error("still failing");
        },
      })
    ).rejects.toMatchObject({
      attempts: 2,
      path: "main.tex",
    });
    expect(attempts).toBe(2);
  });
});
