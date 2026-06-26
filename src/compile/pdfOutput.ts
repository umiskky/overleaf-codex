import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { createOlcxError, isOlcxError } from "../errors.js";

export interface PdfOutputTarget {
  projectRoot: string;
  relativePath: string;
  absolutePath: string;
}

export interface PdfOutputWriteResult {
  relativePath: string;
  absolutePath: string;
  bytesWritten: number;
}

export function resolvePdfOutputTarget(projectRoot: string, pdfPath: string): PdfOutputTarget {
  const normalized = normalizeSafeRelativePdfPath(pdfPath);
  const resolvedRoot = resolve(projectRoot);
  const absolutePath = resolve(resolvedRoot, ...normalized.split("/"));
  const relativeToRoot = relative(resolvedRoot, absolutePath);

  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw unsafePdfPathError(pdfPath);
  }

  return {
    projectRoot: resolvedRoot,
    relativePath: normalized,
    absolutePath,
  };
}

export async function writePdfOutput(target: PdfOutputTarget, bytes: Uint8Array): Promise<PdfOutputWriteResult> {
  try {
    await mkdir(dirname(target.absolutePath), { recursive: true });
    await writeFile(target.absolutePath, bytes);
  } catch (error) {
    if (isOlcxError(error)) {
      throw error;
    }
    throw createOlcxError({
      code: "IO_ERROR",
      message: `Failed to write compiled PDF to ${target.relativePath}.`,
      hint: "Check directory permissions and retry olcx compile.",
      details: { path: target.relativePath },
      cause: error,
    });
  }

  return {
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    bytesWritten: bytes.byteLength,
  };
}

function normalizeSafeRelativePdfPath(pdfPath: string): string {
  if (typeof pdfPath !== "string" || pdfPath.trim().length === 0) {
    throw unsafePdfPathError(pdfPath);
  }

  const trimmed = pdfPath.trim();
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed)) {
    throw unsafePdfPathError(pdfPath);
  }

  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw unsafePdfPathError(pdfPath);
  }

  return segments.join("/");
}

function unsafePdfPathError(pdfPath: string) {
  return createOlcxError({
    code: "USER_INPUT_ERROR",
    message: "PDF output path must be a safe relative path inside the project root.",
    hint: "Use a path like build/overleaf/main.pdf or pass --pdf with a project-relative path.",
    details: { path: pdfPath },
  });
}
