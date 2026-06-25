## User System Rules

# Rules

## 0) Hard Boundaries (Highest Priority — Never Violated)

### Scope Lock

- **NEVER** introduce new third-party dependencies unless the task explicitly requires it.
- **NEVER** create new files unrelated to the current task.
- **NEVER** modify interface signatures, function behavior, or code formatting outside the task scope under the guise of "maintaining compatibility" or "unifying style."
- **NEVER** proactively refactor existing code under the guise of "function too long" or "messy file structure" unless explicitly instructed.
- **NEVER** delete, merge, or relocate modules without an explicit migration instruction.

**Opportunistic fixes — fix on sight, report in completion report:**
When encountering a pre-existing issue that is unrelated to the current task, fix it immediately — without asking — if and only if ALL of the following are true:

1. No refactoring involved (moving, renaming, restructuring code).
2. No new dependencies required.
3. The fix is self-contained and low-risk (a typo, a missing null check, an unused import, an empty catch block, an obvious off-by-one, a broken log message).

If the issue fails any of the three criteria above — stop, do not touch it, and report it under **Follow-up** in the completion report.

### Data & Security

- **NEVER** fabricate tool outputs, test results, logs, or any external confirmations.
- **NEVER** hardcode where constants, enums, or shared definitions are appropriate.
- **NEVER** skip security review on auth, permissions, secrets, file access, execution paths, or user input.
- **NEVER** duplicate shared business rules, cache keys, or classification logic across multiple locations.

### Quality Gates

- **NEVER** ignore type errors, build errors, failing tests, or command failures.
- **NEVER** validate only the happy path — boundary cases and repeated runs must be covered.
- **NEVER** modify or add code paths outside the task scope in order to handle edge cases — discover the issue, report it, do not self-extend.
- Every `except` / `catch` / `match Err` branch **MUST** either handle the error with a log or propagate it. Empty catch blocks are forbidden. Log: what operation failed, the input context, and the original error message.

---

## 1) Basic Norms

- Address the user as `老板`.
- Default to Simplified Chinese. Use English only for code, commands, technical terms, commit types, and tool names.
- Treat the user as non-technical unless they clearly ask for engineering detail. Explain in business terms first.
- Do not dump code unless the user asks for it.
- Comments added to code must explain: business purpose, implementation logic, and edge cases. Use Chinese; avoid jargon.

---

## 2) Tool Invocation

- When a relevant skill or MCP tool exists for the task, invoke it directly — do not ask first.
- **NEVER** fall back to raw shell commands when a better tool alternative is available.

---

## 3) Execution Discipline

### 3.1 Before Acting

- State assumptions explicitly when meaning is unclear — never guess.
- When the requested approach is heavier than necessary, propose a simpler path.
- When business logic or domain rules are unclear, ask once rather than assume.

### 3.2 Change Discipline

- Do only what the user asked. Prefer the smallest change that solves the request.
- Fix broken things on sight — build errors, missing dependencies, type errors, broken commands — regardless of whether the current task introduced them.
- Apply opportunistic fixes per the criteria in §0 Scope Lock. Do not ask for permission; just fix and report under **Opportunistic fixes** in the completion report.
- Do not touch naming, formatting, or architecture preferences unless the task explicitly requires it.
- When replacing a component, function, or module: ① grep all references, ② update them, ③ delete the old file — all in the same change. No leftover references. No compatibility wrappers.

### 3.3 Verifiable Execution

- Execute autonomously. Do not stop and ask for confirmation between steps — keep going until the task is complete or you hit a blocker.
- Stop and ask only when: (a) verification fails and you cannot fix it, (b) business meaning or domain rules are unclear, (c) a destructive action has no safety net, or (d) the user explicitly asked to be consulted.
- On verification failure: stop immediately, report what failed and why. Do not self-patch tests or silently work around the failure.
- For multi-step tasks, list the plan first, then execute all steps autonomously:

```text
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
```

---

## 4) Completion Report

Trigger only when the task or milestone is fully completed:

