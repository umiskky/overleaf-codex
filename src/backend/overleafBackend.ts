import type { ProjectAuth } from "../auth/types.js";
import { createOlcxError, isOlcxError, type OlcxError, type OlcxErrorCode } from "../errors.js";
import { OverleafClient } from "./olcli/index.js";
import type {
  BackendAuthInput,
  BackendCompileInput,
  BackendFastCompileSession,
  BackendFileInput,
  BackendProjectInput,
  BackendUploadInput,
  CompileResult,
  OverleafBackend,
  RemoteFile,
} from "./types.js";

type RawEntity = { path: string; type: "doc" | "file" };
type RawUploadResult = { success: boolean; entityId?: string; entityType?: string };
type RawCompileResult = {
  status: "success" | "failure" | "error";
  pdfUrl?: string;
  outputFiles: { path: string; type: string; url: string }[];
};

const FAST_FALLBACK_PDF_WARNING =
  "Fast/draft fallback PDF: generated with Overleaf draft mode; images may be omitted or simplified.";

interface OlcliClientLike {
  listProjects(): Promise<unknown[]>;
  getEntities(projectId: string): Promise<RawEntity[]>;
  downloadByPath(projectId: string, path: string): Promise<Buffer>;
  uploadFile(projectId: string, folderId: string | null, fileName: string, content: Buffer): Promise<RawUploadResult>;
  deleteByPath(projectId: string, path: string): Promise<void>;
  compileWithOutputs(projectId: string, options?: { timeoutMs?: number; draft?: boolean }): Promise<RawCompileResult>;
  downloadOutputFile(url: string): Promise<Buffer>;
  downloadPdf(projectId: string): Promise<Buffer>;
}

export interface OlcliBackendOptions {
  baseUrl?: string;
  cookieName?: string;
  now?: () => number;
  createClient?: (auth: ProjectAuth) => Promise<OlcliClientLike>;
}

export function createOlcliOverleafBackend(options: OlcliBackendOptions = {}): OverleafBackend {
  return new OlcliOverleafBackend(options);
}

class OlcliOverleafBackend implements OverleafBackend {
  private readonly now: () => number;

  constructor(private readonly options: OlcliBackendOptions) {
    this.now = options.now ?? Date.now;
  }

  async validateAuth(input: BackendAuthInput) {
    const client = await this.createClientFor("validateAuth", input.auth, "BACKEND_AUTH_FAILED");
    await this.callRaw("validateAuth", () => client.listProjects(), "BACKEND_AUTH_FAILED");

    return {
      authenticated: true,
      accountLabel: input.auth.accountLabel,
    };
  }

