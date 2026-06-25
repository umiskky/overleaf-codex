# Security Policy

`olcx` handles Overleaf session data. Treat this repository as security-sensitive
even when the code is open source.

## Supported versions

The project is pre-1.0. Security fixes target the current `main` branch until a
release process exists.

## Reporting a vulnerability

Do not open a public issue containing credentials, cookies, private Overleaf
project IDs, or paper contents.

Use GitHub private vulnerability reporting if enabled for the repository. If it
is not enabled, open a minimal public issue that says a private security report
is needed, without including secret details.

## Secret handling rules

- Project-local auth belongs in `.olcx/auth.local.json`.
- `.olcx/*.local.json` and `.olcx/*.secret.json` must stay ignored by Git.
- Logs and diagnostics must redact raw cookies and session values.
- Tests must use fake session values.

More details are in [docs/security.md](docs/security.md).
