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

- Before writing any code that calls your project's own backend (regardless of language or library), read `rules/api.d.ts` first. Endpoint path, HTTP method, request shape, and response shape must match exactly.
- External library APIs → query `context7` MCP. Your project's own API → read `rules/api.d.ts`. **NEVER** guess either.
- If `rules/api.d.ts` does not exist or the needed endpoint is missing: update `rules/api.d.ts` first, then implement both backend and frontend together. **NEVER** write client code against an undocumented endpoint.

---

## 6) Toolchain

- **Python**: ALL operations MUST go through `uv`. **NEVER** invoke `python`, `pip`, `venv`, or `virtualenv` directly.
- **JavaScript / TypeScript**: Use the package manager already present in the project (`npm`, `yarn`, or `pnpm` — determined by the lockfile). **NEVER** mix package managers in the same project.
- When the project's toolchain is not covered above, check the project-level for toolchain rules before using any default.
  <general-project-rules>

# pi-swarm

Agent Swarm & Team extension for pi-coding-agent. Single to 20 subagents: parallel swarm (item-template) with optional mailbox mode. Live TUI progress, rate-limit-aware retries, concurrency control, crash recovery.

Goal: replace both the third-party `subagent` extension and `worktree`, becoming the unified sub-agent orchestration solution for the pi ecosystem.

## shazam Tools — USE THEM

You have access to pi-shazam — 7 code analysis tools. You WILL use every one of them. They are NOT optional.

**`shazam_overview` is ALREADY in your context.** It was auto-injected before you started reading. READ it. The project structure, top files, and hotspots are right there above this section. If you can see the overview output in your context — Do NOT call `shazam_overview`. If you do NOT see it — call it immediately. It is the single most important tool. You cannot work blind.

Here are the other 6 tools. You MUST call them. Memorize them. Use them or fail.

| Tool                   | What it does                                                        | You MUST call it when                                                             |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `shazam_lookup`        | Symbol/file details — hover info, type hierarchy, callers, callees  | You need to understand any symbol or file                                         |
| `shazam_impact`        | Blast radius — every file, symbol, and test affected by your change | BEFORE editing shared or exported modules. Do NOT guess what you'll break.        |
| `shazam_verify`        | Post-edit gate — LSP diagnostics, graph analysis, PASS/WARN/FAIL    | AFTER every write. Run it. Read the verdict. If it says FAIL or WARN, fix it NOW. |
| `shazam_changes`       | Git change summary with symbol-level detail and risk level          | You edited things and need to know what actually changed                          |
| `shazam_format`        | Auto-fix formatting — supports multiple formatters                  | `shazam_verify` reports format errors                                             |
| `shazam_rename_symbol` | Cross-file symbol rename with atomic writes and safety gate         | Renaming ANY symbol. Do NOT manually find-and-replace.                            |

If a tool errors or is unavailable, try once more, then work around it. But you MUST try it first. These tools are the difference between a working change and a broken build.

## When to Read Companion Files

| File                   | Trigger                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `PLAN.md`              | Any code change, new module, API design — architecture design, module specs, API contracts |
| `README.md`            | User onboarding, release announcements                                                     |
| `CHANGELOG.md`         | Before creating a release, before investigating regression                                 |
| `docs/architecture.md` | Understanding module interactions, data flows, design rationale                            |

## When to Read Rules Files

| File                    | Trigger                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `rules/CODING.md`       | Before writing or modifying any source code                                                  |
| `rules/REVIEW-RULES.md` | Before performing a code review — NEVER submit findings that violate the DO NOT REPORT rules |
| `rules/ARCHITECTURE.md` | Before modifying module structure or layer boundaries                                        |

## Project Snapshot

