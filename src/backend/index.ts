export { createOlcliOverleafBackend } from "./overleafBackend.js";
export type { OlcliBackendOptions } from "./overleafBackend.js";
import type { OlcliBackendOptions } from "./overleafBackend.js";
import type { OverleafBackend } from "./types.js";
export type {
  BackendAccount,
  BackendAuthInput,
  BackendCompileInput,
  BackendFastCompileRestoreResult,
  BackendFastCompileRestoreStatus,
  BackendFastCompileSession,
  BackendFileInput,
  BackendProjectInput,
  BackendUploadInput,
  CompileLogEntry,
  CompileResult,
  OverleafBackend,
  RemoteFile,
} from "./types.js";

export type OverleafBackendFactory = (options: OlcliBackendOptions) => OverleafBackend;
