import { describe, expect, it } from "vitest";
import { createOlcxError, EXIT_CODES, isOlcxError } from "../src/errors";
import { ERROR_CODE_EXIT_CODES, mapErrorCodeToExitCode } from "../src/cli-behavior";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";

const projectId = "<overleaf-project-id>";
const fakePdf = new Uint8Array(Buffer.from("%PDF-1.4\n% fake olcx pdf\n", "utf8"));

function fakeAuth() {
  return {
    schemaVersion: 1 as const,
    accountLabel: "test account",
    sessionCookie: "<redacted-session-cookie>",
    updatedAt: "2026-06-25T08:00:00.000Z",
    source: "env" as const,
  };
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

describe("backend error contracts", () => {
  it("uses the same error categories and exit mapping as CLI behavior", () => {
    const error = createOlcxError({
      code: "BACKEND_AUTH_FAILED",
      message: "Overleaf authentication was rejected.",
      hint: "Run olcx auth again with a fresh session cookie.",
    });

    expect(isOlcxError(error)).toBe(true);
    expect(error.name).toBe("OlcxError");
    expect(error.code).toBe("BACKEND_AUTH_FAILED");
    expect(error.exitCode).toBe(EXIT_CODES.AUTH_ERROR);
    expect(ERROR_CODE_EXIT_CODES.BACKEND_AUTH_FAILED).toBe(EXIT_CODES.AUTH_ERROR);
    expect(mapErrorCodeToExitCode(error.code)).toBe(error.exitCode);
  });
});

describe("fake Overleaf backend", () => {
  it("supports deterministic auth, file operations, compile, and PDF download", async () => {
    const backend = createFakeOverleafBackend({
      projects: [
        {
          projectId,
          files: [{ path: "main.tex", text: "\\documentclass{article}\n\\begin{document}Fake\\end{document}\n" }],
          pdfBytes: fakePdf,
        },
      ],
    });
    const auth = fakeAuth();

    await expect(backend.validateAuth({ auth })).resolves.toEqual({
      authenticated: true,
      accountLabel: "test account",
    });
    await expect(backend.listFiles({ auth, projectId })).resolves.toEqual([
      expect.objectContaining({ path: "main.tex", kind: "file", size: expect.any(Number) }),
    ]);
    await expect(backend.downloadFile({ auth, projectId, path: "main.tex" })).resolves.toSatisfy(
      (bytes: Uint8Array) => text(bytes).includes("\\begin{document}Fake")
    );

    await expect(
      backend.uploadFile({
        auth,
        projectId,
        path: "refs.bib",
        bytes: Buffer.from("@article{fake,title={Fake}}\n", "utf8"),
      })
    ).resolves.toMatchObject({ path: "refs.bib", kind: "file", remoteId: "fake-remote-2" });
    await expect(backend.listFiles({ auth, projectId })).resolves.toEqual([
      expect.objectContaining({ path: "main.tex" }),
      expect.objectContaining({ path: "refs.bib" }),
    ]);

    await expect(backend.deleteFile({ auth, projectId, path: "refs.bib" })).resolves.toBeUndefined();
    await expect(backend.listFiles({ auth, projectId })).resolves.toEqual([
      expect.objectContaining({ path: "main.tex" }),
    ]);

    const compile = await backend.compile({ auth, projectId, rootDocument: "main.tex", timeoutMs: 30000 });
    expect(compile.status).toBe("success");
    expect(text(compile.pdfBytes ?? new Uint8Array())).toContain("%PDF-1.4");
    await expect(backend.downloadPdf({ auth, projectId })).resolves.toEqual(fakePdf);
  });

  it("rejects auth failures with BACKEND_AUTH_FAILED", async () => {
    const backend = createFakeOverleafBackend({ failures: { validateAuth: "auth" } });

    await expect(backend.validateAuth({ auth: fakeAuth() })).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_AUTH_FAILED",
      exitCode: EXIT_CODES.AUTH_ERROR,
    });
  });

  it("rejects network failures with BACKEND_NETWORK_ERROR", async () => {
    const backend = createFakeOverleafBackend({ failures: { listFiles: "network" } });

    await expect(backend.listFiles({ auth: fakeAuth(), projectId })).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_NETWORK_ERROR",
      exitCode: EXIT_CODES.NETWORK_ERROR,
    });
  });

  it("returns a compile failure result with COMPILE_FAILED", async () => {
    const backend = createFakeOverleafBackend({
      projects: [{ projectId, compileStatus: "failure" }],
    });

    const result = await backend.compile({ auth: fakeAuth(), projectId, rootDocument: "main.tex", timeoutMs: 30000 });

    expect(result.status).toBe("failure");
    expect(result.error).toMatchObject({
      name: "OlcxError",
      code: "COMPILE_FAILED",
      exitCode: EXIT_CODES.COMPILE_FAILED,
    });
  });

  it("supports fast fallback compile status, PDF bytes, and restore", async () => {
    const fastPdf = new Uint8Array(Buffer.from("%PDF-1.4\n% fake fast fallback pdf\n", "utf8"));
    const backend = createFakeOverleafBackend({
      projects: [
        {
          projectId,
          compileStatus: "timeout",
          fastCompileStatus: "success",
          fastPdfBytes: fastPdf,
        },
      ],
    });
    const session = await backend.beginFastCompile?.({ auth: fakeAuth(), projectId });

    expect(session?.compileOptions).toEqual({ fastMode: true });
    const compile = await backend.compile({
      auth: fakeAuth(),
      projectId,
      rootDocument: "main.tex",
      timeoutMs: 15000,
      fastMode: true,
    });

    expect(compile.status).toBe("fallback-success");
    expect(compile.fallbackUsed).toBe(true);
    expect(text(compile.pdfBytes ?? new Uint8Array())).toContain("fake fast fallback pdf");
    await expect(session?.restore()).resolves.toEqual({ status: "restored" });
  });

  it("can simulate fast compile restore failures", async () => {
    const backend = createFakeOverleafBackend({
      projects: [{ projectId, fastRestoreFailure: true }],
    });
    const session = await backend.beginFastCompile?.({ auth: fakeAuth(), projectId });

    await expect(session?.restore()).rejects.toMatchObject({
      name: "OlcxError",
      code: "COMPILE_FAILED",
      exitCode: EXIT_CODES.COMPILE_FAILED,
    });
  });

  it("rejects PDF download failures with COMPILE_FAILED", async () => {
    const backend = createFakeOverleafBackend({
      projects: [{ projectId, files: [{ path: "main.tex", text: "fake" }], pdfBytes: fakePdf }],
      failures: { downloadPdf: "pdf" },
    });

    await expect(backend.downloadPdf({ auth: fakeAuth(), projectId })).rejects.toMatchObject({
      name: "OlcxError",
      code: "COMPILE_FAILED",
      exitCode: EXIT_CODES.COMPILE_FAILED,
    });
  });
});
