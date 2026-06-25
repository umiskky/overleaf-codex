# Design

## Product intent

`olcx` connects a local paper repository to one Overleaf project. The local side
owns editing, Git history, VS Code preview, and Codex-assisted writing. Overleaf
owns LaTeX compilation and PDF generation.

The target experience is:

1. Author edits locally.
2. `olcx watch` detects a quiet period after changes.
3. `olcx` synchronizes safe changes with Overleaf.
4. `olcx` triggers Overleaf compilation.
5. `olcx` downloads the PDF to `build/overleaf/main.pdf`.
6. VS Code previews that file.

## Architecture

The first implementation is an npm/TypeScript CLI named `olcx`.

The Overleaf backend will be based on a one-time integration of MIT-licensed
`aloth/olcli` code. Users install `olcx` only; they do not install `olcli`
separately. This repository owns future behavior, maintenance, docs, and release
packaging.

The CLI should remain split into small units:

- command parsing and user-facing output;
- project config and auth file handling;
- Overleaf backend adapter;
- sync and conflict policy;
- compile and PDF download flow;
- watch and debounce queue;
- diagnostics.

## Project-local state

Each real paper repository has a `.olcx/` directory.

`config.json` is intended to be shareable:

```json
{
  "projectId": "overleaf-project-id",
  "pdfPath": "build/overleaf/main.pdf",
  "sync": {
    "mode": "bidirectional",
    "conflictPolicy": "pause"
  }
}
```

`auth.local.json` is local-only:

```json
{
  "account": "user@example.com",
  "sessionCookie": "redacted",
  "updatedAt": "2026-06-25T00:00:00.000Z"
}
```

The exact schema can evolve, but auth stays project-local and ignored by Git.

## Sync policy

The default sync mode is bidirectional, but not destructive.

If local and Overleaf versions changed the same file, `olcx` pauses the automatic
queue and reports the conflict. It must not choose a winner silently. Manual
commands can later resolve conflicts by choosing local, remote, or a user-merged
file.

## Non-goals for v1

- No GUI.
- No VS Code extension.
- No local LaTeX dependency.
- No multi-project workspace manager.
- No silent overwrites.
- No committed credentials or cookies.
