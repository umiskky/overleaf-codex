# Sync State

## Purpose And Scope

`olcx sync` and `olcx watch` use one shared state machine for file comparison,
ignore handling, delete safety, conflict semantics, and recovery guidance. Watch
does not define a second conflict model; it pauses on the same conflicts that a
manual sync reports.

This document defines planning, local snapshots, and conflict reporting. It does
not implement real Overleaf calls, backend adapters, filesystem reads, filesystem
writes, or command wiring.

## Local State Files

The sync state file is:

```text
.olcx/state/sync.json
```

It stores the last successful bidirectional sync baseline used by sync and watch.
It is local-only state, must remain ignored by Git, and is not shareable project
configuration.

The conflict report file is:

```text
.olcx/state/conflicts.json
```

It stores the latest local diagnostic report for a paused sync/watch flow. It is
not a source of file truth and must not be committed.

Neither file may contain authorization data, credentials, session values,
passwords, cookies, file contents, private compile logs, raw backend responses,
or private paper content.

## Content Digest

Content digests use SHA-256 and are encoded as lowercase hexadecimal strings.
The digest is computed over exact bytes. If a caller has a string, it hashes
`Buffer.from(value)` with the default UTF-8 encoding. If a caller has bytes, it
hashes those bytes directly.

Line endings are not normalized before hashing. This keeps the baseline honest:
if local bytes differ from remote bytes, the hashes differ.

Remote digests may use backend-provided hashes only when the backend hash is
semantically the same content digest. If not, a later backend task must download
the bytes and hash them before planning.

## Path Normalization

All sync paths are repository-relative POSIX-style paths with forward slashes.
Inputs such as `./main.tex` normalize to `main.tex`, and Windows separators are
converted to `/`.

Absolute paths and parent traversal are not valid sync targets. Paths such as
`/tmp/main.tex`, `../main.tex`, and `sections/../main.tex` must not escape the
paper repository. A pure planner may treat them as safe ignored inputs or as
unsupported conflicts, but it must never upload, download, delete, or watch them.

## State Schema

The persisted state shape is:

```json
{
  "schemaVersion": 1,
  "hashAlgorithm": "sha256",
  "updatedAt": "2026-06-25T08:00:00.000Z",
  "files": {
    "main.tex": {
      "path": "main.tex",
      "contentHash": "<sha256-hex>",
      "size": 1234,
      "localModifiedAt": "2026-06-25T07:59:00.000Z",
      "remoteModifiedAt": "2026-06-25T07:58:00.000Z",
      "remoteId": "<remote-file-id>",
      "remoteRevision": "<remote-revision>",
      "syncedAt": "2026-06-25T08:00:00.000Z"
    }
  }
}
```

`schemaVersion` is `1` for the v1 state file. `hashAlgorithm` is `sha256`.
`updatedAt` is the time the state file was last replaced after a successful
non-dry-run sync.

Each file entry stores the repository-relative path, content hash, optional size,
optional local and remote modified times, optional remote identity metadata, and
the time that path was last known to be synchronized.

## Remote And Local Snapshot Fields

Local snapshots use these fields:

| Field | Meaning |
| --- | --- |
| `path` | Repository-relative POSIX path. |
| `exists` | Whether the local file exists at snapshot time. |
| `contentHash` | SHA-256 digest when the file exists. |
| `size` | File size in bytes when available. |
| `modifiedAt` | Local modified timestamp when available. |
| `ignored` | Whether the path was already classified as ignored by the caller. |

Remote snapshots use these fields:

| Field | Meaning |
| --- | --- |
| `path` | Repository-relative POSIX path. |
| `exists` | Whether the remote file exists at snapshot time. |
| `contentHash` | SHA-256 digest or equivalent backend content digest. |
| `size` | Remote file size in bytes when available. |
| `modifiedAt` | Remote modified timestamp when available. |
| `remoteId` | Backend file identifier for later operations. |
| `revision` | Backend revision marker for conflict diagnostics. |
| `binary` | Whether the remote entry should be treated as binary. |

Snapshots contain metadata only. They do not contain file bodies.

## Ignore Precedence

Ignore handling is deterministic and shared by sync and watch.

1. Normalize paths to repository-relative POSIX paths.
2. Reject or safe-ignore absolute paths and paths containing `..`.
3. Apply built-in safety ignores first.
4. Apply user-configured ignores second.
5. Do not support negated unignore rules such as `!path` in v1.

The built-in safety ignores are:

```text
.git/
node_modules/
.olcx/auth.local.json
.olcx/*.local.json
.olcx/*.secret.json
.olcx/state/
build/overleaf/
*.aux
*.bbl
*.bcf
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.run.xml
*.synctex.gz
*.toc
```

User ignores are appended after the built-in set, so they can exclude more files
but cannot re-include a built-in safety ignore.

Ignored paths become `ignored` operations. They never upload, download, delete,
watch-trigger, or become blocking conflicts.

## SyncPlan Operations

`SyncPlan` operations are:

| Operation | Meaning |
| --- | --- |
| `upload` | Local content is the only safe change and should be sent to remote during apply. |
| `download` | Remote content is the only safe change and should be written locally during apply. |
| `deleteLocal` | A remote deletion may remove the local file only in an explicit delete-allowed flow. |
| `deleteRemote` | A local deletion may remove the remote file only in an explicit delete-allowed flow. |
| `unchanged` | No apply action is needed for this path. |
| `conflict` | Automatic apply must pause for this path. |
| `ignored` | The path is excluded and must not be applied or reported as a conflict. |

