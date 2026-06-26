import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_GITIGNORE_ENTRIES = [
  ".olcx/auth.local.json",
  ".olcx/*.local.json",
  ".olcx/*.secret.json",
  ".olcx/state/",
  "build/overleaf/",
  "*.aux",
  "*.log",
  "*.synctex.gz",
] as const;

const MARKER_COMMENT = "# Local paper-project state created by olcx.";

export async function ensureGitignoreEntries(projectRoot: string): Promise<{ changed: boolean; added: string[] }> {
  const path = join(projectRoot, ".gitignore");
  const existing = await readExistingGitignore(path);
  const lines = existing.content.split(/\r?\n/);
  const existingEntries = new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0));
  const added = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !existingEntries.has(entry));

  if (added.length === 0) {
    return { changed: false, added: [] };
  }

  const newline = existing.newline;
  const blocks: string[] = [];

  if (existing.content.length > 0) {
    blocks.push(ensureEndsWithNewline(existing.content, newline));
    if (!existing.content.endsWith("\n") && !existing.content.endsWith("\r\n")) {
      blocks.push(newline);
    }
  }

  if (existing.content.length > 0 && !existing.content.endsWith(`${newline}${newline}`)) {
    blocks.push(newline);
  }

  blocks.push([MARKER_COMMENT, ...added].join(newline), newline);
  await writeFile(path, blocks.join(""), "utf8");

  return { changed: true, added };
}

async function readExistingGitignore(path: string): Promise<{ content: string; newline: "\n" | "\r\n" }> {
  try {
    const content = await readFile(path, "utf8");
    return { content, newline: content.includes("\r\n") ? "\r\n" : "\n" };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", newline: "\n" };
    }
    throw error;
  }
}

function ensureEndsWithNewline(content: string, newline: "\n" | "\r\n"): string {
  return content.endsWith("\n") || content.endsWith("\r\n") ? content : `${content}${newline}`;
}
