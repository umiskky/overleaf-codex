import { createOlcxError, isOlcxError } from "../errors.js";
import { ensureGitignoreEntries } from "../config/ignoreRules.js";
import { parseProjectReference, type ParsedProjectReference } from "../config/overleafProject.js";
import { readProjectConfig, writeProjectConfig } from "../config/projectConfig.js";
import { findProjectRoot } from "../config/projectRoot.js";
import { createDefaultProjectConfig, type ProjectConfig } from "../config/types.js";
import { ensureVsCodeConfig } from "../config/vscode.js";

export interface InitProjectOptions {
  cwd: string;
  project: string;
  vscode?: boolean;
}

export interface InitProjectResult {
  projectRoot: string;
  projectId: string;
  pdfPath: string;
  configCreated: boolean;
  gitignoreChanged: boolean;
  vscodeChanged: boolean;
}

export async function initProject(options: InitProjectOptions): Promise<InitProjectResult> {
  const projectRef = parseProjectReference(options.project);
  const projectRoot = await findProjectRoot(options.cwd);
  const { config, created } = await readOrCreateConfig(projectRoot, projectRef);
  const gitignore = await ensureGitignoreEntries(projectRoot);
  const vscode = await ensureVsCodeConfig(projectRoot, {
    pdfPath: config.pdfPath,
    rootDocument: config.rootDocument,
  });

  return {
    projectRoot,
    projectId: config.projectId,
    pdfPath: config.pdfPath,
    configCreated: created,
    gitignoreChanged: gitignore.changed,
    vscodeChanged: vscode.changed,
  };
}

async function readOrCreateConfig(
  projectRoot: string,
  projectRef: ParsedProjectReference
): Promise<{ config: ProjectConfig; created: boolean }> {
  try {
    const existing = await readProjectConfig(projectRoot);

    if (existing.projectId !== projectRef.projectId) {
      throw createOlcxError({
        code: "PROJECT_CONFIG_INVALID",
        message: "This repository is already bound to a different Overleaf project.",
        hint: "Use the existing binding or edit .olcx/config.json intentionally.",
        details: { path: ".olcx/config.json" },
      });
    }

    return { config: existing, created: false };
  } catch (error) {
    if (!isOlcxError(error) || error.code !== "PROJECT_CONFIG_NOT_FOUND") {
      throw error;
    }
  }

  const config = createDefaultProjectConfig(projectRef);
  await writeProjectConfig(projectRoot, config);
  return { config, created: true };
}
