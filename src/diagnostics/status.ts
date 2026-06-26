import { readProjectAuth, summarizeProjectAuth } from "../auth/projectAuth.js";
import { redactForStatus } from "../auth/redact.js";
import { readProjectConfig, summarizeProjectConfig } from "../config/projectConfig.js";
import { findProjectRoot } from "../config/projectRoot.js";
import { isOlcxError } from "../errors.js";
import type { ProjectStatusReport } from "./types.js";

const INIT_NEXT = "olcx init --project <overleaf-project-url-or-id>";
const AUTH_NEXT = "olcx auth --from-env OLCX_OVERLEAF_SESSION";

export interface CollectProjectStatusOptions {
  cwd: string;
}

export async function collectProjectStatus(
  options: CollectProjectStatusOptions
): Promise<ProjectStatusReport> {
  const projectRoot = await findProjectRoot(options.cwd);
  const config = await collectConfigStatus(projectRoot);
  const auth = await collectAuthStatus(projectRoot);
  const next = unique([
    config.state === "configured" ? undefined : INIT_NEXT,
    auth.state === "present" ? undefined : AUTH_NEXT,
  ]);

  return {
    projectRoot,
    config,
    auth,
    next,
  };
}

export function formatProjectStatus(report: ProjectStatusReport): string {
  const lines = [
    "olcx status",
    `Project root: ${redactForStatus(report.projectRoot)}`,
    `Project binding: ${report.config.state}`,
    `Project id: ${report.config.hasProjectId ? "present" : "missing"}`,
    ...(report.config.state === "configured" && report.config.overleafBaseUrl !== undefined
      ? [`Overleaf endpoint: ${redactForStatus(report.config.overleafBaseUrl)}`]
      : []),
    `PDF output: ${redactForStatus(report.config.pdfPath)}`,
    `Auth: ${report.auth.state}`,
    `Account: ${redactForStatus(report.auth.accountLabel)}`,
  ];

  if (report.auth.state === "present" && report.auth.source !== undefined) {
    lines.push(`Auth source: ${redactForStatus(report.auth.source)}`);
  }
  if (report.auth.state === "present" && report.auth.updatedAt !== undefined) {
    lines.push(`Auth updated: ${redactForStatus(report.auth.updatedAt)}`);
  }

  for (const next of report.next) {
    lines.push(`Next: ${redactForStatus(next)}`);
  }

  return lines.join("\n") + "\n";
}

async function collectConfigStatus(projectRoot: string): Promise<ProjectStatusReport["config"]> {
  try {
    const config = await readProjectConfig(projectRoot);
    const summary = summarizeProjectConfig(config);
    return {
      state: "configured",
      hasProjectId: summary.hasProjectId === true,
      overleafBaseUrl: String((summary.overleaf as { baseUrl?: unknown } | undefined)?.baseUrl ?? "unknown"),
      pdfPath: String(summary.pdfPath ?? "unknown"),
    };
  } catch (error) {
    if (isOlcxError(error) && error.code === "PROJECT_CONFIG_NOT_FOUND") {
      return {
        state: "missing",
        hasProjectId: false,
        pdfPath: "unknown",
        reason: redactForStatus(error.message),
      };
    }
    if (isOlcxError(error) && error.code === "PROJECT_CONFIG_INVALID") {
      return {
        state: "invalid",
        hasProjectId: false,
        pdfPath: "unknown",
        reason: redactForStatus(error.message),
      };
    }
    throw error;
  }
}

async function collectAuthStatus(projectRoot: string): Promise<ProjectStatusReport["auth"]> {
  try {
    const auth = await readProjectAuth(projectRoot);
    const summary = summarizeProjectAuth(auth);
    return {
      state: "present",
      accountLabel: summary.accountLabel,
      source: summary.source,
      updatedAt: summary.updatedAt,
    };
  } catch (error) {
    if (isOlcxError(error) && error.code === "PROJECT_AUTH_NOT_FOUND") {
      return {
        state: "missing",
        accountLabel: "unknown",
        reason: redactForStatus(error.message),
      };
    }
    if (isOlcxError(error) && error.code === "PROJECT_AUTH_INVALID") {
      return {
        state: "invalid",
        accountLabel: "unknown",
        reason: redactForStatus(error.message),
      };
    }
    throw error;
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}
