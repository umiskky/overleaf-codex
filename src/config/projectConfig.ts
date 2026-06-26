import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { createOlcxError } from "../errors.js";
import {
  DEFAULT_OVERLEAF_BASE_URL,
  MAX_FAST_FALLBACK_ATTEMPTS,
  OLCX_DIR,
  PROJECT_CONFIG_FILENAME,
  type OverleafBaseUrl,
  type ProjectConfig,
} from "./types.js";

const FORBIDDEN_SECRET_KEYS = new Set(["password", "sessioncookie", "cookie", "token", "auth", "authorization", "csrf"]);

export function getProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, OLCX_DIR, PROJECT_CONFIG_FILENAME);
}

export async function readProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  const path = getProjectConfigPath(projectRoot);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw createOlcxError({
        code: "PROJECT_CONFIG_NOT_FOUND",
        message: "Project config was not found.",
        hint: "Run olcx init for this paper repository before using project commands.",
        details: { path: ".olcx/config.json" },
        cause: error,
      });
    }
    throw error;
  }

  try {
    return validateProjectConfig(JSON.parse(raw));
  } catch (error) {
    throw createOlcxError({
      code: "PROJECT_CONFIG_INVALID",
      message: "Project config is invalid.",
      hint: "Fix .olcx/config.json or regenerate it with olcx init.",
      details: {
        path: ".olcx/config.json",
        reason: error instanceof Error ? error.message : "Invalid JSON or schema.",
      },
      cause: error,
    });
  }
}

export async function writeProjectConfig(projectRoot: string, config: ProjectConfig): Promise<void> {
  const validated = validateProjectConfig(config);
  await mkdir(join(projectRoot, OLCX_DIR), { recursive: true });
  await writeFile(getProjectConfigPath(projectRoot), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  assertRecord(value, "config");
  assertNoForbiddenSecretKeys(value, "config");

  if (value.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }

  const projectId = requireNonEmptyString(value.projectId, "projectId");
  const overleaf = value.overleaf === undefined ? undefined : requireRecord(value.overleaf, "overleaf");
  const overleafBaseUrl =
    overleaf === undefined
      ? DEFAULT_OVERLEAF_BASE_URL
      : requireOverleafBaseUrl(overleaf.baseUrl, "overleaf.baseUrl");
  const rootDocument = requireSafeRelativePath(value.rootDocument, "rootDocument");
  const pdfPath = requireSafeRelativePath(value.pdfPath, "pdfPath");
  const sync = requireRecord(value.sync, "sync");
  const compile = requireRecord(value.compile, "compile");
  const fastFallback = requireRecord(compile.fastFallback, "compile.fastFallback");

  if (sync.mode !== "bidirectional") {
    throw new Error('sync.mode must be "bidirectional"');
  }
  if (sync.conflictPolicy !== "pause") {
    throw new Error('sync.conflictPolicy must be "pause"');
  }
  if (!Array.isArray(sync.ignore)) {
    throw new Error("sync.ignore must be an array");
  }

  const ignore = sync.ignore.map((entry, index) => requireNonEmptyString(entry, `sync.ignore[${index}]`));
  const timeoutMs = requirePositiveInteger(compile.timeoutMs, "compile.timeoutMs");
  const fastFallbackTimeoutMs = requirePositiveInteger(
    fastFallback.timeoutMs,
    "compile.fastFallback.timeoutMs"
  );
  const attempts = requireIntegerInRange(
    fastFallback.attempts,
    "compile.fastFallback.attempts",
    0,
    MAX_FAST_FALLBACK_ATTEMPTS
  );

  if (typeof fastFallback.enabled !== "boolean") {
    throw new Error("compile.fastFallback.enabled must be a boolean");
  }

  const config: ProjectConfig = {
    schemaVersion: 1,
    projectId,
    overleaf: {
      baseUrl: overleafBaseUrl,
    },
    rootDocument,
    pdfPath,
    sync: {
      mode: "bidirectional",
      conflictPolicy: "pause",
      ignore,
    },
    compile: {
      timeoutMs,
      fastFallback: {
        enabled: fastFallback.enabled,
        attempts,
        timeoutMs: fastFallbackTimeoutMs,
      },
    },
  };

  if (value.projectUrl !== undefined) {
    config.projectUrl = requireNonEmptyString(value.projectUrl, "projectUrl");
  }

  return config;
}

export function summarizeProjectConfig(config: ProjectConfig): Record<string, unknown> {
  return {
    schemaVersion: config.schemaVersion,
    hasProjectId: config.projectId.trim().length > 0,
    hasProjectUrl: config.projectUrl !== undefined,
    overleaf: config.overleaf,
    rootDocument: config.rootDocument,
    pdfPath: config.pdfPath,
    sync: config.sync,
    compile: config.compile,
  };
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  assertRecord(value, field);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOverleafBaseUrl(value: unknown, field: string): OverleafBaseUrl {
  const baseUrl = requireNonEmptyString(value, field);
  if (baseUrl !== "https://www.overleaf.com" && baseUrl !== "https://cn.overleaf.com") {
    throw new Error(`${field} must be https://www.overleaf.com or https://cn.overleaf.com`);
  }
  return baseUrl;
}

function requireSafeRelativePath(value: unknown, field: string): string {
  const path = requireNonEmptyString(value, field);
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  if (isAbsolute(path) || win32.isAbsolute(path) || segments.includes("..")) {
    throw new Error(`${field} must be a safe relative path`);
  }

  return normalized;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertNoForbiddenSecretKeys(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenSecretKeys(entry, `${field}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      throw new Error(`${field}.${key} is not allowed in project config`);
    }
    assertNoForbiddenSecretKeys(entry, `${field}.${key}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
