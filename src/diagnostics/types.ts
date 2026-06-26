import type { ExitCode } from "../errors.js";

export type DiagnosticState = "configured" | "present" | "missing" | "invalid" | "not-checked";
export type DiagnosticLevel = "pass" | "warn" | "fail";

export interface ProjectStatusReport {
  projectRoot: string;
  config: {
    state: "configured" | "missing" | "invalid";
    hasProjectId: boolean;
    overleafBaseUrl?: string;
    pdfPath: string;
    reason?: string;
  };
  auth: {
    state: "present" | "missing" | "invalid";
    accountLabel: string;
    source?: string;
    updatedAt?: string;
    reason?: string;
  };
  next: string[];
}

export interface DiagnosticCheck {
  level: DiagnosticLevel;
  name: string;
  message: string;
  next?: string;
}

export interface DoctorReport {
  checks: DiagnosticCheck[];
  exitCode: ExitCode;
  errorMessage?: string;
  next?: string;
}
