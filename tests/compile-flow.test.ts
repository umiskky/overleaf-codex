import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAuth } from "../src/auth/types";
import type { BackendCompileInput, BackendProjectInput, CompileResult, OverleafBackend } from "../src/backend/types";
import { writeProjectAuth } from "../src/auth/projectAuth";
import { writeProjectConfig } from "../src/config/projectConfig";
import { createDefaultProjectConfig } from "../src/config/types";
import { createOlcxError } from "../src/errors";
import { compileProject } from "../src/compile/compileFlow";
import { resolvePdfOutputTarget, writePdfOutput } from "../src/compile/pdfOutput";

const projectId = "<overleaf-project-id>";
const auth: ProjectAuth = {
  schemaVersion: 1,
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: "2026-06-25T08:00:00.000Z",
  source: "env",
};
const defaultPdfBytes = Buffer.from("%PDF-1.4\n% fake compile pdf\n", "utf8");

async function withTempCompileProject<T>(
  fn: (projectRoot: string) => Promise<T>,
  options: {
    pdfPath?: string;
    timeoutMs?: number;
    rootDocument?: string;
    writeConfig?: boolean;
    writeAuth?: boolean;
    fastFallback?: {
      enabled?: boolean;
      attempts?: number;
      timeoutMs?: number;
    };
  } = {}
): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-compile-flow-test-"));
  try {
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    if (options.writeConfig !== false) {
      await writeProjectConfig(
        projectRoot,
        createDefaultProjectConfig({
          projectId,
          pdfPath: options.pdfPath,
          rootDocument: options.rootDocument,
          compile: { timeoutMs: options.timeoutMs, fastFallback: options.fastFallback },
        })
      );
    }
    if (options.writeAuth !== false) {
      await writeProjectAuth(projectRoot, auth);
    }
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function createRecordingCompileBackend(
  options: {
    compileResult?: (input: BackendCompileInput) => CompileResult;
    compileReject?: (input: BackendCompileInput) => Promise<CompileResult>;
    downloadPdfBytes?: Uint8Array;
    downloadPdfReject?: (input: BackendProjectInput) => Promise<Uint8Array>;
    restoreReject?: () => Promise<void>;
  } = {}
): {
  backend: OverleafBackend;
  compileInputs: BackendCompileInput[];
  downloadPdfInputs: BackendProjectInput[];
  beginFastCompileInputs: BackendProjectInput[];
  restoreCalls: string[];
} {
  const compileInputs: BackendCompileInput[] = [];
  const downloadPdfInputs: BackendProjectInput[] = [];
  const beginFastCompileInputs: BackendProjectInput[] = [];
  const restoreCalls: string[] = [];
  const backend: OverleafBackend = {
    async validateAuth() {
      return { authenticated: true };
    },
    async listFiles() {
      return [];
    },
    async downloadFile() {
      return new Uint8Array();
    },
    async uploadFile() {
      throw new Error("uploadFile is not used by compile flow tests");
    },
    async deleteFile() {},
    async compile(input) {
      compileInputs.push(input);
      if (options.compileReject) {
        return options.compileReject(input);
      }
      return (
        options.compileResult?.(input) ?? {
          status: "success",
          projectId: input.projectId,
          pdfBytes: new Uint8Array(defaultPdfBytes),
          logs: [{ level: "info", message: "Fake compile succeeded." }],
          warnings: [],
          elapsedMs: 42,
          fallbackUsed: false,
        }
      );
    },
    async downloadPdf(input) {
      downloadPdfInputs.push(input);
      if (options.downloadPdfReject) {
        return options.downloadPdfReject(input);
      }
      return new Uint8Array(options.downloadPdfBytes ?? defaultPdfBytes);
    },
    async beginFastCompile(input) {
      beginFastCompileInputs.push(input);
      return {
        strategy: "project-settings" as const,
        compileOptions: { fastMode: true as const },
        restore: async () => {
          restoreCalls.push(input.projectId);
          if (options.restoreReject) {
            await options.restoreReject();
          }
          return { status: "restored" as const };
        },
      };
    },
  };

  return { backend, compileInputs, downloadPdfInputs, beginFastCompileInputs, restoreCalls };
}

describe("PDF output helper", () => {
  it("resolves configured PDF paths inside the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-pdf-output-test-"));

    try {
      const target = resolvePdfOutputTarget(root, "build\\overleaf\\main.pdf");

      expect(target.relativePath).toBe("build/overleaf/main.pdf");
      expect(target.absolutePath).toBe(join(root, "build", "overleaf", "main.pdf"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes PDF bytes and creates parent directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "olcx-pdf-write-test-"));

    try {
      const target = resolvePdfOutputTarget(root, "build/overleaf/main.pdf");
      const result = await writePdfOutput(target, Buffer.from("%PDF-1.4\n% fake test pdf\n", "utf8"));

      expect(result).toEqual({
        absolutePath: join(root, "build", "overleaf", "main.pdf"),
        relativePath: "build/overleaf/main.pdf",
        bytesWritten: 25,
      });
      await expect(readFile(join(root, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake test pdf\n"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["blank", " "],
    ["absolute", "/tmp/main.pdf"],
    ["Windows absolute", "C:\\tmp\\main.pdf"],
    ["parent segment", "../main.pdf"],
    ["nested parent segment", "build/../../main.pdf"],
  ])("rejects %s PDF output paths", (_name, pdfPath) => {
    const root = join(tmpdir(), "olcx-pdf-unsafe-test");

    expect(() => resolvePdfOutputTarget(root, pdfPath)).toThrow(
      expect.objectContaining({
        name: "OlcxError",
        code: "USER_INPUT_ERROR",
        exitCode: 2,
      })
    );
  });
});

describe("compile workflow success paths", () => {
  it("creates the backend with the configured Overleaf base URL", async () => {
    await withTempCompileProject(async (projectRoot) => {
      await writeProjectConfig(
        projectRoot,
        createDefaultProjectConfig({
          projectId,
          overleaf: { baseUrl: "https://cn.overleaf.com" },
        })
      );
      const capturedOptions: unknown[] = [];
      const { backend } = createRecordingCompileBackend();

      await compileProject({
        cwd: projectRoot,
        env: {},
        createBackend: (options) => {
          capturedOptions.push(options);
          return backend;
        },
      });

      expect(capturedOptions).toEqual([{ baseUrl: "https://cn.overleaf.com" }]);
    });
  });

  it("compiles Overleaf and writes the configured default PDF path", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const { backend, compileInputs, beginFastCompileInputs, restoreCalls } = createRecordingCompileBackend();

      const result = await compileProject({ cwd: projectRoot, backend, env: {} });

      expect(result).toMatchObject({
        projectRoot,
        pdfPath: "build/overleaf/main.pdf",
        status: "success",
        elapsedMs: 42,
        fallbackUsed: false,
        bytesWritten: defaultPdfBytes.byteLength,
      });
      expect(result.logs).toEqual([{ level: "info", message: "Fake compile succeeded." }]);
      expect(compileInputs).toHaveLength(1);
      expect(beginFastCompileInputs).toEqual([]);
      expect(restoreCalls).toEqual([]);
      expect(compileInputs[0]).toMatchObject({
        projectId,
        auth,
        timeoutMs: 120000,
        rootDocument: "main.tex",
      });
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake compile pdf\n"
      );
    });
  });

  it("writes a caller-provided PDF output path instead of the configured path", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const { backend, beginFastCompileInputs, restoreCalls } = createRecordingCompileBackend();

      const result = await compileProject({ cwd: projectRoot, backend, env: {}, pdfPath: "artifacts/paper.pdf" });

      expect(result.pdfPath).toBe("artifacts/paper.pdf");
      expect(result.bytesWritten).toBe(defaultPdfBytes.byteLength);
      expect(beginFastCompileInputs).toEqual([]);
      expect(restoreCalls).toEqual([]);
      await expect(readFile(join(projectRoot, "artifacts", "paper.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% fake compile pdf\n"
      );
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("downloads the PDF after a successful compile result without inline bytes", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const downloadPdfBytes = Buffer.from("%PDF-1.4\n% downloaded after compile\n", "utf8");
      const { backend, downloadPdfInputs, beginFastCompileInputs, restoreCalls } = createRecordingCompileBackend({
        downloadPdfBytes,
        compileResult: (input) => ({
          status: "success",
          projectId: input.projectId,
          logs: [{ level: "warning", message: "LaTeX Warning: Reference changed." }],
          warnings: ["Reference changed."],
          elapsedMs: 53,
          fallbackUsed: false,
        }),
      });

      const result = await compileProject({ cwd: projectRoot, backend, env: {} });

      expect(result).toMatchObject({
        status: "success",
        warnings: ["Reference changed."],
        bytesWritten: downloadPdfBytes.byteLength,
      });
      expect(downloadPdfInputs).toEqual([{ projectId, auth }]);
      expect(beginFastCompileInputs).toEqual([]);
      expect(restoreCalls).toEqual([]);
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
        "%PDF-1.4\n% downloaded after compile\n"
      );
    });
  });

  it("falls back to fast draft compile after a normal timeout and writes the fallback PDF", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const fallbackPdf = Buffer.from("%PDF-1.4\n% fast fallback pdf\n", "utf8");
        const { backend, compileInputs, beginFastCompileInputs, restoreCalls } = createRecordingCompileBackend({
          compileResult: (input) => {
            if (input.fastMode) {
              return {
                status: "fallback-success",
                projectId: input.projectId,
                pdfBytes: new Uint8Array(fallbackPdf),
                logs: [{ level: "warning", message: "Compiled in fast draft mode." }],
                warnings: ["Fast/draft fallback PDF: images may be omitted."],
                elapsedMs: 17,
                fallbackUsed: true,
              };
            }
            return {
              status: "timeout",
              projectId: input.projectId,
              logs: [{ level: "error", message: "Compile timed out after 120s." }],
              warnings: [],
              elapsedMs: 120000,
              fallbackUsed: false,
            };
          },
        });

        const result = await compileProject({ cwd: projectRoot, backend, env: {} });

        expect(result).toMatchObject({
          status: "fallback-success",
          fallbackUsed: true,
          warnings: expect.arrayContaining(["Fast/draft fallback PDF: images may be omitted."]),
          bytesWritten: fallbackPdf.byteLength,
        });
        expect(compileInputs).toHaveLength(2);
        expect(compileInputs[0]).toMatchObject({ timeoutMs: 120000, fastMode: undefined });
        expect(compileInputs[1]).toMatchObject({ timeoutMs: 15000, fastMode: true });
        expect(beginFastCompileInputs).toEqual([{ projectId, auth }]);
        expect(restoreCalls).toEqual([projectId]);
        await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).resolves.toBe(
          "%PDF-1.4\n% fast fallback pdf\n"
        );
      },
      { fastFallback: { enabled: true, attempts: 1, timeoutMs: 15000 } }
    );
  });

  it("treats upgrade and time-limit compile failures as recoverable fallback triggers", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend, compileInputs } = createRecordingCompileBackend({
          compileResult: (input) =>
            input.fastMode
              ? {
                  status: "fallback-success",
                  projectId: input.projectId,
                  pdfBytes: new Uint8Array(defaultPdfBytes),
                  logs: [{ level: "info", message: "Fast compile succeeded." }],
                  warnings: ["Fast/draft fallback PDF: images may be omitted."],
                  elapsedMs: 20,
                  fallbackUsed: true,
                }
              : {
                  status: "failure",
                  projectId: input.projectId,
                  logs: [{ level: "error", message: "Upgrade required: compile time limit reached." }],
                  warnings: [],
                  elapsedMs: 120000,
                  fallbackUsed: false,
                },
        });

        const result = await compileProject({ cwd: projectRoot, backend, env: {} });

        expect(result.status).toBe("fallback-success");
        expect(compileInputs.map((entry) => entry.fastMode)).toEqual([undefined, true]);
      },
      { fastFallback: { enabled: true, attempts: 1, timeoutMs: 15000 } }
    );
  });
});

