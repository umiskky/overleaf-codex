# Troubleshooting

Use `olcx status` and `olcx doctor` first. They are local checks and do not
contact Overleaf by default.

For workflow detail, see [Auth](auth.md), [Sync](sync.md), and
[Compile](compile.md).

## Auth Failure

Symptoms: `AUTH_ERROR`, missing `.olcx/auth.local.json`, invalid local auth, or
Overleaf rejecting the current session.

```bash
olcx status
olcx doctor
export OLCX_OVERLEAF_SESSION='<replace-with-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
unset OLCX_OVERLEAF_SESSION
```

Next actions: regenerate project-local auth, keep `.olcx/auth.local.json`
ignored, and retry the command that failed. Do not paste cookies into tracked
docs, issues, tests, or handoff files.

## Project Binding Failure

Symptoms: missing `.olcx/config.json`, invalid config, or a repository already
bound to a different Overleaf project.

```bash
olcx status
cat .olcx/config.json
olcx init --project https://www.overleaf.com/project/<your-project-id>
```

Next actions: confirm you are in the intended paper repository. If the repo is
already bound to another project, edit `.olcx/config.json` intentionally or use a
fresh repository; `olcx init` will not silently rebind it.

## Sync Conflict

Symptoms: `SYNC_CONFLICT`, watch paused after sync, or a conflict report under
`.olcx/state/conflicts.json`.

```bash
olcx sync --dry-run
cat .olcx/state/conflicts.json
olcx sync
```

Next actions: review each listed path locally and in Overleaf, choose local,
remote, or a manual merge, then rerun `olcx sync --dry-run`. Run `olcx sync`
only after the dry run is clean.

## Compile Failure

Symptoms: `COMPILE_FAILED`, `COMPILE_TIMEOUT`, missing package errors, or fast
fallback warnings.

```bash
olcx compile
olcx compile --disable-fast-fallback
olcx compile --fast-fallback-timeout 60000
```

Next actions: inspect the compile log summary printed by `olcx compile`, fix the
LaTeX source on Overleaf or locally, and retry. `olcx` does not require local
LaTeX for the core workflow.

## PDF Not Updated

Symptoms: compile succeeds but the preview still shows an old PDF, or
`build/overleaf/main.pdf` is missing.

```bash
olcx compile
ls -l build/overleaf/main.pdf
olcx status
```

Next actions: confirm `pdfPath` in `.olcx/config.json` is
`build/overleaf/main.pdf` or the path you expect, then open that exact file in
your previewer. If the file timestamp does not change, rerun `olcx compile` and
check for PDF retrieval errors.

## Watch Loop

Symptoms: `olcx watch` repeatedly reacts to generated files, pauses after a
workflow failure, or keeps compiling when no paper source changed.

```bash
olcx watch --debounce 2500
olcx sync --dry-run
olcx compile
```

Next actions: confirm `.gitignore` contains `build/overleaf/`, `.olcx/state/`,
`.olcx/auth.local.json`, `.olcx/*.local.json`, `.olcx/*.secret.json`,
`*.local.json`, and `*.secret.json`. Stop watch, fix the sync or compile issue
manually, then restart `olcx watch`.

## Network Problems

Symptoms: `NETWORK_ERROR`, backend protocol errors, timeouts while talking to
Overleaf, or commands that fail only when remote access is needed.

```bash
olcx endpoint status
olcx endpoint test
olcx endpoint set cn
olcx endpoint test --apply
olcx doctor
olcx sync --dry-run
```

Next actions: check local network access, proxy or firewall settings, and
Overleaf availability. `olcx endpoint test` probes only public `/project`
reachability for `https://www.overleaf.com` and `https://cn.overleaf.com`.
`olcx endpoint set cn` and `olcx endpoint test --apply` update
`overleaf.baseUrl` in `.olcx/config.json`. Retry the failing command after
network access is restored. `olcx doctor` is offline by default, so a passing
doctor result does not prove the current Overleaf session or network path is
valid.
