# Architecture

## Purpose And Contract Status

This document is the v1 internal architecture contract for `olcx`. It is a
repository contract for implementation tasks, not a public npm API guarantee.
Later tasks should use it to choose module locations, dependency direction,
stable internal types, path ownership, and backend boundaries.

`docs/design.md`, `docs/usage.md`, and `docs/security.md` remain the product,
workflow, and security context. This document owns internal module boundaries and
the shared TypeScript interface direction used by implementation tasks.

## V1 Principles And Non-Goals

- v1 is a lightweight CLI-first implementation.
- The core workflow must not require a local LaTeX installation.
- v1 does not include a VS Code extension. The CLI generates and repairs
  `.vscode/settings.json` and `.vscode/tasks.json` during `olcx init`.
- One local paper repository binds to one Overleaf project by default.
- Sync must never silently overwrite local or remote changes.
- Auth is project-local by default and must not store Overleaf passwords.
- Users install and run `olcx`; they must not need `olcli` as a separate runtime
  tool.
- `olcx` is not an official Overleaf project and is not an official `olcli`
  project.
- Normal tests must not require real Overleaf access, local LaTeX, Playwright, or
  browser automation.

## Module Boundaries

The CLI entry and bootstrap module, currently `src/cli.ts`, owns Commander
setup, version wiring, top-level process entry, and delegation to command action
modules. It must not own sync, compile, auth, config, or backend workflow logic.

Command modules in `src/commands/*` own option parsing, user-facing output,
exit-code mapping, and calls into workflow modules. Commands must remain thin and
must not import backend-private `olcli` code.

Config modules in `src/config/*` own project root discovery,
`.olcx/config.json`, config schema validation, default paths, ignore-rule
assembly, allowed Overleaf endpoint values, and shareable workflow settings.

Auth modules in `src/auth/*` own `.olcx/auth.local.json`, environment-variable
auth overrides, redaction, local-only persistence, auth status summaries, and
validation of auth file shape. They must not store passwords.

Backend modules in `src/backend/*` own the stable `OverleafBackend` interface and
all network or private Overleaf implementation details. Imported or adapted
`olcli` code is backend-private.

Endpoint modules in `src/endpoint/*` own the public `www`/`cn` endpoint aliases,
allowed base URLs, read-only `/project` probing, latency selection, and redacted
probe failure formatting. Endpoint probing must not use project-specific URLs or
the backend-private `olcli` client.

Sync modules in `src/sync/*` own local and remote snapshots, ignore filtering,
sync planning, safe application of operations, conflict reports, and sync state
under `.olcx/state/`.

Compile modules in `src/compile/*` own compile orchestration, polling policy, PDF
download and write behavior, compile logs, timeouts, and fast or draft fallback
behavior.

Watch modules in `src/watch/*` own file watching, debounce, serial queueing,
failure pause state, and composition of sync plus compile. Watch must reuse the
same ignore rules and sync semantics as manual `sync`.

Diagnostics modules in `src/diagnostics/*` own `status` and `doctor` checks,
redacted summaries, and user-facing remediation hints.

Testing support in `src/testing/*` owns fake backends, temporary paper repository
helpers, deterministic fixtures, and helpers for CLI-level integration tests.

## V1 Source Tree

This is the suggested source tree contract for later implementation tasks. This
documentation task does not create these source files.

```text
src/
  cli.ts
  commands/
    auth.ts
    init.ts
    sync.ts
    compile.ts
    watch.ts
    status.ts
    doctor.ts
    endpoint.ts
  config/
    types.ts
    projectRoot.ts
    projectConfig.ts
    ignoreRules.ts
  auth/
    types.ts
    projectAuth.ts
    redact.ts
  backend/
    types.ts
    overleafBackend.ts
    olcli/
  sync/
  endpoint/
    overleafEndpoint.ts
    types.ts
    snapshot.ts
    plan.ts
    apply.ts
    conflicts.ts
  compile/
    types.ts
    compileFlow.ts
    pdfOutput.ts
  watch/
    types.ts
    queue.ts
    watcher.ts
  diagnostics/
    types.ts
    status.ts
    doctor.ts
  testing/
    fakeBackend.ts
    tempProject.ts
  errors.ts
  result.ts
tests/
  fixtures/
```

## Stable Internal TypeScript Interfaces

These drafts are stable internal contracts for v1 modules. Field additions are
allowed when later tasks need them, but modules should not rename or bypass these
shapes without updating this contract.

