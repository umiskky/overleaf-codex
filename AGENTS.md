# AGENTS.md

This repository builds `olcx`, a TypeScript CLI for connecting local LaTeX paper
repositories with Overleaf-backed compilation.

## Project rules

- Keep the first implementation lightweight and CLI-first.
- Do not require a local LaTeX installation for the core workflow.
- Do not build a VS Code extension in the first version; generate optional VS Code
  settings/tasks from the CLI instead.
- One paper repository binds to one Overleaf project by default.
- Sync must not silently overwrite local or remote changes.

## Security rules

- Never commit Overleaf credentials, passwords, cookies, or session values.
- Project-local auth belongs in `.olcx/auth.local.json`.
- `.olcx/auth.local.json` and other `*.local.json` / `*.secret.json` files must
  remain ignored by Git.
- Do not add real paper content, private Overleaf project IDs, or user cookies to
  fixtures.

## olcli integration

- `olcx` may copy or adapt MIT-licensed code from `aloth/olcli`.
- Preserve original MIT attribution and notices for copied or adapted code.
- Users should not need to install `olcli` separately at runtime.
- Do not describe `olcx` as an official Overleaf or `olcli` project.

## Commands

```bash
npm install
npm run build
npm run typecheck
npm test
npm run dev -- --help
```

## Coding style

- Use TypeScript and small modules with explicit responsibilities.
- Keep command implementations thin; put workflow logic behind testable modules.
- Prefer deterministic tests with fake Overleaf/HTTP or fake CLI adapters.
- Use clear, user-facing error messages for auth, sync, and conflict failures.
