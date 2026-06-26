import type { ExitCode } from "../errors.js";

export type WatchEventName = "add" | "change" | "unlink";

export interface WatchChangeEvent {
  event: WatchEventName;
  path: string;
}

export interface WatchQueueStatus {
  paused: boolean;
  running: boolean;
  pending: boolean;
  stopped: boolean;
  lastError?: unknown;
}

export interface WatchTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface WatchQueueInput {
  debounceMs: number;
  run: (events: WatchChangeEvent[]) => Promise<void>;
  onStart?: (events: WatchChangeEvent[]) => void | Promise<void>;
  onSuccess?: (events: WatchChangeEvent[]) => void | Promise<void>;
  onFailure?: (error: unknown, events: WatchChangeEvent[]) => void | Promise<void>;
  timers?: WatchTimers;
}

export interface WatchQueue {
  trigger(event: WatchChangeEvent): boolean;
  pause(error?: unknown): void;
  status(): WatchQueueStatus;
  shutdown(): Promise<void>;
}

export interface WatchHandle {
  close(): Promise<void> | void;
}

export interface WatchAdapterInput {
  projectRoot: string;
  ignored: (path: string) => boolean;
  onChange: (event: WatchChangeEvent) => void;
  onError: (error: unknown) => void;
}

export interface WatchAdapter {
  watch(input: WatchAdapterInput): Promise<WatchHandle> | WatchHandle;
}

export type WatchSignalName = "SIGINT" | "SIGTERM";

export interface WatchSignalRuntime {
  on(signal: WatchSignalName, listener: () => void | Promise<void>): () => void;
}

export interface WatchCommandResult {
  exitCode: ExitCode;
  paused: boolean;
  lastError?: unknown;
}
