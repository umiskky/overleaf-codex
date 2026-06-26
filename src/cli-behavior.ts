import {
  ERROR_CODE_EXIT_CODES,
  EXIT_CODES,
  type ExitCode,
  type OlcxErrorCode,
  mapErrorCodeToExitCode,
} from "./errors.js";

export {
  ERROR_CODE_EXIT_CODES,
  EXIT_CODES,
  createOlcxError,
  isOlcxError,
  mapErrorCodeToExitCode,
} from "./errors.js";
export type { ExitCode, ExitCodeName, OlcxError, OlcxErrorCode } from "./errors.js";

export interface CliFailure {
  code: OlcxErrorCode;
  exitCode: ExitCode;
  message: string;
  hint: string;
  details?: unknown;
}

export function isNonInteractive(
  env: Record<string, string | undefined> = process.env,
  stdinIsTTY = Boolean(process.stdin.isTTY)
): boolean {
  return env.OLCX_NON_INTERACTIVE === "1" || env.CI === "1" || env.CI === "true" || !stdinIsTTY;
}

export function plannedCommandFailure(commandName: string, details?: unknown): CliFailure {
  return {
    code: "INTERNAL_ERROR",
    exitCode: EXIT_CODES.INTERNAL_ERROR,
    message: `olcx ${commandName} is part of the v1 interface, but this scaffold does not implement it yet.`,
    hint: "Follow the current QuickDev task queue before using this command against a paper repository.",
    details,
  };
}

export function redactSensitive(value: unknown): string {
  const normalized = typeof value === "string" ? value : JSON.stringify(redactByKey(value));
  return redactText(normalized ?? String(value));
}

export function formatCliFailure(failure: CliFailure): string {
  const detailText = failure.details === undefined ? "" : `\nDetails: ${redactSensitive(failure.details)}`;

  return [`Error: ${redactSensitive(failure.message)}`, `Next: ${redactSensitive(failure.hint)}`, detailText.trim()]
    .filter(Boolean)
    .join("\n")
    .concat("\n");
}

function redactByKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactByKey(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const normalizedKey = key.toLowerCase();

      if (
        normalizedKey.includes("cookie") ||
        normalizedKey.includes("session") ||
        normalizedKey.includes("password") ||
        normalizedKey.includes("token") ||
        normalizedKey.includes("auth")
      ) {
        return [key, "<redacted-secret>"];
      }

      if (normalizedKey === "account" || normalizedKey === "email" || normalizedKey === "accountlabel") {
        return [key, "<redacted-account>"];
      }

      if (normalizedKey === "projectid" || normalizedKey === "projecturl" || normalizedKey === "overleafprojectid") {
        return [key, "<redacted-project-id>"];
      }

      return [key, redactByKey(entry)];
    })
  );
}

function redactText(value: string): string {
  return value
    .replace(
      /https:\/\/(?:www\.|cn\.)?overleaf\.com\/project\/[A-Za-z0-9_-]+/g,
      "https://www.overleaf.com/project/<redacted-project-id>"
    )
    .replace(/\b[A-Fa-f0-9]{24}\b/g, "<redacted-project-id>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-account>")
    .replace(
      /(["']?(?:accountLabel|account|email)["']?\s*[:=]\s*)(["'])?[^"',;\s}]+(\2)?/gi,
      "$1$2<redacted-account>$2"
    )
    .replace(
      /(["']?(?:sessionCookie|cookie|session|password|passwd|token|auth|authorization|csrf|connect\.sid|_overleaf_session)["']?\s*[:=]\s*)(["'])?[^"',;\s}]+(\2)?/gi,
      "$1$2<redacted-secret>$2"
    );
}
