import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoRealE2eSensitiveOutput,
  createRealE2eLogger,
  formatRealE2eStep,
  loadRealE2eConfig,
  parseDotEnv,
  REQUIRED_REAL_E2E_KEYS,
  RealE2eBlockedError,
  resolveRealE2eConfig,
  runRealOverleafE2e,
  sanitizeRealE2eOutput,
} from "../../scripts/run-real-overleaf-e2e";
import { run, type CliIo, type CliRuntime } from "../../src/cli";
import { createFakeOverleafBackend } from "../../src/testing/fakeBackend";
import { EXIT_CODES, type ExitCode } from "../../src/errors";
import type { OverleafBackend } from "../../src/backend/types";

const fakeEnv = {
  OLCX_E2E_ENABLE_REAL: "1",
  OLCX_E2E_OVERLEAF_SESSION: "fake-session-value",
  OLCX_E2E_PROJECT_ID: "0123456789abcdef01234567",
  OLCX_E2E_ACCOUNT_LABEL: "writer@example.test",
  OLCX_E2E_PROJECT_URL: "https://www.overleaf.com/project/0123456789abcdef01234567",
};

describe("real Overleaf E2E env helpers", () => {
  it("parses dotenv comments, blank lines, unquoted values, and quoted values", () => {
    expect(
      parseDotEnv(`
# comment

PLAIN=value
SINGLE='single quoted value'
DOUBLE="double quoted value"
SPACED = "trimmed quoted value"
EMPTY=
`)
    ).toEqual({
      PLAIN: "value",
      SINGLE: "single quoted value",
      DOUBLE: "double quoted value",
      SPACED: "trimmed quoted value",
      EMPTY: "",
    });
  });

  it("lets process env override dotenv values", () => {
    const config = resolveRealE2eConfig({
      fileEnv: {
        OLCX_E2E_ENABLE_REAL: "0",
        OLCX_E2E_OVERLEAF_SESSION: "file-session",
        OLCX_E2E_PROJECT_ID: "file-project-id",
      },
      processEnv: fakeEnv,
    });

    expect(config).toMatchObject({
      ready: true,
      enabled: true,
      missing: [],
      sessionCookie: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
      projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
      projectUrl: fakeEnv.OLCX_E2E_PROJECT_URL,
      accountLabel: fakeEnv.OLCX_E2E_ACCOUNT_LABEL,
      projectRef: fakeEnv.OLCX_E2E_PROJECT_URL,
    });
  });

  it("loads fake dotenv values from the repo root without overriding process env", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "olcx-real-env-test-"));

    try {
      await writeFile(
        join(repoRoot, ".env.e2e.local"),
        [
          "OLCX_E2E_ENABLE_REAL=1",
          "OLCX_E2E_OVERLEAF_SESSION=file-session",
          "OLCX_E2E_PROJECT_ID=file-project-id",
        ].join("\n"),
        "utf8"
      );

      const config = await loadRealE2eConfig({
        repoRoot,
        processEnv: { OLCX_E2E_OVERLEAF_SESSION: "process-session" },
      });

      expect(config).toMatchObject({
        ready: true,
        sessionCookie: "process-session",
        projectId: "file-project-id",
        projectRef: "file-project-id",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("can force skip without reading a local real E2E env file", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "olcx-real-env-ignore-test-"));

    try {
      await writeFile(
        join(repoRoot, ".env.e2e.local"),
        [
          "OLCX_E2E_ENABLE_REAL=1",
          "OLCX_E2E_OVERLEAF_SESSION=fake-must-not-be-loaded",
          "OLCX_E2E_PROJECT_ID=0123456789abcdef01234567",
        ].join("\n"),
        "utf8"
      );

      const config = await loadRealE2eConfig({
        repoRoot,
        processEnv: {
          OLCX_E2E_IGNORE_LOCAL_ENV: "1",
          OLCX_E2E_ENABLE_REAL: "0",
        },
      });

      expect(config.ready).toBe(false);
      expect(config.enabled).toBe(false);
      expect(config.missing).toEqual(["OLCX_E2E_ENABLE_REAL", "OLCX_E2E_OVERLEAF_SESSION", "OLCX_E2E_PROJECT_ID"]);
      expect(config.sessionCookie).toBeUndefined();
      expect(config.projectId).toBeUndefined();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("reports missing gated config by variable name only", () => {
    const config = resolveRealE2eConfig({ fileEnv: {}, processEnv: {} });

    expect(config.ready).toBe(false);
    expect(config.enabled).toBe(false);
    expect(config.missing).toEqual([...REQUIRED_REAL_E2E_KEYS]);
    expect(config.skipMessage).toBe(
      "skipped: set OLCX_E2E_ENABLE_REAL=1, OLCX_E2E_OVERLEAF_SESSION, OLCX_E2E_PROJECT_ID or .env.e2e.local"
    );
  });

  it("falls back to the required project id when the optional project URL is not an Overleaf project URL", () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        ...fakeEnv,
        OLCX_E2E_PROJECT_URL: "<optional-project-url-placeholder>",
      },
    });

    expect(config.ready).toBe(true);
    expect(config.projectUrl).toBeUndefined();
    expect(config.projectRef).toBe(fakeEnv.OLCX_E2E_PROJECT_ID);
  });

  it("uses cn Overleaf as the default real E2E backend base URL and accepts explicit overrides", () => {
    expect(resolveRealE2eConfig({ fileEnv: {}, processEnv: fakeEnv }).baseUrl).toBe("https://cn.overleaf.com");

    expect(
      resolveRealE2eConfig({
        fileEnv: {},
        processEnv: {
          ...fakeEnv,
          OLCX_E2E_OVERLEAF_BASE_URL: "https://www.overleaf.com",
        },
      }).baseUrl
    ).toBe("https://www.overleaf.com");
  });

  it("sanitizes configured fake sensitive values before output or errors", () => {
    const config = resolveRealE2eConfig({ fileEnv: {}, processEnv: fakeEnv });
    const output = [
      `cookie ${fakeEnv.OLCX_E2E_OVERLEAF_SESSION}`,
      `project ${fakeEnv.OLCX_E2E_PROJECT_ID}`,
      `url ${fakeEnv.OLCX_E2E_PROJECT_URL}`,
      `account ${fakeEnv.OLCX_E2E_ACCOUNT_LABEL}`,
    ].join("\n");

    const sanitized = sanitizeRealE2eOutput(output, config);

    for (const value of Object.values(fakeEnv).filter(Boolean)) {
      expect(sanitized).not.toContain(value);
    }
    expect(sanitized).toContain("<redacted-real-e2e-value>");
    expect(() => assertNoRealE2eSensitiveOutput(sanitized, config)).not.toThrow();

    try {
      assertNoRealE2eSensitiveOutput(output, config);
      throw new Error("expected leak assertion to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Output leaked a configured real E2E sensitive value.");
      for (const value of Object.values(fakeEnv).filter(Boolean)) {
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it("formats real E2E status lines with step names and variable-name-only blockers", () => {
    expect(formatRealE2eStep("auth validation", "ok")).toBe("[real-e2e] auth validation: ok\n");
    expect(formatRealE2eStep("blocked", "OLCX_E2E_OVERLEAF_SESSION")).toBe(
      "[real-e2e] blocked: OLCX_E2E_OVERLEAF_SESSION\n"
    );
    expect(
      formatRealE2eStep(
        "skipped",
        "set OLCX_E2E_ENABLE_REAL=1, OLCX_E2E_OVERLEAF_SESSION, OLCX_E2E_PROJECT_ID or .env.e2e.local"
      )
    ).toBe(
      "[real-e2e] skipped: set OLCX_E2E_ENABLE_REAL=1, OLCX_E2E_OVERLEAF_SESSION, OLCX_E2E_PROJECT_ID or .env.e2e.local\n"
    );
  });

  it("sanitizes output before writing real E2E log lines", () => {
    const config = resolveRealE2eConfig({ fileEnv: {}, processEnv: fakeEnv });
    const written: string[] = [];
    const logger = createRealE2eLogger({
      config,
      writeOut: (value) => written.push(value),
    });

    logger.logLine(
      formatRealE2eStep("upload verification", `ok ${fakeEnv.OLCX_E2E_OVERLEAF_SESSION} ${fakeEnv.OLCX_E2E_PROJECT_ID}`)
    );

    expect(written).toHaveLength(1);
    expect(logger.outputBlocks).toEqual(written);
    expect(written[0]).toContain("[real-e2e] upload verification: ok");
    expect(written[0]).toContain("<redacted-real-e2e-value>");
    expect(written[0]).not.toContain(fakeEnv.OLCX_E2E_OVERLEAF_SESSION);
    expect(written[0]).not.toContain(fakeEnv.OLCX_E2E_PROJECT_ID);
  });

  it("runs the E2E workflow through the CLI without placing the session in argv", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "utf8"),
      Buffer.alloc(128, "x"),
      Buffer.from("\n%%EOF\n", "utf8"),
    ]);
    const backend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
          pdfBytes,
          fastPdfBytes: pdfBytes,
        },
      ],
    });
    const argvLog: string[][] = [];
    const written: string[] = [];

    const result = await runRealOverleafE2e({
      repoRoot: process.cwd(),
      config,
      backend,
      writeOut: (value) => written.push(value),
      runCli: async (argv: string[], io: CliIo, runtime: CliRuntime): Promise<ExitCode> => {
        argvLog.push([...argv]);
        return run(argv, io, runtime);
      },
    });

    const output = result.outputBlocks.join("");
    expect(result.outputBlocks).toEqual(written);
    expect(output).toContain("[real-e2e] auth validation: ok");
    expect(output).toContain("[real-e2e] init: ok");
    expect(output).toContain("[real-e2e] auth file: ok");
    expect(output).toContain("[real-e2e] initial sync: ok");
    expect(output).toContain("[real-e2e] upload verification: ok");
    expect(output).toContain("[real-e2e] compile/pdf: ok");
    expect(output).toContain(
      "[real-e2e] fallback: documented limitation - normal real Overleaf compile did not time out; fake backend coverage remains required"
    );
    expect(output).not.toContain(fakeEnv.OLCX_E2E_OVERLEAF_SESSION);
    expect(output).not.toContain(fakeEnv.OLCX_E2E_PROJECT_ID);
    expect(argvLog.flat()).not.toContain(fakeEnv.OLCX_E2E_OVERLEAF_SESSION);
    expect(argvLog).toContainEqual(["node", "olcx", "auth", "--from-env", "OLCX_E2E_OVERLEAF_SESSION"]);
  }, 20_000);

  it("accepts natural normal compile timeout when fast fallback produces the PDF", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "utf8"),
      Buffer.alloc(128, "x"),
      Buffer.from("\n%%EOF\n", "utf8"),
    ]);
    const backend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
          pdfBytes,
          fastPdfBytes: pdfBytes,
          compileStatus: "timeout",
          fastCompileStatus: "success",
        },
      ],
    });
    const argvLog: string[][] = [];

    const result = await runRealOverleafE2e({
      repoRoot: process.cwd(),
      config,
      backend,
      writeOut: () => {},
      runCli: async (argv: string[], io: CliIo, runtime: CliRuntime): Promise<ExitCode> => {
        argvLog.push([...argv]);
        return run(argv, io, runtime);
      },
    });

    const output = result.outputBlocks.join("");
    expect(output).toContain("[real-e2e] compile/pdf: ok");
    expect(output).toContain("[real-e2e] fallback: ok");
    expect(argvLog.some((argv) => argv.includes("compile") && argv.includes("--disable-fast-fallback"))).toBe(false);
  }, 20_000);

  it("scopes sync to generated sentinel files without downloading existing project files", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "utf8"),
      Buffer.alloc(128, "x"),
      Buffer.from("\n%%EOF\n", "utf8"),
    ]);
    const baseBackend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [
            { path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" },
            { path: "sections/background.tex", text: "Existing remote project content\n" },
          ],
          pdfBytes,
          fastPdfBytes: pdfBytes,
        },
      ],
    });
    const existingDownloads: string[] = [];
    const guardedBackend: OverleafBackend = {
      validateAuth: (input) => baseBackend.validateAuth(input),
      listFiles: (input) => baseBackend.listFiles(input),
      downloadFile: async (input) => {
        if (!input.path.startsWith("olcx-e2e-")) {
          existingDownloads.push(input.path);
          throw new Error("existing remote project files should not be downloaded by the real E2E runner");
        }
        return baseBackend.downloadFile(input);
      },
      uploadFile: (input) => baseBackend.uploadFile(input),
      deleteFile: (input) => baseBackend.deleteFile(input),
      compile: (input) => baseBackend.compile(input),
      beginFastCompile: (input) => baseBackend.beginFastCompile?.(input) ?? Promise.reject(new Error("missing fallback")),
      downloadPdf: (input) => baseBackend.downloadPdf(input),
    };

    const result = await runRealOverleafE2e({
      repoRoot: process.cwd(),
      config,
      backend: guardedBackend,
      writeOut: () => {},
    });

    expect(result.outputBlocks.join("")).toContain("[real-e2e] upload verification: ok");
    expect(existingDownloads).toEqual([]);
  }, 20_000);

  it("retries generated sentinel verification when the remote download is briefly stale", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "utf8"),
      Buffer.alloc(128, "x"),
      Buffer.from("\n%%EOF\n", "utf8"),
    ]);
    const baseBackend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
          pdfBytes,
          fastPdfBytes: pdfBytes,
        },
      ],
    });
    let sentinelDownloadAttempts = 0;
    const eventuallyConsistentBackend: OverleafBackend = {
      validateAuth: (input) => baseBackend.validateAuth(input),
      listFiles: (input) => baseBackend.listFiles(input),
      downloadFile: async (input) => {
        if (input.path.startsWith("olcx-e2e-") && sentinelDownloadAttempts === 0) {
          sentinelDownloadAttempts += 1;
          throw new Error("remote sentinel is not visible yet");
        }
        if (input.path.startsWith("olcx-e2e-")) {
          sentinelDownloadAttempts += 1;
        }
        return baseBackend.downloadFile(input);
      },
      uploadFile: (input) => baseBackend.uploadFile(input),
      deleteFile: (input) => baseBackend.deleteFile(input),
      compile: (input) => baseBackend.compile(input),
      beginFastCompile: (input) => baseBackend.beginFastCompile?.(input) ?? Promise.reject(new Error("missing fallback")),
      downloadPdf: (input) => baseBackend.downloadPdf(input),
    };

    const result = await runRealOverleafE2e({
      repoRoot: process.cwd(),
      config,
      backend: eventuallyConsistentBackend,
      writeOut: () => {},
      verificationRetryDelayMs: 1,
    });

    expect(result.outputBlocks.join("")).toContain("[real-e2e] upload verification: ok");
    expect(sentinelDownloadAttempts).toBeGreaterThan(1);
  }, 20_000);

  it("uses a root-level generated sentinel path for real adapter compatibility", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "utf8"),
      Buffer.alloc(128, "x"),
      Buffer.from("\n%%EOF\n", "utf8"),
    ]);
    const baseBackend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
          pdfBytes,
          fastPdfBytes: pdfBytes,
        },
      ],
    });
    const uploadedPaths: string[] = [];
    const rootOnlyBackend: OverleafBackend = {
      validateAuth: (input) => baseBackend.validateAuth(input),
      listFiles: (input) => baseBackend.listFiles(input),
      downloadFile: (input) => baseBackend.downloadFile(input),
      uploadFile: (input) => {
        uploadedPaths.push(input.path);
        if (input.path.includes("/")) {
          throw new Error("real adapter root upload does not create nested paths");
        }
        return baseBackend.uploadFile(input);
      },
      deleteFile: (input) => baseBackend.deleteFile(input),
      compile: (input) => baseBackend.compile(input),
      beginFastCompile: (input) => baseBackend.beginFastCompile?.(input) ?? Promise.reject(new Error("missing fallback")),
      downloadPdf: (input) => baseBackend.downloadPdf(input),
    };

    const result = await runRealOverleafE2e({
      repoRoot: process.cwd(),
      config,
      backend: rootOnlyBackend,
      writeOut: () => {},
    });

    expect(result.outputBlocks.join("")).toContain("[real-e2e] upload verification: ok");
    expect(uploadedPaths).not.toHaveLength(0);
    expect(uploadedPaths.every((path) => !path.includes("/"))).toBe(true);
    expect(uploadedPaths.every((path) => !path.toLowerCase().endsWith(".tex"))).toBe(true);
  }, 20_000);

  it("blocks with a sanitized category when backend validation exceeds the step timeout", async () => {
    const config = resolveRealE2eConfig({ fileEnv: {}, processEnv: fakeEnv });
    const backend: OverleafBackend = {
      validateAuth: async () => new Promise(() => {}),
      listFiles: async () => [],
      downloadFile: async () => new Uint8Array(),
      uploadFile: async () => ({ path: "unused.tex", kind: "file" as const }),
      deleteFile: async () => {},
      compile: async () => {
        throw new Error("compile is not reached");
      },
      downloadPdf: async () => new Uint8Array(),
    };
    const written: string[] = [];

    await expect(
      runRealOverleafE2e({
        repoRoot: process.cwd(),
        config,
        backend,
        writeOut: (value) => written.push(value),
        stepTimeoutMs: 5,
      })
    ).rejects.toEqual(new RealE2eBlockedError("network/backend availability"));

    expect(written.join("")).not.toContain(fakeEnv.OLCX_E2E_OVERLEAF_SESSION);
    expect(written.join("")).not.toContain(fakeEnv.OLCX_E2E_PROJECT_ID);
  });

  it("blocks with a sanitized category when a CLI step exceeds the step timeout", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const backend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
        },
      ],
    });
    const written: string[] = [];

    await expect(
      runRealOverleafE2e({
        repoRoot: process.cwd(),
        config,
        backend,
        writeOut: (value) => written.push(value),
        stepTimeoutMs: 100,
        runCli: async (argv: string[], io: CliIo, runtime: CliRuntime): Promise<ExitCode> => {
          if (argv.includes("sync")) {
            return new Promise(() => {});
          }
          return run(argv, io, runtime);
        },
      })
    ).rejects.toEqual(new RealE2eBlockedError("network/backend availability"));

    const output = written.join("");
    expect(output).toContain("[real-e2e] auth validation: ok");
    expect(output).toContain("[real-e2e] init: ok");
    expect(output).toContain("[real-e2e] auth file: ok");
    expect(output).not.toContain(fakeEnv.OLCX_E2E_OVERLEAF_SESSION);
    expect(output).not.toContain(fakeEnv.OLCX_E2E_PROJECT_ID);
  });

  it("blocks with network/backend availability when sentinel verification never becomes visible", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const pdfBytes = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "utf8"),
      Buffer.alloc(128, "x"),
      Buffer.from("\n%%EOF\n", "utf8"),
    ]);
    const baseBackend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
          pdfBytes,
          fastPdfBytes: pdfBytes,
        },
      ],
    });
    const neverVisibleBackend: OverleafBackend = {
      validateAuth: (input) => baseBackend.validateAuth(input),
      listFiles: (input) => baseBackend.listFiles(input),
      downloadFile: async (input) => {
        if (input.path.startsWith("olcx-e2e-")) {
          throw new Error("remote sentinel is not visible");
        }
        return baseBackend.downloadFile(input);
      },
      uploadFile: (input) => baseBackend.uploadFile(input),
      deleteFile: (input) => baseBackend.deleteFile(input),
      compile: (input) => baseBackend.compile(input),
      beginFastCompile: (input) => baseBackend.beginFastCompile?.(input) ?? Promise.reject(new Error("missing fallback")),
      downloadPdf: (input) => baseBackend.downloadPdf(input),
    };

    await expect(
      runRealOverleafE2e({
        repoRoot: process.cwd(),
        config,
        backend: neverVisibleBackend,
        writeOut: () => {},
        verificationTimeoutMs: 5,
        verificationRetryDelayMs: 1,
      })
    ).rejects.toEqual(new RealE2eBlockedError("network/backend availability"));
  });

  it("removes the local temp repo before best-effort remote cleanup can hang after a blocked compile", async () => {
    const config = resolveRealE2eConfig({
      fileEnv: {},
      processEnv: {
        OLCX_E2E_ENABLE_REAL: "1",
        OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
        OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
      },
    });
    const beforeTempDirs = await listRealE2eTempDirs();
    const baseBackend = createFakeOverleafBackend({
      projects: [
        {
          projectId: fakeEnv.OLCX_E2E_PROJECT_ID,
          files: [{ path: "main.tex", text: "\\documentclass{article}\\begin{document}Fake\\end{document}\n" }],
        },
      ],
    });
    let markDeleteStarted: () => void = () => {};
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    const backend: OverleafBackend = {
      validateAuth: (input) => baseBackend.validateAuth(input),
      listFiles: (input) => baseBackend.listFiles(input),
      downloadFile: (input) => baseBackend.downloadFile(input),
      uploadFile: (input) => baseBackend.uploadFile(input),
      deleteFile: async () => {
        markDeleteStarted();
        return new Promise(() => {});
      },
      compile: (input) => baseBackend.compile(input),
      beginFastCompile: (input) => baseBackend.beginFastCompile?.(input) ?? Promise.reject(new Error("missing fallback")),
      downloadPdf: (input) => baseBackend.downloadPdf(input),
    };

    const runPromise = runRealOverleafE2e({
      repoRoot: process.cwd(),
      config,
      backend,
      writeOut: () => {},
      stepTimeoutMs: 75,
      runCli: async (argv: string[], io: CliIo, runtime: CliRuntime): Promise<ExitCode> => {
        if (argv.includes("compile") && !argv.includes("--fast-fallback-attempts")) {
          return EXIT_CODES.COMPILE_FAILED;
        }
        return run(argv, io, runtime);
      },
    });
    const runResult = runPromise.then(
      () => undefined,
      (error: unknown) => error
    );

    try {
      await deleteStarted;
      const afterTempDirs = await listRealE2eTempDirs();
      const createdTempDirs = [...afterTempDirs].filter((path) => !beforeTempDirs.has(path));
      const authFilesStillPresent: string[] = [];
      for (const tempDir of createdTempDirs) {
        if (await fileExists(join(tempDir, ".olcx", "auth.local.json"))) {
          authFilesStillPresent.push(tempDir);
        }
      }

      expect(authFilesStillPresent).toEqual([]);
      expect(await runResult).toEqual(
        new RealE2eBlockedError("Provided Overleaf E2E project must compile successfully.")
      );
    } finally {
      await runResult;
      const afterTempDirs = await listRealE2eTempDirs();
      await Promise.all(
        [...afterTempDirs]
          .filter((path) => !beforeTempDirs.has(path))
          .map((path) => rm(path, { recursive: true, force: true }))
      );
    }
  }, 20_000);

  it("manual entrypoint exits after reporting a sanitized blocker", async () => {
    const runnerModule = (await import("../../scripts/run-real-overleaf-e2e")) as Record<string, unknown>;
    expect(typeof runnerModule.runManualRealE2eEntrypoint).toBe("function");
    const runManualRealE2eEntrypoint = runnerModule.runManualRealE2eEntrypoint as (input: {
      repoRoot: string;
      processEnv: Record<string, string | undefined>;
      writeOut: (value: string) => void;
      runRealOverleafE2e: () => Promise<unknown>;
      exit: (code: number) => void;
    }) => Promise<void>;
    const repoRoot = await mkdtemp(join(tmpdir(), "olcx-real-entrypoint-test-"));
    const written: string[] = [];
    const exitCodes: number[] = [];

    try {
      await runManualRealE2eEntrypoint({
        repoRoot,
        processEnv: {
          OLCX_E2E_ENABLE_REAL: "1",
          OLCX_E2E_OVERLEAF_SESSION: fakeEnv.OLCX_E2E_OVERLEAF_SESSION,
          OLCX_E2E_PROJECT_ID: fakeEnv.OLCX_E2E_PROJECT_ID,
        },
        writeOut: (value) => written.push(value),
        runRealOverleafE2e: async () => {
          throw new RealE2eBlockedError("Provided Overleaf E2E project must compile successfully.");
        },
        exit: (code) => {
          exitCodes.push(code);
        },
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }

    const output = written.join("");
    expect(exitCodes).toEqual([1]);
    expect(output).toContain("[real-e2e] blocked: Provided Overleaf E2E project must compile successfully.");
    expect(output).not.toContain(fakeEnv.OLCX_E2E_OVERLEAF_SESSION);
    expect(output).not.toContain(fakeEnv.OLCX_E2E_PROJECT_ID);
  });
});

async function listRealE2eTempDirs(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir()))
      .filter((entry) => entry.startsWith("olcx-real-e2e-"))
      .map((entry) => join(tmpdir(), entry))
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
