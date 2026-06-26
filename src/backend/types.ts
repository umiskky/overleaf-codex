import type { ProjectAuth } from "../auth/types.js";
import type { OlcxError } from "../errors.js";

export interface BackendAuthInput {
  auth: ProjectAuth;
}

export interface BackendAccount {
  accountLabel?: string;
  authenticated: boolean;
}

export interface BackendProjectInput {
  projectId: string;
  auth: ProjectAuth;
}

export interface BackendFileInput extends BackendProjectInput {
  path: string;
  remoteId?: string;
}

export interface BackendUploadInput extends BackendProjectInput {
  path: string;
  bytes: Uint8Array;
}

export interface BackendCompileInput extends BackendProjectInput {
  timeoutMs: number;
  rootDocument: string;
  fastMode?: boolean;
}

export type BackendFastCompileRestoreStatus = "restored" | "restore-not-needed";

export interface BackendFastCompileRestoreResult {
  status: BackendFastCompileRestoreStatus;
  warning?: string;
}

export interface BackendFastCompileSession {
  strategy: "request-draft" | "project-settings";
  compileOptions: Pick<BackendCompileInput, "fastMode">;
  restore(): Promise<BackendFastCompileRestoreResult>;
}

export interface RemoteFile {
  path: string;
  kind: "file" | "directory";
  remoteId?: string;
  size?: number;
  contentHash?: string;
  modifiedAt?: string;
  revision?: string;
  binary?: boolean;
}

export interface CompileLogEntry {
  level: "info" | "warning" | "error";
  message: string;
  file?: string;
  line?: number;
}

export interface CompileResult {
  status: "success" | "failure" | "timeout" | "fallback-success";
  projectId: string;
  pdfBytes?: Uint8Array;
  pdfPath?: string;
  logs: CompileLogEntry[];
  warnings: string[];
  elapsedMs: number;
  fallbackUsed: boolean;
  error?: OlcxError;
}

export interface OverleafBackend {
  validateAuth(input: BackendAuthInput): Promise<BackendAccount>;
  listFiles(input: BackendProjectInput): Promise<RemoteFile[]>;
  downloadFile(input: BackendFileInput): Promise<Uint8Array>;
  uploadFile(input: BackendUploadInput): Promise<RemoteFile>;
  deleteFile(input: BackendFileInput): Promise<void>;
  compile(input: BackendCompileInput): Promise<CompileResult>;
  beginFastCompile?(input: BackendProjectInput): Promise<BackendFastCompileSession>;
  downloadPdf(input: BackendProjectInput): Promise<Uint8Array>;
}
