import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNpmPublishWorkflowSecurity } from "../scripts/prepublish-check";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("npm publish workflow", () => {
  it("uses trusted publishing without long-lived npm token material", () => {
    const workflow = readRepo(".github/workflows/npm-publish.yml");

    expect(() => assertNpmPublishWorkflowSecurity(workflow)).not.toThrow();
    expect(workflow).toContain("github.repository == 'umiskky/overleaf-codex'");
    expect(workflow).toContain("environment: npm-publish");
    expect(workflow).toContain("github.event.release.prerelease");
    expect(workflow).toContain("NPM_DIST_TAG=next");
    expect(workflow).toContain("NPM_DIST_TAG=latest");
    expect(workflow).toContain("Release tag must use vX.Y.Z or vX.Y.Z-prerelease.N");
    expect(workflow).toContain("Stable npm publish is blocked until sanitized real Overleaf E2E is recorded.");
    expect(workflow).toContain("Stable release decision: Approved for stable release");
    expect(workflow).toContain("Sanitized real E2E artifact: gh-release://");
    expect(workflow).toContain("not recorded|placeholder|not evidence");
    expect(workflow).toContain("Concrete sanitized real E2E artifact reference is required for stable npm publish.");
    expect(workflow).toContain("npm run prepublish:check");
    expect(workflow).toContain("npm publish --tag \"$NPM_DIST_TAG\"");
  });

  it("keeps npm publish metadata explicit", () => {
    const packageJson = JSON.parse(readRepo("package.json")) as {
      name?: string;
      version?: string;
      bin?: Record<string, string>;
      files?: string[];
      license?: string;
      repository?: { type?: string; url?: string };
      homepage?: string;
      engines?: { node?: string };
    };

    expect(packageJson.name).toBe("overleaf-codex");
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(packageJson.bin?.olcx).toBe("./dist/cli.js");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/umiskky/overleaf-codex.git",
    });
    expect(packageJson.homepage).toBe("https://github.com/umiskky/overleaf-codex#readme");
    expect(packageJson.engines?.node).toBe(">=20");
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        "assets",
        "dist",
        "README.md",
        "LICENSE",
        "NOTICE.md",
        "docs",
        "examples",
        "src/backend/olcli/LICENSE",
        "src/backend/olcli/README.md",
      ])
    );
  });
});
