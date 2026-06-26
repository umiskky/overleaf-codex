import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init";
import { REQUIRED_GITIGNORE_ENTRIES } from "../src/config/ignoreRules";
import { parseProjectReference } from "../src/config/overleafProject";
import { createDefaultProjectConfig } from "../src/config/types";
import { ensureVsCodeConfig } from "../src/config/vscode";

const tempRoots: string[] = [];
const expectedOlcxTasks = [
  { label: "olcx: status", args: ["status"] },
  { label: "olcx: doctor", args: ["doctor"] },
  { label: "olcx: sync dry-run", args: ["sync", "--dry-run"] },
  { label: "olcx: sync apply", args: ["sync"] },
  { label: "olcx: compile", args: ["compile"] },
  { label: "olcx: watch", args: ["watch"] },
  { label: "olcx: endpoint status", args: ["endpoint", "status"] },
  { label: "olcx: endpoint test", args: ["endpoint", "test"] },
] as const;

type VsCodeTask = {
  label?: string;
  command?: string;
  args?: string[];
  isBackground?: boolean;
  problemMatcher?: unknown;
  presentation?: { panel?: string; reveal?: string; clear?: boolean };
};

async function makeTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "olcx-init-test-"));
  tempRoots.push(root);
  return root;
}

function parseTaskList(tasksJson: string): VsCodeTask[] {
  const parsed = JSON.parse(tasksJson) as { tasks?: VsCodeTask[] };
  expect(Array.isArray(parsed.tasks)).toBe(true);
  return parsed.tasks ?? [];
}