```markdown
老板您好，已完成 [一句话总结]。

**做了什么**

- [业务层面]：[通俗说明变更内容和原因]

**结果**

- [什么变了]：[用户视角描述变更效果]
- [影响范围]：[受影响的页面 / 功能 / 模块]

**已确认**

- [验证项 1]：[验证方式和结果]
- [验证项 2]：[验证方式和结果]

**顺手修了这些** _(非本次任务引入的遗留问题，已在本次一并修复)_

- [文件 / 位置]：[问题描述，做了什么]

**需要你决策**

- [需人工判断的事项]：[为什么需要你决定]

**待跟进** _(发现但未修复——改动太大或风险过高)_

- #N：[简述] → [为何未在本次修复]
```

---

## 5) Code Structure

### 5.1 Function Scope

- **NEVER** write a function that does more than one thing. If the name needs "and" to describe its purpose, split it.
- This rule applies only to new or modified functions within the task scope. **NEVER** proactively refactor existing functions on this basis.

### 5.2 File Boundaries

- One file = one business concept. Any file with a generic name (`utils`, `helpers`, `common`, `misc`) that spans multiple unrelated domains is a boundary violation — regardless of line count.
- When a file directly touched by the task contains 2+ unrelated domains, extract each into its own file. **NEVER** proactively scan the codebase to clean this up.
- **NEVER** create a module file that only re-exports another module's symbols — inline the imports at call sites instead.

### 5.3 API Calls

- Before writing any code that calls your project's own backend (regardless of language or library), read `./api.d.ts` first. Endpoint path, HTTP method, request shape, and response shape must match exactly.
- External library APIs → query `context7` MCP. Your project's own API → read `./api.d.ts`. **NEVER** guess either.
- If `api.d.ts` does not exist or the needed endpoint is missing: update `api.d.ts` first, then implement both backend and frontend together. **NEVER** write client code against an undocumented endpoint.

---

## 6) Toolchain

- **Python**: ALL operations MUST go through `uv`. **NEVER** invoke `python`, `pip`, `venv`, or `virtualenv` directly.
- **JavaScript / TypeScript**: Use the package manager already present in the project (`npm`, `yarn`, or `pnpm` — determined by the lockfile). **NEVER** mix package managers in the same project.
- When the project's toolchain is not covered above, check the project-level for toolchain rules before using any default.

<general-project-rules>

# pi-swarm

Agent Swarm & Team extension for pi-coding-agent. Single to 128 subagents: parallel swarm (item-template) and collaborative team (role-based with mailbox). Live TUI progress, rate-limit-aware retries, concurrency control, crash recovery. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), team patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew).

Goal: replace both the third-party `subagent` extension and `worktree`, becoming the unified sub-agent orchestration solution for the pi ecosystem.

## When to Read Companion Files

| File                   | Directive                                                                                                                                                                                       | Trigger                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `PLAN.md`              | Architecture design, module specs, API contracts. Read before coding.                                                                                                                           | Any code change, new module, API design                        |
| `README.md`            | User-facing setup, install, and feature descriptions.                                                                                                                                           | User onboarding, release announcements                         |
| `CHANGELOG.md`         | Release history and version tracking. Update when releasing.                                                                                                                                    | Before creating a release, before investigating regression     |
| `LOCAL_CI.md`          | Local CI checklist. Run ALL checks BEFORE committing.                                                                                                                                           | Before every commit, before reporting task completion          |
| `OPS.md`               | Release operations checklist. Run through ALL items when publishing.                                                                                                                            | Before every release                                           |
| `LLM-REVIEW-GUIDE.md`  | Read before performing a code review on this project. Contains project-specific review rules, risk tiers, and sanity checks. NEVER submit review findings that violate the DO NOT REPORT rules. | Before any code review                                         |
| `docs/architecture.md` | Detailed architecture design, data flows, design rationale.                                                                                                                                     | Understanding module interactions, onboarding new contributors |

## Commands

| Command             | Purpose                                 |
| ------------------- | --------------------------------------- |
| `npm install`       | Install dependencies                    |
| `npm run build`     | Compile TS → `dist/`                    |
| `npm run typecheck` | `tsc --noEmit` — type validation        |
| `npm run dev`       | `tsc --watch` — incremental compilation |
| `npm test`          | Run all tests via vitest                |
| `npm run ci`        | typecheck + test + build + dist verify  |

## Development Environment

