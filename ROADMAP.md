# Roadmap

This roadmap is intentionally narrow. The first useful release should be a
reliable CLI, not a large platform.

## Phase 0: Project foundation

- Initialize TypeScript CLI scaffold.
- Publish open-source docs, contribution rules, and CI.
- Document security and licensing constraints.

## Phase 1: Backend integration

- Import the needed MIT-licensed `olcli` backend code with attribution.
- Keep `olcx` independently packaged so users do not install `olcli`.
- Add tests around auth, project binding, compile, and PDF download behavior.

## Phase 2: Paper project workflow

- Implement `olcx auth`.
- Implement `olcx init --project <url-or-id> --vscode`.
- Store project-local auth in `.olcx/auth.local.json`.
- Store shareable binding config in `.olcx/config.json`.

## Phase 3: Safe sync and compile loop

- Implement bidirectional sync with no silent overwrites.
- Pause on conflicts and print actionable resolution steps.
- Implement `olcx compile` and download to `build/overleaf/main.pdf`.
- Implement `olcx watch` with debounce and queue state.

## Phase 4: Community hardening

- Test Linux, macOS, Windows, and headless usage.
- Improve docs with real examples and troubleshooting.
- Prepare npm package publishing.
- Consider optional VS Code extension only after the CLI is stable.
