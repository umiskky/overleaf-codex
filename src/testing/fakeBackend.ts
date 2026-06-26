import type { ProjectAuth } from "../auth/types.js";
import { createOlcxError, type OlcxErrorCode } from "../errors.js";
import type {
  BackendAuthInput,
  BackendCompileInput,
  BackendFileInput,
  BackendProjectInput,
  BackendUploadInput,
  CompileResult,
  OverleafBackend,
  RemoteFile,
} from "../backend/types.js";

type FakeFailureKind = "auth" | "network" | "compile" | "pdf";
type FakeOperation = keyof OverleafBackend;

export interface FakeFileSeed {
  path: string;
  text?: string;
  bytes?: Uint8Array;
  binary?: boolean;
  modifiedAt?: string;
  revision?: string;
}

export interface FakeProjectSeed {
  projectId: string;
  files?: FakeFileSeed[];
  pdfBytes?: Uint8Array;
  fastPdfBytes?: Uint8Array;
  compileStatus?: "success" | "failure" | "timeout";
  fastCompileStatus?: "success" | "failure" | "timeout";
  fastRestoreFailure?: boolean;
}

export interface FakeOverleafBackendOptions {
  now?: string;
  projects?: FakeProjectSeed[];
  failures?: Partial<Record<FakeOperation, FakeFailureKind>>;
}

interface FakeStoredFile {
  path: string;
  bytes: Uint8Array;
  binary: boolean;
  remoteId: string;
  modifiedAt: string;
  revision: string;
}

interface FakeStoredProject {
  projectId: string;
  files: Map<string, FakeStoredFile>;
  pdfBytes: Uint8Array;
  fastPdfBytes: Uint8Array;
  compileStatus: "success" | "failure" | "timeout";
  fastCompileStatus: "success" | "failure" | "timeout";
  fastRestoreFailure: boolean;
  nextRemoteId: number;
}

const DEFAULT_NOW = "2026-06-25T08:00:00.000Z";
const DEFAULT_PDF = Buffer.from("%PDF-1.4\n% fake olcx pdf\n", "utf8");

export function createFakeOverleafBackend(options: FakeOverleafBackendOptions = {}): OverleafBackend {
  return new FakeOverleafBackend(options);
}

class FakeOverleafBackend implements OverleafBackend {
  private readonly now: string;
  private readonly failures: Partial<Record<FakeOperation, FakeFailureKind>>;
  private readonly projects: Map<string, FakeStoredProject>;

  constructor(options: FakeOverleafBackendOptions) {
    this.now = options.now ?? DEFAULT_NOW;
    this.failures = options.failures ?? {};
    this.projects = new Map(
      (options.projects ?? []).map((project) => [project.projectId, toStoredProject(project, this.now)])
    );
  }

  async validateAuth(input: BackendAuthInput) {
    this.failIfConfigured("validateAuth");
    this.assertAuth(input.auth);
    return {
      authenticated: true,
      accountLabel: input.auth.accountLabel,
    };
  }

  async listFiles(input: BackendProjectInput): Promise<RemoteFile[]> {
    this.failIfConfigured("listFiles");
    this.assertAuth(input.auth);
    const project = this.getProject(input.projectId);
    return [...project.files.values()].map((file) => toRemoteFile(file)).sort((a, b) => a.path.localeCompare(b.path));
  }

  async downloadFile(input: BackendFileInput): Promise<Uint8Array> {
    this.failIfConfigured("downloadFile");
    this.assertAuth(input.auth);
    const project = this.getProject(input.projectId);
    const file = project.files.get(normalizePath(input.path));
    if (!file) {
      throw createOlcxError({
        code: "BACKEND_PROTOCOL_ERROR",
        message: `Remote file was not found: ${normalizePath(input.path)}`,
        hint: "Run olcx sync --dry-run to refresh the remote file listing.",
      });
    }
    return new Uint8Array(file.bytes);
  }

  async uploadFile(input: BackendUploadInput): Promise<RemoteFile> {
    this.failIfConfigured("uploadFile");
    this.assertAuth(input.auth);
    const project = this.getProject(input.projectId);
    const path = normalizePath(input.path);
    const remoteId = project.files.get(path)?.remoteId ?? `fake-remote-${project.nextRemoteId++}`;
    const file: FakeStoredFile = {
      path,
      bytes: new Uint8Array(input.bytes),
      binary: isBinaryPath(path),
      remoteId,
      modifiedAt: this.now,
      revision: `rev-${remoteId}`,
    };
    project.files.set(path, file);
    return toRemoteFile(file);
  }

  async deleteFile(input: BackendFileInput): Promise<void> {
    this.failIfConfigured("deleteFile");
    this.assertAuth(input.auth);
    const project = this.getProject(input.projectId);
    project.files.delete(normalizePath(input.path));
  }

