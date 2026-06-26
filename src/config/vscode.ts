import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOlcxError } from "../errors.js";

export interface VsCodeConfigInput {
  pdfPath: string;
  rootDocument: string;
}

export interface VsCodeConfigResult {
  changed: boolean;
}

const SETTINGS_FILENAME = "settings.json";
const TASKS_FILENAME = "tasks.json";
const OLCX_MANAGED_TASKS = [
  { label: "olcx: status", args: ["status"] },
  { label: "olcx: doctor", args: ["doctor"] },
  { label: "olcx: sync dry-run", args: ["sync", "--dry-run"] },
  { label: "olcx: sync apply", args: ["sync"] },
  { label: "olcx: compile", args: ["compile"] },
  { label: "olcx: watch", args: ["watch"] },
  { label: "olcx: endpoint status", args: ["endpoint", "status"] },
  { label: "olcx: endpoint test", args: ["endpoint", "test"] },
] as const;
const OLCX_MANAGED_TASK_LABELS = new Set<string>(OLCX_MANAGED_TASKS.map((task) => task.label));

export function mergeVsCodeSettings(existing: unknown, input: VsCodeConfigInput): Record<string, unknown> {
  assertRecord(existing, ".vscode/settings.json");

  return {
    ...existing,
    "olcx.pdfPath": input.pdfPath,
    "olcx.rootDocument": input.rootDocument,
  };
}

export function mergeVsCodeTasks(existing: unknown): Record<string, unknown> {
  assertRecord(existing, ".vscode/tasks.json");

  const tasks = existing.tasks;
  if (tasks !== undefined && !Array.isArray(tasks)) {
    throw createOlcxError({
      code: "PROJECT_CONFIG_INVALID",
      message: ".vscode/tasks.json is invalid.",
      hint: "Make tasks an array before running olcx init again.",
      details: { path: ".vscode/tasks.json", reason: "tasks must be an array" },
    });
  }

  return {
    ...existing,
    version: "2.0.0",
    tasks: [...(tasks ?? []).filter((task) => !isOlcxManagedTask(task)), ...OLCX_MANAGED_TASKS.map(createOlcxTask)],
  };
}

export async function ensureVsCodeConfig(projectRoot: string, input: VsCodeConfigInput): Promise<VsCodeConfigResult> {
  const vscodeDir = join(projectRoot, ".vscode");
  await mkdir(vscodeDir, { recursive: true });

  const settings = await prepareMergedJson(
    join(vscodeDir, SETTINGS_FILENAME),
    ".vscode/settings.json",
    (existing) => mergeVsCodeSettings(existing, input)
  );
  const tasks = await prepareMergedJson(join(vscodeDir, TASKS_FILENAME), ".vscode/tasks.json", mergeVsCodeTasks);

  await writePreparedJson(settings);
  await writePreparedJson(tasks);

  return { changed: settings.changed || tasks.changed };
}

interface PreparedJsonWrite {
  path: string;
  content: string;
  changed: boolean;
}

async function prepareMergedJson(
  path: string,
  displayPath: string,
  merge: (existing: unknown) => Record<string, unknown>
): Promise<PreparedJsonWrite> {
  const existing = await readJsonFile(path, displayPath);
  const merged = merge(existing.value);
  const nextContent = `${JSON.stringify(merged, null, 2)}\n`;

  return {
    path,
    content: nextContent,
    changed: existing.content !== nextContent,
  };
}

async function writePreparedJson(prepared: PreparedJsonWrite): Promise<void> {
  if (prepared.changed) {
    await writeFile(prepared.path, prepared.content, "utf8");
  }
}

async function readJsonFile(path: string, displayPath: string): Promise<{ value: unknown; content?: string }> {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { value: {} };
    }
    throw error;
  }

  try {
    return { value: JSON.parse(content), content };
  } catch (error) {
    throw createOlcxError({
      code: "PROJECT_CONFIG_INVALID",
      message: `${displayPath} contains invalid JSON.`,
      hint: `Fix ${displayPath} before running olcx init again.`,
      details: { path: displayPath, reason: error instanceof Error ? error.message : "Invalid JSON" },
      cause: error,
    });
  }
}

function createOlcxTask(spec: (typeof OLCX_MANAGED_TASKS)[number]): Record<string, unknown> {
  const task: Record<string, unknown> = {
    label: spec.label,
    type: "shell",
    command: "olcx",
    args: [...spec.args],
    problemMatcher: [],
  };

  if (spec.label === "olcx: compile") {
    task.group = "build";
    task.presentation = {
      reveal: "always",
      panel: "dedicated",
    };
  }

  if (spec.label === "olcx: watch") {
    task.isBackground = true;
    task.presentation = {
      reveal: "always",
      panel: "dedicated",
      clear: false,
    };
  }

  return task;
}

function isOlcxManagedTask(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { label?: unknown }).label === "string" &&
    OLCX_MANAGED_TASK_LABELS.has((value as { label: string }).label)
  );
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createOlcxError({
      code: "PROJECT_CONFIG_INVALID",
      message: `${path} must contain a JSON object.`,
      hint: `Fix ${path} before running olcx init again.`,
      details: { path },
    });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
