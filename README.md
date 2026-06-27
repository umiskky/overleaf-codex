<p align="center">
  <img src="assets/olcx-mark.svg" alt="olcx" width="96" height="96">
</p>

# overleaf-codex

[![CI](https://github.com/umiskky/overleaf-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/umiskky/overleaf-codex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-v1--stable--released-green.svg)](#current-status)

`overleaf-codex` provides the `olcx` CLI for writing LaTeX papers locally while
using a bound Overleaf project for remote compilation.

The workflow is CLI-first:

- edit the paper locally in VS Code or another editor;
- keep source history in local Git;
- bind one paper repository to one Overleaf project by default;
- store Overleaf authorization in project-local ignored files;
- sync without silently overwriting local or remote changes;
- compile on Overleaf and download the PDF to a stable local path.

`olcx` does not require a local LaTeX installation for the core workflow. It does
not include a VS Code extension; `olcx init` creates or repairs local VS Code
settings and tasks by default.

## Install

From npm:

```bash
npm install -g overleaf-codex
olcx --help
```

From a checkout:

```bash
npm install
npm run build
npm run dev -- --help
```

## First Run

Run these commands from the root of a paper repository:

```bash
git init
olcx init --project https://www.overleaf.com/project/<overleaf-project-id>
olcx endpoint status
olcx endpoint test
olcx auth
olcx status
olcx doctor
olcx sync --dry-run
olcx sync
olcx compile
olcx watch
```

`olcx init` creates `.olcx/config.json`, updates local ignore rules, and merges
`.vscode/settings.json` and `.vscode/tasks.json`. The generated VS Code tasks
cover status, doctor, sync dry-run, sync apply, compile, watch, and read-only
endpoint checks.

For headless shells or CI-like terminals, provide the session cookie through an
environment variable instead of an interactive prompt:

```bash
export OLCX_OVERLEAF_SESSION='<copied-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
unset OLCX_OVERLEAF_SESSION
```

`olcx auth` writes only project-local authorization:

```text
.olcx/auth.local.json
```

That file is ignored by Git and must not be committed. `olcx` must not store
Overleaf passwords.

## Current Status

v1 is released as `0.1.1`. Release gates, stable approval, and the sanitized
disposable real Overleaf E2E artifact are tracked in
[docs/release-notes-v1.md](docs/release-notes-v1.md).

The implemented command surface is:

```bash
olcx auth
olcx init --project <overleaf-url-or-id>
olcx endpoint status
olcx endpoint test
olcx endpoint set cn
olcx endpoint test --apply
olcx sync --dry-run
olcx sync
olcx pull --mode rebase
olcx pull --mode reset
olcx push
olcx compile
olcx watch
olcx status
olcx doctor
```

The detailed CLI behavior, output, redaction, and exit-code contract is
documented in [docs/cli-behavior.md](docs/cli-behavior.md).

Endpoint testing is read-only and manual by default. `olcx endpoint test` probes
public reachability for `https://www.overleaf.com/project` and
`https://cn.overleaf.com/project`; it does not sync, upload, compile, validate
auth, or modify remote projects. The configured endpoint is stored as
`overleaf.baseUrl` in `.olcx/config.json`, and `olcx endpoint test --apply` is
the only automatic selection mode.

## Sync And Compile

`olcx sync --dry-run` shows the planned upload, download, and delete actions.
`olcx sync` applies a clean plan. If the same path changed locally and remotely,
`olcx` stops with `SYNC_CONFLICT` and writes a conflict report under
`.olcx/state/conflicts.json`; it must not silently overwrite either side.

Manual conflict recovery:

```bash
olcx sync --dry-run
cat .olcx/state/conflicts.json
olcx sync
```

`olcx compile` asks Overleaf to compile the bound project and downloads the PDF:

```text
build/overleaf/main.pdf
```

You can override that path with `olcx compile --pdf build/overleaf/main.pdf`.
`olcx watch` pauses on `SYNC_CONFLICT` or compile failure and prints the manual
command to run next.

## Documentation

- [docs/usage.md](docs/usage.md) covers the full install-to-watch workflow.
- [docs/auth.md](docs/auth.md) covers interactive and headless auth.
- [docs/sync.md](docs/sync.md) covers dry runs, conflicts, and safe recovery.
- [docs/compile.md](docs/compile.md) covers remote compile and PDF output.
- [docs/endpoint.md](docs/endpoint.md) covers `www`/`cn` endpoint selection.
- [docs/troubleshooting.md](docs/troubleshooting.md) lists diagnosis commands.
- [docs/npm-packaging.md](docs/npm-packaging.md) explains package contents.
- [docs/release-gates.md](docs/release-gates.md) explains release checks.
- [docs/release-notes-v1.md](docs/release-notes-v1.md) records the v1 release status, release notes, known limitations, and stable-release approval.

See the [minimal example paper](examples/minimal-paper/README.md) for a
sanitized project layout with `.olcx/config.json`, an auth-file shape example,
the default `build/overleaf/main.pdf` output path, and the `olcx watch` flow.
Replace `<overleaf-project-id>` with your own project reference through
`olcx init --project https://www.overleaf.com/project/<overleaf-project-id>`.

## Relationship to olcli

`olcx` vendors backend-private code copied or adapted from `@aloth/olcli@0.5.0`
as an Overleaf backend foundation.

- Source repository: https://github.com/aloth/olcli
- Source tag: `v0.5.0`
- Source commit: `524c30b11328a847a9c0bcf4447d2b3468160f8c`
- Copied/adapted file: upstream `src/client.ts` to `src/backend/olcli/client.ts`
- License: MIT
- Copyright: Copyright (c) 2026 Alexander Loth

Users install and run `olcx`; they do not need to install `olcli` separately.
`@aloth/olcli` is not a runtime dependency of this package.

`olcx` is not an official Overleaf project and is not an official `olcli` project.
It is not affiliated with, endorsed by, or maintained by Overleaf or `olcli`.

## Security Model

`olcx` must never commit Overleaf credentials, cookies, passwords, or local
session files. Keep `.olcx/auth.local.json`, `*.local.json`, and
`*.secret.json` ignored. See [docs/security.md](docs/security.md) and
[SECURITY.md](SECURITY.md).

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
OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real
npm audit --audit-level=high
npm run prepublish:check
```

## Contributing

This project is intended to be open source and community-maintained. Before
contributing, read:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)
- [ROADMAP.md](ROADMAP.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
