#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { Command } from "commander";

export const VERSION = "0.1.0";

function plannedCommand(commandName: string) {
  return () => {
    console.error(
      `olcx ${commandName} is part of the v1 interface, but this initialization scaffold does not implement it yet.`
    );
    console.error("Next phase: port and adapt the Overleaf backend into this repository.");
    process.exitCode = 2;
  };
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("olcx")
    .description("Bridge local Git, VS Code, and Codex workflows with Overleaf compilation.")
    .version(VERSION)
    .showHelpAfterError();

  program
    .command("auth")
    .description("Store project-local Overleaf authorization for the current paper repository.")
    .option("--cookie <value>", "Overleaf session cookie value")
    .option("--from-env <name>", "Read the session cookie from an environment variable")
    .action(plannedCommand("auth"));

  program
    .command("init")
    .description("Bind the current paper repository to one Overleaf project.")
    .requiredOption("--project <url-or-id>", "Overleaf project URL or project id")
    .option("--vscode", "Create optional VS Code settings and tasks for PDF preview")
    .action(plannedCommand("init"));

  program
    .command("sync")
    .description("Synchronize local files and the bound Overleaf project without silent overwrites.")
    .option("--dry-run", "Show planned sync operations without changing files")
    .action(plannedCommand("sync"));

  program
    .command("compile")
    .description("Compile the bound Overleaf project and download the PDF artifact.")
    .option("--pdf <path>", "PDF output path", "build/overleaf/main.pdf")
    .action(plannedCommand("compile"));

  program
    .command("watch")
    .description("Watch local source changes, debounce them, then sync and compile.")
    .option("--debounce <ms>", "Debounce window in milliseconds", "2500")
    .action(plannedCommand("watch"));

  program
    .command("status")
    .description("Show binding, authorization, and sync state for the current paper repository.")
    .action(plannedCommand("status"));

  program
    .command("doctor")
    .description("Check the local olcx environment and project configuration.")
    .action(plannedCommand("doctor"));

  return program;
}

export function run(argv = process.argv): void {
  buildCli().parse(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
