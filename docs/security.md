# Security

`olcx` handles Overleaf authorization data. Treat that data as secret.

## Storage model

Authorization is project-local by default:

```text
.olcx/auth.local.json
```

This supports the common case where different paper repositories use different
Overleaf accounts.

Project binding and workflow settings live in:

```text
.olcx/config.json
```

`config.json` is designed to be shareable, but it may still reveal an Overleaf
project id. Users should decide whether their paper repository is private.

## Git rules

The following files must never be committed:

```text
.olcx/auth.local.json
.olcx/*.local.json
.olcx/*.secret.json
```

Generated PDFs and LaTeX build artifacts are ignored by default:

```text
build/overleaf/
*.aux
*.log
*.synctex.gz
```

## Passwords

The first version must not store Overleaf passwords. Auth should use a session
cookie or environment-provided token-like value.

## Headless usage

If a server has no browser, the expected flow is:

1. Log in to Overleaf from any browser.
2. Copy the required session value.
3. Provide it to `olcx auth` or an environment variable on the server.
4. Store it in the paper repository's ignored local auth file.

## Reporting

`olcx status` may show the account label or email when available, but it must not
print the raw session cookie.
