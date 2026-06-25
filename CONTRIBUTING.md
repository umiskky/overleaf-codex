# Contributing

Thanks for helping improve `overleaf-codex`.

The project is early. Contributions should keep the tool small, testable, and
safe for real paper repositories.

## Development setup

```bash
npm install
npm run build
npm run typecheck
npm test
```

Use Node.js 20 or newer.

## Contribution priorities

High-value work:

- documentation for real authoring workflows;
- project-local auth and secret handling;
- safe sync behavior with clear conflict reporting;
- Overleaf backend integration based on MIT-licensed `olcli` code;
- cross-platform behavior on Linux, macOS, Windows, and headless servers.

Avoid expanding scope before the CLI is useful. GUI, VS Code extension, and
multi-project workspace features are not first-version goals.

## Pull request expectations

- Keep changes focused.
- Add or update tests for behavior changes.
- Update docs when user-facing behavior changes.
- Never add real Overleaf cookies, passwords, private project IDs, or paper
  contents to tests or docs.
- Preserve MIT notices when copying or adapting code from `aloth/olcli`.

## Local verification

Before opening a pull request, run:

```bash
npm run build
npm run typecheck
npm test
npm audit
```

## Commit style

Use short, descriptive commits:

```text
feat: add project-local auth loader
docs: explain headless cookie flow
test: cover sync conflict pause state
```