- Node.js >= 18, npm as package manager
- TypeScript 6.x with `NodeNext` module resolution
- Extension auto-discovered via `pi.extensions: ["./dist"]` in `package.json`
- Types imported from `@earendil-works/pi-coding-agent` (runtime) and `@earendil-works/pi-tui` (TUI components)
- Test the extension by symlinking `dist/` into `~/.pi/agent/extensions/pi-swarm` or installing via `pi install npm:@gjczone/pi-swarm@latest`

## Architecture

```
src/
├── index.ts              # Entry: default export, registers tools + commands + hooks
├── shared/
│   ├── types.ts          # Shared type definitions
│   ├── spawner.ts        # Sub-agent process spawner (pi --print)
│   ├── controller.ts     # Concurrency controller (ramp-up + rate-limit + abort)
│   ├── render.ts         # Result rendering (<agent_swarm_result> XML)
│   └── pi-invoke.ts      # pi CLI invocation helper
├── swarm/
│   ├── tool.ts           # AgentSwarm tool registration (pi.registerTool)
│   ├── command.ts        # /swarm slash command handler
│   └── mode.ts           # SwarmMode state machine (enter/exit/reminders)
├── team/
│   ├── tool.ts           # SwarmTeam tool registration (pi.registerTool)
│   ├── command.ts        # /swarm-team slash command handler
│   ├── mailbox.ts        # JSONL mailbox system (inbox/outbox/delivery)
│   ├── task-graph.ts     # Phase dependency graph (DAG)
│   └── supervisor.ts     # Team supervisor (decomposition + assignment + synthesis)
├── tui/
│   ├── progress.ts        # AgentSwarmProgressComponent (live braille progress bars)
│   ├── swarm-markers.ts   # SwarmModeMarkerComponent (activated/deactivated/ended)
│   ├── permission-prompt.ts  # Permission prompt dialog for manual mode
│   └── team-dashboard.ts  # SwarmTeam live phase progress dashboard
└── state/
    ├── persistence.ts    # Durable state (manifest, tasks, events, atomic writes)
    └── recovery.ts       # Crash recovery (stale run detection, cleanup)
```

### Layer Dependency

`tui/` + `state/` → `swarm/` + `team/` → `shared/` → `index.ts`

`shared/` is the core with zero pi or tui imports. `swarm/` and `team/` compose shared primitives. `tui/` implements Component from pi-tui. `state/` is pure Node.js filesystem. `index.ts` wires everything.

## Key Design Decisions

| Decision             | Choice                                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| Sub-agent execution  | Spawn `pi --print` child processes (JSON Lines event stream)                         |
| Concurrency strategy | Two-phase: ramp-up (5 + 1/700ms) → rate-limit (capacity model)                       |
| Rate-limit handling  | Auto suspend + retry with exponential backoff (3s/6s/12s/…)                          |
| Context isolation    | Each sub-agent runs in a fresh pi process, no parent context                         |
| Model selection      | Optional; passed via settings. Defaults to parent agent's model                      |
| Tool whitelist       | All tools available to sub-agents by default                                         |
| Persistence          | Durable file-based state; resume if not completed; disband when done                 |
| TUI progress         | Braille progress bars with 80ms frame animation, onProgress callback from controller |
| Swarm output format  | `<agent_swarm_result>` XML (compatible with kimi-code)                               |
| Team communication   | JSONL mailbox (inbox.jsonl / outbox.jsonl)                                           |
| Team workflow        | Sequential phases with dependency graph (DAG)                                        |
| Dual mode            | `/swarm` (parallel) + `/swarm-team` (collaborative)                                  |

## Change Map

