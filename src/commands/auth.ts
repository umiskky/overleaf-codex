import { createInterface } from "node:readline/promises";
import { isNonInteractive } from "../cli-behavior.js";
import { summarizeProjectAuth, writeProjectAuth } from "../auth/projectAuth.js";
import type { ProjectAuth } from "../auth/types.js";
import { PROJECT_AUTH_PATH } from "../auth/types.js";
import { findProjectRoot } from "../config/projectRoot.js";
import { createOlcxError } from "../errors.js";

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type AuthCookiePrompt = () => Promise<string>;

export interface AuthenticateProjectOptions {
  cwd: string;
  cookie?: string;
  fromEnv?: string;
  account?: string;
  env?: Record<string, string | undefined>;
  stdinIsTTY?: boolean;
  now?: () => Date;
  promptCookie?: AuthCookiePrompt;
}

export interface AuthenticateProjectResult {
  projectRoot: string;
  authPath: typeof PROJECT_AUTH_PATH;
  auth: ProjectAuth;
}

interface CookieSelection {
  value: string;
  source: ProjectAuth["source"];
}

export function createSessionCookiePrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): AuthCookiePrompt {
  return async () => {
    const readline = createInterface({ input, output });
    try {
      return await readline.question("Paste Overleaf session cookie: ");
    } finally {
      readline.close();
    }
  };
}

export async function authenticateProject(
  options: AuthenticateProjectOptions
): Promise<AuthenticateProjectResult> {
  const projectRoot = await findProjectRoot(options.cwd);
  const selected = await selectCookieSource(options);
  const accountLabel = options.account?.trim();
  const auth: ProjectAuth = {
    schemaVersion: 1,
    sessionCookie: selected.value,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    source: selected.source,
  };

  if (accountLabel !== undefined && accountLabel.length > 0) {
    auth.accountLabel = accountLabel;
  }

  await writeProjectAuth(projectRoot, auth);

  return {
    projectRoot,
    authPath: PROJECT_AUTH_PATH,
    auth,
  };
}

export function formatAuthSuccess(result: AuthenticateProjectResult): string {
  const summary = summarizeProjectAuth(result.auth);

  return [
    "Stored project-local Overleaf auth.",
    `Auth file: ${result.authPath}`,
    `Account: ${summary.accountLabel}`,
    `Source: ${summary.source}`,
    "Next: olcx status",
  ].join("\n") + "\n";
}

async function selectCookieSource(options: AuthenticateProjectOptions): Promise<CookieSelection> {
  const hasCookieOption = options.cookie !== undefined;
  const hasFromEnvOption = options.fromEnv !== undefined;
  const hasCookie = hasNonBlankValue(options.cookie);
  const hasFromEnv = hasNonBlankValue(options.fromEnv);

  if (hasCookieOption && hasFromEnvOption) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: "Choose exactly one auth source.",
      hint: "Run olcx auth --cookie <session-cookie> or olcx auth --from-env OLCX_OVERLEAF_SESSION.",
    });
  }

  if (hasCookie) {
    return { value: options.cookie!.trim(), source: "cli-option" };
  }

  if (hasFromEnv) {
    const envVarName = options.fromEnv!.trim();
    if (!ENV_VAR_NAME_PATTERN.test(envVarName)) {
      throw createOlcxError({
        code: "USER_INPUT_ERROR",
        message: `Environment variable name ${envVarName} is invalid.`,
        hint: "Use a shell environment variable name such as OLCX_OVERLEAF_SESSION.",
      });
    }

    const envValue = options.env?.[envVarName];
    if (!hasNonBlankValue(envValue)) {
      throw createOlcxError({
        code: "USER_INPUT_ERROR",
        message: `Environment variable ${envVarName} is not set or is empty.`,
        hint: `export ${envVarName}=<session-cookie> && olcx auth --from-env ${envVarName}`,
      });
    }

    return { value: envValue.trim(), source: "env" };
  }

  if (isNonInteractive(options.env, options.stdinIsTTY ?? false)) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: "No auth source was provided.",
      hint: "run olcx auth --from-env OLCX_OVERLEAF_SESSION or olcx auth --cookie <session-cookie>",
    });
  }

  const promptCookie = options.promptCookie ?? createSessionCookiePrompt();
  const promptedCookie = (await promptCookie()).trim();

  if (promptedCookie.length === 0) {
    throw createOlcxError({
      code: "USER_INPUT_ERROR",
      message: "No auth source was provided.",
      hint: "run olcx auth --from-env OLCX_OVERLEAF_SESSION or olcx auth --cookie <session-cookie>",
    });
  }

  return { value: promptedCookie, source: "interactive" };
}

function hasNonBlankValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
