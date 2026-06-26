import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";

const OLCX_VERSION = "0.1.0";
const OLCLI_VERSION = "0.5.0";
const OLCLI_COMMIT = "524c30b11328a847a9c0bcf4447d2b3468160f8c";
const OLCLI_TARBALL = "https://registry.npmjs.org/@aloth/olcli/-/olcli-0.5.0.tgz";
const OLCLI_INTEGRITY =
  "sha512-kFstYGK6htjDiOlX0H/nmjzugwRYN2RlBufK+bAA648h21GqQOVxeHr5po2ybwxetoccT9ky3YV2ch7c3b6GmQ==";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
};

function repoUrl(relativePath: string): URL {
  return new URL(`../${relativePath}`, import.meta.url);
}

function repoPath(relativePath: string): string {
  return repoUrl(relativePath).pathname;
}

function readRepoFile(relativePath: string): string {
  return readFileSync(repoUrl(relativePath), "utf8");
}

function repoFileExists(relativePath: string): boolean {
  return existsSync(repoUrl(relativePath));
}

function readPackageJson(): PackageJson {
  return JSON.parse(readRepoFile("package.json")) as PackageJson;
}

function allPackageDependencies(pkg: PackageJson): Record<string, string> {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
}

function sourceFilePaths(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const fullPath = `${dir}/${entry}`;
      const stat = statSync(fullPath);
      return stat.isDirectory() ? sourceFilePaths(fullPath) : [fullPath];
    })
    .filter((filePath) => filePath.endsWith(".ts"));
}

describe("olcli backend vendoring", () => {
  it("keeps olcli as vendored source instead of a package dependency", () => {
    const pkg = readPackageJson();
    const allDeps = allPackageDependencies(pkg);

    expect(allDeps["@aloth/olcli"]).toBeUndefined();
    expect(pkg.dependencies).toMatchObject({
      "adm-zip": "0.5.16",
      cheerio: "1.0.0",
    });
    expect(pkg.devDependencies).toMatchObject({
      "@types/adm-zip": "0.5.7",
    });

    for (const disallowed of [
      "@modelcontextprotocol/sdk",
      "conf",
      "chalk",
      "ora",
      "zod",
      "tough-cookie",
      "ignore",
    ]) {
      expect(allDeps[disallowed]).toBeUndefined();
    }

    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "dist",
        "README.md",
        "LICENSE",
        "NOTICE.md",
        "src/backend/olcli/LICENSE",
        "src/backend/olcli/README.md",
      ])
    );
  });

  it("documents exact upstream source, license, and non-official relationship", () => {
    const readme = readRepoFile("README.md");
    const notice = readRepoFile("NOTICE.md");
    const backendReadme = readRepoFile("src/backend/olcli/README.md");
    const backendLicense = readRepoFile("src/backend/olcli/LICENSE");

    for (const value of [
      `@aloth/olcli@${OLCLI_VERSION}`,
      "https://github.com/aloth/olcli",
      "v0.5.0",
      OLCLI_COMMIT,
      "src/backend/olcli/client.ts",
      "MIT",
    ]) {
      expect(readme).toContain(value);
      expect(notice).toContain(value);
      expect(backendReadme).toContain(value);
    }

    expect(notice).toContain(OLCLI_TARBALL);
    expect(backendReadme).toContain(OLCLI_TARBALL);
    expect(backendReadme).toContain(OLCLI_INTEGRITY);
    expect(notice).toContain("Copyright (c) 2026 Alexander Loth");
    expect(backendLicense).toContain("MIT License");
    expect(backendLicense).toContain("Copyright (c) 2026 Alexander Loth");
    expect(readme).toMatch(/not an official Overleaf project/i);
    expect(readme).toMatch(/not an official `?olcli`? project/i);
    expect(notice).toMatch(/not affiliated with, endorsed by, or maintained by Overleaf or `?olcli`?/i);
    expect(backendReadme).toMatch(/Only backend adapter modules may import/i);
  });

  it("preserves copied-source attribution and removes import-time package metadata lookup", () => {
    const clientSource = readRepoFile("src/backend/olcli/client.ts");
    const indexSource = readRepoFile("src/backend/olcli/index.ts");

    expect(clientSource).toContain(`Adapted from @aloth/olcli v${OLCLI_VERSION} src/client.ts`);
    expect(clientSource).toContain(OLCLI_COMMIT);
    expect(clientSource).toContain("Copyright (c) 2026 Alexander Loth");
    expect(clientSource).toContain("Licensed under the MIT License");
    expect(clientSource).toContain(
      `export const USER_AGENT = "olcx/${OLCX_VERSION} olcli/${OLCLI_VERSION}";`
    );
    expect(clientSource).not.toContain("readFileSync");
    expect(clientSource).not.toContain("fileURLToPath");
    expect(clientSource).not.toContain("join(__dirname");
    expect(indexSource).toContain('export { OverleafClient, USER_AGENT } from "./client.js";');
  });

  it("does not copy upstream CLI, MCP, or global config entrypoints", () => {
    for (const unexpected of [
      "src/backend/olcli/cli.ts",
      "src/backend/olcli/mcp.ts",
      "src/backend/olcli/config.ts",
      "src/backend/olcli/ignore.ts",
    ]) {
      expect(repoFileExists(unexpected)).toBe(false);
    }

    const clientSource = readRepoFile("src/backend/olcli/client.ts");

    expect(clientSource).not.toContain(".olauth");
    expect(clientSource).not.toContain("@modelcontextprotocol/sdk");
    expect(clientSource).not.toMatch(/from ['"]conf['"]/);
    expect(clientSource).not.toMatch(/from ['"]chalk['"]/);
    expect(clientSource).not.toMatch(/from ['"]ora['"]/);
    expect(clientSource).not.toMatch(/from ['"]zod['"]/);
    expect(clientSource).not.toMatch(/from ['"]tough-cookie['"]/);
    expect(clientSource).not.toMatch(/from ['"]ignore['"]/);
  });

  it("imports and instantiates the backend-private client without network or package-json lookup", async () => {
    const backend = await import("../src/backend/olcli/index");

    expect(backend.USER_AGENT).toBe(`olcx/${OLCX_VERSION} olcli/${OLCLI_VERSION}`);

    const client = new backend.OverleafClient({
      cookies: { overleaf_session2: "<fake-session-cookie>" },
      csrf: "<fake-csrf>",
      baseUrl: "https://example.invalid",
    });

    expect(typeof client.setVerbose).toBe("function");
    expect(client.computeRootFolderId("0123456789abcdef01234567")).toBe(
      "0123456789abcdef01234566"
    );
  });

  it("keeps direct olcli imports inside backend adapter modules only", () => {
    const srcRoot = repoPath("src");
    const allowed = new Set([
      "src/backend/overleafBackend.ts",
      "src/backend/olcli/index.ts",
      "src/backend/olcli/client.ts",
    ]);
    const importPattern = /(?:from\s+["'][^"']*olcli[^"']*["'])|(?:import\(["'][^"']*olcli[^"']*["']\))/;

    const offenders = sourceFilePaths(srcRoot)
      .map((filePath) => ({
        relativePath: relative(repoPath("."), filePath),
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(({ relativePath, source }) => importPattern.test(source) && !allowed.has(relativePath));

    expect(offenders).toEqual([]);
  });
});
