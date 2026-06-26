import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OLCX_DIR } from "../config/types.js";
import { createOlcxError } from "../errors.js";
import {
  DEFAULT_PROJECT_AUTH_ENV_VAR,
  PROJECT_AUTH_FILENAME,
  type ProjectAuth,
} from "./types.js";
import { redactForStatus } from "./redact.js";

const FORBIDDEN_AUTH_KEYS = new Set(["password", "passwd", "cookie", "token", "auth", "authorization", "csrf"]);

export interface ResolveProjectAuthOptions {
  env?: Record<string, string | undefined>;
  envVarName?: string;
  now?: () => Date;
}

export function getProjectAuthPath(projectRoot: string): string {
  return join(projectRoot, OLCX_DIR, PROJECT_AUTH_FILENAME);
}

export function validateProjectAuth(value: unknown): ProjectAuth {
  assertRecord(value, "auth");
  assertNoForbiddenAuthKeys(value, "auth");

  if (value.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }

  const sessionCookie = requireNonEmptyString(value.sessionCookie, "sessionCookie");
  const updatedAt = requireIsoTimestamp(value.updatedAt, "updatedAt");
  const source = requireAuthSource(value.source);
  const auth: ProjectAuth = {
    schemaVersion: 1,
    sessionCookie,
    updatedAt,
    source,
  };

  if (value.accountLabel !== undefined) {
    auth.accountLabel = requireNonEmptyString(value.accountLabel, "accountLabel");
  }

  return auth;
}

export async function readProjectAuth(projectRoot: string): Promise<ProjectAuth> {
  const path = getProjectAuthPath(projectRoot);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw createOlcxError({
        code: "PROJECT_AUTH_NOT_FOUND",
        message: "Project auth was not found.",
        hint: "Authenticate this paper repository before using Overleaf-backed operations.",
        details: { path: ".olcx/auth.local.json" },
        cause: error,
      });
    }
    throw error;
  }

  try {
    return validateProjectAuth(JSON.parse(raw));
  } catch (error) {
    throw createOlcxError({
      code: "PROJECT_AUTH_INVALID",
      message: "Project auth is invalid.",
      hint: "Re-authenticate this paper repository to regenerate .olcx/auth.local.json.",
      details: {
        path: ".olcx/auth.local.json",
        reason: error instanceof Error ? error.message : "Invalid JSON or schema.",
      },
      cause: error,
    });
  }
}

export async function writeProjectAuth(projectRoot: string, auth: ProjectAuth): Promise<void> {
  const validated = validateProjectAuth(auth);
  await mkdir(join(projectRoot, OLCX_DIR), { recursive: true });
  await writeFile(getProjectAuthPath(projectRoot), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export async function deleteProjectAuth(projectRoot: string): Promise<boolean> {
  try {
    await rm(getProjectAuthPath(projectRoot));
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function resolveProjectAuth(
  projectRoot: string,
  options: ResolveProjectAuthOptions = {}
): Promise<ProjectAuth> {
  const env = options.env ?? process.env;
  const envVarName = options.envVarName ?? DEFAULT_PROJECT_AUTH_ENV_VAR;
  const envValue = env[envVarName];

  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return validateProjectAuth({
      schemaVersion: 1,
      sessionCookie: envValue,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
      source: "env",
    });
  }

  return readProjectAuth(projectRoot);
}

export function summarizeProjectAuth(auth: ProjectAuth): {
  schemaVersion: 1;
  accountLabel: string;
  source: ProjectAuth["source"];
  updatedAt: string;
  hasSessionCookie: boolean;
} {
  return {
    schemaVersion: auth.schemaVersion,
    accountLabel: summarizeAccountLabel(auth.accountLabel),
    source: auth.source,
    updatedAt: auth.updatedAt,
    hasSessionCookie: auth.sessionCookie.trim().length > 0,
  };
}

function summarizeAccountLabel(accountLabel: string | undefined): string {
  if (accountLabel === undefined || accountLabel.trim().length === 0) {
    return "unknown";
  }

  const trimmed = accountLabel.trim();
  const redacted = redactForStatus(trimmed);
  if (redacted !== trimmed) {
    return redacted;
  }
  if (/[^\w .@+-]/.test(trimmed)) {
    return "<redacted-account>";
  }
  return trimmed;
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field);
  const parsed = Date.parse(timestamp);

  if (Number.isNaN(parsed)) {
    throw new Error(`${field} must be a parseable ISO timestamp`);
  }

  return timestamp;
}

function requireAuthSource(value: unknown): ProjectAuth["source"] {
  if (value !== "interactive" && value !== "cli-option" && value !== "env") {
    throw new Error('source must be "interactive", "cli-option", or "env"');
  }
  return value;
}

function assertNoForbiddenAuthKeys(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenAuthKeys(entry, `${field}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey !== "sessioncookie" && FORBIDDEN_AUTH_KEYS.has(normalizedKey)) {
      throw new Error(`${field}.${key} is not allowed in project auth`);
    }
    assertNoForbiddenAuthKeys(entry, `${field}.${key}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
