import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectAuth } from "../src/auth/types";
import type { BackendFileInput, BackendProjectInput, OverleafBackend, RemoteFile } from "../src/backend/types";
import { sha256Hex } from "../src/sync/plan";
import { createLocalSnapshot, createRemoteSnapshot } from "../src/sync/snapshot";
import { createFakeOverleafBackend } from "../src/testing/fakeBackend";

const projectId = "<overleaf-project-id>";
const auth: ProjectAuth = {
  schemaVersion: 1,
  sessionCookie: "<fake-env-session-cookie>",
  updatedAt: "2026-06-25T08:00:00.000Z",
  source: "env",
};

async function withTempProject<T>(fn: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "olcx-sync-snapshot-test-"));
  try {
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

describe("local sync snapshots", () => {
  it("hashes regular files and returns sorted repository-relative POSIX paths", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "zeta.tex", "zeta\n");
      await writeFixture(projectRoot, "sections/intro.tex", "intro\n");
      await writeFixture(projectRoot, "main.tex", "local main\n");

      const snapshot = await createLocalSnapshot({ projectRoot });

      expect(snapshot.map((file) => file.path)).toEqual(["main.tex", "sections/intro.tex", "zeta.tex"]);
      expect(snapshot).toEqual([
        expect.objectContaining({
          path: "main.tex",
          exists: true,
          contentHash: sha256Hex("local main\n"),
          size: Buffer.byteLength("local main\n"),
          modifiedAt: expect.any(String),
        }),
        expect.objectContaining({
          path: "sections/intro.tex",
          exists: true,
          contentHash: sha256Hex("intro\n"),
          size: Buffer.byteLength("intro\n"),
          modifiedAt: expect.any(String),
        }),
        expect.objectContaining({
          path: "zeta.tex",
          exists: true,
          contentHash: sha256Hex("zeta\n"),
          size: Buffer.byteLength("zeta\n"),
          modifiedAt: expect.any(String),
        }),
      ]);
    });
  });

  it("excludes built-in ignored paths, user ignores, symlinks, and non-regular files", async () => {
    await withTempProject(async (projectRoot) => {
      await writeFixture(projectRoot, "main.tex", "local main\n");
      await writeFixture(projectRoot, ".git/config", "ignored\n");
      await writeFixture(projectRoot, "node_modules/pkg/index.js", "ignored\n");
      await writeFixture(projectRoot, ".olcx/auth.local.json", "ignored\n");
      await writeFixture(projectRoot, ".olcx/cache.local.json", "ignored\n");
      await writeFixture(projectRoot, ".olcx/cache.secret.json", "ignored\n");
      await writeFixture(projectRoot, ".olcx/state/sync.json", "ignored\n");
      await writeFixture(projectRoot, "build/overleaf/main.pdf", "ignored\n");
      await writeFixture(projectRoot, "main.aux", "ignored\n");
      await writeFixture(projectRoot, "main.log", "ignored\n");
      await writeFixture(projectRoot, "main.synctex.gz", "ignored\n");
      await writeFixture(projectRoot, "drafts/private.tex", "ignored\n");
      await writeFixture(projectRoot, "linked-target.tex", "linked target\n");
      await symlink(join(projectRoot, "linked-target.tex"), join(projectRoot, "linked.tex"));
      await mkdir(join(projectRoot, "empty-dir"), { recursive: true });

      const snapshot = await createLocalSnapshot({
        projectRoot,
        userIgnorePatterns: ["drafts/**", "linked-target.tex"],
      });

      expect(snapshot.map((file) => file.path)).toEqual(["main.tex"]);
      expect(snapshot[0]).toMatchObject({
        path: "main.tex",
        contentHash: sha256Hex("local main\n"),
      });
    });
  });
});

