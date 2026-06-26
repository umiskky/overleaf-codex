import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProjectAuth } from "../src/auth/projectAuth";
import { createDefaultProjectConfig } from "../src/config/types";
import { writeProjectConfig } from "../src/config/projectConfig";
import { collectProjectStatus, formatProjectStatus } from "../src/diagnostics/status";
import { formatDoctorReport, runDoctorDiagnostics } from "../src/diagnostics/doctor";
import { EXIT_CODES } from "../src/errors";

const tempRoots: string[] = [];
const fakeProjectId = "0123456789abcdef01234567";

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olcx-status-doctor-test-"));
  tempRoots.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function expectNoSensitiveOutput(output: string): void {
  expect(output).not.toContain("<fake-cli-session-cookie>");
  expect(output).not.toContain("<fake-env-session-cookie>");
  expect(output).not.toContain("<fake-interactive-session-cookie>");
  expect(output).not.toContain("writer@example.test");
  expect(output).not.toContain(fakeProjectId);
}

async function writeHealthyConfig(root: string): Promise<void> {
  await writeProjectConfig(root, createDefaultProjectConfig({ projectId: fakeProjectId }));
}

async function writeHealthyAuth(root: string, accountLabel = "work"): Promise<void> {
  await writeProjectAuth(root, {
    schemaVersion: 1,
    accountLabel,
    sessionCookie: "<fake-env-session-cookie>",
    updatedAt: "2026-06-25T08:00:00.000Z",
    source: "env",
  });
}

async function writeRequiredGitignore(root: string): Promise<void> {
  await writeFile(
    join(root, ".gitignore"),
    [".olcx/auth.local.json", ".olcx/*.local.json", ".olcx/*.secret.json", ""].join("\n"),
    "utf8"
  );
}

describe("status diagnostics", () => {
  it("formats configured project and auth status without leaking secrets", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeHealthyAuth(root);

    const report = await collectProjectStatus({ cwd: root });
    const output = formatProjectStatus(report);

    expect(report).toMatchObject({
      config: {
        state: "configured",
        hasProjectId: true,
        pdfPath: "build/overleaf/main.pdf",
        overleafBaseUrl: "https://www.overleaf.com",
      },
      auth: {
        state: "present",
        accountLabel: "work",
        source: "env",
        updatedAt: "2026-06-25T08:00:00.000Z",
      },
      next: [],
    });
    expect(output).toContain("olcx status");
    expect(output).toContain("Project binding: configured");
    expect(output).toContain("Project id: present");
    expect(output).toContain("Overleaf endpoint: https://www.overleaf.com");
    expect(output).toContain("PDF output: build/overleaf/main.pdf");
    expect(output).toContain("Auth: present");
    expect(output).toContain("Account: work");
    expect(output).toContain("Auth source: env");
    expect(output).toContain("Auth updated: 2026-06-25T08:00:00.000Z");
    expect(output).not.toContain("Next:");
    expectNoSensitiveOutput(output);
  });

  it("reports missing config and auth with actionable next steps", async () => {
    const root = await makeTempProject();

    const report = await collectProjectStatus({ cwd: root });
    const output = formatProjectStatus(report);

    expect(report).toMatchObject({
      config: { state: "missing", hasProjectId: false, pdfPath: "unknown" },
      auth: { state: "missing", accountLabel: "unknown" },
      next: [
        "olcx init --project <overleaf-project-url-or-id>",
        "olcx auth --from-env OLCX_OVERLEAF_SESSION",
      ],
    });
    expect(output).toContain("Project binding: missing");
    expect(output).toContain("Project id: missing");
    expect(output).toContain("PDF output: unknown");
    expect(output).toContain("Auth: missing");
    expect(output).toContain("Account: unknown");
    expect(output).toContain("Next: olcx init --project <overleaf-project-url-or-id>");
    expect(output).toContain("Next: olcx auth --from-env OLCX_OVERLEAF_SESSION");
    expectNoSensitiveOutput(output);
  });

  it("reports invalid config without printing raw project ids", async () => {
    const root = await makeTempProject();
    await mkdir(join(root, ".olcx"), { recursive: true });
    await writeFile(join(root, ".olcx", "config.json"), "{not-json", "utf8");
    await writeHealthyAuth(root);

    const report = await collectProjectStatus({ cwd: root });
    const output = formatProjectStatus(report);

    expect(report.config.state).toBe("invalid");
    expect(output).toContain("Project binding: invalid");
    expect(output).toContain("Project id: missing");
    expect(output).toContain("Next: olcx init --project <overleaf-project-url-or-id>");
    expectNoSensitiveOutput(output);
  });

  it("redacts email-like account labels in status output", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeHealthyAuth(root, "writer@example.test");

    const output = formatProjectStatus(await collectProjectStatus({ cwd: root }));

    expect(output).toContain("Account: <redacted-account>");
    expectNoSensitiveOutput(output);
  });
});