  async listFiles(input: BackendProjectInput): Promise<RemoteFile[]> {
    const client = await this.createClientFor("listFiles", input.auth, "BACKEND_PROTOCOL_ERROR");
    const entities = await this.callRaw(
      "listFiles",
      () => client.getEntities(input.projectId),
      "BACKEND_PROTOCOL_ERROR"
    );

    return entities
      .map((entity) => ({
        path: normalizeRemotePath(entity.path),
        kind: "file" as const,
        binary: entity.type === "file",
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async downloadFile(input: BackendFileInput): Promise<Uint8Array> {
    const client = await this.createClientFor("downloadFile", input.auth, "BACKEND_PROTOCOL_ERROR");
    const bytes = await this.callRaw(
      "downloadFile",
      () => client.downloadByPath(input.projectId, input.path),
      "BACKEND_PROTOCOL_ERROR"
    );

    return new Uint8Array(bytes);
  }

  async uploadFile(input: BackendUploadInput): Promise<RemoteFile> {
    const client = await this.createClientFor("uploadFile", input.auth, "BACKEND_PROTOCOL_ERROR");
    const result = await this.callRaw(
      "uploadFile",
      () => client.uploadFile(input.projectId, null, normalizeRemotePath(input.path), Buffer.from(input.bytes)),
      "BACKEND_PROTOCOL_ERROR"
    );
    assertSuccessfulUploadResult(result);

    return {
      path: normalizeRemotePath(input.path),
      kind: "file",
      remoteId: result.entityId,
      size: input.bytes.byteLength,
      binary: result.entityType === "file",
    };
  }

  async deleteFile(input: BackendFileInput): Promise<void> {
    const client = await this.createClientFor("deleteFile", input.auth, "BACKEND_PROTOCOL_ERROR");
    await this.callRaw("deleteFile", () => client.deleteByPath(input.projectId, input.path), "BACKEND_PROTOCOL_ERROR");
  }

  async compile(input: BackendCompileInput): Promise<CompileResult> {
    const startedAt = this.now();
    const fastMode = input.fastMode === true;
    const client = await this.createClientFor("compile", input.auth, "COMPILE_FAILED");
    const compiled = await this.callRaw(
      "compile",
      () => client.compileWithOutputs(input.projectId, { timeoutMs: input.timeoutMs, draft: fastMode }),
      "COMPILE_FAILED"
    );

    if (compiled.status !== "success" || !compiled.pdfUrl) {
      return {
        status: "failure",
        projectId: input.projectId,
        logs: [],
        warnings: [],
        elapsedMs: Math.max(0, this.now() - startedAt),
        fallbackUsed: fastMode,
        error: createOlcxError({
          code: "COMPILE_FAILED",
          message: "Overleaf reported a compile failure.",
          hint: "Open the project on Overleaf or inspect the compile logs before retrying.",
          details: { status: compiled.status, outputFiles: compiled.outputFiles.map((file) => file.path), fastMode },
        }),
      };
    }

    const pdfBytes = await this.callRaw(
      "downloadCompilePdf",
      () => client.downloadOutputFile(compiled.pdfUrl as string),
      "COMPILE_FAILED"
    );

    return {
      status: fastMode ? "fallback-success" : "success",
      projectId: input.projectId,
      pdfBytes: new Uint8Array(pdfBytes),
      logs: [],
      warnings: fastMode ? [FAST_FALLBACK_PDF_WARNING] : [],
      elapsedMs: Math.max(0, this.now() - startedAt),
      fallbackUsed: fastMode,
    };
  }

  async beginFastCompile(): Promise<BackendFastCompileSession> {
    return {
      strategy: "request-draft",
      compileOptions: { fastMode: true },
      async restore() {
        return { status: "restore-not-needed" as const };
      },
    };
  }

  async downloadPdf(input: BackendProjectInput): Promise<Uint8Array> {
    const client = await this.createClientFor("downloadPdf", input.auth, "COMPILE_FAILED");
    const bytes = await this.callRaw("downloadPdf", () => client.downloadPdf(input.projectId), "COMPILE_FAILED");
    return new Uint8Array(bytes);
  }

  private async createClientFor(
    operation: string,
    auth: ProjectAuth,
    fallbackCode: OlcxErrorCode
  ): Promise<OlcliClientLike> {
    return this.callRaw(`${operation}:createClient`, () => this.createClient(auth), fallbackCode);
  }

  private async createClient(auth: ProjectAuth): Promise<OlcliClientLike> {
    if (!auth.sessionCookie) {
      throw createOlcxError({
        code: "PROJECT_AUTH_INVALID",
        message: "Project-local Overleaf auth is missing a session cookie.",
        hint: "Run olcx auth again before using Overleaf-backed commands.",
      });
    }

    if (this.options.createClient) {
      return this.options.createClient(auth);
    }

    return OverleafClient.fromSessionCookie(auth.sessionCookie, this.options.baseUrl, this.options.cookieName);
  }

  private async callRaw<T>(operation: string, run: () => Promise<T>, fallbackCode: OlcxErrorCode): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toOlcxBackendError(operation, error, fallbackCode);
    }
  }
}

function normalizeRemotePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function toOlcxBackendError(operation: string, error: unknown, fallbackCode: OlcxErrorCode): OlcxError {
  if (isOlcxError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = classifyRawError(message, fallbackCode);

  return createOlcxError({
    code,
    message: backendMessage(operation, code),
    hint: backendHint(code),
    details: { operation, rawMessage: redactRawBackendMessage(message) },
  });
}

function assertSuccessfulUploadResult(result: unknown): asserts result is RawUploadResult {
  if (
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === true &&
    optionalString(result, "entityId") &&
    optionalString(result, "entityType")
  ) {
    return;
  }

  throw createOlcxError({
    code: "BACKEND_PROTOCOL_ERROR",
    message: "Overleaf backend returned an unexpected upload response.",
    hint: "Retry the command; if it repeats, update the backend adapter for the current Overleaf response.",
    details: { operation: "uploadFile", responseShape: typeof result },
  });
}

function optionalString(value: object, key: "entityId" | "entityType"): boolean {
  const entry = (value as Record<string, unknown>)[key];
  return entry === undefined || typeof entry === "string";
}

function classifyRawError(message: string, fallbackCode: OlcxErrorCode): OlcxErrorCode {
  if (/\b(401|403)\b|csrf|expired|unauth|forbidden|session/i.test(message)) {
    return "BACKEND_AUTH_FAILED";
  }
  if (fallbackCode === "COMPILE_FAILED" && /timeout|timed out|compile timeout|time limit|upgrade required/i.test(message)) {
    return "COMPILE_TIMEOUT";
  }
  if (/timeout|timed out|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket|network/i.test(message)) {
    return "BACKEND_NETWORK_ERROR";
  }
  return fallbackCode;
}

function backendMessage(operation: string, code: OlcxErrorCode): string {
  if (code === "BACKEND_AUTH_FAILED") return "Overleaf authentication was rejected.";
  if (code === "BACKEND_NETWORK_ERROR") return `Overleaf network request failed during ${operation}.`;
  if (code === "COMPILE_TIMEOUT") return `Overleaf compile timed out during ${operation}.`;
  if (code === "COMPILE_FAILED") return `Overleaf compile or PDF retrieval failed during ${operation}.`;
  return `Overleaf backend returned an unexpected response during ${operation}.`;
}

function backendHint(code: OlcxErrorCode): string {
  if (code === "BACKEND_AUTH_FAILED") return "Run olcx auth again with a fresh Overleaf session cookie.";
  if (code === "BACKEND_NETWORK_ERROR") return "Check network access to Overleaf and retry the command.";
  if (code === "COMPILE_TIMEOUT") return "Increase compile.timeoutMs in .olcx/config.json or retry when Overleaf is responsive.";
  if (code === "COMPILE_FAILED") return "Inspect the Overleaf compile result, then retry olcx compile.";
  return "Retry the command; if it repeats, update the backend adapter for the current Overleaf response.";
}

function redactRawBackendMessage(message: string): string {
  return message
    .replace(/https:\/\/(?:www\.|cn\.)?overleaf\.com\/project\/[A-Za-z0-9_-]+/g, "https://www.overleaf.com/project/<redacted-project-id>")
    .replace(/\b[A-Fa-f0-9]{24}\b/g, "<redacted-project-id>")
    .replace(/(session|cookie|csrf|token|auth)[^,\s]*/gi, "<redacted-secret>");
}
