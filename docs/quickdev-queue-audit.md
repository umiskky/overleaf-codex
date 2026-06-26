# QuickDev Queue Audit

## Scope And Inputs

Audit timestamp: `2026-06-25T18:53:52+08:00`.

Source of truth for the current queue is `todo.md` as observed top to bottom during this audit. `done.md` contains no completed task blocks. The audit is documentation-only: no task was marked complete, blocked, skipped, deleted, archived, or reordered.

Files inspected:

- `AGENTS.md`
- `goal.md`
- `todo.md`
- `done.md`
- `package.json`
- `README.md`
- `ROADMAP.md`
- `docs/design.md`
- `docs/usage.md`
- `docs/security.md`
- every current `tmp/*/00-task.md` handoff copy for the 20 queued tasks
- current `git status --short`

Important input note: `todo.md` has the current task text. The current real E2E queue block is more specific than its `00-task.md` handoff copy because it names placeholder environment variables and says missing local secrets should block rather than prompting for values. Use the current `todo.md` block when that task is executed, or refresh the handoff copy before planning it.

## Current Queue

| Pos | Task ID | Title | Status | Created At | Handoff Dir |
| --- | --- | --- | --- | --- | --- |
| 1 | `20260625-163340-992326` | 审计 QuickDev 队列顺序与任务可执行性 | `todo` | `2026-06-25T16:33:40+08:00` | `tmp/20260625-163340-992326-审计 QuickDev 队列顺序与任务可执行性` |
| 2 | `20260625-163153-333824` | 冻结 v1 架构模块与公共接口契约 | `todo` | `2026-06-25T16:31:53+08:00` | `tmp/20260625-163153-333824-冻结 v1 架构模块与公共接口契约` |
| 3 | `20260625-163246-549133` | 统一 CLI 行为输出与退出码规范 | `todo` | `2026-06-25T16:32:46+08:00` | `tmp/20260625-163246-549133-统一 CLI 行为输出与退出码规范` |
| 4 | `20260625-163308-046461` | 定义同步状态机快照与冲突报告格式 | `todo` | `2026-06-25T16:33:08+08:00` | `tmp/20260625-163308-046461-定义同步状态机快照与冲突报告格式` |
| 5 | `20260625-160751-353900` | 引入 olcli 后端代码与许可证合规 | `todo` | `2026-06-25T16:07:51+08:00` | `tmp/20260625-160751-353900-引入 olcli 后端代码与许可证合规` |
| 6 | `20260625-160853-429297` | 实现 Overleaf 后端适配层 | `todo` | `2026-06-25T16:08:53+08:00` | `tmp/20260625-160853-429297-实现 Overleaf 后端适配层` |
| 7 | `20260625-160804-867992` | 建立项目配置认证与安全基础设施 | `todo` | `2026-06-25T16:08:04+08:00` | `tmp/20260625-160804-867992-建立项目配置认证与安全基础设施` |
| 8 | `20260625-160819-417512` | 实现 olcx init 与 VS Code 配置生成 | `todo` | `2026-06-25T16:08:19+08:00` | `tmp/20260625-160819-417512-实现 olcx init 与 VS Code 配置生成` |
| 9 | `20260625-160836-699088` | 实现 olcx auth status doctor | `todo` | `2026-06-25T16:08:36+08:00` | `tmp/20260625-160836-699088-实现 olcx auth status doctor` |
| 10 | `20260625-160912-750072` | 实现安全双向同步与冲突暂停 | `todo` | `2026-06-25T16:09:12+08:00` | `tmp/20260625-160912-750072-实现安全双向同步与冲突暂停` |
| 11 | `20260625-160925-146032` | 实现远程编译和 PDF 下载 | `todo` | `2026-06-25T16:09:25+08:00` | `tmp/20260625-160925-146032-实现远程编译和 PDF 下载` |
| 12 | `20260625-165248-545991` | 实现 Overleaf 编译超时快速模式降级恢复 | `todo` | `2026-06-25T16:52:48+08:00` | `tmp/20260625-165248-545991-实现 Overleaf 编译超时快速模式降级恢复` |
| 13 | `20260625-160938-324045` | 实现 olcx watch 自动工作流 | `todo` | `2026-06-25T16:09:38+08:00` | `tmp/20260625-160938-324045-实现 olcx watch 自动工作流` |
| 14 | `20260625-162413-873208` | 全链路本地沙箱回归测试 | `todo` | `2026-06-25T16:24:13+08:00` | `tmp/20260625-162413-873208-全链路本地沙箱回归测试` |
| 15 | `20260625-160946-910101` | 真实 Overleaf 集成 E2E 测试 | `todo` | `2026-06-25T16:09:46+08:00` | `tmp/20260625-160946-910101-真实 Overleaf 集成 E2E 测试` |
| 16 | `20260625-162426-756284` | 跨平台与无头环境兼容性验证 | `todo` | `2026-06-25T16:24:26+08:00` | `tmp/20260625-162426-756284-跨平台与无头环境兼容性验证` |
| 17 | `20260625-162438-154174` | 安全许可证与供应链发布门禁 | `todo` | `2026-06-25T16:24:38+08:00` | `tmp/20260625-162438-154174-安全许可证与供应链发布门禁` |
| 18 | `20260625-162447-918619` | 示例论文项目与故障排查资料 | `todo` | `2026-06-25T16:24:47+08:00` | `tmp/20260625-162447-918619-示例论文项目与故障排查资料` |
| 19 | `20260625-161006-526237` | 文档发布与社区维护完善 | `todo` | `2026-06-25T16:10:06+08:00` | `tmp/20260625-161006-526237-文档发布与社区维护完善` |
| 20 | `20260625-162518-364796` | v1 发布候选总验收与冻结 | `todo` | `2026-06-25T16:25:18+08:00` | `tmp/20260625-162518-364796-v1 发布候选总验收与冻结` |

