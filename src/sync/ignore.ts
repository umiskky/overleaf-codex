export const BUILT_IN_IGNORE_PATTERNS = [
  ".git/",
  ".gitignore",
  "node_modules/",
  ".vscode/",
  ".olcx/config.json",
  ".olcx/auth.local.json",
  ".olcx/*.local.json",
  ".olcx/*.secret.json",
  ".olcx/state/",
  "build/overleaf/",
  "*.aux",
  "*.bbl",
  "*.bcf",
  "*.blg",
  "*.fdb_latexmk",
  "*.fls",
  "*.log",
  "*.out",
  "*.run.xml",
  "*.synctex.gz",
  "*.toc",
] as const;

export function normalizeSyncPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/+$/, "");
}

export function createIgnoreMatcher(userPatterns: readonly string[] = []) {
  const patterns = [...BUILT_IN_IGNORE_PATTERNS, ...userPatterns];

  return {
    isIgnored(path: string): boolean {
      const normalized = normalizeSyncPath(path);

      if (isUnsafePath(normalized)) {
        return true;
      }

      return patterns.some((pattern) => matchesPattern(normalized, pattern));
    },
  };
}

function isUnsafePath(path: string): boolean {
  return path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../");
}

function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern || pattern.startsWith("!")) {
    return false;
  }

  const normalizedPattern = normalizeSyncPath(pattern);

  if (pattern.endsWith("/") || normalizedPattern.endsWith("/")) {
    return matchesDirectory(path, normalizedPattern);
  }

  if (normalizedPattern.endsWith("/**")) {
    return matchesDirectory(path, normalizedPattern.slice(0, -3));
  }

  if (normalizedPattern.includes("*")) {
    return matchesStarPattern(path, normalizedPattern);
  }

  return path === normalizedPattern;
}

function matchesDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = normalizeSyncPath(directory);
  return path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`);
}

function matchesStarPattern(path: string, pattern: string): boolean {
  const starIndex = pattern.indexOf("*");
  const prefix = pattern.slice(0, starIndex);
  const suffix = pattern.slice(starIndex + 1);

  if (prefix === "" && !suffix.includes("/")) {
    return basename(path).endsWith(suffix);
  }

  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return false;
  }

  return !path.slice(prefix.length, path.length - suffix.length).includes("/");
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}
