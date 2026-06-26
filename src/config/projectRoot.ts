import { stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { PROJECT_CONFIG_PATH } from "./types.js";

export async function findProjectRoot(startDir: string): Promise<string> {
  const original = resolve(startDir);
  let current = original;
  const root = parse(current).root;

  while (true) {
    if (await exists(join(current, PROJECT_CONFIG_PATH))) {
      return current;
    }

    if (await exists(join(current, ".git"))) {
      return current;
    }

    if (await exists(join(current, "package.json"))) {
      return current;
    }

    if (current === root) {
      return original;
    }

    current = dirname(current);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
