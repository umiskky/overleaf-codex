# npm Packaging

The npm package is intentionally small and user-facing. Check it with:

```bash
npm pack --dry-run --json --ignore-scripts
```

`npm run prepublish:check` runs the same dry-run package inspection after build,
typecheck, tests, audit, license checks, notice checks, and release text scans.

## Required Package Surface

The package must include:

- `dist/`
- `docs/`
- `examples/`
- `assets/`
- `README.md`
- `LICENSE`
- `NOTICE.md`
- `package.json`
- `src/backend/olcli/LICENSE`
- `src/backend/olcli/README.md`

Focused user docs such as `docs/usage.md`, `docs/auth.md`, `docs/endpoint.md`,
`docs/sync.md`, `docs/compile.md`, `docs/troubleshooting.md`,
`docs/release-gates.md`, `docs/npm-packaging.md`, and
`docs/release-notes-v1.md` are required package files.

## Excluded Content

The package gate rejects tests, scripts, `.github/`, `tmp/`, `node_modules/`,
local auth files, local or secret JSON files, environment files, logs, generated
Overleaf output, and real E2E output.

The only tracked `.olcx` files allowed in the package are sanitized example
files under `examples/minimal-paper/`.

## Manual npm Publish

Run all release gates before any manual publish:

```bash
npm run build
npm run typecheck
npm test
OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real
npm audit --audit-level=high
npm pack --dry-run --json --ignore-scripts
npm run prepublish:check
```

Confirm the package name and current registry state before publishing:

```bash
npm view overleaf-codex version
npm login
npm whoami
npm publish --dry-run
```

For the current unscoped package name, the real manual publish command is:

```bash
npm publish
```

If the package is ever renamed to a scoped public package, use
`npm publish --access public` and update `package.json`, this document, the
Trusted Publisher binding, and the workflow tests together.

Interactive npm publishes or package settings changes can prompt for `2FA` or
an `OTP`. Enter those values only in the npm prompt. Do not write OTPs,
passwords, npm auth values, or session values into docs, scripts, CI, or Git.

Stable release is not approved until a sanitized disposable real Overleaf E2E pass is recorded. The forced skip smoke is not a stable-release substitute.

## GitHub Actions Trusted Publishing

Prefer GitHub Actions Trusted Publisher configuration over long-lived npm
tokens. The repository workflow is `.github/workflows/npm-publish.yml`; it uses
OIDC with `permissions: id-token: write` and publishes only from explicit
GitHub release publication events.

Do not configure repository `NPM_TOKEN`, `NODE_AUTH_TOKEN`, npm automation
token material, `_authToken`, or a checked-in `.npmrc` for publishing.

Configure the npm Trusted Publisher binding on npm with these fields:

- `owner: umiskky`
- `repository: overleaf-codex`
- `workflow filename: npm-publish.yml`
- `environment: npm-publish`
- `package: overleaf-codex`
- `allowed action: npm publish`

The workflow runs on GitHub-hosted `ubuntu-latest`, installs a trusted
publishing capable npm CLI, runs the forced E2E skip smoke, then runs
`npm run prepublish:check` before `npm publish --tag "$NPM_DIST_TAG"`.
Trusted publishing is expected to generate npm provenance automatically; verify
the published package provenance after release from npm or the package page.

## Version, Tag, And Release Strategy

GitHub release tags must match the `package.json` version exactly after removing
the leading `v`.

- Stable package versions use non-prerelease GitHub releases such as `vX.Y.Z`
  and publish with npm dist-tag `latest`.
- Prerelease package versions use GitHub prereleases such as `vX.Y.Z-rc.1` and
  publish with npm dist-tag `next`.

The stable workflow path checks `docs/release-notes-v1.md` for explicit stable
approval and a concrete sanitized real E2E artifact reference before publishing
`latest`. The required format is:

```text
Sanitized real E2E artifact: gh-release://umiskky/overleaf-codex/vX.Y.Z/sanitized-real-e2e.md
```

Concrete sanitized real E2E artifact reference means the path names a reviewed
release artifact. Placeholder text such as `not recorded`, `placeholder`, or
`not evidence` must be removed before stable npm publish can proceed.

## Stable Release Block

Stable npm publication remains blocked in the current repository state. The
release notes must continue to say the release is not approved until the
sanitized disposable real Overleaf E2E result is recorded and reviewed.

The forced skip smoke proves CI does not read local E2E secrets or contact
Overleaf. It is required for safety, but it is not proof that a disposable real
Overleaf project passed the E2E flow.

## Rollback, Unpublish, And Deprecate

Prefer fixing forward with a new patch version for a bad release. If users need
a warning on an already-published version, use:

```bash
npm deprecate overleaf-codex@<version> "<message>"
```

`npm unpublish overleaf-codex@<version>` is time-limited and policy-limited.
After a version has been published, that exact package name and version cannot
be reused. Use unpublish only when npm policy allows it and deprecate otherwise.