## Completeness Matrix

All current task blocks contain the required QuickDev fields: target/goal, scope, acceptance criteria, constraints, and notes. The matrix focuses on whether the text is sufficient for independent `plan`, `actor`, and `verify` roles.

| Pos | Task ID | Required Fields | Implementation Context | Actor Executable | Verifier Independent | Main Prerequisites Or Blockers |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `20260625-163340-992326` | Present | Sufficient for docs audit | Yes | Yes | None; current audit task |
| 2 | `20260625-163153-333824` | Present | Sufficient; builds on existing design docs | Yes | Yes | Should run before most implementation tasks |
| 3 | `20260625-163246-549133` | Present | Sufficient after architecture contract | Yes | Yes | Depends on architecture vocabulary and command list |
| 4 | `20260625-163308-046461` | Present | Sufficient after architecture contract | Yes | Yes | Depends on architecture vocabulary; should precede sync/watch |
| 5 | `20260625-160751-353900` | Present | Sufficient, but requires current olcli source/license lookup | Yes | Yes | Architecture should define adapter boundary; network access may be needed |
| 6 | `20260625-160853-429297` | Present | Sufficient after olcli import and architecture contract | Yes | Yes | Depends on olcli import, backend interface, and auth model |
| 7 | `20260625-160804-867992` | Present | Sufficient; security paths are documented | Yes | Yes | Should follow CLI behavior contract; should precede command flows |
| 8 | `20260625-160819-417512` | Present | Sufficient after config/auth and CLI behavior | Yes | Yes | Depends on config schema, ignore rules, CLI output/exit codes |
| 9 | `20260625-160836-699088` | Present | Sufficient after config/auth, init, CLI behavior | Yes | Yes | Uses placeholder auth values only; no real account required |
| 10 | `20260625-160912-750072` | Present | Sufficient after sync state, backend, config/auth | Yes | Yes | Depends on fake backend, sync plan contract, ignore rules |
| 11 | `20260625-160925-146032` | Present | Sufficient after backend, config/auth, CLI behavior | Yes | Yes | Depends on compile adapter and PDF path ownership |
| 12 | `20260625-165248-545991` | Present | Medium; real private interface behavior is uncertain | Yes with fake tests | Yes for fake tests | Depends on compile flow and adapter; real behavior belongs in E2E |
| 13 | `20260625-160938-324045` | Present | Sufficient after sync and compile | Yes | Yes | Depends on sync safety, compile command, watch queue contract |
| 14 | `20260625-162413-873208` | Present | Sufficient after core fake-backend commands exist | Yes | Yes | Depends on init, auth, sync, compile, watch flows |
| 15 | `20260625-160946-910101` | Present | Sufficient in current `todo.md`; handoff copy should be refreshed | Conditional | Conditional | Requires pre-provided local E2E placeholders; blocks if missing or invalid |
| 16 | `20260625-162426-756284` | Present | Sufficient but broad | Yes | Yes | Depends on stable core behavior; CI/platform access needed |
| 17 | `20260625-162438-154174` | Present | Sufficient after code and notices stabilize | Yes | Yes | Depends on olcli notice state and package contents |
| 18 | `20260625-162447-918619` | Present | Sufficient after core commands and docs stabilize | Yes | Yes | Must use placeholders only; depends on stable config examples |
| 19 | `20260625-161006-526237` | Present | Sufficient but broad final-doc task | Yes | Yes | Depends on core implementation, examples, gates, E2E decision |
| 20 | `20260625-162518-364796` | Present | Sufficient as final gate | Yes | Yes | Must wait for all prior tasks; cannot fake real E2E status |

