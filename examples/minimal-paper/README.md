# Minimal Paper Example

This is a sanitized olcx paper repository example. It is safe to inspect because
`.olcx/config.json` uses `<overleaf-project-id>` and the real local auth file
`.olcx/auth.local.json` is not included.

The example does not contact Overleaf by default. Commands that need Overleaf,
such as `olcx sync`, `olcx compile`, and `olcx watch`, require you to replace the
placeholder project id and create local auth first.

## Files

- `main.tex` is a minimal paper source with generic example text.
- `.olcx/config.json` is the shareable olcx project config.
- `.olcx/auth.local.example.json` shows the auth file shape without a usable
  cookie.
- `.gitignore` keeps `.olcx/auth.local.json`, other local or secret JSON files,
  local environment files, `.olcx/state/`, LaTeX build artifacts, and
  `build/overleaf/` out of Git.

## Config

`.olcx/config.json` binds one local paper repository to one Overleaf project:

```json
{
  "projectId": "<overleaf-project-id>",
  "overleaf": {
    "baseUrl": "https://www.overleaf.com"
  },
  "rootDocument": "main.tex",
  "pdfPath": "build/overleaf/main.pdf"
}
```

Replace `<overleaf-project-id>` and `projectUrl` with your own Overleaf project
before running Overleaf-backed commands. If this is your real paper repository,
the safer path is to run:

```bash
olcx init --project https://www.overleaf.com/project/<your-project-id>
```

Use `olcx endpoint set cn` if this paper repository should use
`https://cn.overleaf.com` instead.

## Auth

Real auth belongs only in `.olcx/auth.local.json`, which must stay ignored by
Git. The tracked file `.olcx/auth.local.example.json` is only a shape example.

For a headless shell:

```bash
export OLCX_OVERLEAF_SESSION='<replace-with-session-cookie>'
olcx auth --from-env OLCX_OVERLEAF_SESSION
unset OLCX_OVERLEAF_SESSION
```

For an interactive terminal:

```bash
olcx auth
```

## PDF Output

Remote compilation downloads the PDF to:

```text
build/overleaf/main.pdf
```

That path is generated output and is ignored by Git.

## Watch Flow

After replacing the placeholder project binding and authenticating:

```bash
olcx sync --dry-run
olcx compile
olcx watch
```

`olcx watch` detects local edits, runs safe sync, compiles on Overleaf, downloads
`build/overleaf/main.pdf`, and ignores that generated PDF so it does not trigger
a watch loop.
