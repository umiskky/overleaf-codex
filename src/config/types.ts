export const OLCX_DIR = ".olcx" as const;
export const PROJECT_CONFIG_FILENAME = "config.json" as const;
export const PROJECT_CONFIG_PATH = `${OLCX_DIR}/${PROJECT_CONFIG_FILENAME}` as const;
export const MAX_FAST_FALLBACK_ATTEMPTS = 3 as const;
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