describe("remote sync snapshots", () => {
  it("downloads and hashes remote files when listings have no content hash", async () => {
    const backend = createFakeOverleafBackend({
      projects: [{ projectId, files: [{ path: "main.tex", text: "remote main\n" }] }],
    });

    const snapshot = await createRemoteSnapshot({ backend, projectId, auth });

    expect(snapshot).toEqual([
      expect.objectContaining({
        path: "main.tex",
        exists: true,
        contentHash: sha256Hex("remote main\n"),
        size: Buffer.byteLength("remote main\n"),
        remoteId: "fake-remote-1",
        revision: "rev-fake-remote-1",
      }),
    ]);
  });

  it("reuses valid lowercase SHA-256 remote content hashes without downloading", async () => {
    const contentHash = sha256Hex("remote main\n");
    const backend = backendWithFiles(
      [
        {
          path: "main.tex",
          kind: "file",
          contentHash,
          size: 12,
          remoteId: "remote-main",
          modifiedAt: "2026-06-25T08:00:00.000Z",
          revision: "rev-main",
        },
      ],
      async () => {
        throw new Error("downloadFile should not be called for valid content hashes");
      }
    );

    const snapshot = await createRemoteSnapshot({ backend, projectId, auth });

    expect(snapshot).toEqual([
      expect.objectContaining({
        path: "main.tex",
        exists: true,
        contentHash,
        size: 12,
        remoteId: "remote-main",
        revision: "rev-main",
      }),
    ]);
  });

  it("ignores invalid hash metadata and downloads bytes for hashing", async () => {
    let downloads = 0;
    const backend = backendWithFiles(
      [
        {
          path: "main.tex",
          kind: "file",
          contentHash: "A".repeat(64),
          remoteId: "remote-main",
        },
      ],
      async () => {
        downloads += 1;
        return Buffer.from("remote main\n", "utf8");
      }
    );

    const snapshot = await createRemoteSnapshot({ backend, projectId, auth });

    expect(downloads).toBe(1);
    expect(snapshot[0]).toMatchObject({
      path: "main.tex",
      contentHash: sha256Hex("remote main\n"),
      size: Buffer.byteLength("remote main\n"),
    });
  });

  it("skips ignored remote paths before any download attempt", async () => {
    const backend = backendWithFiles(
      [
        { path: "build/overleaf/main.pdf", kind: "file", remoteId: "remote-pdf" },
        { path: "main.aux", kind: "file", remoteId: "remote-aux" },
        { path: "drafts/private.tex", kind: "file", remoteId: "remote-draft" },
      ],
      async () => {
        throw new Error("downloadFile should not be called for ignored remote paths");
      }
    );

    const snapshot = await createRemoteSnapshot({
      backend,
      projectId,
      auth,
      userIgnorePatterns: ["drafts/**"],
    });

    expect(snapshot).toEqual([]);
  });

  it("skips directory entries from the remote listing", async () => {
    const backend = backendWithFiles(
      [
        { path: "sections", kind: "directory" },
        { path: "sections/intro.tex", kind: "file", remoteId: "remote-intro" },
      ],
      async (input) => Buffer.from(`${input.path}\n`, "utf8")
    );

    const snapshot = await createRemoteSnapshot({ backend, projectId, auth });

    expect(snapshot.map((file) => file.path)).toEqual(["sections/intro.tex"]);
    expect(snapshot[0]).toMatchObject({
      contentHash: sha256Hex("sections/intro.tex\n"),
    });
  });
});

function backendWithFiles(
  files: RemoteFile[],
  downloadFile: (input: BackendFileInput) => Promise<Uint8Array>
): OverleafBackend {
  return {
    validateAuth: async () => ({ authenticated: true }),
    listFiles: async (_input: BackendProjectInput) => files,
    downloadFile,
    uploadFile: async () => {
      throw new Error("uploadFile is not used by remote snapshot tests");
    },
    deleteFile: async () => {
      throw new Error("deleteFile is not used by remote snapshot tests");
    },
    compile: async () => {
      throw new Error("compile is not used by remote snapshot tests");
    },
    downloadPdf: async () => {
      throw new Error("downloadPdf is not used by remote snapshot tests");
    },
  };
}
