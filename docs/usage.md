# Usage

This page shows the common install, bind, auth, sync, compile, and watch flow for
one local paper repository bound to one Overleaf project.

## Install

Published package:

```bash
npm install -g overleaf-codex
olcx --help
```

Local checkout:

```bash
npm install
npm run build
npm link
olcx --help
```

Users do not need to install `olcli` separately, and the core workflow does not
require local LaTeX.

## Bind

From a paper repository:

```bash
olcx init --project https://www.overleaf.com/project/<overleaf-project-id>
```

This creates `.olcx/config.json`, updates ignore rules for local secrets and
generated PDF output, and creates or merges local VS Code settings/tasks by
default. The default binding model is one paper repository to one Overleaf
project.

## Authorize

Interactive terminal:

```bash
olcx auth
```

Headless Linux/macOS shell:

```bash
export OLCX_OVERLEAF_SESSION='<copied-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
unset OLCX_OVERLEAF_SESSION
```

Headless Windows PowerShell:

```powershell
$env:OLCX_OVERLEAF_SESSION = '<copied-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
Remove-Item Env:OLCX_OVERLEAF_SESSION
```

One-shot paste:

```bash
olcx auth --cookie '<copied-session-cookie>'
```

Auth is stored in `.olcx/auth.local.json` for the current paper repository only.
That file is ignored by Git.

## Inspect

Use local diagnostics before changing remote state:

```bash
olcx status
olcx doctor
```

`olcx status` summarizes binding, auth presence, and sync state. `olcx doctor`
checks local prerequisites and config without requiring a local LaTeX
installation.

## Endpoint

Inspect and choose the Overleaf web endpoint for this paper repository:

```bash
olcx endpoint status
olcx endpoint test
olcx endpoint set cn
olcx endpoint test --apply
```

The configured value is stored as `overleaf.baseUrl` in `.olcx/config.json` and
is either `https://www.overleaf.com` or `https://cn.overleaf.com`. `olcx
endpoint test` is read-only by default and probes only public `/project`
reachability. `olcx endpoint test --apply` is the only automatic selection mode;
it writes config only when at least one endpoint is available.

## Manual Sync

Always preview remote-changing operations first:

```bash
olcx sync --dry-run
olcx sync
```

If `olcx` reports `SYNC_CONFLICT`, review `.olcx/state/conflicts.json` and
resolve the listed files intentionally before rerunning `olcx sync --dry-run`.
Sync must not silently overwrite local or remote changes.

## Manual Compile

Compile on Overleaf and download the PDF:

```bash
olcx compile
olcx compile --pdf build/overleaf/main.pdf
```

The default PDF path is:

```text
build/overleaf/main.pdf
```

## Watch

Run the normal authoring loop:

```bash
olcx watch
```

The watcher detects local file changes, debounces them, runs sync, compiles on
Overleaf, and downloads the PDF. Generated PDFs, `.olcx/state/`, and local auth
files are ignored so the watch loop does not react to its own outputs.

## Headless Use

Set `OLCX_NON_INTERACTIVE=1` or `CI=true` when a command must fail fast instead
of prompting for auth input. For real Overleaf E2E smoke checks that should not
read a developer machine's `.env.e2e.local`, run:

```bash
OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real
```

## Conflict Handling

When sync detects both local and remote edits to the same path, it exits with
`SYNC_CONFLICT`, writes `.olcx/state/conflicts.json`, and leaves both sides
unchanged. Inspect the report, merge or choose the intended content manually,
then confirm with:

```bash
olcx sync --dry-run
cat .olcx/state/conflicts.json
olcx sync
```

## Platform Notes

`olcx watch` uses Node and chokidar. It listens for local `add`, `change`, and
`unlink` events, normalizes Windows and POSIX paths to repository-relative
`/`-separated paths, then runs one sync/compile cycle at a time.

Ctrl-C sends `SIGINT` in common Linux, macOS, and Windows terminals. `olcx watch`
also handles `SIGTERM` for process managers. Filesystem watchers can coalesce or
delay events on network drives, WSL, and synced folders, so use `olcx sync
--dry-run` and `olcx compile` when debugging a paused watch loop.

## More Detail

- [Auth](auth.md)
- [Endpoint](endpoint.md)
- [Sync](sync.md)
- [Compile](compile.md)
- [Troubleshooting](troubleshooting.md)
- [npm Packaging](npm-packaging.md)
