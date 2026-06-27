# Sync

`olcx sync` performs the default local-incremental sync for the bound Overleaf
project. It uploads local files that changed from the last `.olcx/state`
baseline and uses remote metadata to stop before overwriting a path that also
changed on Overleaf. It does not download every remote file just to compute
hashes. Sync must not silently overwrite local or remote changes.

## Dry Run First

```bash
olcx sync --dry-run
```

The dry run prints planned uploads without changing files. Use it before any
manual sync in a repository that may have local edits.

## Apply A Clean Plan

```bash
olcx sync
```

`olcx sync` applies the plan only when it can do so safely. The sync state is
stored under `.olcx/state/` and generated reports are local-only. Applied
transfers show file-level progress, retry transient failures using the configured
retry budget, and end with a table of path, size, duration, and attempts.

For the older strict bidirectional check, use:

```bash
olcx sync --strict --dry-run
olcx sync --strict
```

Strict mode may download remote files that lack usable hash metadata.

## Pull And Push

Use `pull` when the Overleaf project should drive local files:

```bash
olcx pull --mode rebase
olcx pull --mode reset
```

`rebase` pulls remote changes while keeping local edits; same-path local and
remote edits stop with `SYNC_CONFLICT`. `reset` replaces local files with the
remote project and removes local-only files.

Use `push` when the local repository should overwrite Overleaf:

```bash
olcx push
olcx push --no-prune
```

`push` uploads all local non-ignored files and prunes remote-only files by
default. `--no-prune` keeps remote-only files.

## Conflict Handling

If the same path changed locally and on Overleaf, `olcx` exits with
`SYNC_CONFLICT` and writes:

```text
.olcx/state/conflicts.json
```

Review each listed path locally and in Overleaf, choose the correct content or
perform a manual merge, then rerun:

```bash
olcx sync --dry-run
cat .olcx/state/conflicts.json
olcx sync
```

Do not delete the conflict report until you understand why the conflict
happened.
Do not commit `.olcx/state/` files. Conflict reports contain metadata and paths only; they must not contain cookies, auth values, raw backend responses, private logs, or paper content.

## Watch Integration

`olcx watch` pauses when sync reports a conflict. Resolve the conflict manually,
confirm the dry run is clean, then restart the watcher.