- **Adding a new shared utility**: Create `shared/<name>.ts` → export → import in consumers; must not import from `swarm/`, `team/`, `tui/`, or `state/`
- **Adding a new type**: Add to `shared/types.ts`; if it's a value (e.g., `SMALL_MODEL_ROLES`), use `import` (not `import type`) in consumers
- **Adding a new tool**: Create `swarm/<name>.ts` or `team/<name>.ts` with `register*` function → import and call in `index.ts`
- **Adding a new command**: Create handler in `swarm/command.ts` or `team/command.ts` → register with `pi.registerCommand` in `index.ts`
- **Adding a TUI component**: Create `tui/<name>.ts` implementing `Component` from `@earendil-works/pi-tui`. If the component uses `setInterval` for animation, accept a `requestRender` callback and call it on each animation tick so the TUI framework knows to redraw.
- **Adding a team dashboard**: Create `tui/team-dashboard.ts` implementing `Component` from `@earendil-works/pi-tui`; add `TeamProgressSnapshot`, `TeamPhaseStatus`, `TeamProgressCallback` to `shared/types.ts`
- **Adding tool call/result rendering**: Implement `renderCall` and `renderResult` on the tool definition using `Container`/`Text`/`Spacer` from `@earendil-works/pi-tui` for rich display in the conversation transcript.
- **Wiring a TUI widget**: Use `setWidget(key, (tui, theme) => component, opts)` — capture the `tui` reference and pass it to your component so animation timers can call `tui.requestRender()`.
- **Adding persistence**: Add to `state/persistence.ts` → update `state/recovery.ts` if needed
- **Adding per-agent output.log**: Configure `agentDir` in `resolveAgentStateDir` → write to `output.log` in `spawnSubagent` with header/raw output/footer
- **Adding supervisor context passing**: Update `mailbox.ts` (new message types, `ackTaskMessages`) → update `supervisor.ts` (`buildPhasePrompt`, `startNextPhase` dependency results)
- **Adding per-role model tier**: Add `ModelTier`/`SMALL_MODEL_ROLES` to `types.ts` → add `getPhaseExecutionConfig()` to `supervisor.ts` → thread `model`/`tools`/`cwd` through `controller.ts` and `BaseQueuedSubagentTask` → add `small_model`/`modelTier`/`model`/`tools` to `team/tool.ts` schema
- **Enhancing result format**: Update `supervisor.ts` `synthesizeResult()` → add `buildSynthesis()`, `truncateForOutput()`, `extractFirstMeaningfulLine()`, `extractExcerpt()` → replace `escapeXml()` with `escapeAttr()`/`escapeBody()`
- **Changing concurrency strategy**: Modify `shared/controller.ts` → update PLAN.md and docs/architecture.md
- **Changing the team workflow**: Modify `team/supervisor.ts` or `team/task-graph.ts` → update PLAN.md

## First Places to Inspect

- `PLAN.md` — full architecture design and module specs
- `docs/architecture.md` — detailed design rationale, data flows, comparisons
- `src/shared/controller.ts` — concurrency controller (most complex module, ported from kimi-code SubagentBatch)
- `src/swarm/tool.ts` — AgentSwarm tool definition (with output.log persistence and run manifests)
- `src/team/supervisor.ts` — Team supervisor (goal decomposition, phase orchestration, context passing, model tier routing, result synthesis)
- `src/team/mailbox.ts` — JSONL mailbox system with message acknowledgment (inspired by pi-crew)
- `src/team/task-graph.ts` — Phase dependency graph (DAG) with timing tracking
- `src/team/tool.ts` — SwarmTeam tool definition (includes small_model, per-phase model/tools overrides)
- `src/tui/progress.ts` — TUI progress panel (ported from kimi-code AgentSwarmProgressComponent)
- `src/state/persistence.ts` — Durable state with atomic writes, per-agent output.log
- `src/index.ts` — extension entry, all registrations

# General Project Rules

## Coding Rules

- Layer boundaries: `tui/` + `state/` must not import from `swarm/` or `team/`. `shared/` is the core with zero pi or tui imports.
- Tool registration: Every tool file exports a `register*(pi: ExtensionAPI)` function. Registration happens in `index.ts` default export.
- Output format: AgentSwarm tool returns `<agent_swarm_result>` XML (compatible with kimi-code). Never mix formats.
- Error handling: Catch blocks must log the error and context. Do not swallow errors silently.
- Tool descriptions: Write clear, specific `description` strings — these are what the LLM reads to decide when to call.
- PRs: One vertical slice per PR — build a complete module, then merge. No big-bang PRs.
- AGENTS.md: Update this file whenever a new module, tool, command, or data flow is created.

## Testing Rules

- Type correctness: Run `npm run typecheck` after every change. This is the minimum verification gate.
- All tests must pass: `npm test` — 107 tests across 8 test files, 0 failures, 0 skipped.
- Integration testing: Symlink `dist/` into `~/.pi/agent/extensions/pi-swarm` and verify tool calls in a live Pi session.
- Verification: Test with 2-3 items first, then scale to 10+ to verify concurrency behavior.

## Debugging Rules

