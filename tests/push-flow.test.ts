import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAuth } from "../src/auth/types";
import { writeProjectAuth } from "../src/auth/projectAuth";
import { writeProjectConfig } from "../src/config/projectConfig";
import { createDefaultProjectConfig } from "../src/config/types";
import { pushProject } from "../src/commands/push";
import { sha256Hex } from "../src/sync/plan";
import { readSyncState } from "../src/sync/state";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";

const projectId = "<overleaf-project-id>";
const now = "2026-06-25T08:00:00.000Z";
const later = "2026-06-25T09:00:00.000Z";
const auth: ProjectAuth = {
  schemaVersion: 1,
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: now,
  source: "env",
};

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-push-flow-test-"));
  try {
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeProjectConfig(
      projectRoot,
      createDefaultProjectConfig({
        projectId,
        sync: { ignore: [".olcx/config.json"], retry: { maxAttempts: 2, delayMs: 0 } },
      })
    );
    await writeProjectAuth(projectRoot, auth);
    return await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function writeFixture(projectRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = join(projectRoot, ...path.split("/"));
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function readRemoteText(backend: ReturnType<typeof createFakeOverleafBackend>, path: string): Promise<string> {
  const bytes = await backend.downloadFile({ projectId, auth, path });
  return Buffer.from(bytes).toString("utf8");
}

describe("push workflow", () => {
  it("uploads all local files and prunes remote-only files by default", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      await writeFixture(projectRoot, "refs.bib", "@article{local}\n");
      const backend = createFakeOverleafBackend({
        projects: [
          {
            projectId,
            files: [
              { path: "main.tex", text: "old remote\n" },
              { path: "remote-only.tex", text: "remove me\n" },
            ],
          },
        ],
      });

      const result = await pushProject({
        cwd: projectRoot,
        backend,
        env: {},
        now: () => new Date(later),
      });

      expect(result.output).toContain("olcx push");
      expect(result.output).toContain("Plan: upload 2, delete remote 1");
      expect(result.output).toContain("olcx push summary");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("local main\n");
      await expect(readRemoteText(backend, "refs.bib")).resolves.toBe("@article{local}\n");
      await expect(readRemoteText(backend, "remote-only.tex")).rejects.toMatchObject({ code: "BACKEND_PROTOCOL_ERROR" });
      const state = await readSyncState(projectRoot);
      expect(Object.keys(state.files).sort()).toEqual(["main.tex", "refs.bib"]);
      expect(state.files["main.tex"].contentHash).toBe(sha256Hex("local main\n"));
    });
  });

  it("keeps remote-only files when prune is disabled", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "remote-only.tex", text: "keep me\n" }] }],
      });

      const result = await pushProject({
        cwd: projectRoot,
        backend,
        env: {},
        prune: false,
        now: () => new Date(later),
      });

      expect(result.output).toContain("Plan: upload 1, delete remote 0");
      await expect(readRemoteText(backend, "remote-only.tex")).resolves.toBe("keep me\n");
      await expect(readRemoteText(backend, "main.tex")).resolves.toBe("local main\n");
    });
  });
});
