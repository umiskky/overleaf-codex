export const EXIT_CODES = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  USER_INPUT_ERROR: 2,
  CONFIG_ERROR: 3,
  AUTH_ERROR: 4,
  NETWORK_ERROR: 5,
  SYNC_CONFLICT: 6,
  COMPILE_FAILED: 7,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

export type OlcxErrorCode =
  | "USER_INPUT_ERROR"
  | "PROJECT_CONFIG_NOT_FOUND"
  | "PROJECT_CONFIG_INVALID"
  | "PROJECT_AUTH_NOT_FOUND"
  | "PROJECT_AUTH_INVALID"
  | "BACKEND_AUTH_FAILED"
  | "BACKEND_NETWORK_ERROR"
  | "BACKEND_PROTOCOL_ERROR"
  | "SYNC_CONFLICT"
  | "SYNC_UNSAFE_OPERATION"
  | "COMPILE_FAILED"
  | "COMPILE_TIMEOUT"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export const ERROR_CODE_EXIT_CODES: Record<OlcxErrorCode, ExitCode> = {
  USER_INPUT_ERROR: EXIT_CODES.USER_INPUT_ERROR,
  PROJECT_CONFIG_NOT_FOUND: EXIT_CODES.CONFIG_ERROR,
  PROJECT_CONFIG_INVALID: EXIT_CODES.CONFIG_ERROR,
  PROJECT_AUTH_NOT_FOUND: EXIT_CODES.AUTH_ERROR,
  PROJECT_AUTH_INVALID: EXIT_CODES.AUTH_ERROR,
  BACKEND_AUTH_FAILED: EXIT_CODES.AUTH_ERROR,
  BACKEND_NETWORK_ERROR: EXIT_CODES.NETWORK_ERROR,
  BACKEND_PROTOCOL_ERROR: EXIT_CODES.NETWORK_ERROR,
  SYNC_CONFLICT: EXIT_CODES.SYNC_CONFLICT,
  SYNC_UNSAFE_OPERATION: EXIT_CODES.SYNC_CONFLICT,
  COMPILE_FAILED: EXIT_CODES.COMPILE_FAILED,
  COMPILE_TIMEOUT: EXIT_CODES.COMPILE_FAILED,
  IO_ERROR: EXIT_CODES.INTERNAL_ERROR,
  INTERNAL_ERROR: EXIT_CODES.INTERNAL_ERROR,
};

export interface OlcxError extends Error {
  name: "OlcxError";
  code: OlcxErrorCode;
  exitCode: ExitCode;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface CreateOlcxErrorInput {
  code: OlcxErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export function mapErrorCodeToExitCode(code: OlcxErrorCode): ExitCode {
  return ERROR_CODE_EXIT_CODES[code];
}

export function createOlcxError(input: CreateOlcxErrorInput): OlcxError {
  const error = new Error(input.message) as OlcxError;
  error.name = "OlcxError";
  error.code = input.code;
  error.exitCode = mapErrorCodeToExitCode(input.code);

  if (input.hint !== undefined) {
    error.hint = input.hint;
  }
  if (input.details !== undefined) {
    error.details = input.details;
  }
  if (input.cause !== undefined) {
    error.cause = input.cause;
  }

  return error;
}

export function isOlcxError(error: unknown): error is OlcxError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "OlcxError" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
  );
}
