export const PROJECT_AUTH_FILENAME = "auth.local.json" as const;
export const PROJECT_AUTH_PATH = ".olcx/auth.local.json" as const;
export const DEFAULT_PROJECT_AUTH_ENV_VAR = "OLCX_OVERLEAF_SESSION" as const;

export interface ProjectAuth {
  schemaVersion: 1;
  accountLabel?: string;
  sessionCookie: string;
  updatedAt: string;
  source: "interactive" | "cli-option" | "env";
}
