import { redactSensitive } from "../cli-behavior.js";
import {
  compileProject,
  type CompileProjectInput,
  type CompileProjectResult,
} from "../compile/compileFlow.js";
import type { OlcxError } from "../errors.js";

export interface RunCompileCommandInput extends CompileProjectInput {}

export async function runCompileCommand(input: RunCompileCommandInput): Promise<CompileProjectResult> {
  return compileProject(input);
}

export function formatCompileSuccess(result: CompileProjectResult): string {
  const lines = [
    "olcx compile",
    `Status: ${result.status}`,
    `PDF: ${result.pdfPath}`,
    `Bytes: ${result.bytesWritten}`,
    `Elapsed: ${result.elapsedMs}ms`,
    `Warnings: ${result.warnings.length}`,
  ];

  if (result.fallbackUsed) {
    lines.push("Fallback: fast/draft");
  }
  if (result.warnings.length > 0) {
    lines.push(...result.warnings.map((warning) => `- ${warning}`));
  }
  lines.push(`Next: open ${result.pdfPath}`);

  return redactSensitive(`${lines.join("\n")}\n`);
}

export function formatCompileFailure(error: OlcxError): string {
  const lines = [`Error: ${error.message}`];
  const logSummary = readLogSummary(error.details);
  const normalFailure = readFailureSummary(error.details, "normalFailure");
  const fallbackFailure = readFailureSummary(error.details, "fallbackFailure");
  const restoreStatus = readStringDetail(error.details, "restoreStatus");
  const restoreWarning = readStringDetail(error.details, "restoreWarning");

  if (normalFailure) lines.push(`Normal compile failure: ${normalFailure}`);
  if (fallbackFailure) lines.push(`Fast/draft fallback failure: ${fallbackFailure}`);
  if (restoreStatus) lines.push(`Restore: ${restoreStatus}`);
  if (restoreWarning) lines.push(`Restore warning: ${restoreWarning}`);

  if (logSummary.length > 0) {
    lines.push("Compile log summary:", ...logSummary.map((entry) => `- ${entry}`));
  }

  lines.push(`Next: ${error.hint ?? "Fix the compile issue and retry olcx compile."}`);
  return redactSensitive(`${lines.join("\n")}\n`);
}

function readLogSummary(details: unknown): string[] {
  if (!details || typeof details !== "object" || !("logSummary" in details)) {
    return [];
  }

  const logSummary = (details as { logSummary?: unknown }).logSummary;
  if (!Array.isArray(logSummary)) {
    return [];
  }

  return logSummary.filter((entry): entry is string => typeof entry === "string");
}

function readStringDetail(details: unknown, key: string): string | undefined {
  if (!details || typeof details !== "object" || !(key in details)) {
    return undefined;
  }

  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readFailureSummary(details: unknown, key: "normalFailure" | "fallbackFailure"): string | undefined {
  if (!details || typeof details !== "object" || !(key in details)) {
    return undefined;
  }

  const value = (details as Record<string, unknown>)[key];
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}
