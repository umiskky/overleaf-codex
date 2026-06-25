# Usage model

This document describes the intended user workflow once the backend is
implemented.

## Install

During local development:

```bash
npm install
npm run build
npm link
```

After package publication, users should install `olcx` directly. They should not
need to install `olcli`.

## Bind a paper repository

From a paper repository:

```bash
olcx init --project https://www.overleaf.com/project/<project-id> --vscode
```

This creates project-local config in `.olcx/config.json`, updates ignore rules
for local secrets and generated PDF output, and optionally creates VS Code
settings/tasks.

## Authorize Overleaf

```bash
olcx auth
```

The default auth flow stores authorization for the current paper repository only.
That lets different paper projects use different Overleaf accounts.

For headless machines, the planned fallback is to set or paste a session cookie
obtained from a browser where the user is already logged in.

## Work loop

```bash
olcx watch
```

The watcher detects local changes, waits for a debounce window, synchronizes safe
changes, compiles on Overleaf, and downloads the PDF to:

```text
build/overleaf/main.pdf
```

Manual commands remain available for debugging:

```bash
olcx sync
olcx compile
olcx status
olcx doctor
```

## Conflict behavior

If the same file changed locally and on Overleaf, the automatic flow pauses and
prints a conflict report. `olcx` must not silently overwrite either side.
