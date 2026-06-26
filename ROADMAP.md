# Roadmap

This roadmap is intentionally narrow. v1 is a CLI-first stable release, not a
large platform. Stable v1 is released after a sanitized disposable real Overleaf
E2E artifact was recorded.

## v1 Stable

The v1 stable release includes:

- TypeScript CLI packaging with build, typecheck, test, audit, and prepublish
  gates.
- Open-source docs, contribution rules, security policy, CI, and release notes.
- MIT-attributed backend-private code copied or adapted from `@aloth/olcli@0.5.0`.
- `olcx auth`, `olcx init --project <url-or-id> --vscode`, `olcx status`, and
  `olcx doctor`.
- Project-local auth in `.olcx/auth.local.json` and shareable binding config in
  `.olcx/config.json`.
- Safe bidirectional sync that stops on `SYNC_CONFLICT` instead of silently
  overwriting local or remote changes.
- Remote Overleaf-backed compile that downloads to `build/overleaf/main.pdf`
  without requiring local LaTeX.
- `olcx watch` with debounce and queued sync/compile behavior.

## Stable release gate

Stable v1 approval requires a sanitized disposable real Overleaf E2E artifact.
Raw cookies, session values, account labels, private project IDs, and private
paper content must stay out of the repository.

## Post-v1

- Improve structured output for automation.
- Expand compatibility coverage as Overleaf behavior changes.
- Improve docs with additional sanitized examples and troubleshooting.
- Consider optional VS Code extension only after the CLI workflow is stable.
