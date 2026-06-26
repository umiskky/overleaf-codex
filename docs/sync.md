# Sync

`olcx sync` synchronizes the local paper repository with the bound Overleaf
project. It must not silently overwrite local or remote changes.

## Dry Run First

```bash
olcx sync --dry-run
```

The dry run prints planned uploads, downloads, and deletes without changing
files. Use it before any manual sync in a repository that may have local or
remote edits.

## Apply A Clean Plan

```bash
olcx sync
```

`olcx sync` applies the plan only when it can do so safely. The sync state is
stored under `.olcx/state/` and generated reports are local-only.

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
