export interface SyncRetryConfig {
  maxAttempts: number;
  delayMs: number;
}

export interface SyncTimeoutConfig {
  baseMs: number;
  unknownSizeMs: number;
  minBytesPerSecond: number;
  bufferRatio: number;
  maxMs: number;
}

export interface TransferAttemptInput {
  attempt: number;
  timeoutMs: number;
}

export interface TransferWithRetryResult<T> {
  value: T;
  attempts: number;
  elapsedMs: number;
  timeoutMs: number;
}

export interface TransferFailure extends Error {
  path: string;
  attempts: number;
  timeoutMs: number;
  cause: unknown;
}

export function calculateFileTimeoutMs(size: number | undefined, config: SyncTimeoutConfig): number {
  if (size === undefined) {
    return config.unknownSizeMs;
  }

  const estimatedMs = config.baseMs + (size / config.minBytesPerSecond) * 1000 * config.bufferRatio;
  return Math.min(Math.ceil(estimatedMs), config.maxMs);
}

export async function runTransferWithRetry<T>(input: {
  path: string;
  size?: number;
  retry: SyncRetryConfig;
  timeout: SyncTimeoutConfig;
  operation: (attempt: TransferAttemptInput) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}): Promise<TransferWithRetryResult<T>> {
  const sleep = input.sleep ?? defaultSleep;
  const nowMs = input.nowMs ?? (() => Date.now());
  const startedAt = nowMs();
  const timeoutMs = calculateFileTimeoutMs(input.size, input.timeout);
  let lastError: unknown;

  for (let attempt = 1; attempt <= input.retry.maxAttempts; attempt += 1) {
    try {
      const value = await input.operation({ attempt, timeoutMs });
      return {
        value,
        attempts: attempt,
        elapsedMs: Math.max(0, nowMs() - startedAt),
        timeoutMs,
      };
    } catch (error) {
      lastError = error;
      if (attempt === input.retry.maxAttempts) {
        throw transferFailure({
          path: input.path,
          attempts: attempt,
          timeoutMs,
          cause: lastError,
        });
      }
      await sleep(input.retry.delayMs);
    }
  }

  throw transferFailure({
    path: input.path,
    attempts: input.retry.maxAttempts,
    timeoutMs,
    cause: lastError,
  });
}

function transferFailure(input: {
  path: string;
  attempts: number;
  timeoutMs: number;
  cause: unknown;
}): TransferFailure {
  const message = input.cause instanceof Error ? input.cause.message : "Transfer failed.";
  const error = new Error(message) as TransferFailure;
  error.path = input.path;
  error.attempts = input.attempts;
  error.timeoutMs = input.timeoutMs;
  error.cause = input.cause;
  return error;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