  async compile(input: BackendCompileInput): Promise<CompileResult> {
    this.failIfConfigured("compile");
    this.assertAuth(input.auth);
    const project = this.getProject(input.projectId);
    const fastMode = input.fastMode === true;
    const compileStatus = fastMode ? project.fastCompileStatus : project.compileStatus;
    if (compileStatus !== "success") {
      return {
        status: compileStatus,
        projectId: input.projectId,
        logs: [{ level: "error", message: fastMode ? "Fake Overleaf fast fallback compile failed." : "Fake Overleaf compile failed." }],
        warnings: [],
        elapsedMs: 0,
        fallbackUsed: fastMode,
        error: createOlcxError({
          code: compileStatus === "timeout" ? "COMPILE_TIMEOUT" : "COMPILE_FAILED",
          message: fastMode ? "Fake Overleaf fast fallback compile failed." : "Fake Overleaf compile failed.",
          hint: "Inspect the fake compile logs in the test assertion.",
        }),
      };
    }

    return {
      status: fastMode ? "fallback-success" : "success",
      projectId: input.projectId,
      pdfBytes: new Uint8Array(fastMode ? project.fastPdfBytes : project.pdfBytes),
      logs: [
        {
          level: "info",
          message: fastMode ? "Fake Overleaf fast fallback compile succeeded." : "Fake Overleaf compile succeeded.",
        },
      ],
      warnings: fastMode
        ? ["Fast/draft fallback PDF: generated with fake draft mode; images may be omitted or simplified."]
        : [],
      elapsedMs: 0,
      fallbackUsed: fastMode,
    };
  }

  async beginFastCompile(input: BackendProjectInput) {
    this.assertAuth(input.auth);
    const project = this.getProject(input.projectId);
    return {
      strategy: "project-settings" as const,
      compileOptions: { fastMode: true as const },
      restore: async () => {
        if (project.fastRestoreFailure) {
          throw createOlcxError({
            code: "COMPILE_FAILED",
            message: "Fake backend failed to restore fast compile settings.",
            hint: "Inspect the fake backend restore failure test setup.",
          });
        }
        return { status: "restored" as const };
      },
    };
  }

  async downloadPdf(input: BackendProjectInput): Promise<Uint8Array> {
    this.failIfConfigured("downloadPdf");
    this.assertAuth(input.auth);
    return new Uint8Array(this.getProject(input.projectId).pdfBytes);
  }

  private failIfConfigured(operation: FakeOperation): void {
    const failure = this.failures[operation];
    if (!failure) return;
    throw fakeFailure(operation, failure);
  }

  private assertAuth(auth: ProjectAuth): void {
    if (!auth.sessionCookie) {
      throw createOlcxError({
        code: "PROJECT_AUTH_INVALID",
        message: "Fake backend received invalid auth.",
        hint: "Provide a fake non-empty session cookie in the test.",
      });
    }
  }

  private getProject(projectId: string): FakeStoredProject {
    const project = this.projects.get(projectId);
    if (!project) {
      throw createOlcxError({
        code: "BACKEND_PROTOCOL_ERROR",
        message: "Fake backend project was not found.",
        hint: "Seed the fake backend with the project id used by the test.",
        details: { projectId: "<redacted-project-id>" },
      });
    }
    return project;
  }
}

function toStoredProject(seed: FakeProjectSeed, now: string): FakeStoredProject {
  let nextRemoteId = 1;
  const files = new Map<string, FakeStoredFile>();
  for (const file of seed.files ?? []) {
    const path = normalizePath(file.path);
    const remoteId = `fake-remote-${nextRemoteId++}`;
    const bytes = file.bytes ?? Buffer.from(file.text ?? "", "utf8");
    files.set(path, {
      path,
      bytes: new Uint8Array(bytes),
      binary: file.binary ?? isBinaryPath(path),
      remoteId,
      modifiedAt: file.modifiedAt ?? now,
      revision: file.revision ?? `rev-${remoteId}`,
    });
  }

  return {
    projectId: seed.projectId,
    files,
    pdfBytes: new Uint8Array(seed.pdfBytes ?? DEFAULT_PDF),
    fastPdfBytes: new Uint8Array(seed.fastPdfBytes ?? seed.pdfBytes ?? DEFAULT_PDF),
    compileStatus: seed.compileStatus ?? "success",
    fastCompileStatus: seed.fastCompileStatus ?? seed.compileStatus ?? "success",
    fastRestoreFailure: seed.fastRestoreFailure ?? false,
    nextRemoteId,
  };
}

function toRemoteFile(file: FakeStoredFile): RemoteFile {
  return {
    path: file.path,
    kind: "file",
    remoteId: file.remoteId,
    size: file.bytes.byteLength,
    modifiedAt: file.modifiedAt,
    revision: file.revision,
    binary: file.binary,
  };
}

function fakeFailure(operation: FakeOperation, failure: FakeFailureKind) {
  const codeByFailure: Record<FakeFailureKind, OlcxErrorCode> = {
    auth: "BACKEND_AUTH_FAILED",
    network: "BACKEND_NETWORK_ERROR",
    compile: "COMPILE_FAILED",
    pdf: "COMPILE_FAILED",
  };
  return createOlcxError({
    code: codeByFailure[failure],
    message: `Fake backend ${failure} failure during ${String(operation)}.`,
    hint: "Adjust the fake backend failure configuration in the test.",
  });
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isBinaryPath(path: string): boolean {
  return /\.(pdf|png|jpg|jpeg|gif|eps|svg)$/i.test(path);
}
