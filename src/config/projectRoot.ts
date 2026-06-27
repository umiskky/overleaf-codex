import { resolve } from "node:path";

export async function findProjectRoot(startDir: string): Promise<string> {
  return resolve(startDir);
}
