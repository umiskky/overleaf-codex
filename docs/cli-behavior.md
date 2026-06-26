# CLI Behavior

This document is the v1 command-line behavior contract for `olcx`. It defines
the user-facing behavior for auth, init, endpoint, sync, compile, watch,
status, and doctor workflows.

`olcx` is a lightweight CLI. It must not require local LaTeX for the core
workflow, must not silently overwrite local or remote changes, and must not
print credentials, cookies, session values, passwords, or private project
identifiers.

## Command Surface

| Command | Required parameters | Optional parameters | Environment variables | Interactive input | Non-interactive behavior |
| --- | --- | --- | --- | --- | --- |
| `olcx auth` | In non-interactive mode, one auth source is required: `--cookie <value>` or `--from-env <name>`. | `--cookie <value>`, `--from-env <name>`. | The variable named by `--from-env`; recommended local name is `OLCX_OVERLEAF_SESSION`. `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | In interactive mode, may prompt on stderr for a pasted session cookie. It must never ask for or store an Overleaf password. | If no auth source is available, fail with `USER_INPUT_ERROR` and print a next-step hint. Do not wait forever for input. |
| `olcx init --project <overleaf-url-or-id>` | `--project <overleaf-url-or-id>`. | None. | `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | None in v1. | Missing or invalid `--project` fails with `USER_INPUT_ERROR`; conflicting local files fail with an actionable error instead of overwriting. Init creates or repairs local VS Code settings/tasks by default. |
| `olcx endpoint status` | Bound project config. | None. | None. | None. | Reads `overleaf.baseUrl`, performs no network access, and returns `CONFIG_ERROR` if config is missing or invalid. |
| `olcx endpoint test` | Bound project config. | `--timeout <ms>`, `--apply`. | None. | None. | Probes only `https://www.overleaf.com/project` and `https://cn.overleaf.com/project`. Without `--apply`, never writes config. With `--apply`, writes only the fastest available endpoint. If both fail, returns `NETWORK_ERROR` and leaves config unchanged. Invalid timeout returns `USER_INPUT_ERROR`. |
| `olcx endpoint set cn` | Bound project config and endpoint alias `www` or `cn`. | None. | None. | None. | Writes `overleaf.baseUrl` without probing. Invalid aliases return `USER_INPUT_ERROR` and leave config unchanged. |
| `olcx sync` | Bound project config and auth. | `--dry-run`. | `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | None in v1. | Missing config returns `CONFIG_ERROR`; missing auth returns `AUTH_ERROR`; conflicts return `SYNC_CONFLICT`; `--dry-run` must not mutate local or remote files. |
| `olcx compile` | Bound project config and auth. | `--pdf <path>`, `--disable-fast-fallback`, `--fast-fallback-attempts <count>`, and `--fast-fallback-timeout <ms>`. | `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | None in v1. | Missing config returns `CONFIG_ERROR`; missing auth returns `AUTH_ERROR`; network failures return `NETWORK_ERROR`; compile failures or timeouts return `COMPILE_FAILED`. |
| `olcx watch` | Bound project config and auth. | `--debounce <ms>` defaults to `2500`. | `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | None in v1. | Must not prompt while watching. On sync conflict or compile failure, pause the automatic loop and print the next manual command to run. |
| `olcx status` | None. | None. | `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | None. | Must return a redacted local summary. Missing config or auth is reported as status, not as leaked detail. |
| `olcx doctor` | None. | None. | `OLCX_NON_INTERACTIVE=1` and `CI=true` force non-interactive mode. | None. | Must run local checks without real Overleaf access by default. Failures return the most specific exit code and a next-step hint. |

## Exit Codes

| Name | Number | Meaning |
| --- | ---: | --- |
| `SUCCESS` | `0` | Successful command, help, or version output. |
| `INTERNAL_ERROR` | `1` | Unexpected thrown error or uncategorized local I/O failure. |
| `USER_INPUT_ERROR` | `2` | Invalid arguments, missing required options, invalid option values, unsupported command usage, or required non-interactive input not provided. |
| `CONFIG_ERROR` | `3` | Missing or invalid `.olcx/config.json`. |
| `AUTH_ERROR` | `4` | Missing, invalid, expired, or rejected project-local auth. |
| `NETWORK_ERROR` | `5` | Backend network or protocol failure while talking to Overleaf. |
| `SYNC_CONFLICT` | `6` | Sync conflict or unsafe sync operation that pauses instead of overwriting. |
| `COMPILE_FAILED` | `7` | Overleaf compile failure, compile timeout, or failed PDF retrieval. |

## Output Streams

- stdout is for successful command results, help, version output, status
  summaries, dry-run summaries, sync plans, compile summaries, and future JSON
  payloads.
- stderr is for prompts, warnings, errors, conflict notices, compile failure
  summaries, and next-step hints.
- A failed command must not write partial machine-readable data to stdout. It
  should write a redacted error and a `Next:` hint to stderr.
- Help requested directly with `--help` exits `0`. Help shown after a usage
  error exits `2`.
- Endpoint test failures where neither `www` nor `cn` is reachable write the
  formatted probe result to stderr and exit `NETWORK_ERROR`.
- `olcx endpoint test --apply` writes `.olcx/config.json` only after a
  successful probe finds at least one reachable endpoint.

## Human Output

- Human-readable output should be short, direct, and actionable.
- Failure output uses this shape:

```text
Error: <redacted failure message>
Next: <one command or action the user can take>
```

- Stack traces are not printed for expected failures.
- Commands must not use local LaTeX in the core compile path.
- When fast/draft fallback produces the PDF, stdout must show
  `Status: fallback-success` and a `Fallback: fast/draft` line. The command must
  not present the fallback PDF as a full normal compile artifact.

## Future JSON Output

JSON output is reserved for a future `--json` mode. Until that mode is
implemented, command implementations must not print ad hoc JSON. When
introduced, JSON payloads will go to stdout, warnings and errors will remain on
stderr, and secrets will still be redacted before serialization.

## Redaction

All command output, errors, diagnostics, test fixtures, snapshots, docs, and
handoff reports must redact:

- Overleaf cookies and session values.
- Password-like, token-like, auth-like, and CSRF-like values.
- Account-private values such as raw emails when they appear in errors or
  diagnostic details.
- Overleaf project URLs and project-id-like values.
- Endpoint base URLs such as `https://www.overleaf.com` and
  `https://cn.overleaf.com` are not secrets, but project URLs under either host
  must be redacted.

Use placeholders such as `<redacted-secret>`, `<redacted-account>`, and
`<redacted-project-id>`. Do not write real credentials or private project IDs to
tests, fixtures, docs, QuickDev handoff files, terminal output, or CI logs.
