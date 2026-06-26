# Endpoint Management

`olcx` supports the public Overleaf web endpoints:

- `https://www.overleaf.com`
- `https://cn.overleaf.com`

The default is `https://www.overleaf.com`. Endpoint selection is manual by
default and is stored per paper repository.

## Status

Show the configured endpoint without network access:

```bash
olcx endpoint status
```

This reads `.olcx/config.json` and prints the current alias and URL.

## Read-only Test

Probe public endpoint reachability:

```bash
olcx endpoint test
```

`olcx endpoint test` probes only:

```text
https://www.overleaf.com/project
https://cn.overleaf.com/project
```

It does not sync, upload, compile, validate auth, read project-specific URLs, or
modify remote projects. Without `--apply`, it never writes config.

## Manual Switch

Set the endpoint explicitly:

```bash
olcx endpoint set cn
olcx endpoint set www
```

This writes `.olcx/config.json` and does not contact Overleaf.

## Apply Fastest Available

Probe both endpoints and write the fastest reachable one:

```bash
olcx endpoint test --apply
```

`--apply` writes config only when at least one endpoint is available. If both
endpoints fail, `olcx` returns `NETWORK_ERROR`, prints both redacted failure
reasons, and leaves `.olcx/config.json` unchanged.

## Configuration

Endpoint state lives in `overleaf.baseUrl`:

```json
{
  "overleaf": {
    "baseUrl": "https://www.overleaf.com"
  }
}
```

Allowed values are `https://www.overleaf.com` and `https://cn.overleaf.com`.
Legacy configs without `overleaf.baseUrl` default to `https://www.overleaf.com`
in memory.

## Security

Endpoint base URLs are not secrets. Probe failure messages are still redacted
because network errors can include cookies, session values, project URLs, or
project-id-like strings. Do not paste real cookies, account labels, private
project IDs, or private paper content into docs, tests, issues, or handoff
files.
