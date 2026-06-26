import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWatchIgnoredPredicate } from "../src/watch/watcher";

describe("watch ignore predicate", () => {
  const projectRoot = join(tmpdir(), "paper");

  it.each([
    ".git/config",
    "node_modules/pkg/index.js",
    ".olcx/auth.local.json",
    ".olcx/cache.local.json",
    ".olcx/cache.secret.json",
    ".olcx/state/sync.json",
    "build/overleaf/main.pdf",
    "main.aux",
    "main.bbl",
    "main.bcf",
    "main.blg",
    "main.fdb_latexmk",
    "main.fls",
    "main.log",
    "main.out",
    "main.run.xml",
    "main.synctex.gz",
    "main.toc",
  ])("ignores built-in unsafe or generated path %s", (path) => {
    const ignored = createWatchIgnoredPredicate({ projectRoot });

    expect(ignored(path)).toBe(true);
  });

  it("applies user ignore patterns after built-in ignores", () => {
    const ignored = createWatchIgnoredPredicate({
      projectRoot,
      userIgnorePatterns: ["drafts/**"],
    });

    expect(ignored("drafts/private.tex")).toBe(true);
    expect(ignored("main.tex")).toBe(false);
  });

  it("normalizes absolute and Windows-style paths", () => {
    const ignored = createWatchIgnoredPredicate({ projectRoot });

    expect(ignored(join(projectRoot, "build", "overleaf", "main.pdf"))).toBe(true);
    expect(ignored("sections\\intro.tex")).toBe(false);
    expect(ignored("..\\outside.tex")).toBe(true);
  });
});
