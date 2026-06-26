import { describe, expect, it } from "vitest";
import { createOlcliOverleafBackend } from "../src/backend";

function fakeAuth() {
  return {
    schemaVersion: 1 as const,
    accountLabel: "test account",
    sessionCookie: "<redacted-session-cookie>",
    updatedAt: "2026-06-25T08:00:00.000Z",
    source: "env" as const,
  };
}

describe("olcli backend adapter", () => {
  it("exposes the stable OverleafBackend surface without constructing a real network client", () => {
    const backend = createOlcliOverleafBackend({
      baseUrl: "https://example.invalid",
      cookieName: "overleaf_session2",
    });

    expect(typeof backend.validateAuth).toBe("function");
    expect(typeof backend.listFiles).toBe("function");
    expect(typeof backend.downloadFile).toBe("function");
    expect(typeof backend.uploadFile).toBe("function");
    expect(typeof backend.deleteFile).toBe("function");
    expect(typeof backend.compile).toBe("function");
    expect(typeof backend.beginFastCompile).toBe("function");
    expect(typeof backend.downloadPdf).toBe("function");
    expect("fromSessionCookie" in backend).toBe(false);
  });

  it("can be exercised with an injected private client instead of real Overleaf", async () => {
    const calls: string[] = [];
    const rawClient = {
      async listProjects() {
        calls.push("listProjects");
        return [{ id: "<overleaf-project-id>", name: "Fake Project", lastUpdated: "2026-06-25T08:00:00.000Z" }];
      },
      async getEntities() {
        calls.push("getEntities");
        return [{ path: "/main.tex", type: "doc" as const }];
      },
      async downloadByPath() {
        calls.push("downloadByPath");
        return Buffer.from("fake tex", "utf8");
      },
      async uploadFile() {
        calls.push("uploadFile");
        return { success: true, entityId: "remote-main", entityType: "doc" };
      },
      async deleteByPath() {
        calls.push("deleteByPath");
      },
      async compileWithOutputs() {
        calls.push("compileWithOutputs");
        return {
          status: "success" as const,
          pdfUrl: "https://example.invalid/build/output.pdf",
          outputFiles: [{ path: "output.pdf", type: "pdf", url: "https://example.invalid/build/output.pdf" }],
        };
      },
      async downloadOutputFile() {
        calls.push("downloadOutputFile");
        return Buffer.from("%PDF-1.4\n% fake adapter pdf\n", "utf8");
      },
      async downloadPdf() {
        calls.push("downloadPdf");
        return Buffer.from("%PDF-1.4\n% fake direct pdf\n", "utf8");
      },
    };

    const backend = createOlcliOverleafBackend({
      createClient: async () => rawClient,
      now: () => 0,
    });
    const auth = fakeAuth();

    await expect(backend.validateAuth({ auth })).resolves.toMatchObject({ authenticated: true });
    await expect(backend.listFiles({ auth, projectId: "<overleaf-project-id>" })).resolves.toEqual([
      expect.objectContaining({ path: "main.tex", kind: "file" }),
    ]);
    await expect(backend.downloadFile({ auth, projectId: "<overleaf-project-id>", path: "main.tex" })).resolves.toEqual(
      new Uint8Array(Buffer.from("fake tex", "utf8"))
    );
    await expect(
      backend.uploadFile({
        auth,
        projectId: "<overleaf-project-id>",
        path: "refs.bib",
        bytes: Buffer.from("fake bib", "utf8"),
      })
    ).resolves.toMatchObject({ path: "refs.bib", remoteId: "remote-main" });
    await expect(backend.deleteFile({ auth, projectId: "<overleaf-project-id>", path: "main.tex" })).resolves.toBeUndefined();

    const compile = await backend.compile({
      auth,
      projectId: "<overleaf-project-id>",
      rootDocument: "main.tex",
      timeoutMs: 30000,
    });
    expect(compile.status).toBe("success");
    expect(Buffer.from(compile.pdfBytes ?? []).toString("utf8")).toContain("%PDF-1.4");

    await expect(backend.downloadPdf({ auth, projectId: "<overleaf-project-id>" })).resolves.toEqual(
      new Uint8Array(Buffer.from("%PDF-1.4\n% fake direct pdf\n", "utf8"))
    );

    expect(calls).toEqual([
      "listProjects",
      "getEntities",
      "downloadByPath",
      "uploadFile",
      "deleteByPath",
      "compileWithOutputs",
      "downloadOutputFile",
      "downloadPdf",
    ]);
  });

  it("maps private client creation auth failures to BACKEND_AUTH_FAILED", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () => {
        throw new Error("403 expired session overleaf_session2=<secret>");
      },
    });

    await expect(backend.validateAuth({ auth: fakeAuth() })).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_AUTH_FAILED",
      exitCode: 4,
    });
    await expect(backend.validateAuth({ auth: fakeAuth() })).rejects.not.toThrow("<secret>");
  });

  it("maps raw auth failures to BACKEND_AUTH_FAILED without leaking the cookie", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async listProjects() {
            throw new Error("403 expired session overleaf_session2=<secret>");
          },
        }) as never,
    });

    await expect(backend.validateAuth({ auth: fakeAuth() })).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_AUTH_FAILED",
      exitCode: 4,
    });
    await expect(backend.validateAuth({ auth: fakeAuth() })).rejects.not.toThrow("<secret>");
  });

  it("maps raw network failures to BACKEND_NETWORK_ERROR", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async getEntities() {
            throw new Error("ECONNRESET socket hang up");
          },
        }) as never,
    });

    await expect(backend.listFiles({ auth: fakeAuth(), projectId: "<overleaf-project-id>" })).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_NETWORK_ERROR",
      exitCode: 5,
    });
  });

  it("rejects unsuccessful raw upload results as BACKEND_PROTOCOL_ERROR", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async uploadFile() {
            return { success: false };
          },
        }) as never,
    });

    await expect(
      backend.uploadFile({
        auth: fakeAuth(),
        projectId: "<overleaf-project-id>",
        path: "main.tex",
        bytes: Buffer.from("fake", "utf8"),
      })
    ).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_PROTOCOL_ERROR",
    });
  });

  it("rejects malformed raw upload results as BACKEND_PROTOCOL_ERROR", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async uploadFile() {
            return null;
          },
        }) as never,
    });

    await expect(
      backend.uploadFile({
        auth: fakeAuth(),
        projectId: "<overleaf-project-id>",
        path: "main.tex",
        bytes: Buffer.from("fake", "utf8"),
      })
    ).rejects.toMatchObject({
      name: "OlcxError",
      code: "BACKEND_PROTOCOL_ERROR",
    });
  });

  it("sanitizes raw backend errors without retaining secret-bearing causes", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async listProjects() {
            throw new Error("403 expired session overleaf_session2=<secret>");
          },
        }) as never,
    });

    try {
      await backend.validateAuth({ auth: fakeAuth() });
      throw new Error("Expected validateAuth to reject.");
    } catch (error) {
      expect(error).toMatchObject({
        name: "OlcxError",
        code: "BACKEND_AUTH_FAILED",
      });

      const olcxError = error as { cause?: unknown; details?: unknown; message?: string };
      expect(JSON.stringify({ message: olcxError.message, details: olcxError.details })).not.toContain("<secret>");
      expect(JSON.stringify(olcxError.cause ?? {})).not.toContain("<secret>");
      expect((olcxError.cause as { message?: string } | undefined)?.message ?? "").not.toContain("<secret>");
    }
  });

  it("redacts cn project URLs and secrets from raw backend errors", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async getEntities() {
            throw new Error(
              "https://cn.overleaf.com/project/0123456789abcdef01234567 overleaf_session2=<secret>"
            );
          },
        }) as never,
    });

    try {
      await backend.listFiles({ auth: fakeAuth(), projectId: "<overleaf-project-id>" });
      throw new Error("Expected listFiles to reject.");
    } catch (error) {
      const olcxError = error as { details?: unknown; message?: string };
      const details = JSON.stringify({ message: olcxError.message, details: olcxError.details });

      expect(details).not.toContain("0123456789abcdef01234567");
      expect(details).not.toContain("<secret>");
      expect(details).not.toContain("cn.overleaf.com/project/0123456789abcdef01234567");
    }
  });

  it("returns compile failure results instead of throwing for Overleaf compile status failure", async () => {
    const backend = createOlcliOverleafBackend({
      now: () => 0,
      createClient: async () =>
        ({
          async compileWithOutputs() {
            return { status: "failure" as const, outputFiles: [] };
          },
        }) as never,
    });

    const result = await backend.compile({
      auth: fakeAuth(),
      projectId: "<overleaf-project-id>",
      rootDocument: "main.tex",
      timeoutMs: 30000,
    });

    expect(result.status).toBe("failure");
    expect(result.error).toMatchObject({ code: "COMPILE_FAILED", exitCode: 7 });
  });

  it("passes compile timeoutMs through to the private olcli client", async () => {
    let compileOptions: unknown;
    const backend = createOlcliOverleafBackend({
      now: () => 0,
      createClient: async () =>
        ({
          async compileWithOutputs(_projectId: string, options: unknown) {
            compileOptions = options;
            return {
              status: "success" as const,
              pdfUrl: "https://example.invalid/build/output.pdf",
              outputFiles: [{ path: "output.pdf", type: "pdf", url: "https://example.invalid/build/output.pdf" }],
            };
          },
          async downloadOutputFile() {
            return Buffer.from("%PDF-1.4\n% fake adapter pdf\n", "utf8");
          },
        }) as never,
    });

    await backend.compile({
      auth: fakeAuth(),
      projectId: "<overleaf-project-id>",
      rootDocument: "main.tex",
      timeoutMs: 45000,
    });

    expect(compileOptions).toEqual({ timeoutMs: 45000, draft: false });
  });

  it("passes draft mode to the private olcli client for fast fallback compiles", async () => {
    let compileOptions: unknown;
    const backend = createOlcliOverleafBackend({
      now: () => 0,
      createClient: async () =>
        ({
          async compileWithOutputs(_projectId: string, options: unknown) {
            compileOptions = options;
            return {
              status: "success" as const,
              pdfUrl: "https://example.invalid/build/output.pdf",
              outputFiles: [{ path: "output.pdf", type: "pdf", url: "https://example.invalid/build/output.pdf" }],
            };
          },
          async downloadOutputFile() {
            return Buffer.from("%PDF-1.4\n% fake fast adapter pdf\n", "utf8");
          },
        }) as never,
    });

    const compile = await backend.compile({
      auth: fakeAuth(),
      projectId: "<overleaf-project-id>",
      rootDocument: "main.tex",
      timeoutMs: 15000,
      fastMode: true,
    });

    expect(compileOptions).toEqual({ timeoutMs: 15000, draft: true });
    expect(compile.status).toBe("fallback-success");
    expect(compile.fallbackUsed).toBe(true);
    expect(compile.warnings.join("\n")).toMatch(/fast\/draft fallback/i);
  });

  it("creates a no-op request-draft fast compile session", async () => {
    const backend = createOlcliOverleafBackend({ createClient: async () => ({}) as never });
    const session = await backend.beginFastCompile?.({ auth: fakeAuth(), projectId: "<overleaf-project-id>" });

    expect(session).toMatchObject({
      strategy: "request-draft",
      compileOptions: { fastMode: true },
    });
    await expect(session?.restore()).resolves.toEqual({ status: "restore-not-needed" });
  });

  it("maps raw compile timeout failures to COMPILE_TIMEOUT", async () => {
    const backend = createOlcliOverleafBackend({
      createClient: async () =>
        ({
          async compileWithOutputs() {
            throw new Error("compile timed out after 30000ms");
          },
        }) as never,
    });

    await expect(
      backend.compile({
        auth: fakeAuth(),
        projectId: "<overleaf-project-id>",
        rootDocument: "main.tex",
        timeoutMs: 30000,
      })
    ).rejects.toMatchObject({
      name: "OlcxError",
      code: "COMPILE_TIMEOUT",
      exitCode: 7,
      message: "Overleaf compile timed out during compile.",
      hint: "Increase compile.timeoutMs in .olcx/config.json or retry when Overleaf is responsive.",
    });
  });
});