- **Language**: TypeScript 6.x, `NodeNext` module resolution, compiled to `dist/`
- **Runtime**: Node.js >= 18, npm package manager
- **Type**: pi-coding-agent extension, auto-discovered via `pi.extensions: ["./dist"]` in `package.json`
- **Dependencies**: `@earendil-works/pi-tui` (TUI components), `typebox` (schema); peer: `@earendil-works/pi-coding-agent`
- **Test framework**: vitest — 85 tests, 7 test files, 0 failures
- **Key risk areas**: concurrency controller (rate-limit capacity model, runAsync coordinator), sub-agent process lifecycle (spawn/kill/abort), worktree isolation edge cases, mailbox atomic writes, profile resolution ordering

## Commands

| Command                   | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `npm install`             | Install dependencies                                |
| `npm run build`           | Compile TS → `dist/`                                |
| `npm run typecheck`       | `tsc --noEmit` — type validation                    |
| `npm run dev`             | `tsc --watch` — incremental compilation             |
| `npm test`                | Run all tests via vitest                            |
| `npm run ci`              | typecheck + test + build + dist verify              |
| `bash scripts/ci.sh`      | Full CI: typecheck, test, build, lint, verify       |
| `bash scripts/release.sh` | Release checklist — run ALL items before publishing |

Dev env: Node.js >= 18. Extension tested by symlinking `dist/` into `~/.pi/agent/extensions/pi-swarm`.

## Architecture

**Layer dependency**: `tui/` + `state/` → `swarm/` + `team/` → `shared/` → `index.ts`

- `shared/` — no pi or tui imports. Pure logic, types, process management, agent profiles.
- `swarm/` — compose shared primitives, register pi tools/commands (Swarm, SwarmCoordinator, SendMessage, TaskStop, SwarmStatus). Must not import from `team/`.
- `team/` — mailbox system and team command. Must not import from `swarm/`.
- `tui/` — implements `Component` from `@earendil-works/pi-tui`.
- `state/` — pure Node.js filesystem, no pi imports.
- `index.ts` — wires everything via `pi.registerTool`, `pi.registerCommand`, `pi.on`.

## Key Design Decisions

| Decision              | Choice                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Sub-agent execution   | Spawn `pi --print` child processes (JSON Lines event stream)                                                         |
| Concurrency strategy  | Two-phase: ramp-up (5 + 1/700ms) → rate-limit (capacity model)                                                       |
| Rate-limit handling   | Auto suspend + retry with exponential backoff (3s/6s/12s/…)                                                          |
| Context isolation     | Each sub-agent runs in a fresh pi process, no parent context sharing                                                 |
| Persistence           | Durable file-based state under `.pi/swarm/state/`; resume if not completed                                           |
| TUI progress          | Fixed-width tool-call-driven braille bars with baseline track, onProgress callback                                   |
| Swarm output format   | `<agent_swarm_result>` XML                                                                                           |
| Mailbox communication | JSONL mailbox (inbox.jsonl / outbox.jsonl) with atomic writes and real-time polling                                  |
| Agent profiles        | Capability-based (allowWrite / allowBashWrite). Four built-in + user-defined custom via settings                     |
| Coordinator mode      | Non-blocking swarm via `runAsync()` + `SwarmHandle`. Main agent orchestrates with SendMessage/TaskStop               |
| Triple mode           | `/swarm` (blocking parallel), `/swarm-team` (mailbox collaborative), `SwarmCoordinator` (non-blocking orchestration) |

## Data & State Flows

| State location                                              | Purpose                                                 | Lifecycle                                         |
| ----------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `.pi/swarm/state/runs/<runId>/manifest.json`                | Run metadata, agent list, start/end times               | Created at run start, updated on completion       |
| `.pi/swarm/state/runs/<runId>/tasks.json`                   | Task queue with status per agent                        | Created at run start, updated per task completion |
| `.pi/swarm/state/runs/<runId>/events.jsonl`                 | Append-only event log                                   | Written throughout run, read for crash recovery   |
| `.pi/swarm/state/runs/<runId>/agents/<agentId>/status.json` | Per-agent status (running/completed/failed)             | Created at agent spawn, updated on exit           |
| `.pi/swarm/state/runs/<runId>/agents/<agentId>/output.log`  | Per-agent full stdout/stderr                            | Written during agent execution                    |
| `.pi/swarm/state/runs/<runId>/mailbox/`                     | Team mailbox (inbox.jsonl, outbox.jsonl, delivery.json) | Created for team runs, polled at ~1.25Hz          |