describe("doctor diagnostics", () => {
  it("passes healthy local setup while leaving auth validity and endpoint probes offline", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeHealthyAuth(root);
    await writeRequiredGitignore(root);

    const report = await runDoctorDiagnostics({
      cwd: root,
      nodeVersion: "22.0.0",
      backendAvailable: true,
    });
    const output = formatDoctorReport(report);

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(output).toContain("olcx doctor");
    expect(output).toContain("[pass] Node.js");
    expect(output).toContain("[pass] Project root");
    expect(output).toContain("[pass] Config");
    expect(output).toContain("[pass] Overleaf endpoint: https://www.overleaf.com");
    expect(output).toContain("[pass] Auth file");
    expect(output).toContain("[pass] Backend module");
    expect(output).toContain("[pass] Git ignore");
    expect(output).toContain("[pass] PDF output");
    expect(output).toContain("[warn] Auth validity: not checked by offline doctor");
    expect(output).not.toContain("Error:");
    expectNoSensitiveOutput(output);
  });

  it("returns config errors for missing project config", async () => {
    const root = await makeTempProject();

    const report = await runDoctorDiagnostics({
      cwd: root,
      nodeVersion: "22.0.0",
      backendAvailable: true,
    });
    const output = formatDoctorReport(report);

    expect(report.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(output).toContain("[fail] Config: missing .olcx/config.json");
    expect(output).toContain("Error: olcx doctor found project configuration problems.");
    expect(output).toContain("Next: olcx init --project <overleaf-project-url-or-id>");
    expectNoSensitiveOutput(output);
  });

  it("returns auth errors for missing project auth after config is valid", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeRequiredGitignore(root);

    const report = await runDoctorDiagnostics({
      cwd: root,
      nodeVersion: "22.0.0",
      backendAvailable: true,
    });
    const output = formatDoctorReport(report);

    expect(report.exitCode).toBe(EXIT_CODES.AUTH_ERROR);
    expect(output).toContain("[fail] Auth file: missing .olcx/auth.local.json");
    expect(output).toContain("Error: olcx doctor found auth problems.");
    expect(output).toContain("Next: olcx auth --from-env OLCX_OVERLEAF_SESSION");
    expectNoSensitiveOutput(output);
  });

  it("returns auth errors for invalid project auth", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeRequiredGitignore(root);
    await mkdir(join(root, ".olcx"), { recursive: true });
    await writeFile(join(root, ".olcx", "auth.local.json"), "{not-json", "utf8");

    const report = await runDoctorDiagnostics({
      cwd: root,
      nodeVersion: "22.0.0",
      backendAvailable: true,
    });
    const output = formatDoctorReport(report);

    expect(report.exitCode).toBe(EXIT_CODES.AUTH_ERROR);
    expect(output).toContain("[fail] Auth file: invalid .olcx/auth.local.json");
    expect(output).toContain("Next: olcx auth --from-env OLCX_OVERLEAF_SESSION");
    expectNoSensitiveOutput(output);
  });

  it("returns internal errors for backend module failures before project-local fixes", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeHealthyAuth(root);
    await writeRequiredGitignore(root);

    const report = await runDoctorDiagnostics({
      cwd: root,
      nodeVersion: "22.0.0",
      backendAvailable: false,
    });
    const output = formatDoctorReport(report);

    expect(report.exitCode).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(output).toContain("[fail] Backend module");
    expect(output).toContain("Error: olcx doctor found local runtime problems.");
    expect(output).toContain("Next: npm run typecheck");
    expectNoSensitiveOutput(output);
  });

  it("flags missing local-secret gitignore rules as configuration problems", async () => {
    const root = await makeTempProject();
    await writeHealthyConfig(root);
    await writeHealthyAuth(root);
    await writeFile(join(root, ".gitignore"), ".olcx/auth.local.json\n", "utf8");

    const report = await runDoctorDiagnostics({
      cwd: root,
      nodeVersion: "22.0.0",
      backendAvailable: true,
    });
    const output = formatDoctorReport(report);

    expect(report.exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(output).toContain("[fail] Git ignore");
    expect(output).toContain(".olcx/*.local.json");
    expect(output).toContain("Next: add .olcx/auth.local.json, .olcx/*.local.json, and .olcx/*.secret.json to .gitignore");
    expectNoSensitiveOutput(output);
  });
});
