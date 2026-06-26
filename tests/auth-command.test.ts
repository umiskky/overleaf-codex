import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateProject,
  formatAuthSuccess,
  type AuthenticateProjectOptions,
} from "../src/commands/auth";
import { readProjectAuth } from "../src/auth/projectAuth";

const tempRoots: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olcx-auth-command-test-"));
  tempRoots.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixedNow(): Date {
  return new Date("2026-06-25T08:00:00.000Z");
}

function expectNoSensitiveOutput(output: string): void {
  expect(output).not.toContain("<fake-cli-session-cookie>");
  expect(output).not.toContain("<fake-env-session-cookie>");
  expect(output).not.toContain("<fake-interactive-session-cookie>");
  expect(output).not.toContain("writer@example.test");
  expect(output).not.toContain("0123456789abcdef01234567");
}

async function expectAuthFailure(options: AuthenticateProjectOptions): Promise<unknown> {
  try {
    await authenticateProject(options);
  } catch (error) {
    return error;
  }

  throw new Error("Expected authenticateProject to fail");
}

describe("auth command workflow", () => {
  it("writes auth from --cookie without leaking the cookie in formatted output", async () => {
    const root = await makeTempProject();
    const result = await authenticateProject({
      cwd: root,
      cookie: "<fake-cli-session-cookie>",
      account: "work",
      env: {},
      stdinIsTTY: false,
      now: fixedNow,
    });

    expect(await readProjectAuth(root)).toMatchObject({
      sessionCookie: "<fake-cli-session-cookie>",
      accountLabel: "work",
      updatedAt: "2026-06-25T08:00:00.000Z",
      source: "cli-option",
    });
    const output = formatAuthSuccess(result);
    expect(output).toContain("Stored project-local Overleaf auth.");
    expect(output).toContain("Auth file: .olcx/auth.local.json");
    expect(output).toContain("Account: work");
    expect(output).toContain("Source: cli-option");
    expect(output).toContain("Next: olcx status");
    expectNoSensitiveOutput(output);
  });

  it("writes auth from a named environment variable", async () => {
    const root = await makeTempProject();

    await authenticateProject({
      cwd: root,
      fromEnv: "OLCX_OVERLEAF_SESSION",
      env: { OLCX_OVERLEAF_SESSION: "<fake-env-session-cookie>" },
      stdinIsTTY: false,
      now: fixedNow,
    });

    await expect(readProjectAuth(root)).resolves.toMatchObject({
      sessionCookie: "<fake-env-session-cookie>",
      source: "env",
    });
  });

  it("uses an injected prompt in interactive mode without hanging tests", async () => {
    const root = await makeTempProject();
    let prompted = false;

    await authenticateProject({
      cwd: root,
      env: {},
      stdinIsTTY: true,
      promptCookie: async () => {
        prompted = true;
        return "<fake-interactive-session-cookie>";
      },
      now: fixedNow,
    });

    expect(prompted).toBe(true);
    await expect(readProjectAuth(root)).resolves.toMatchObject({
      sessionCookie: "<fake-interactive-session-cookie>",
      source: "interactive",
    });
  });

  it("fails fast in non-interactive mode when no auth source is provided", async () => {
    const root = await makeTempProject();
    const started = Date.now();

    await expect(authenticateProject({ cwd: root, env: {}, stdinIsTTY: false })).rejects.toMatchObject({
      code: "USER_INPUT_ERROR",
      exitCode: 2,
      hint: expect.stringContaining("olcx auth --from-env OLCX_OVERLEAF_SESSION"),
    });
    expect(Date.now() - started).toBeLessThan(500);
    await expect(readProjectAuth(root)).rejects.toMatchObject({ code: "PROJECT_AUTH_NOT_FOUND" });
  });

  it("rejects conflicting auth sources before writing auth", async () => {
    const root = await makeTempProject();

    const error = await expectAuthFailure({
      cwd: root,
      cookie: "<fake-cli-session-cookie>",
      fromEnv: "OLCX_OVERLEAF_SESSION",
      env: { OLCX_OVERLEAF_SESSION: "<fake-env-session-cookie>" },
      stdinIsTTY: false,
    });

    expect(error).toMatchObject({ code: "USER_INPUT_ERROR", exitCode: 2 });
    expectNoSensitiveOutput(String(error instanceof Error ? error.message : error));
    await expect(readProjectAuth(root)).rejects.toMatchObject({ code: "PROJECT_AUTH_NOT_FOUND" });
  });

  it("rejects conflicting auth source options even when the cookie value is blank", async () => {
    const root = await makeTempProject();

    await expect(
      authenticateProject({
        cwd: root,
        cookie: " ",
        fromEnv: "OLCX_OVERLEAF_SESSION",
        env: { OLCX_OVERLEAF_SESSION: "<fake-env-session-cookie>" },
        stdinIsTTY: false,
      })
    ).rejects.toMatchObject({ code: "USER_INPUT_ERROR", exitCode: 2 });
    await expect(readProjectAuth(root)).rejects.toMatchObject({ code: "PROJECT_AUTH_NOT_FOUND" });
  });

  it("rejects missing env auth without leaking env-shaped secrets", async () => {
    const root = await makeTempProject();

    await expect(
      authenticateProject({
        cwd: root,
        fromEnv: "OLCX_OVERLEAF_SESSION",
        env: { OLCX_OVERLEAF_SESSION: "" },
        stdinIsTTY: false,
      })
    ).rejects.toMatchObject({
      code: "USER_INPUT_ERROR",
      exitCode: 2,
      message: "Environment variable OLCX_OVERLEAF_SESSION is not set or is empty.",
      hint: expect.stringContaining("export OLCX_OVERLEAF_SESSION=<session-cookie>"),
    });
  });
});