function expectGeneratedOlcxTasks(tasks: VsCodeTask[]): void {
  expect(tasks.map((task) => task.label)).toEqual(expectedOlcxTasks.map((task) => task.label));

  for (const expected of expectedOlcxTasks) {
    const matches = tasks.filter((task) => task.label === expected.label);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      command: "olcx",
      args: expected.args,
    });
  }

  expect(
    tasks.some(
      (task) =>
        task.label?.includes("endpoint test --apply") ||
        (Array.isArray(task.args) && task.args.join(" ").includes("endpoint test --apply"))
    )
  ).toBe(false);

  const watchTask = tasks.find((task) => task.label === "olcx: watch");
  expect(watchTask).toMatchObject({
    isBackground: true,
    problemMatcher: [],
    presentation: { panel: "dedicated" },
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("init project reference parsing", () => {
  it("accepts direct project ids", () => {
    expect(parseProjectReference("abc123def456")).toEqual({
      projectId: "abc123def456",
      overleaf: { baseUrl: "https://www.overleaf.com" },
    });
  });

  it("accepts canonical Overleaf project urls", () => {
    expect(parseProjectReference("https://www.overleaf.com/project/abc123def456?foo=bar#top")).toEqual({
      projectId: "abc123def456",
      projectUrl: "https://www.overleaf.com/project/abc123def456",
      overleaf: { baseUrl: "https://www.overleaf.com" },
    });
  });

  it("accepts cn Overleaf project urls and records the cn base URL", () => {
    expect(parseProjectReference("https://cn.overleaf.com/project/abc123def456?foo=bar#top")).toEqual({
      projectId: "abc123def456",
      projectUrl: "https://cn.overleaf.com/project/abc123def456",
      overleaf: { baseUrl: "https://cn.overleaf.com" },
    });
  });

  it("rejects invalid project references without network access", () => {
    for (const value of [
      "",
      "   ",
      "https://example.com/project/abc123def456",
      "https://user:pass@www.overleaf.com/project/abc123def456",
      "http://www.overleaf.com/project/abc123def456",
      "https://www.overleaf.com/read/abc123def456",
      "https://www.overleaf.com/project/abc123def456/history",
      "abc/123",
      "abc 123",
    ]) {
      expect(() => parseProjectReference(value)).toThrow(
        expect.objectContaining({ code: "USER_INPUT_ERROR", exitCode: 2 })
      );
    }
  });
});

describe("VS Code config merge", () => {
  it("creates settings and all olcx tasks when absent", async () => {
    const root = await makeTempProject();

    const result = await ensureVsCodeConfig(root, {
      pdfPath: "build/overleaf/main.pdf",
      rootDocument: "main.tex",
    });

    const settings = JSON.parse(await readFile(join(root, ".vscode", "settings.json"), "utf8"));
    const tasks = JSON.parse(await readFile(join(root, ".vscode", "tasks.json"), "utf8"));

    expect(result.changed).toBe(true);
    expect(settings).toMatchObject({
      "olcx.pdfPath": "build/overleaf/main.pdf",
      "olcx.rootDocument": "main.tex",
    });
    expectGeneratedOlcxTasks(tasks.tasks);
  });

  it("preserves user keys and tasks while replacing only olcx owned entries", async () => {
    const root = await makeTempProject();
    const userTask = { label: "user task", type: "shell", command: "echo user", problemMatcher: [] };
    await mkdir(join(root, ".vscode"), { recursive: true });
    await writeFile(
      join(root, ".vscode", "settings.json"),
      JSON.stringify({ "editor.wordWrap": "on", "olcx.pdfPath": "old.pdf", "olcx.rootDocument": "old.tex" }, null, 2),
      "utf8"
    );
    await writeFile(
      join(root, ".vscode", "tasks.json"),
      JSON.stringify(
        {
          version: "2.0.0",
          tasks: [
            userTask,
            { label: "olcx: compile", type: "shell", command: "old", args: ["old"], problemMatcher: [] },
            { label: "olcx: watch", type: "shell", command: "old-watch", args: [], problemMatcher: [] },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const first = await ensureVsCodeConfig(root, {
      pdfPath: "build/overleaf/main.pdf",
      rootDocument: "main.tex",
    });
    const afterFirstSettings = await readFile(join(root, ".vscode", "settings.json"), "utf8");
    const afterFirstTasks = await readFile(join(root, ".vscode", "tasks.json"), "utf8");
    const second = await ensureVsCodeConfig(root, {
      pdfPath: "build/overleaf/main.pdf",
      rootDocument: "main.tex",
    });
    const afterSecondSettings = await readFile(join(root, ".vscode", "settings.json"), "utf8");
    const afterSecondTasks = await readFile(join(root, ".vscode", "tasks.json"), "utf8");

    const settings = JSON.parse(afterFirstSettings);
    const tasks = parseTaskList(afterFirstTasks);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(afterSecondSettings).toBe(afterFirstSettings);
    expect(afterSecondTasks).toBe(afterFirstTasks);
    expect(settings["editor.wordWrap"]).toBe("on");
    expect(settings["olcx.pdfPath"]).toBe("build/overleaf/main.pdf");
    expect(settings["olcx.rootDocument"]).toBe("main.tex");
    expect(tasks).toContainEqual(userTask);
    expect(tasks.some((task) => task.command === "old" || task.command === "old-watch")).toBe(false);
    expectGeneratedOlcxTasks(tasks.filter((task) => task.label?.startsWith("olcx:")));
  });

  it("does not partially update settings when tasks config is invalid", async () => {
    const root = await makeTempProject();
    await mkdir(join(root, ".vscode"), { recursive: true });
    const settingsPath = join(root, ".vscode", "settings.json");
    const tasksPath = join(root, ".vscode", "tasks.json");
    const existingSettings = `${JSON.stringify({ "editor.wordWrap": "on" }, null, 2)}\n`;
    const existingTasks = `${JSON.stringify({ version: "2.0.0", tasks: "bad" }, null, 2)}\n`;

    await writeFile(settingsPath, existingSettings, "utf8");
    await writeFile(tasksPath, existingTasks, "utf8");

    await expect(
      ensureVsCodeConfig(root, {
        pdfPath: "build/overleaf/main.pdf",
        rootDocument: "main.tex",
      })
    ).rejects.toMatchObject({ code: "PROJECT_CONFIG_INVALID" });

    expect(await readFile(settingsPath, "utf8")).toBe(existingSettings);
    expect(await readFile(tasksPath, "utf8")).toBe(existingTasks);
  });
});

describe("init workflow", () => {
  it("creates config, updates gitignore, and generates VS Code config idempotently", async () => {
    const root = await makeTempProject();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "# user rules\nprivate-notes.tex\n", "utf8");

    const first = await initProject({
      cwd: root,
      project: "https://www.overleaf.com/project/abc123def456",
    });
    const configAfterFirst = await readFile(join(root, ".olcx", "config.json"), "utf8");
    const gitignoreAfterFirst = await readFile(join(root, ".gitignore"), "utf8");
    const settingsAfterFirst = await readFile(join(root, ".vscode", "settings.json"), "utf8");
    const tasksAfterFirst = await readFile(join(root, ".vscode", "tasks.json"), "utf8");

    const second = await initProject({ cwd: root, project: "abc123def456" });

    expect(first).toMatchObject({
      projectRoot: root,
      projectId: "abc123def456",
      configCreated: true,
      gitignoreChanged: true,
      vscodeChanged: true,
    });
    expect(second).toMatchObject({
      projectRoot: root,
      projectId: "abc123def456",
      configCreated: false,
      gitignoreChanged: false,
      vscodeChanged: false,
    });
    expect(JSON.parse(configAfterFirst)).toMatchObject({
      schemaVersion: 1,
      projectId: "abc123def456",
      projectUrl: "https://www.overleaf.com/project/abc123def456",
      overleaf: { baseUrl: "https://www.overleaf.com" },
      rootDocument: "main.tex",
      pdfPath: "build/overleaf/main.pdf",
    });
    expect(await readFile(join(root, ".olcx", "config.json"), "utf8")).toBe(configAfterFirst);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(gitignoreAfterFirst);
    expect(await readFile(join(root, ".vscode", "settings.json"), "utf8")).toBe(settingsAfterFirst);
    expect(await readFile(join(root, ".vscode", "tasks.json"), "utf8")).toBe(tasksAfterFirst);
  });

  it("repairs missing gitignore entries and old olcx VS Code tasks on repeated init", async () => {
    const root = await makeTempProject();
    await mkdir(join(root, ".git"), { recursive: true });
    await initProject({ cwd: root, project: "abc123def456" });

    const missingIgnoreRule = REQUIRED_GITIGNORE_ENTRIES[0];
    const gitignorePath = join(root, ".gitignore");
    const tasksPath = join(root, ".vscode", "tasks.json");
    const gitignoreBeforeRepair = await readFile(gitignorePath, "utf8");
    await writeFile(gitignorePath, gitignoreBeforeRepair.replace(`${missingIgnoreRule}\n`, ""), "utf8");
    await writeFile(
      tasksPath,
      `${JSON.stringify(
        {
          version: "2.0.0",
          tasks: [
            { label: "olcx: compile", type: "shell", command: "old", args: ["old"], problemMatcher: [] },
            { label: "user task", type: "shell", command: "echo user", problemMatcher: [] },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const repair = await initProject({ cwd: root, project: "abc123def456" });
    const repairedGitignore = await readFile(gitignorePath, "utf8");
    const repairedTasks = parseTaskList(await readFile(tasksPath, "utf8"));

    expect(repair).toMatchObject({
      configCreated: false,
      gitignoreChanged: true,
      vscodeChanged: true,
    });
    expect(repairedGitignore).toContain(missingIgnoreRule);
    expect(repairedTasks).toContainEqual({ label: "user task", type: "shell", command: "echo user", problemMatcher: [] });
    expect(repairedTasks.some((task) => task.command === "old")).toBe(false);
    expectGeneratedOlcxTasks(repairedTasks.filter((task) => task.label?.startsWith("olcx:")));
  });

  it("does not overwrite a repository already bound to another project", async () => {
    const root = await makeTempProject();
    await mkdir(join(root, ".olcx"), { recursive: true });
    await mkdir(join(root, ".vscode"), { recursive: true });
    const existingConfig = `${JSON.stringify(createDefaultProjectConfig({ projectId: "existing123" }), null, 2)}\n`;
    const existingGitignore = "# sentinel ignore\n";
    const existingSettings = `${JSON.stringify({ "editor.wordWrap": "bounded" }, null, 2)}\n`;
    const existingTasks = `${JSON.stringify(
      { version: "2.0.0", tasks: [{ label: "user task", type: "shell", command: "echo keep", problemMatcher: [] }] },
      null,
      2
    )}\n`;
    await writeFile(join(root, ".olcx", "config.json"), existingConfig, "utf8");
    await writeFile(join(root, ".gitignore"), existingGitignore, "utf8");
    await writeFile(join(root, ".vscode", "settings.json"), existingSettings, "utf8");
    await writeFile(join(root, ".vscode", "tasks.json"), existingTasks, "utf8");

    await expect(initProject({ cwd: root, project: "different456" })).rejects.toMatchObject({
      code: expect.stringMatching(/PROJECT_CONFIG_INVALID|USER_INPUT_ERROR/),
    });

    expect(await readFile(join(root, ".olcx", "config.json"), "utf8")).toBe(existingConfig);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(existingGitignore);
    expect(await readFile(join(root, ".vscode", "settings.json"), "utf8")).toBe(existingSettings);
    expect(await readFile(join(root, ".vscode", "tasks.json"), "utf8")).toBe(existingTasks);
  });

  it("creates config for cn Overleaf project urls", async () => {
    const root = await makeTempProject();
    await mkdir(join(root, ".git"), { recursive: true });

    await initProject({
      cwd: root,
      project: "https://cn.overleaf.com/project/abc123def456",
      vscode: false,
    });

    await expect(readFile(join(root, ".olcx", "config.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      projectId: "abc123def456",
      projectUrl: "https://cn.overleaf.com/project/abc123def456",
      overleaf: { baseUrl: "https://cn.overleaf.com" },
    });
  });
});
