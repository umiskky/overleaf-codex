import type { WatchChangeEvent, WatchQueue, WatchQueueInput, WatchQueueStatus } from "./types.js";

export function createWatchQueue(input: WatchQueueInput): WatchQueue {
  const timers = input.timers ?? { setTimeout, clearTimeout };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bufferedEvents: WatchChangeEvent[] = [];
  let running = false;
  let pending = false;
  let paused = false;
  let stopped = false;
  let lastError: unknown;
  let currentRun: Promise<void> | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
      timer = undefined;
    }
  }

  function schedule(): void {
    clearTimer();
    if (paused || stopped || bufferedEvents.length === 0) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      void drain();
    }, input.debounceMs);
  }

  async function drain(): Promise<void> {
    if (paused || stopped || running) {
      pending = running && !paused && !stopped && bufferedEvents.length > 0;
      return;
    }

    const events = bufferedEvents;
    bufferedEvents = [];
    pending = false;
    running = true;
    currentRun = (async () => {
      try {
        await input.onStart?.(events);
        await input.run(events);
        await input.onSuccess?.(events);
      } catch (error) {
        lastError = error;
        paused = true;
        bufferedEvents = [];
        pending = false;
        clearTimer();
        await input.onFailure?.(error, events);
      } finally {
        running = false;
        currentRun = undefined;
        if (!paused && !stopped && bufferedEvents.length > 0) {
          pending = true;
          schedule();
        }
      }
    })();

    await currentRun;
  }

  return {
    trigger(event) {
      if (paused || stopped) return false;
      bufferedEvents.push(event);
      if (running) {
        pending = true;
        return true;
      }
      schedule();
      return true;
    },
    pause(error) {
      lastError = error;
      paused = true;
      pending = false;
      bufferedEvents = [];
      clearTimer();
    },
    status(): WatchQueueStatus {
      return { paused, running, pending, stopped, lastError };
    },
    async shutdown() {
      stopped = true;
      pending = false;
      bufferedEvents = [];
      clearTimer();
      await currentRun;
    },
  };
}
