export const OLCX_DIR = ".olcx" as const;
export const PROJECT_CONFIG_FILENAME = "config.json" as const;
export const PROJECT_CONFIG_PATH = `${OLCX_DIR}/${PROJECT_CONFIG_FILENAME}` as const;
export const MAX_FAST_FALLBACK_ATTEMPTS = 3 as const;
export const DEFAULT_SYNC_DOWNLOAD_CONCURRENCY = 5 as const;
export const MAX_SYNC_DOWNLOAD_CONCURRENCY = 5 as const;
export const DEFAULT_SYNC_UPLOAD_CONCURRENCY = 3 as const;
export const MAX_SYNC_UPLOAD_CONCURRENCY = 5 as const;
export const DEFAULT_SYNC_RETRY_MAX_ATTEMPTS = 5 as const;
export const DEFAULT_SYNC_RETRY_DELAY_MS = 6000 as const;
export const DEFAULT_SYNC_TIMEOUT_BASE_MS = 30000 as const;
export const DEFAULT_SYNC_TIMEOUT_UNKNOWN_SIZE_MS = 600000 as const;
export const DEFAULT_SYNC_TIMEOUT_MIN_BYTES_PER_SECOND = 25000 as const;
export const DEFAULT_SYNC_TIMEOUT_BUFFER_RATIO = 2.5 as const;
export const DEFAULT_SYNC_TIMEOUT_MAX_MS = 1800000 as const;
export type OverleafBaseUrl = "https://www.overleaf.com" | "https://cn.overleaf.com";
export const DEFAULT_OVERLEAF_BASE_URL: OverleafBaseUrl = "https://www.overleaf.com";

export interface ProjectConfig {
  schemaVersion: 1;
  projectId: string;
  projectUrl?: string;
  overleaf: {
    baseUrl: OverleafBaseUrl;
  };
  rootDocument: string;
  pdfPath: string;
  sync: {
    mode: "bidirectional";
    conflictPolicy: "pause";
    ignore: string[];
    remoteCheck: "local-baseline" | "strict";
    downloadConcurrency: number;
    uploadConcurrency: number;
    retry: {
      maxAttempts: number;
      delayMs: number;
    };
    timeout: {
      baseMs: number;
      unknownSizeMs: number;
      minBytesPerSecond: number;
      bufferRatio: number;
      maxMs: number;
    };
  };
  compile: {
    timeoutMs: number;
    fastFallback: {
      enabled: boolean;
      attempts: number;
      timeoutMs: number;
    };
  };
}

export interface CreateDefaultProjectConfigInput {
  projectId: string;
  projectUrl?: string;
  overleaf?: {
    baseUrl?: OverleafBaseUrl;
  };
  rootDocument?: string;
  pdfPath?: string;
  sync?: {
    ignore?: string[];
    remoteCheck?: "local-baseline" | "strict";
    downloadConcurrency?: number;
    uploadConcurrency?: number;
    retry?: {
      maxAttempts?: number;
      delayMs?: number;
    };
    timeout?: {
      baseMs?: number;
      unknownSizeMs?: number;
      minBytesPerSecond?: number;
      bufferRatio?: number;
      maxMs?: number;
    };
  };
  compile?: {
    timeoutMs?: number;
    fastFallback?: {
      enabled?: boolean;
      attempts?: number;
      timeoutMs?: number;
    };
  };
}

export function createDefaultProjectConfig(input: CreateDefaultProjectConfigInput): ProjectConfig {
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectId: input.projectId,
    overleaf: {
      baseUrl: input.overleaf?.baseUrl ?? DEFAULT_OVERLEAF_BASE_URL,
    },
    rootDocument: input.rootDocument ?? "main.tex",
    pdfPath: input.pdfPath ?? "build/overleaf/main.pdf",
    sync: {
      mode: "bidirectional",
      conflictPolicy: "pause",
      ignore: input.sync?.ignore ?? [],
      remoteCheck: input.sync?.remoteCheck ?? "local-baseline",
      downloadConcurrency: input.sync?.downloadConcurrency ?? DEFAULT_SYNC_DOWNLOAD_CONCURRENCY,
      uploadConcurrency: input.sync?.uploadConcurrency ?? DEFAULT_SYNC_UPLOAD_CONCURRENCY,
      retry: {
        maxAttempts: input.sync?.retry?.maxAttempts ?? DEFAULT_SYNC_RETRY_MAX_ATTEMPTS,
        delayMs: input.sync?.retry?.delayMs ?? DEFAULT_SYNC_RETRY_DELAY_MS,
      },
      timeout: {
        baseMs: input.sync?.timeout?.baseMs ?? DEFAULT_SYNC_TIMEOUT_BASE_MS,
        unknownSizeMs: input.sync?.timeout?.unknownSizeMs ?? DEFAULT_SYNC_TIMEOUT_UNKNOWN_SIZE_MS,
        minBytesPerSecond:
          input.sync?.timeout?.minBytesPerSecond ?? DEFAULT_SYNC_TIMEOUT_MIN_BYTES_PER_SECOND,
        bufferRatio: input.sync?.timeout?.bufferRatio ?? DEFAULT_SYNC_TIMEOUT_BUFFER_RATIO,
        maxMs: input.sync?.timeout?.maxMs ?? DEFAULT_SYNC_TIMEOUT_MAX_MS,
      },
    },
    compile: {
      timeoutMs: input.compile?.timeoutMs ?? 120000,
      fastFallback: {
        enabled: input.compile?.fastFallback?.enabled ?? true,
        attempts: input.compile?.fastFallback?.attempts ?? 1,
        timeoutMs: input.compile?.fastFallback?.timeoutMs ?? 30000,
      },
    },
  };

  if (input.projectUrl !== undefined) {
    config.projectUrl = input.projectUrl;
  }

  return config;
}
