# olcli Backend Source

This directory contains backend-private code copied or adapted from `@aloth/olcli@0.5.0`.

- Source repository: https://github.com/aloth/olcli
- Source tag: `v0.5.0`
- Source commit: `524c30b11328a847a9c0bcf4447d2b3468160f8c`
- npm tarball: https://registry.npmjs.org/@aloth/olcli/-/olcli-0.5.0.tgz
- npm integrity: `sha512-kFstYGK6htjDiOlX0H/nmjzugwRYN2RlBufK+bAA648h21GqQOVxeHr5po2ybwxetoccT9ky3YV2ch7c3b6GmQ==`
- Upstream file: `src/client.ts`
- olcx file: `src/backend/olcli/client.ts`
- License: MIT
- Copyright: Copyright (c) 2026 Alexander Loth

The upstream MIT license text is copied in `src/backend/olcli/LICENSE`.

## olcx Adaptations

- The upstream `src/client.ts` file was moved into the backend-private `src/backend/olcli/` directory.
- The import-time upstream `package.json` version lookup was removed so the built package can import the module without requiring an adjacent source `package.json`.
- The user agent is fixed as `olcx/0.1.0 olcli/0.5.0`.
- Upstream CLI, MCP server, global `Conf` config, global auth-file behavior, and ignore helper entrypoints were not copied.

Only backend adapter modules may import from this directory. Commands, sync, compile, watch, diagnostics, and tests for public behavior should depend on the stable `OverleafBackend` adapter introduced by the later backend adapter task.

`olcx` is not an official Overleaf project and is not an official `olcli` project.