Crash recovery: `state/recovery.ts` detects stale runs (30min no heartbeat) on session start and marks them abandoned. Completed runs auto-deleted after 7 days. All JSON/JSONL mutations use `writeAtomic` (temp-file + rename) to prevent partial writes.

## Debugging Guide

| Symptom                                     | Likely cause                                  | Check                                                                |
| ------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Sub-agent spawns but produces no output     | `pi --print` path resolution wrong            | Inspect `pi-invoke.ts` resolution logic, verify pi CLI is on PATH    |
| Rate-limit errors cascade                   | Capacity model depleted                       | Check `controller.ts` rate-limit phase logic, verify backoff timing  |
| Run appears "stuck"                         | Dead agent process or starvation              | Inspect `events.jsonl` for last event, check per-agent `status.json` |
| Mailbox messages not delivered              | Polling interval or symlink issue in worktree | Check mailbox directory exists, verify outbox polling at 800ms       |
| Build succeeds but extension not discovered | `dist/` not in `pi.extensions` array          | Verify `package.json` has `"pi": { "extensions": ["./dist"] }`       |

Log locations: `.pi/swarm/state/runs/<runId>/events.jsonl` (event log), `.pi/swarm/state/runs/<runId>/agents/<agentId>/output.log` (per-agent output). Always `npm run build` before runtime debugging.

## Change Map

- **Adding a new shared utility**: Create `shared/<name>.ts` → export → import in consumers; must not import from `swarm/`, `team/`, `tui/`, or `state/`
- **Adding a file-based agent format**: Create `.md` file in `~/.pi/agents/` or `.pi/agents/` with YAML frontmatter. See `src/shared/agents.ts` for parsing logic.
- **Adding a new type**: Add to `shared/types.ts`; value exports use `import` (not `import type`) in consumers
- **Adding a new tool**: Create `swarm/<name>.ts` or `team/<name>.ts` with `register*(pi: ExtensionAPI)` → import and call in `index.ts`
- **Adding a new command**: Create handler in `swarm/command.ts` or `team/command.ts` → register with `pi.registerCommand` in `index.ts`
- **Adding a TUI component**: Create `tui/<name>.ts` implementing `Component` from `@earendil-works/pi-tui`. Animation timers must accept a `requestRender` callback and call it on each tick.
- **Adding persistence**: Add to `state/persistence.ts` → update `state/recovery.ts` if needed. Always use `writeAtomic` for JSON/JSONL writes.
- **Adding per-agent output.log**: Configure `agentDir` in `resolveAgentStateDir` → write in `spawnSubagent` with header/raw output/footer
- **Adding a new agent profile**: Add built-in to `BUILTIN_PROFILES` in `shared/profiles.ts` → add to `BuiltinProfileName` type union in `types.ts` → document in README.md
- **Adding tool restrictions to a profile**: Set `tools` (allowlist) or `disallowedTools` (denylist) on `AgentProfile`. See `resolveProfileTools()` in `shared/profiles.ts`.
- **Adding auto-routing rules to a file agent**: Add `matchPatterns` and `matchKeywords` frontmatter fields. See `matchItemToAgent()` in `shared/agents.ts`.
- **Adding a coordinator tool**: Create handler in `swarm/coordinator.ts` → register via `pi.registerTool` → update `index.ts` to import and call the registration function
- **Blocking a tool at system level**: Add to `FORBIDDEN_SUBAGENT_TOOLS` in `shared/pi-invoke.ts`. This prevents the tool from ever being passed to subagents.
- **Adding per-role model tier**: Add `ModelTier`/`SMALL_MODEL_ROLES` to `types.ts` → thread `model`/`tools`/`cwd` through `controller.ts` and `BaseQueuedSubagentTask`
- **Changing concurrency strategy**: Modify `shared/controller.ts` → update `PLAN.md` and `docs/architecture.md`

