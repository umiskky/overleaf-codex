# Release Gates

Run this before publishing:

```bash
npm run prepublish:check
```

The command runs build, typecheck, the deterministic test suite, a high-severity
npm audit, dependency license validation, olcli notice validation, a
sensitive-value scan over release-relevant files, and an npm pack dry-run
package-content check.

The release checklist is:

```bash
npm run build
npm run typecheck
npm test
OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real
npm audit --audit-level=high
npm pack --dry-run --json --ignore-scripts
npm run prepublish:check
```

Before freezing a v1 RC, update [docs/release-notes-v1.md](release-notes-v1.md)
with the final gate results and stable-release decision. Stable release is not approved until a sanitized disposable real Overleaf E2E pass is recorded. The default agent-safe gate may only run the forced skip smoke:

```bash
OLCX_E2E_IGNORE_LOCAL_ENV=1 OLCX_E2E_ENABLE_REAL=0 npm run test:e2e:real
```

The forced real E2E skip smoke must use `OLCX_E2E_IGNORE_LOCAL_ENV=1` so it does
not read a contributor's ignored `.env.e2e.local` file. Do not run real Overleaf
E2E unless you intentionally set `OLCX_E2E_ENABLE_REAL=1` with a disposable,
sanitized test project.

## npm Trusted Publishing Gate

The npm publishing workflow is `.github/workflows/npm-publish.yml`. It publishes
only from explicit GitHub release publication events and uses the protected
GitHub environment `npm-publish`. Configure that environment with manual
reviewer protection before enabling real publication.

GitHub release tags must match the package version:

- Stable releases use tags like `vX.Y.Z`, non-prerelease GitHub releases, and
  npm dist-tag `latest`.
- Prereleases use tags like `vX.Y.Z-rc.1`, GitHub prereleases, and npm dist-tag
  `next`.

Stable npm publish is blocked until both conditions are true:

- `docs/release-notes-v1.md` records stable release approval.
- A sanitized disposable real Overleaf E2E artifact is recorded and reviewed
  with this concrete reference format:

```text
Sanitized real E2E artifact: gh-release://umiskky/overleaf-codex/vX.Y.Z/sanitized-real-e2e.md
```

Concrete sanitized real E2E artifact reference means the referenced release
artifact has been reviewed and contains no raw cookie, session value, account
label, private project id, or private paper content.

The forced skip smoke is allowed but is not a stable substitute. It remains
required because it proves the CI E2E command is safely disabled and does not
read ignored local environment files.

## Package Contents

The package allowlist is intentionally small: `assets/`, `dist/`, `docs/`,
`examples/`, root `README.md`, root `LICENSE`, root `NOTICE.md`,
`package.json`, `src/backend/olcli/LICENSE`, and
`src/backend/olcli/README.md`.

Inspect the package surface directly with:

```bash
npm pack --dry-run --json --ignore-scripts
```

The gate fails if the dry-run package contains `node_modules/`, tests, scripts,
real `.olcx/` local state, local or secret JSON, local environment files,
`tmp/`, generated Overleaf output, E2E output, or logs. The only tracked
`.olcx` files allowed in the package are
`examples/minimal-paper/.olcx/config.json` and
`examples/minimal-paper/.olcx/auth.local.example.json`; both must stay
sanitized placeholders.

## Dependency Licenses

The current lockfile uses these compatible license families: `0BSD`,
`Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MIT`, and `MPL-2.0`.

`MPL-2.0` appears only as dependency/dev-tool package metadata and does not
relicense `olcx` source. Do not add GPL, AGPL, LGPL, unknown, or missing-license
dependencies without a documented legal review and an explicit gate update.

## npm Audit

The release gate runs:

```bash
npm audit --audit-level=high
```

There are no active audit exceptions. If a future high-severity advisory cannot
be fixed before release, document the package, advisory id, severity, runtime
reachability, mitigation, owner, and expiration date in this file before
changing the gate.

## Third-Party Source Notices

`olcx` vendors backend-private source copied or adapted from
`@aloth/olcli@0.5.0`. Preserve the MIT license text in
`src/backend/olcli/LICENSE`, the source metadata in `NOTICE.md`, `README.md`,
and `src/backend/olcli/README.md`, and the attribution header in
`src/backend/olcli/client.ts`.