The v1 default matrix is:

| Baseline | Local now | Remote now | Result |
| --- | --- | --- | --- |
| absent | present | absent | `upload` |
| absent | absent | present | `download` |
| absent | present hash A | present hash A | `unchanged` |
| absent | present hash A | present hash B | `conflict`, `both-modified` |
| present hash A | present hash A | present hash A | `unchanged` |
| present hash A | present hash B | present hash A | `upload` |
| present hash A | present hash A | present hash B | `download` |
| present hash A | present hash B | present hash B | `unchanged` |
| present hash A | present hash B | present hash C | `conflict`, `both-modified` |
| present hash A | present hash B | absent | `conflict`, `local-modified-remote-deleted` |
| present hash A | absent | present hash B | `conflict`, `remote-modified-local-deleted` |
| present hash A | present hash A | absent | default `conflict`, `unsafe-delete`; with `allowDeletes: true`, `deleteLocal` |
| present hash A | absent | present hash A | default `conflict`, `unsafe-delete`; with `allowDeletes: true`, `deleteRemote` |
| present hash A | absent | absent | `unchanged`, `both-deleted` |
| any | ignored | any | `ignored` |
| any | any | ignored | `ignored` |

Any non-empty `conflicts` list pauses automatic sync and watch application.

## V1 Delete Policy

Automatic deletes are disabled by default in CLI v1. A missing file on one side
can mean a deliberate delete, a stale listing, a backend issue, or a local
mistake. The default planner therefore downgrades risky or implicit deletes to a
`conflict` with reason `unsafe-delete`.

`deleteLocal` and `deleteRemote` remain in the type contract for a future
explicit user-confirmed flow or a carefully gated internal `allowDeletes` mode.
The default CLI path must not pass `allowDeletes: true`.

## Conflict Report Format

The conflict report path is:

```text
.olcx/state/conflicts.json
```

The report contains paths, content hashes, sizes, timestamps, known remote
metadata, suggested commands, watch pause state, and manual steps. It does not
include the raw project id because resolving conflicts does not require it.

Example:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-25T08:00:00.000Z",
  "reportPath": ".olcx/state/conflicts.json",
  "syncStatePath": ".olcx/state/sync.json",
  "watch": {
    "paused": true,
    "reason": "sync-conflict",
    "resumeCommand": "olcx watch"
  },
  "conflicts": [
    {
      "path": "main.tex",
      "reason": "both-modified",
      "local": {
        "contentHash": "<local-sha256-hex>",
        "size": 1234,
        "modifiedAt": "2026-06-25T08:00:00.000Z"
      },
      "remote": {
        "contentHash": "<remote-sha256-hex>",
        "size": 1250,
        "modifiedAt": "2026-06-25T08:01:00.000Z",
        "remoteId": "<remote-file-id>",
        "revision": "<remote-revision>"
      },
      "base": {
        "contentHash": "<base-sha256-hex>",
        "size": 1200,
        "syncedAt": "2026-06-25T07:50:00.000Z"
      },
      "suggestedCommands": ["olcx sync --dry-run", "olcx sync"],
      "manualSteps": [
        "Review main.tex locally and in Overleaf.",
        "Review both versions, merge manually, then run olcx sync --dry-run.",
        "Run olcx sync --dry-run before applying changes."
      ]
    }
  ],
  "manualSteps": [
    "Open each conflict path locally and in Overleaf.",
    "Choose local, remote, or a manual merge.",
    "Run olcx sync --dry-run.",
    "Run olcx sync after the dry run is clean.",
    "Restart olcx watch if you use the watcher."
  ]
}
```

Conflict reports must copy only known metadata fields. They must exclude full
file contents, cookies, passwords, session values, authorization data, CSRF
values, raw private logs, and raw backend responses. Formatting must pass
serialized output through the shared redaction helper before display or storage.

## Snapshot Update Rules

- Do not update `.olcx/state/sync.json` during `--dry-run`.
- Do not update the snapshot when the plan contains any `conflict`.
- Do not update the snapshot when any apply step fails.
- Update the snapshot only after a complete successful non-dry-run sync apply.
- For `upload` or `download`, the new baseline digest is the resulting content
  hash shared by both sides.
- For `unchanged`, keep or refresh metadata when local and remote hashes match.
- For `ignored`, do not persist ignored path entries.
- For successful user-confirmed deletes in a future flow, remove the deleted
  path from the state.
- Never write auth data, cookies, session values, file contents, private logs, or
  full remote responses into the state file.

## Testing Contract

Sync state-machine tests cover pure functions with in-memory snapshots. They do
not use real Overleaf, local LaTeX, filesystem writes, backend calls, network
calls, Commander imports, or CLI wiring.

Required coverage includes local-only upload, remote-only download, unchanged
hashes, built-in ignores, user ignores, both-modified conflicts, local-modified
versus remote-deleted conflicts, remote-modified versus local-deleted conflicts,
default unsafe delete downgrades, explicit `allowDeletes` mode, dry-run flag
preservation, summary counts, and conflict report redaction.