## Dependency Graph

Primary prerequisite relationships:

- `20260625-163340-992326` audit completes first so any queue reorder has a documented basis.
- `20260625-163153-333824` architecture contract should precede CLI, config/auth, backend, sync, compile, watch, diagnostics, fixtures, and docs that refer to internal module boundaries.
- `20260625-163246-549133` CLI behavior and exit-code contract should precede command implementation tasks: init, auth/status/doctor, sync, compile, watch, status-like diagnostics, and integration tests.
- `20260625-163308-046461` sync state machine should precede sync and watch so conflict semantics and snapshot ownership are shared.
- `20260625-160804-867992` config/auth security should precede init, auth/status/doctor, sync, compile, watch, local sandbox, real E2E, examples, and release gates.
- `20260625-160751-353900` olcli import/license should precede `20260625-160853-429297` backend adapter.
- `20260625-160853-429297` backend adapter should precede sync, compile, fast fallback, local sandbox, and real E2E.
- `20260625-160819-417512` init should precede auth/status/doctor and most user-flow integration tests because it establishes project binding.
- `20260625-160912-750072` sync and `20260625-160925-146032` compile should precede `20260625-160938-324045` watch.
- `20260625-160925-146032` compile should precede `20260625-165248-545991` fast/draft fallback.
- `20260625-162413-873208` local sandbox regression should run after the fake-backend core flows exist.
- `20260625-160946-910101` real E2E should run only after gated test handling, local secret loading, sync, compile, and fallback fake coverage exist.
- `20260625-162426-756284`, `20260625-162438-154174`, `20260625-162447-918619`, and `20260625-161006-526237` are hardening, package, example, and documentation tasks that should follow stable core behavior.
- `20260625-162518-364796` release-candidate freeze is last and depends on every prior result.

## Recommended Execution Order

This order preserves every current `todo.md` task exactly once. It is a recommendation only; no automatic reorder was performed.

