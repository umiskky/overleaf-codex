import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createOlcliOverleafBackend } from "../backend/index.js";
import { redactForStatus } from "../auth/redact.js";
import { EXIT_CODES } from "../errors.js";
import { collectProjectStatus } from "./status.js";
import type { DiagnosticCheck, DoctorReport, ProjectStatusReport } from "./types.js";

const REQUIRED_SECRET_IGNORE_ENTRIES = [
  ".olcx/auth.local.json",
  ".olcx/*.local.json",
  ".olcx/*.secret.json",
] as const;

const INIT_NEXT = "olcx init --project <overleaf-project-url-or-id>";
const AUTH_NEXT = "olcx auth --from-env OLCX_OVERLEAF_SESSION";
const GITIGNORE_NEXT =
  "add .olcx/auth.local.json, .olcx/*.local.json, and .olcx/*.secret.json to .gitignore";
const RUNTIME_NEXT = "npm run typecheck";

export interface RunDoctorDiagnosticsOptions {
  cwd: string;
  nodeVersion?: string;
  backendAvailable?: boolean;
}

export async function runDoctorDiagnostics(
  options: RunDoctorDiagnosticsOptions
): Promise<DoctorReport> {
  const status = await collectProjectStatus({ cwd: options.cwd });
  const checks: DiagnosticCheck[] = [
    createNodeCheck(options.nodeVersion ?? process.versions.node),
    {
      level: "pass",
      name: "Project root",
      message: status.projectRoot,
    },
    createConfigCheck(status.config),
    createEndpointCheck(status.config),
    createAuthCheck(status.auth),
    createBackendCheck(options.backendAvailable ?? typeof createOlcliOverleafBackend === "function"),
    await createGitignoreCheck(status.projectRoot),
    createPdfOutputCheck(status.config),
    {
      level: "warn",
      name: "Auth validity",
      message: "not checked by offline doctor; Overleaf may reject expired sessions later",
    },
  ];

  return {
    checks,
    ...selectDoctorOutcome(checks, status),
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "olcx doctor",
    ...report.checks.map(
      (check) => `[${check.level}] ${redactForStatus(check.name)}: ${redactForStatus(check.message)}`
    ),
  ];

  if (report.exitCode !== EXIT_CODES.SUCCESS) {
    lines.push(`Error: ${redactForStatus(report.errorMessage ?? "olcx doctor found problems.")}`);
    if (report.next !== undefined) {
      lines.push(`Next: ${redactForStatus(report.next)}`);
    }
  }

  return lines.join("\n") + "\n";
}

function createNodeCheck(version: string): DiagnosticCheck {
  if (nodeMajor(version) >= 20) {
    return {
      level: "pass",
      name: "Node.js",
      message: `${version} satisfies >=20`,
    };
  }

  return {
    level: "fail",
    name: "Node.js",
    message: `${version} does not satisfy >=20`,
    next: RUNTIME_NEXT,
  };
}

function createConfigCheck(config: ProjectStatusReport["config"]): DiagnosticCheck {
  if (config.state === "configured") {
    return {
      level: "pass",
      name: "Config",
      message: ".olcx/config.json is valid",
    };
  }

  return {
    level: "fail",
    name: "Config",
    message:
      config.state === "missing" ? "missing .olcx/config.json" : "invalid .olcx/config.json",
    next: INIT_NEXT,
  };
}

function createAuthCheck(auth: ProjectStatusReport["auth"]): DiagnosticCheck {
  if (auth.state === "present") {
    return {
      level: "pass",
      name: "Auth file",
      message: ".olcx/auth.local.json is valid",
    };
  }

  return {
    level: "fail",
    name: "Auth file",
    message:
      auth.state === "missing" ? "missing .olcx/auth.local.json" : "invalid .olcx/auth.local.json",
    next: AUTH_NEXT,
  };
}

function createEndpointCheck(config: ProjectStatusReport["config"]): DiagnosticCheck {
  if (config.state === "configured") {
    return {
      level: "pass",
      name: "Overleaf endpoint",
      message: config.overleafBaseUrl ?? "unknown",
    };
  }

  return {
    level: "warn",
    name: "Overleaf endpoint",
    message: "unknown until project config is valid",
  };
}

function createBackendCheck(backendAvailable: boolean): DiagnosticCheck {
  if (backendAvailable) {
    return {
      level: "pass",
      name: "Backend module",
      message: "olcli adapter available",
    };
  }

  return {
    level: "fail",
    name: "Backend module",
    message: "olcli adapter unavailable",
    next: RUNTIME_NEXT,
  };
}

async function createGitignoreCheck(projectRoot: string): Promise<DiagnosticCheck> {
  const missing = await missingSecretIgnoreEntries(projectRoot);

  if (missing.length === 0) {
    return {
      level: "pass",
      name: "Git ignore",
      message: "local auth patterns are ignored",
    };
  }

  return {
    level: "fail",
    name: "Git ignore",
    message: `missing ${missing.join(", ")}`,
    next: GITIGNORE_NEXT,
  };
}

function createPdfOutputCheck(config: ProjectStatusReport["config"]): DiagnosticCheck {
  if (config.state === "configured") {
    return {
      level: "pass",
      name: "PDF output",
      message: `configured ${config.pdfPath}`,
    };
  }

  return {
    level: "warn",
    name: "PDF output",
    message: "unknown until project config is valid",
  };
}

function selectDoctorOutcome(
  checks: DiagnosticCheck[],
  status: ProjectStatusReport
): Pick<DoctorReport, "exitCode" | "errorMessage" | "next"> {
  const runtimeFailure = checks.find(
    (check) => check.level === "fail" && (check.name === "Node.js" || check.name === "Backend module")
  );
  if (runtimeFailure !== undefined) {
    return {
      exitCode: EXIT_CODES.INTERNAL_ERROR,
      errorMessage: "olcx doctor found local runtime problems.",
      next: runtimeFailure.next ?? RUNTIME_NEXT,
    };
  }

  const configFailure = checks.find(
    (check) => check.level === "fail" && (check.name === "Config" || check.name === "Git ignore")
  );
  if (configFailure !== undefined) {
    return {
      exitCode: EXIT_CODES.CONFIG_ERROR,
      errorMessage: "olcx doctor found project configuration problems.",
      next: status.config.state === "configured" ? configFailure.next ?? GITIGNORE_NEXT : INIT_NEXT,
    };
  }

  const authFailure = checks.find((check) => check.level === "fail" && check.name === "Auth file");
  if (authFailure !== undefined) {
    return {
      exitCode: EXIT_CODES.AUTH_ERROR,
      errorMessage: "olcx doctor found auth problems.",
      next: authFailure.next ?? AUTH_NEXT,
    };
  }

  return { exitCode: EXIT_CODES.SUCCESS };
}

async function missingSecretIgnoreEntries(projectRoot: string): Promise<string[]> {
  let content = "";
  try {
    content = await readFile(join(projectRoot, ".gitignore"), "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  const entries = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );

  return REQUIRED_SECRET_IGNORE_ENTRIES.filter((entry) => !entries.has(entry));
}

function nodeMajor(version: string): number {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