```ts
export interface ProjectConfig {
  schemaVersion: 1;
  projectId: string;
  projectUrl?: string;
  overleaf: {
    baseUrl: "https://www.overleaf.com" | "https://cn.overleaf.com";
  };
  rootDocument: string;
  pdfPath: string;
  sync: {
    mode: "bidirectional";
    conflictPolicy: "pause";
    ignore?: string[];
  };
  compile: {
    timeoutMs: number;
    fastFallback: {
      enabled: boolean;
      attempts: number;
      timeoutMs: number;
    };
  };
}

export interface ProjectAuth {
  schemaVersion: 1;
  accountLabel?: string;
  sessionCookie: string;
  updatedAt: string;
  source: "interactive" | "cli-option" | "env";
}

export interface BackendAuthInput {
  auth: ProjectAuth;
}

export interface BackendAccount {
  accountLabel?: string;
  authenticated: boolean;
}

export interface BackendProjectInput {
  projectId: string;
  auth: ProjectAuth;
}

export interface BackendFileInput extends BackendProjectInput {
  path: string;
  remoteId?: string;
}

export interface BackendUploadInput extends BackendProjectInput {
  path: string;
  bytes: Uint8Array;
}

export interface BackendCompileInput extends BackendProjectInput {
  timeoutMs: number;
  rootDocument: string;
  fastMode?: boolean;
}

export interface OverleafBackend {
  validateAuth(input: BackendAuthInput): Promise<BackendAccount>;
  listFiles(input: BackendProjectInput): Promise<RemoteFile[]>;
  downloadFile(input: BackendFileInput): Promise<Uint8Array>;
  uploadFile(input: BackendUploadInput): Promise<RemoteFile>;
  deleteFile(input: BackendFileInput): Promise<void>;
  compile(input: BackendCompileInput): Promise<CompileResult>;
  downloadPdf(input: BackendProjectInput): Promise<Uint8Array>;
}

export type OverleafBackendFactory = (options: {
  baseUrl?: string;
  cookieName?: string;
}) => OverleafBackend;

export interface RemoteFile {
  path: string;
  kind: "file" | "directory";
  remoteId?: string;
  size?: number;
  contentHash?: string;
  modifiedAt?: string;
  revision?: string;
  binary?: boolean;
}

export interface LocalFileSnapshot {
  path: string;
  exists: boolean;
  size?: number;
  contentHash?: string;
  modifiedAt?: string;
  ignored: boolean;
}

export type SyncOperationType =
  | "upload"
  | "download"
  | "deleteLocal"
  | "deleteRemote"
  | "unchanged"
  | "conflict"
  | "ignored";

export interface SyncOperation {
  type: SyncOperationType;
  path: string;
  local?: LocalFileSnapshot;
  remote?: RemoteFile;
  reason: string;
}

export interface SyncConflict {
  path: string;
  reason:
    | "both-modified"
    | "local-modified-remote-deleted"
    | "remote-modified-local-deleted"
    | "unsafe-delete"
    | "unsupported";
  local?: LocalFileSnapshot;
  remote?: RemoteFile;
  recommendation: string;
}

export interface SyncPlan {
  projectId: string;
  createdAt: string;
  dryRun: boolean;
  operations: SyncOperation[];
  conflicts: SyncConflict[];
  summary: {
    upload: number;
    download: number;
    deleteLocal: number;
    deleteRemote: number;
    unchanged: number;
    conflict: number;
    ignored: number;
  };
}

export interface CompileLogEntry {
  level: "info" | "warning" | "error";
  message: string;
  file?: string;
  line?: number;
}

export interface CompileResult {
  status: "success" | "failure" | "timeout" | "fallback-success";
  projectId: string;
  pdfBytes?: Uint8Array;
  pdfPath?: string;
  logs: CompileLogEntry[];
  warnings: string[];
  elapsedMs: number;
  fallbackUsed: boolean;
  error?: OlcxError;
}

export type OlcxErrorCode =
  | "USER_INPUT_ERROR"
  | "PROJECT_CONFIG_NOT_FOUND"
  | "PROJECT_CONFIG_INVALID"
  | "PROJECT_AUTH_NOT_FOUND"
  | "PROJECT_AUTH_INVALID"
  | "BACKEND_AUTH_FAILED"
  | "BACKEND_NETWORK_ERROR"
  | "BACKEND_PROTOCOL_ERROR"
  | "SYNC_CONFLICT"
  | "SYNC_UNSAFE_OPERATION"
  | "COMPILE_FAILED"
  | "COMPILE_TIMEOUT"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export interface OlcxError {
  name: "OlcxError";
  code: OlcxErrorCode;
  message: string;
  exitCode: number;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: OlcxError };
```

### Field Meanings