1. `20260625-163340-992326` - 审计 QuickDev 队列顺序与任务可执行性. Finish and verify the current governance task before changing execution strategy.
2. `20260625-163153-333824` - 冻结 v1 架构模块与公共接口契约. Establish module boundaries, shared types, file ownership, and adapter boundaries.
3. `20260625-163246-549133` - 统一 CLI 行为输出与退出码规范. Lock command UX, output streams, non-interactive behavior, redaction, and exit codes.
4. `20260625-163308-046461` - 定义同步状态机快照与冲突报告格式. Lock sync/watch conflict semantics before implementation.
5. `20260625-160804-867992` - 建立项目配置认证与安全基础设施. Implement config/auth, local-only secret storage, schema validation, redaction, and ignore handling before user-flow commands.
6. `20260625-160751-353900` - 引入 olcli 后端代码与许可证合规. Bring in backend foundation with MIT attribution before wrapping it.
7. `20260625-160853-429297` - 实现 Overleaf 后端适配层. Encapsulate imported backend details behind the stable internal adapter and fake backend.
8. `20260625-160819-417512` - 实现 olcx init 与 VS Code 配置生成. Implement binding and local project setup after config schema and CLI contract exist.
9. `20260625-160836-699088` - 实现 olcx auth status doctor. Implement auth entry and diagnostics after project binding and config/auth storage exist.
10. `20260625-160912-750072` - 实现安全双向同步与冲突暂停. Implement safe sync using the state-machine contract, backend adapter, and ignore rules.
11. `20260625-160925-146032` - 实现远程编译和 PDF 下载. Implement compile and PDF download using the backend adapter and config ownership.
12. `20260625-165248-545991` - 实现 Overleaf 编译超时快速模式降级恢复. Extend compile after the baseline compile flow exists; verify real behavior later through gated E2E where possible.
13. `20260625-160938-324045` - 实现 olcx watch 自动工作流. Compose sync and compile into the debounced watcher only after both manual commands are stable.
14. `20260625-162413-873208` - 全链路本地沙箱回归测试. Validate the complete fake-backend CLI journey before real external testing.
15. `20260625-160946-910101` - 真实 Overleaf 集成 E2E 测试. Run only when local E2E placeholders are already provided; if missing or invalid, this task should block per its own constraints.
16. `20260625-162426-756284` - 跨平台与无头环境兼容性验证. Broaden platform confidence after the core flow is stable.
17. `20260625-162438-154174` - 安全许可证与供应链发布门禁. Add publish gates once code, notices, package contents, and E2E skip behavior are known.
18. `20260625-162447-918619` - 示例论文项目与故障排查资料. Create placeholder-only examples and troubleshooting after behavior and gates stabilize.
19. `20260625-161006-526237` - 文档发布与社区维护完善. Finalize public docs after examples, gates, platform notes, and E2E status are known.
20. `20260625-162518-364796` - v1 发布候选总验收与冻结. Final gate; must not claim stable release readiness without honest E2E status.

## Directly Executable Tasks

Directly executable here means the task has enough information for `plan`, `actor`, and `verify` roles and does not require real Overleaf account participation. It may still need earlier prerequisite tasks to complete first.

- Immediate under current FIFO: `20260625-163340-992326`.
- Directly executable after the current audit is archived: `20260625-163153-333824`, `20260625-163246-549133`, `20260625-163308-046461`.
- Directly executable after their prerequisites complete, using fake backends or placeholders only: `20260625-160804-867992`, `20260625-160751-353900`, `20260625-160853-429297`, `20260625-160819-417512`, `20260625-160836-699088`, `20260625-160912-750072`, `20260625-160925-146032`, `20260625-165248-545991`, `20260625-160938-324045`, `20260625-162413-873208`, `20260625-162426-756284`, `20260625-162438-154174`, `20260625-162447-918619`, `20260625-161006-526237`, `20260625-162518-364796`.

## Should Be Frontloaded

- `20260625-163153-333824` architecture contract: prevents command, backend, sync, compile, watch, and fixture tasks from inventing incompatible module boundaries.
- `20260625-163246-549133` CLI behavior contract: prevents inconsistent help text, exit codes, output streams, non-interactive behavior, and redaction behavior across commands.
- `20260625-163308-046461` sync state machine: prevents sync and watch from diverging on conflict, delete, ignore, and snapshot semantics.
- `20260625-160804-867992` config/auth security infrastructure: should be implemented before user-flow commands because it owns `.olcx/config.json`, `.olcx/auth.local.json`, redaction, and ignore behavior.
- `20260625-160751-353900` olcli import/license and `20260625-160853-429297` backend adapter: should precede network-facing sync, compile, fallback, and E2E work.

## Needs User Or Test Account Participation

