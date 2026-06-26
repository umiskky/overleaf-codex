import { afterEach, describe, expect, it, vi } from "vitest";
import { createOlcxError } from "../src/errors";
import { createWatchQueue } from "../src/watch/queue";
import type { WatchChangeEvent } from "../src/watch/types";

const change = (path: string): WatchChangeEvent => ({ event: "change", path });

describe("watch debounce queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces consecutive events into one workflow run", async () => {
    vi.useFakeTimers();
    const runs: WatchChangeEvent[][] = [];
    const queue = createWatchQueue({
      debounceMs: 25,
      run: async (events) => {
        runs.push(events);
      },
    });

    queue.trigger(change("main.tex"));
    queue.trigger(change("sections/intro.tex"));

    await vi.advanceTimersByTimeAsync(24);
    expect(runs).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual([[change("main.tex"), change("sections/intro.tex")]]);
    expect(queue.status()).toMatchObject({ paused: false, running: false, pending: false });
  });

  it("runs queued work serially and never overlaps workflows", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    let active = 0;
    let maxActive = 0;
    const starts: string[][] = [];
    const queue = createWatchQueue({
      debounceMs: 10,
      run: async (events) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(events.map((event) => event.path));
        if (starts.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        active -= 1;
      },
    });

    queue.trigger(change("main.tex"));
    await vi.advanceTimersByTimeAsync(10);
    expect(starts).toEqual([["main.tex"]]);

    queue.trigger(change("refs.bib"));
    await vi.advanceTimersByTimeAsync(30);
    expect(starts).toEqual([["main.tex"]]);
    expect(maxActive).toBe(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(10);
    expect(starts).toEqual([["main.tex"], ["refs.bib"]]);
    expect(maxActive).toBe(1);
  });

  it("pauses after a workflow failure and ignores later triggers", async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    let runs = 0;
    const error = createOlcxError({
      code: "COMPILE_FAILED",
      message: "Fake compile failure.",
      hint: "Run olcx compile.",
    });
    const queue = createWatchQueue({
      debounceMs: 5,
      run: async () => {
        runs += 1;
        throw error;
      },
      onFailure: async (failure) => {
        failures.push(failure);
      },
    });

    queue.trigger(change("main.tex"));
    await vi.advanceTimersByTimeAsync(5);

    expect(runs).toBe(1);
    expect(failures).toEqual([error]);
    expect(queue.status()).toMatchObject({ paused: true, running: false, pending: false });

    queue.trigger(change("main.tex"));
    await vi.advanceTimersByTimeAsync(20);
    expect(runs).toBe(1);
  });

  it("clears pending timers during shutdown", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const queue = createWatchQueue({
      debounceMs: 50,
      run: async () => {
        runs += 1;
      },
    });

    queue.trigger(change("main.tex"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await queue.shutdown();
    await vi.advanceTimersByTimeAsync(100);

    expect(runs).toBe(0);
    expect(queue.status()).toMatchObject({ stopped: true, running: false, pending: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