## First Places to Inspect

- `src/shared/controller.ts` — concurrency controller (two-phase ramp-up / rate-limit, runAsync)
- `src/shared/spawner.ts` — sub-agent lifecycle: spawn, event parsing, worktree, mailbox polling
- `src/shared/worktree.ts` — git worktree isolation (create, symlink, commit, cleanup)
- `src/shared/agents.ts` — file-based agent loader: ~/.pi/agents/\*.md scanning, frontmatter parsing, AgentProfile conversion, matchItemToAgent() routing, buildAgentListing()
- `src/shared/profiles.ts` — agent profile registry (built-in + file-based + user-defined), tool restrictions with allowlist/denylist, resolveProfileTools()
- `src/shared/pi-invoke.ts` — pi CLI invocation, buildSubagentArgs() with FORBIDDEN_SUBAGENT_TOOLS filtering
- `src/swarm/tool.ts` — Swarm tool definition (output.log persistence, run manifests, profile support)
- `src/swarm/coordinator.ts` — Coordinator mode (SwarmCoordinator, SendMessage, TaskStop, SwarmStatus)
- `src/team/mailbox.ts` — JSONL mailbox with message acknowledgment
- `src/team/command.ts` — /swarm-team slash command
- `src/tui/progress.ts` — TUI braille progress panel (fixed-width baseline track)
- `src/state/persistence.ts` — Durable state with atomic writes, per-agent output.log
- `src/index.ts` — extension entry, all registrations

## Project-Specific Rules

- **CREDIT RULE**: README.md MUST include a credit section acknowledging MoonshotAI/kimi-code as the original source of the AgentSwarm architecture. Do not remove or diminish this credit.
- **LANGUAGE RULE**: All source code, code comments, JSDoc, commit messages, PR titles/descriptions, GitHub Issue content, and GitHub Release notes MUST be written in English. No Chinese or any other non-English language in any artifact that goes into the repository.
- **No emoji or decorative symbols**: Emoji, Unicode decorative characters, and ASCII art are forbidden in all source files, tool output, code comments, and commit messages. The only allowed symbols are standard ASCII punctuation and Markdown formatting characters. This rule applies to all repository artifacts except `AGENTS.md` itself and user-facing documentation where appropriate.
- **Tool output must be clean**: Tool output text returned to the LLM must be minimal, structured, and free of noise: no emoji, no decorative Unicode, no ANSI escape codes, no "friendly" filler phrases, consistent heading hierarchy, numerical data in tables or key-value pairs, truncation explicitly flagged, no trailing whitespace.

## Agent Checklist

- [ ] Run `bash scripts/ci.sh` before every commit — all checks pass, 0 failures
- [ ] Run `bash scripts/release.sh` before every release — follow the printed checklist
- [ ] Read `rules/CODING.md` before writing or modifying code
- [ ] Read `rules/ARCHITECTURE.md` before modifying module structure or layer boundaries
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm test` passes — 107+ tests, 0 failures
- [ ] `npm run build` succeeds with `dist/index.js` and `dist/index.d.ts` present
- [ ] `PLAN.md` updated if architecture, API, or module specs changed
- [ ] `docs/architecture.md` updated if design rationale or data flows changed
- [ ] `AGENTS.md` updated if new module, tool, command, or data flow was added
- [ ] Credit to MoonshotAI/kimi-code preserved in README.md
- [ ] Address as 老板 — user-system-rules.md §1
- [ ] Completion report format — user-system-rules.md §4
- [ ] No empty catch blocks — user-system-rules.md §0 Quality Gates

</general-project-rules>