- Read `LOCAL_CI.md` for the exact reproduction commands before investigating any test failure.
- Check `events.jsonl` under `.pi/swarm/state/runs/<runId>/` for the append-only event log of a failed run.
- Inspect per-agent status at `.pi/swarm/state/runs/<runId>/agents/<agentId>/status.json`.
- `npm run build` must succeed before any runtime debugging — run it after every code change.

## API Rules

- Extension API: Import types from `@earendil-works/pi-coding-agent` runtime package. Use `ExtensionAPI`, `ExtensionContext` — do not redefine these types.
- Tool naming: The AgentSwarm tool is named `AgentSwarm` (matching kimi-code convention). Commands use `/swarm` prefix. Team tool is registered as `SwarmTeam`.
- Pi --print mode: Sub-agents communicate via `pi --print` JSON Lines output. Parse `message_end` and `tool_result_end` events to track progress.

## Data & State Rules

- State is stored under `.pi/swarm/state/`. The extension auto-creates `.pi/` if it doesn't exist.
- Atomic writes: `state/persistence.ts` exports `writeAtomic` (temp-file + rename) for crash-safe writes. All JSON/JSONL state mutations (mailbox, delivery, manifest) use it to prevent partial writes on crash.
- Crash recovery: `state/recovery.ts` detects stale runs (30min no heartbeat) on session start and marks them abandoned.
- Cleanup: Completed runs auto-deleted after 7 days.

## Verification Before Completion

- `npm run typecheck` passes with zero errors.
- `npm test` — 107 tests pass across 8 test files.
- `npm run build` succeeds with `dist/index.js` and `dist/index.d.ts` present.
- AgentSwarm tool: callable from Pi, returns valid `<agent_swarm_result>` XML.
- /swarm command: responds correctly to `on`, `off`, and task inputs.
- TUI progress: renders correctly with live braille animation via onProgress callback.
- Concurrency: ramp-up follows the 5 + 1/700ms strategy.

## Project-Specific Rules

- **CREDIT RULE**: README.md MUST include a credit section acknowledging MoonshotAI/kimi-code as the original source of the AgentSwarm architecture. Do not remove or diminish this credit.
- **LANGUAGE RULE**: All source code, code comments, JSDoc, commit messages, PR titles/descriptions, GitHub Issue content, and GitHub Release notes MUST be written in English. No Chinese or any other non-English language in any artifact that goes into the repository.
- **No emoji or decorative symbols.** Emoji, Unicode decorative characters, and ASCII art are forbidden in all source files, tool output, code comments, and commit messages. The only allowed symbols are standard ASCII punctuation and Markdown formatting characters. This rule applies to all repository artifacts except `AGENTS.md` itself (this file) and user-facing documentation where appropriate.
- **Tool output must be clean.** Tool output text returned to the LLM must be minimal, structured, and free of noise. Specifically:
  - No emoji, no decorative Unicode, no ANSI escape codes
  - No "friendly" filler phrases — be direct and factual
  - Consistent heading hierarchy
  - Numerical data in tables or key-value pairs, not prose
  - Truncation explicitly flagged
  - No trailing whitespace, no excessive blank lines

## Agent Checklist

Before committing or creating a PR, verify ALL of the following:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds with `dist/index.js` and `dist/index.d.ts` present
- [ ] `npm test` passes with 107 tests, 0 failures
- [ ] `LOCAL_CI.md` all steps passed
- [ ] `PLAN.md` updated if architecture, API, or module specs changed
- [ ] `docs/architecture.md` updated if design rationale or data flows changed
- [ ] `README.md` updated if user-facing features changed (small_model, result format, output.log)
- [ ] `CHANGELOG.md` updated with version entry
- [ ] `AGENTS.md` updated if new module/tool/command/hook/data flow was added
- [ ] `LLM-REVIEW-GUIDE.md` LOC count, test count, file lists match current code
- [ ] Credit to MoonshotAI/kimi-code preserved in README.md
- [ ] All code comments, JSDoc, commit messages in English
- [ ] Completion report: 做了什么 → 结果 → 已确认 → 需要你决策 → 待跟进
- [ ] Address user as 老板, default to Chinese, explain in business terms, don't dump code
- [ ] Code comments explain business purpose + implementation logic + edge cases (in Chinese)
- [ ] No empty catch blocks — handle or propagate every error

</general-project-rules>