- `ProjectConfig.overleaf.baseUrl` is the project-local Overleaf endpoint. It is
  restricted to `https://www.overleaf.com` and `https://cn.overleaf.com`.
- Sync, compile, watch, and CLI workflow modules must pass
  `{ baseUrl: config.overleaf.baseUrl }` into the real backend factory whenever
  they create an `OverleafBackend`. Tests may inject `createBackend` to avoid
  real Overleaf access.

- `ProjectConfig.schemaVersion`: config schema version. v1 uses `1`.
- `ProjectConfig.projectId`: Overleaf project identifier parsed from a URL or
  direct input. It is shareable config, but can still be sensitive in private
  repositories.
- `ProjectConfig.projectUrl`: optional original project URL using placeholders
  such as `https://www.overleaf.com/project/<overleaf-project-id>`.
- `ProjectConfig.rootDocument`: primary TeX entry point. Default is `main.tex`.
- `ProjectConfig.pdfPath`: local PDF output path. Default is
  `build/overleaf/main.pdf`.
- `ProjectConfig.sync.mode`: v1 sync mode. The only v1 value is
  `bidirectional`.
- `ProjectConfig.sync.conflictPolicy`: v1 conflict behavior. The only v1 value
  is `pause`.
- `ProjectConfig.sync.ignore`: user-configured ignore patterns appended to the
  required built-in ignore set.
- `ProjectConfig.compile.timeoutMs`: normal Overleaf compile timeout budget.
- `ProjectConfig.compile.fastFallback`: bounded fallback settings for timeout,
  time-limit, or upgrade-limit recovery. Defaults to enabled with one fast/draft
  attempt. The current olcli adapter uses per-request draft mode, so it does not
  persistently change project compile settings; future adapters that use project
  settings must restore them through the backend fast compile session.
- `ProjectAuth.schemaVersion`: auth file schema version. v1 uses `1`.
- `ProjectAuth.accountLabel`: optional display label for status output. If it is
  absent, output should display `unknown`.
- `ProjectAuth.sessionCookie`: opaque local-only Overleaf session value. It must
  never be logged, committed, printed, or written to handoff reports.
- `ProjectAuth.updatedAt`: ISO timestamp of the last local auth update.
- `ProjectAuth.source`: how the current local auth value was provided.
- `BackendAuthInput`, `BackendProjectInput`, `BackendFileInput`,
  `BackendUploadInput`, and `BackendCompileInput`: backend adapter request
  shapes. They are accepted by `OverleafBackend` only and should not leak
  private transport details.
- `BackendAccount`: redacted auth validation result suitable for status and
  diagnostics.
- `RemoteFile`: metadata returned by the backend. Listings must not include full
  file contents.
- `RemoteFile.path`: repository-relative file path using forward slashes in
  internal state.
- `RemoteFile.kind`: whether the remote entry is a file or directory.
- `RemoteFile.remoteId`, `revision`, and `modifiedAt`: optional remote metadata
  used only for efficient backend operations and conflict detection.
- `RemoteFile.contentHash`: deterministic digest when available. The backend may
  omit it if content must be downloaded before hashing.
- `RemoteFile.binary`: whether the remote entry should be treated as binary.
- `LocalFileSnapshot.path`: repository-relative local file path using forward
  slashes in internal state.
- `LocalFileSnapshot.exists`: whether the file exists at snapshot time.
- `LocalFileSnapshot.size`, `contentHash`, and `modifiedAt`: deterministic local
  metadata used for sync planning.
- `LocalFileSnapshot.ignored`: whether the path is excluded by built-in or
  project ignore rules.
- `SyncOperation.type`: planned action for a path before application.
- `SyncOperation.reason`: short redacted explanation for why the operation was
  selected.
- `SyncConflict.reason`: stable conflict category for later conflict report
  formatting.
- `SyncConflict.recommendation`: user-facing next step without file contents or
  secrets.
- `SyncPlan.projectId`: project binding used for this plan.
- `SyncPlan.createdAt`: ISO timestamp when the plan was produced.
- `SyncPlan.dryRun`: when true, neither local files nor remote files may be
  mutated.
- `SyncPlan.operations`: planned changes. Operations with type `conflict` or
  `ignored` are informative and must not mutate either side.
- `SyncPlan.conflicts`: blocking conflicts. Any non-empty array pauses automatic
  application.
- `SyncPlan.summary`: counts for user output and tests.
- `CompileLogEntry`: redacted compile message, optionally associated with a file
  and line number.
- `CompileResult.status`: compile outcome. `fallback-success` means the PDF came
  from a fast or draft fallback, not from a normal full compile.
