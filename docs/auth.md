# Auth

`olcx auth` stores project-local Overleaf authorization for the current paper
repository. It must not store Overleaf passwords.

## Interactive Auth

```bash
olcx auth
```

The command prompts for a copied Overleaf session cookie and writes:

```text
.olcx/auth.local.json
```

The auth file is ignored by Git and should never be pasted into issues, docs,
tests, or handoff files.

## Headless Auth

Linux/macOS:

```bash
export OLCX_OVERLEAF_SESSION='<copied-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
unset OLCX_OVERLEAF_SESSION
```

Windows PowerShell:

```powershell
$env:OLCX_OVERLEAF_SESSION = '<copied-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
Remove-Item Env:OLCX_OVERLEAF_SESSION
```

One-shot paste:

```bash
olcx auth --cookie '<copied-session-cookie>'
```

Use `OLCX_NON_INTERACTIVE=1` or `CI=true` when prompts are not allowed.
Prefer `--from-env` for shared terminals and shell history. Use `--account
<label>` only for a local label shown by `olcx status`; do not put private
account data in public logs.

## Non-Interactive Mode

```bash
OLCX_NON_INTERACTIVE=1 olcx auth --from-env OLCX_OVERLEAF_SESSION
```

`OLCX_NON_INTERACTIVE=1` and `CI=true` make auth fail fast when no source is
provided.

## Safety Rules

- Keep `.olcx/auth.local.json` ignored.
- Keep `*.local.json` and `*.secret.json` ignored.
- Use placeholders in examples.
- Do not report cookies, session values, account data, or private project IDs.
- Re-run `olcx auth` if Overleaf rejects the stored session.
