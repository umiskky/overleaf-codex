import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAuth } from "../src/auth/types";
import { writeProjectAuth } from "../src/auth/projectAuth";
import { writeProjectConfig } from "../src/config/projectConfig";
import { createDefaultProjectConfig } from "../src/config/types";
import { pullProject } from "../src/commands/pull";
import { sha256Hex } from "../src/sync/plan";
import { getConflictReportPath, readSyncState, writeSyncState } from "../src/sync/state";
import type { SyncStateFile } from "../src/sync/types";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";
import type { OverleafBackend } from "../src/backend/types";

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
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-pull-flow-test-"));
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

function baseState(files: Record<string, string>): SyncStateFile {
  return {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    updatedAt: now,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        {
          path,
          contentHash: sha256Hex(content),
          size: Buffer.byteLength(content),
          localModifiedAt: now,
          remoteModifiedAt: now,
          remoteId: `remote-${path}`,
          remoteRevision: `rev-${path}`,
          syncedAt: now,
        },
      ])
    ),
  };
}

describe("pull workflow", () => {
  it("reset mode replaces local files with the remote project", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      await writeFixture(projectRoot, "drafts/local.tex", "local only\n");
      const backend = createFakeOverleafBackend({
        projects: [
          {
            projectId,
            files: [
              { path: "main.tex", text: "remote main\n" },
              { path: "refs.bib", text: "@article{remote}\n" },
            ],
          },
        ],
      });

      const result = await pullProject({
        cwd: projectRoot,
        backend,
        env: {},
        mode: "reset",
        now: () => new Date(later),
      });

      expect(result.output).toContain("olcx pull --mode reset");
      expect(result.output).toContain("Plan: download 2, delete local 1");
      expect(result.output).toContain("olcx pull summary");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("remote main\n");
      await expect(readFile(join(projectRoot, "refs.bib"), "utf8")).resolves.toBe("@article{remote}\n");
      await expect(readFile(join(projectRoot, "drafts", "local.tex"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const state = await readSyncState(projectRoot);
      expect(Object.keys(state.files).sort()).toEqual(["main.tex", "refs.bib"]);
    });
  });

  it("rebase mode pulls remote changes while keeping local edits", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      await writeFixture(projectRoot, "notes.tex", "local notes\n");
      await writeSyncState(projectRoot, baseState({ "main.tex": "base\n" }));
      const backend = createFakeOverleafBackend({
        projects: [
          {
            projectId,
            files: [
              { path: "main.tex", text: "base\n", revision: "rev-main.tex" },
              { path: "refs.bib", text: "@article{remote}\n" },
            ],
          },
        ],
      });

      const result = await pullProject({
        cwd: projectRoot,
        backend,
        env: {},
        mode: "rebase",
        now: () => new Date(later),
      });

      expect(result.output).toContain("Kept local changes:\n- main.tex\n- notes.tex");
      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("local change\n");
      await expect(readFile(join(projectRoot, "notes.tex"), "utf8")).resolves.toBe("local notes\n");
      await expect(readFile(join(projectRoot, "refs.bib"), "utf8")).resolves.toBe("@article{remote}\n");
      const state = await readSyncState(projectRoot);
      expect(state.files["main.tex"].contentHash).toBe(sha256Hex("base\n"));
      expect(state.files["refs.bib"].contentHash).toBe(sha256Hex("@article{remote}\n"));
      expect(state.files["notes.tex"]).toBeUndefined();
    });
  });

  it("rebase dry-run does not download unchanged remote files for hash metadata", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "base\n");
      await writeSyncState(projectRoot, baseState({ "main.tex": "base\n" }));
      let downloads = 0;
      const backend: OverleafBackend = {
        validateAuth: async () => ({ authenticated: true }),
        listFiles: async () => [
          {
            path: "main.tex",
            kind: "file",
            remoteId: "remote-main.tex",
            revision: "rev-main.tex",
            modifiedAt: now,
            size: Buffer.byteLength("base\n"),
          },
        ],
        downloadFile: async () => {
          downloads += 1;
          throw new Error("rebase dry-run should not download unchanged remote files");
        },
        uploadFile: async () => {
          throw new Error("not used");
        },
        deleteFile: async () => {
          throw new Error("not used");
        },
        compile: async () => {
          throw new Error("not used");
        },
        downloadPdf: async () => {
          throw new Error("not used");
        },
      };

      const result = await pullProject({
        cwd: projectRoot,
        backend,
        env: {},
        mode: "rebase",
        dryRun: true,
        now: () => new Date(later),
      });

      expect(downloads).toBe(0);
      expect(result.plan.summary).toMatchObject({ download: 0, conflict: 0 });
      expect(result.output).toContain("No files changed.");
    });
  });

  it("rebase mode stops when local and remote changed the same file", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local change\n");
      const previous = baseState({ "main.tex": "base\n" });
      await writeSyncState(projectRoot, previous);
      const backend = createFakeOverleafBackend({
        projects: [{ projectId, files: [{ path: "main.tex", text: "remote change\n" }] }],
      });

      await expect(
        pullProject({
          cwd: projectRoot,
          backend,
          env: {},
          mode: "rebase",
          now: () => new Date(later),
        })
      ).rejects.toMatchObject({
        code: "SYNC_CONFLICT",
        details: { conflicts: [{ path: "main.tex", reason: "both-modified" }] },
      });

      await expect(readFile(join(projectRoot, "main.tex"), "utf8")).resolves.toBe("local change\n");
      await expect(readSyncState(projectRoot)).resolves.toEqual(previous);
      await expect(readFile(getConflictReportPath(projectRoot), "utf8")).resolves.toContain("both-modified");
    });
  });
});