- `CompileResult.projectId`: project binding used for the compile.
- `CompileResult.pdfBytes`: backend-returned artifact bytes before local write.
- `CompileResult.pdfPath`: local path after the PDF is written.
- `CompileResult.logs`: redacted compile log entries.
- `CompileResult.warnings`: redacted warnings that should not fail the command
  by themselves.
- `CompileResult.elapsedMs`: measured compile flow duration.
- `CompileResult.fallbackUsed`: true when the fast or draft fallback path
  produced the returned result.
- `CompileResult.error`: structured failure for failed compile outcomes.
- `OlcxError.name`: constant discriminator.
- `OlcxError.code`: stable error category.
- `OlcxError.message`: redacted user-facing failure message.
- `OlcxError.exitCode`: process exit code selected by command boundary. Numeric
  values are reserved for the later CLI behavior contract.
- `OlcxError.hint`: optional actionable next step.
- `OlcxError.details`: structured diagnostic details. It must not contain raw
  cookies, session values, passwords, or full private file contents.
- `OlcxError.cause`: original thrown value retained for internal debugging only.
- `Result<T>`: preferred workflow-level return shape for expected failures.

## Stable Versus Private Interfaces

Stable internal contracts for other modules are `ProjectConfig`, `ProjectAuth`,
`OverleafBackend`, `RemoteFile`, `LocalFileSnapshot`, `SyncPlan`,
`SyncOperation`, `SyncConflict`, `CompileResult`, `CompileLogEntry`,
`OlcxError`, `OlcxErrorCode`, and `Result<T>`.

Private implementation details include imported or adapted `olcli` code, raw
Overleaf HTTP routes, raw cookies, session parsing, backend retry internals,
HTML or CSRF parsing, and temporary protocol models.

No command, sync, compile, watch, diagnostics, or test module should import from
`src/backend/olcli/*` directly. Those modules depend on `OverleafBackend`.

## Command-To-Module Dependencies

| Command | Command Module | Allowed Dependencies | Backend Requirement |
| --- | --- | --- | --- |
| `auth` | `src/commands/auth.ts` | `config`, `auth`, optional `backend.validateAuth`, `diagnostics` redaction | Optional validation only |
| `init` | `src/commands/init.ts` | `config`, `config/ignoreRules`, VS Code config helper | None |
| `sync` | `src/commands/sync.ts` | `config`, `auth`, `backend`, `sync`, `diagnostics` | Required |
| `compile` | `src/commands/compile.ts` | `config`, `auth`, `backend`, `compile`, `diagnostics` | Required |
| `watch` | `src/commands/watch.ts` | `config`, `auth`, `watch`, `sync`, `compile`, `diagnostics` | Required through sync and compile |
| `status` | `src/commands/status.ts` | `config`, `auth`, sync state, `diagnostics` | Only if a later explicit remote check is requested |
| `doctor` | `src/commands/doctor.ts` | `config`, `auth`, `diagnostics`, backend capability checks | Must not require real Overleaf by default |

Commands convert workflow `Result<T>` values into stdout, stderr, and process
exit behavior. They must not invent alternate error shapes.

## Path Ownership

| Path | Owner | Contract |
| --- | --- | --- |
| `.olcx/config.json` | `src/config` | Shareable workflow config. May reveal project binding. Must not contain credentials. |
| `.olcx/auth.local.json` | `src/auth` | Local-only secret auth file. Must remain ignored. Must not contain passwords. |
| `.olcx/state/` | `src/sync` and `src/watch` | Local-only state directory for snapshots, conflicts, and pause state. Must remain ignored. |
| `.olcx/state/sync.json` | `src/sync` | Sync snapshot state. Local-only and ignored. |
| `.olcx/state/conflicts.json` | `src/sync` | Conflict report state. Local-only and ignored. |
| `.olcx/state/watch.json` | `src/watch` | Watch pause and queue metadata when persistence is needed. Local-only and ignored. |
| `build/overleaf/main.pdf` | `src/compile` | Default generated PDF output. Must remain ignored. |
| `.gitignore` | `src/config` ignore helper and `init` | Managed conservatively. Preserve user entries and ensure required local-only/generated paths stay ignored. |
| `.vscode/settings.json` | `init` VS Code helper | Generated or merged VS Code configuration. Preserve user content. |
| `.vscode/tasks.json` | `init` VS Code helper | Generated or merged VS Code tasks. Preserve user content and replace only olcx-managed task labels. |

## Ignore Rules Contract

Sync and watch share one deterministic ignore-rule implementation. They must
exclude:

