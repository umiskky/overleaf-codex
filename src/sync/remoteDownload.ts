import { createOlcxError } from "../errors.js";

export const DEFAULT_REMOTE_DOWNLOAD_TIMEOUT_MS = 300_000;

export async function withRemoteDownloadTimeout(
  download: () => Promise<Uint8Array>,
  input: { path: string; timeoutMs: number; message: string; hint: string }
): Promise<Uint8Array> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      download(),
      new Promise<Uint8Array>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              createOlcxError({
                code: "BACKEND_NETWORK_ERROR",
                message: input.message,
                hint: input.hint,
                details: { path: input.path, timeoutMs: input.timeoutMs },
              })
            ),
          input.timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