- `20260625-160946-910101` real Overleaf E2E requires pre-provided local-only test values such as `OLCX_E2E_ENABLE_REAL`, `OLCX_E2E_OVERLEAF_SESSION`, `OLCX_E2E_PROJECT_ID`, optional `OLCX_E2E_ACCOUNT_LABEL`, and optional `OLCX_E2E_PROJECT_URL`, or equivalent `.env.e2e.local` entries. Do not write real values into git, queue files, docs, or handoff reports.
- `20260625-165248-545991` fast/draft fallback can be implemented and verified with fake backend coverage, but real fallback behavior depends on Overleaf private interface availability and should be covered by the gated E2E task when feasible.
- `20260625-162518-364796` release-candidate freeze needs a user/release decision if real E2E was skipped, blocked, or unavailable. It must report that limitation instead of treating stable release readiness as verified.
- Any reorder of `todo.md` requires explicit user confirmation before editing queue state.

## Needs Split Or Clarification

No task is missing required QuickDev fields. These are execution-risk clarifications, not reasons to mutate status during this audit.

- `20260625-160946-910101`: current `todo.md` and its existing `00-task.md` handoff copy differ. Before execution, refresh the handoff copy from the current queue block or have the plan role explicitly cite `todo.md` as authoritative.
- `20260625-165248-545991`: fast/draft fallback may need a small discovery subtask if the adapter cannot safely identify compile-setting APIs. Keep the fallback implementation separate from real E2E proof.
- `20260625-162426-756284`: broad across CI, platform path handling, environment variables, and watch behavior. Split into CI matrix plus platform-specific test/doc subtasks if the actor cannot keep the change reviewable.
- `20260625-161006-526237`: broad public documentation and maintenance task. Split README/tutorial, release docs, and contributor docs if it becomes too large for one reviewable actor pass.

## Reorder Safety

QuickDev is FIFO and append-only by default: the manager reads `todo.md` from top to bottom and selects the first task with `status: todo`. Skipping, deleting, or moving blocks without explicit confirmation would violate `goal.md` and could hide user intent.

No automatic reorder was performed in this audit. Safe manual reorder procedure, only after user confirmation:

1. Stop the queue manager before editing.
2. Confirm the exact recommended order and whether credential-dependent E2E should remain before later non-secret hardening tasks or be deferred.
3. Back up `todo.md`.
4. Move whole `<!-- quickdev-task:start ... -->` through `<!-- quickdev-task:end -->` blocks only; never edit IDs, titles, statuses, handoff directories, or task text while reordering.
5. Preserve every current task exactly once.
6. Run a block-count check and inspect `git diff -- todo.md`.
7. Resume QuickDev only after the user approves the diff.

If no user confirmation is given, keep FIFO execution. Under the current queue, the next implementation-relevant tasks after this audit are already the three frontloaded contract tasks.

## Security Review

This audit includes only policy names, placeholder variable names, paths, and task IDs. It does not include real credentials, raw cookie values, session values, passwords, private Overleaf project IDs, or real paper content.

Security requirements to preserve during future tasks:

- Project-local auth belongs in `.olcx/auth.local.json`.
- `.olcx/auth.local.json`, `.olcx/*.local.json`, `.olcx/*.secret.json`, and `.env.e2e.local` must remain ignored by Git.
- `.env.e2e.example` may contain empty placeholder variable names only.
- Fixtures, examples, docs, QuickDev handoff files, CI logs, and npm packages must not contain real credentials, private project IDs, or private paper content.
- Sync, watch, and package gates must explicitly avoid uploading or publishing local auth, generated PDFs, build artifacts, and unredacted logs.

## Git State Notes

Pre-audit `git status --short` showed:

- `M .gitignore`
- `?? .env.e2e.example`
- `?? done.md`
- `?? goal.md`
- `?? tmp/`
- `?? todo.md`

The `.gitignore` diff observed during audit adds an allowlist entry for `.env.e2e.example`. The QuickDev queue files and `tmp/` directory were already untracked or modified before this actor wrote the audit. This audit is expected to add `docs/quickdev-queue-audit.md` and `tmp/20260625-163340-992326-审计 QuickDev 队列顺序与任务可执行性/20-actor-report.md` only. It must not change `todo.md`, `done.md`, or `goal.md`.