- `.git/`
- `node_modules/`
- `.olcx/auth.local.json`
- `.olcx/*.local.json`
- `.olcx/*.secret.json`
- `.olcx/state/`
- `build/overleaf/`
- `*.aux`
- `*.bbl`
- `*.bcf`
- `*.blg`
- `*.fdb_latexmk`
- `*.fls`
- `*.log`
- `*.out`
- `*.run.xml`
- `*.synctex.gz`
- `*.toc`
- user-configured patterns from `ProjectConfig.sync.ignore`

Ignore handling must be path-normalized and deterministic across platforms.
Ignored files are never uploaded, downloaded, watched for automatic workflow
triggers, or included in conflict reports except as counted ignored entries.

## Error Model And Exit Categories

Workflow modules should return `Result<T>` for expected failures. Expected
failures include:

- user input errors;
- missing or invalid project config;
- missing or invalid project auth;
- backend auth failures;
- backend network failures;
- backend protocol failures;
- sync conflicts;
- unsafe sync operations;
- compile failures;
- compile timeouts;
- local I/O failures.

CLI commands convert `OlcxError.exitCode` to the process exit code and print a
redacted `message` plus an optional `hint`. Unexpected thrown errors are
converted at the command boundary into `INTERNAL_ERROR`.

Numeric exit-code mapping is intentionally deferred to task
`20260625-163246-549133`. Until that task finalizes numbers, modules must depend
on `OlcxErrorCode` categories rather than hard-coding incompatible numeric
meanings.

`OlcxError.details`, command output, logs, snapshots, test fixtures, and handoff
reports must not include raw cookies, session values, passwords, or full private
file contents.

## olcli MIT Attribution Boundary

MIT-derived code from `aloth/olcli` may live only under `src/backend/olcli/` or
an equivalent backend-private path. Copied or adapted files must preserve the
original MIT attribution and notices required by their source.

Users install and run `olcx`; they do not install `olcli` separately at runtime.
Only backend adapter modules may call `olcli`-derived private APIs or private
Overleaf endpoints. All other modules depend on `OverleafBackend`.

The backend adapter translates `olcli` or private Overleaf failures into
redacted `OlcxError` values. Upper layers must not branch on private Overleaf
routes, raw HTML markers, CSRF details, or `olcli` internal classes.

## Fake Backend And Testing Boundaries

`src/testing/fakeBackend.ts` should implement `OverleafBackend`
deterministically. Unit and integration tests should use fake backend instances
and temporary paper repositories rather than real Overleaf.

Fixtures must not contain real paper content, credentials, cookies, session
values, passwords, account data, or private project IDs. Placeholder values such
as `<overleaf-project-id>` and `<redacted-session-cookie>` are acceptable.

Real Overleaf E2E tests are gated by local-only environment variables and belong
to task `20260625-160946-910101`. Normal `npm test` runs must not require
network access, a real Overleaf account, local LaTeX, Playwright, or browser
automation.

Compile tests should use fake PDF bytes and verify write paths. Sync tests should
verify snapshots, plans, conflict detection, and ignore filtering without
uploading real files.

## Security Constraints

- `.olcx/auth.local.json`, `.olcx/*.local.json`, `.olcx/*.secret.json`,
  `.env.e2e.local`, and local state under `.olcx/state/` must remain ignored.
- Redaction must happen before secret-like values reach command output, logs,
  errors, test snapshots, docs, or QuickDev handoff reports.
- Overleaf passwords must not be stored.
- Raw cookies and raw session values must not be printed.
- Real project IDs, account data, private paper content, and real compile logs
  must not be placed in fixtures or docs.
- Conflict reports include paths, hashes, sizes, timestamps, conflict reasons,
  and recommendations. They must not include full file contents.
- `ProjectConfig.projectId` is shareable config, but users should treat it as
  potentially sensitive when a paper repository is public.

## Open Follow-Up Contracts

- CLI output, stdout and stderr rules, non-interactive behavior, redaction text,
  and numeric exit-code mapping belong to task `20260625-163246-549133`.
- Sync state-machine details, snapshot persistence format, delete semantics, and
  conflict report format belong to task `20260625-163308-046461`.
- Exact `olcli` import layout, source file selection, and notice updates belong
  to task `20260625-160751-353900`.
- Backend adapter implementation details and fake backend behavior belong to task
  `20260625-160853-429297`.
- Config/auth schemas, project root discovery, redaction helpers, and `.gitignore`
  update behavior belong to task `20260625-160804-867992`.
- Default init VS Code merge behavior belongs to task `20260625-160819-417512`.
- Remote compile polling, PDF write behavior, and fast fallback implementation
  belong to tasks `20260625-160925-146032` and `20260625-165248-545991`.
- Real Overleaf E2E gating and local-only secret loading belong to task
  `20260625-160946-910101`.
