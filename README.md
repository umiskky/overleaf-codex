# overleaf-codex

`overleaf-codex` is a planned CLI tool for writing LaTeX papers locally while using
Overleaf as the remote compiler.

The command name is `olcx`.

## Goal

Overleaf's Git and GitHub synchronization features require a paid plan, while local
Git is still the best way to manage source history, review changes, and work with
Codex in VS Code. `olcx` is designed to combine those strengths:

- edit the paper locally in VS Code;
- use Git for local project history;
- use Codex for writing, editing, and review assistance;
- upload changes to a bound Overleaf project;
- trigger Overleaf compilation remotely;
- download the compiled PDF to a stable local path for preview.

The first implementation target is a lightweight cross-platform CLI, not a VS Code
extension or GUI.

## Current status

This repository is initialized as the project scaffold. The CLI command surface is
present, but the Overleaf backend is not implemented yet.

```bash
npm install
npm run build
node dist/cli.js --help
```

During development:

```bash
npm run dev -- --help
npm test
```

## Planned command surface

```bash
olcx auth
olcx init --project <overleaf-url-or-id> --vscode
olcx sync
olcx compile
olcx watch
olcx status
olcx doctor
```

`olcx auth` stores authorization for the current paper project. Authorization is
project-local by design, so different paper repositories can use different
Overleaf accounts.

## Paper project layout

In a real paper repository, `olcx` will create a `.olcx/` directory:

```text
.olcx/
  config.json       # shareable binding and workflow config
  auth.local.json   # local Overleaf session data, never committed
```

The default compiled PDF path is:

```text
build/overleaf/main.pdf
```

That path is meant for local preview and is ignored by Git by default.

## Relationship to olcli

`olcx` will use code from the MIT-licensed
[`aloth/olcli`](https://github.com/aloth/olcli) project as an initial Overleaf
backend foundation.

This is a one-time integration strategy:

- users install and run `olcx`, not `olcli`;
- `olcli` is not planned as a runtime dependency that users must install
  separately;
- after integration, this repository maintains the `olcx` code independently;
- license and notice files must preserve the original MIT attribution for any
  copied or adapted `olcli` code.

`olcx` is not an official Overleaf project and is not affiliated with Overleaf.

## Security model

`olcx` must never commit Overleaf credentials, cookies, or local session files.

The project-level authorization file is:

```text
.olcx/auth.local.json
```

It is intentionally ignored by Git. See [docs/security.md](docs/security.md) for
the detailed rules.

## Development

Requirements:

- Node.js 20 or newer
- npm 10 or newer

Useful commands:

```bash
npm install
npm run build
npm run typecheck
npm test
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