describe("compile workflow failure paths", () => {
  it("turns compile failures into readable errors with log details", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const logs = [
        { level: "error" as const, message: "LaTeX Error: File `missing.sty' not found.", file: "main.tex", line: 12 },
        { level: "warning" as const, message: "LaTeX Warning: Reference `sec:intro' undefined." },
      ];
      const { backend } = createRecordingCompileBackend({
        compileResult: (input) => ({
          status: "failure",
          projectId: input.projectId,
          logs,
          warnings: ["Reference `sec:intro' undefined."],
          elapsedMs: 75,
          fallbackUsed: false,
        }),
      });

      await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
        name: "OlcxError",
        code: "COMPILE_FAILED",
        exitCode: 7,
        message: "Overleaf compile failed: LaTeX Error: File `missing.sty' not found.",
        details: {
          status: "failure",
          logs,
          logSummary: [
            "error main.tex:12 LaTeX Error: File `missing.sty' not found.",
            "warning LaTeX Warning: Reference `sec:intro' undefined.",
          ],
        },
      });
    });
  });

  it("preserves timeout status returned by the backend", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const logs = [{ level: "error" as const, message: "Compile timed out after 30s." }];
        const { backend } = createRecordingCompileBackend({
          compileResult: (input) => ({
            status: "timeout",
            projectId: input.projectId,
            logs,
            warnings: [],
            elapsedMs: 30000,
            fallbackUsed: false,
          }),
        });

        await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          name: "OlcxError",
          code: "COMPILE_TIMEOUT",
          exitCode: 7,
          message: "Overleaf compile timed out: Compile timed out after 30s.",
          details: {
            status: "timeout",
            logs,
            logSummary: ["error Compile timed out after 30s."],
          },
        });
      },
      { fastFallback: { enabled: false, attempts: 0, timeoutMs: 15000 } }
    );
  });

  it("enforces config timeoutMs when backend compile hangs", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend } = createRecordingCompileBackend({
          compileReject: () => new Promise<CompileResult>(() => {}),
        });

        const result = await Promise.race([
          compileProject({ cwd: projectRoot, backend, env: {} }).catch((error) => error),
          new Promise((resolve) => setTimeout(() => resolve("still-running"), 100)),
        ]);

        expect(result).toMatchObject({
          name: "OlcxError",
          code: "COMPILE_TIMEOUT",
          exitCode: 7,
          message: "Overleaf compile timed out after 20ms.",
        });
      },
      { timeoutMs: 20, fastFallback: { enabled: false, attempts: 0, timeoutMs: 10 } }
    );
  });

  it("does not fall back when fast fallback is disabled", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend, compileInputs, beginFastCompileInputs } = createRecordingCompileBackend({
          compileResult: (input) => ({
            status: "timeout",
            projectId: input.projectId,
            logs: [{ level: "error", message: "Compile timed out after 120s." }],
            warnings: [],
            elapsedMs: 120000,
            fallbackUsed: false,
          }),
        });

        await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          name: "OlcxError",
          code: "COMPILE_TIMEOUT",
          exitCode: 7,
        });
        expect(compileInputs).toHaveLength(1);
        expect(beginFastCompileInputs).toEqual([]);
      },
      { fastFallback: { enabled: false, attempts: 0, timeoutMs: 15000 } }
    );
  });

  it("returns a combined failure when fast fallback also fails", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend, compileInputs, restoreCalls } = createRecordingCompileBackend({
          compileResult: (input) =>
            input.fastMode
              ? {
                  status: "failure",
                  projectId: input.projectId,
                  logs: [{ level: "error", message: "Fast compile also failed." }],
                  warnings: [],
                  elapsedMs: 15000,
                  fallbackUsed: true,
                }
              : {
                  status: "timeout",
                  projectId: input.projectId,
                  logs: [{ level: "error", message: "Compile timed out after 120s." }],
                  warnings: [],
                  elapsedMs: 120000,
                  fallbackUsed: false,
                },
        });

        await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          name: "OlcxError",
          code: "COMPILE_FAILED",
          exitCode: 7,
          message: "Overleaf compile failed and fast/draft fallback also failed.",
          details: {
            normalFailure: expect.objectContaining({ message: expect.stringContaining("timed out") }),
            fallbackFailure: expect.objectContaining({ message: expect.stringContaining("Fast compile also failed") }),
            restoreStatus: "restored",
          },
        });
        expect(compileInputs).toHaveLength(2);
        expect(restoreCalls).toEqual([projectId]);
        await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { fastFallback: { enabled: true, attempts: 1, timeoutMs: 15000 } }
    );
  });

  it("retries fast fallback only up to the configured attempt count", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        let fastAttempts = 0;
        const { backend, compileInputs } = createRecordingCompileBackend({
          compileResult: (input) => {
            if (!input.fastMode) {
              return {
                status: "timeout",
                projectId: input.projectId,
                logs: [{ level: "error", message: "Compile timed out." }],
                warnings: [],
                elapsedMs: 120000,
                fallbackUsed: false,
              };
            }
            fastAttempts += 1;
            return fastAttempts === 1
              ? {
                  status: "failure",
                  projectId: input.projectId,
                  logs: [{ level: "error", message: "First fast attempt failed." }],
                  warnings: [],
                  elapsedMs: 15000,
                  fallbackUsed: true,
                }
              : {
                  status: "fallback-success",
                  projectId: input.projectId,
                  pdfBytes: new Uint8Array(defaultPdfBytes),
                  logs: [{ level: "info", message: "Second fast attempt succeeded." }],
                  warnings: ["Fast/draft fallback PDF: images may be omitted."],
                  elapsedMs: 14000,
                  fallbackUsed: true,
                };
          },
        });

        const result = await compileProject({ cwd: projectRoot, backend, env: {} });

        expect(result.status).toBe("fallback-success");
        expect(compileInputs.map((entry) => entry.fastMode)).toEqual([undefined, true, true]);
      },
      { fastFallback: { enabled: true, attempts: 2, timeoutMs: 15000 } }
    );
  });

  it("adds a warning when restore fails after fallback success", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend } = createRecordingCompileBackend({
          compileResult: (input) =>
            input.fastMode
              ? {
                  status: "fallback-success",
                  projectId: input.projectId,
                  pdfBytes: new Uint8Array(defaultPdfBytes),
                  logs: [{ level: "info", message: "Fast compile succeeded." }],
                  warnings: [],
                  elapsedMs: 15,
                  fallbackUsed: true,
                }
              : {
                  status: "timeout",
                  projectId: input.projectId,
                  logs: [{ level: "error", message: "Compile timed out." }],
                  warnings: [],
                  elapsedMs: 120000,
                  fallbackUsed: false,
                },
          restoreReject: async () => {
            throw createOlcxError({
              code: "COMPILE_FAILED",
              message: "Restore failed in fake backend.",
              hint: "Retry after checking settings.",
            });
          },
        });

        const result = await compileProject({ cwd: projectRoot, backend, env: {} });

        expect(result.status).toBe("fallback-success");
        expect(result.warnings.join("\n")).toMatch(/restore/i);
        expect(result.warnings.join("\n")).toContain("Restore failed in fake backend.");
      },
      { fastFallback: { enabled: true, attempts: 1, timeoutMs: 15000 } }
    );
  });

  it("reports missing project config before contacting the backend", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend, compileInputs } = createRecordingCompileBackend();

        await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          name: "OlcxError",
          code: "PROJECT_CONFIG_NOT_FOUND",
          exitCode: 3,
        });
        expect(compileInputs).toEqual([]);
      },
      { writeConfig: false }
    );
  });

  it("reports missing project auth before contacting the backend", async () => {
    await withTempCompileProject(
      async (projectRoot) => {
        const { backend, compileInputs } = createRecordingCompileBackend();

        await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
          name: "OlcxError",
          code: "PROJECT_AUTH_NOT_FOUND",
          exitCode: 4,
        });
        expect(compileInputs).toEqual([]);
      },
      { writeAuth: false }
    );
  });

  it("preserves specific PDF retrieval compile failures after a successful compile", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const retrievalError = createOlcxError({
        code: "COMPILE_FAILED",
        message: "Fake PDF retrieval failed.",
        hint: "Retry olcx compile.",
      });
      const { backend } = createRecordingCompileBackend({
        compileResult: (input) => ({
          status: "success",
          projectId: input.projectId,
          logs: [{ level: "info", message: "Compile succeeded but no inline PDF was returned." }],
          warnings: [],
          elapsedMs: 34,
          fallbackUsed: false,
        }),
        downloadPdfReject: async () => {
          throw retrievalError;
        },
      });

      await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
        name: "OlcxError",
        code: "COMPILE_FAILED",
        exitCode: 7,
        message: "Fake PDF retrieval failed.",
        hint: "Retry olcx compile.",
      });
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("preserves PDF retrieval backend network failures after a successful compile", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const { backend } = createRecordingCompileBackend({
        compileResult: (input) => ({
          status: "success",
          projectId: input.projectId,
          logs: [{ level: "info", message: "Compile succeeded but no inline PDF was returned." }],
          warnings: [],
          elapsedMs: 34,
          fallbackUsed: false,
        }),
        downloadPdfReject: async () => {
          throw createOlcxError({
            code: "BACKEND_NETWORK_ERROR",
            message: "Fake backend network failure during downloadPdf.",
            hint: "Retry after network access is restored.",
          });
        },
      });

      await expect(compileProject({ cwd: projectRoot, backend, env: {} })).rejects.toMatchObject({
        name: "OlcxError",
        code: "BACKEND_NETWORK_ERROR",
        exitCode: 5,
        message: "Fake backend network failure during downloadPdf.",
      });
      await expect(readFile(join(projectRoot, "build", "overleaf", "main.pdf"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("rejects unsafe caller-provided PDF output paths before contacting the backend", async () => {
    await withTempCompileProject(async (projectRoot) => {
      const { backend, compileInputs } = createRecordingCompileBackend();

      await expect(compileProject({ cwd: projectRoot, backend, env: {}, pdfPath: "../main.pdf" })).rejects.toMatchObject({
        name: "OlcxError",
        code: "USER_INPUT_ERROR",
        exitCode: 2,
      });
      expect(compileInputs).toEqual([]);
    });
  });
});

describe("compile implementation safety", () => {
  it("does not invoke local LaTeX tooling", async () => {
    const sourceFiles = [
      "../src/compile/compileFlow.ts",
      "../src/compile/pdfOutput.ts",
      "../src/commands/compile.ts",
      "../src/backend/overleafBackend.ts",
      "../src/backend/olcli/client.ts",
    ];
    const forbiddenLocalCompilePattern = /child_process|execFile|spawn|latexmk|pdflatex|xelatex|lualatex/;

    for (const sourceFile of sourceFiles) {
      const source = await readFile(new URL(sourceFile, import.meta.url), "utf8");

      expect(source, sourceFile).not.toMatch(forbiddenLocalCompilePattern);
    }
  });
});
