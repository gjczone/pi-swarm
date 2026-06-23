## User System Rules

# Rules

## 1) Prohibitions

- No silent assumptions at critical semantic points.
- No fabricated tool outputs, test results, logs, or external confirmations.
- No hardcoding where constants, enums, or shared definitions are appropriate.
- No blind copy-paste of generated code. Review all generated code, especially queries, auth, file handling, and user input.
- No skipping verification for features, bugfixes, or behavior changes.
- No ignoring security on auth, permissions, secrets, file access, execution, or user input paths.

## 2) Basic Norms

- Address the user as `老板`.
- Default to Simplified Chinese. Use English only for code, commands, technical terms, commit types, and tool names.
- Treat the user as non-technical unless they clearly ask for engineering detail. Explain in business terms first.
- Do not dump code unless the user asks for code.
- Verify important claims with tools. Do not ignore type errors, build errors, failing tests, or command failures.
- Comments added to code must explain: business purpose, implementation logic, and edge cases; use Chinese and avoid jargon.

## 3) Behavioral Guidelines

### 3.1 Before Acting

- State assumptions explicitly when meaning is unclear.
- Propose a simpler path when the requested approach is heavier than necessary.
- When business logic or domain rules are unclear, ask once rather than guess. A wrong assumption costs more than a clarifying question.

### 3.2 Change Discipline

- Do only what the user asked. Prefer the smallest change that solves the request.
- Fix broken things on sight — build errors, missing dependencies, type errors, broken commands — regardless of whether the current task introduced it. Do not touch anything that is a matter of style or opinion (naming, formatting, architecture preference) unless the task explicitly requires it. Report fixes in the completion report.
- Match the local style of the touched area.
- Keep shared business rules, cache keys, and classification logic in one source of truth. When adding state, cache, schema, or persisted fields, update the full lifecycle.

### 3.3 Verifiable Execution

- Verify beyond the happy path: boundary cases, repeated runs, and nearby old entry points.
- Execute autonomously. Do not stop and ask for confirmation between steps — keep going until the task is complete or you hit a blocker.
- Stop and ask only when: (a) verification fails and you cannot fix it, (b) business meaning or domain rules are unclear, (c) a destructive action has no safety net, or (d) the user explicitly asked to be consulted.
- Verification failure: stop immediately, report what failed and why, do not self-patch tests or silently work around the failure.

## 4) Completion Report

Trigger only when the task or milestone is fully completed:

```markdown
老板您好，已完成 [一句话总结]。

**做了什么**

- [业务层面]: [通俗说明变更内容和原因]

**结果**

- [什么变了]: [用户视角描述变更效果]
- [影响范围]: [受影响的页面/功能/模块]

**已确认**

- [验证项 1]: [验证方式和结果]
- [验证项 2]: [验证方式和结果]

**需要你决策**

- [需人工判断的事项]: [为什么需要你决定]

**待跟进**

- #N: [简述] → 已建 issue，后续处理
```

## 5) Tool Invocation — Aggressive & Automatic

Skills and MCP tools provide domain-specific knowledge and workflows. When a relevant skill or MCP tool exists for the task at hand, invoke it without asking — do not default to raw shell commands when a better alternative is available.

## 6) Coding Structure Rules

### 6.1 Function Scope

- A function does ONE thing. If its name needs "and" to describe its purpose, split it.
- If a function exceeds 80 lines, extract helper functions (`_build_*`, `_compute_*`, `_classify_*`).

### 6.2 File Boundaries

- One file = one business concept. A file named `utils.ts` or `helpers.ts` over 200 lines is no longer utilities — split it by domain.
- When a single file contains 2+ unrelated domains, extract each into its own file under a shared directory.
- When migrating: grep all callers first, update them, then delete the old file. Do not create pass-through compatibility layers.

### 6.3 Deletion Discipline

- When a component, function, or module is replaced, delete the old one in the same change. No compatibility wrappers.
- Before deleting, grep for all references. If any remain, update them in the same change.
- A file that only re-exports another module's symbols is dead weight — inline the imports at call sites and remove the file.

### 6.4 API Calls

- Before writing any `fetch()`, `axios.`, `curl`, or API client code, read `./api.d.ts` if it exists. The endpoint path, HTTP method, request shape, and response shape must match `api.d.ts` exactly.
- When implementing a new API call, cross-check: does the backend endpoint exist in `api.d.ts`? Does the frontend request shape match the backend's expected input?
- External library APIs → query `context7` MCP. Your project's own API → read `./api.d.ts`. Know which is which — do not guess either.
- If the needed endpoint is not in `api.d.ts`, update `api.d.ts` FIRST, then implement both backend and frontend. Never write client code against an undocumented endpoint.

### 6.5 Logging

- Every `except` / `catch` / `match Err` branch must either handle the error (with a log) or propagate it. Empty catch blocks are forbidden.
- When handling an error, log: what operation failed, the input context, and the original error message.

## 7) Reasoning

Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.

## 8) Toolchain Rules

- Python: ALL operations MUST go through `uv` — installing, running, syncing, building. NEVER invoke `python`, `pip`, `venv`, or `virtualenv` directly. If a command needs Python, wrap it with `uv run`. If dependencies need installing, use `uv sync`. If a virtual environment is needed, `uv` manages it automatically.
- Node.js: Use `npm` as package manager. `npm install` for dependencies, `npm run build` for TypeScript compilation.

<general-project-rules>

# pi-swarm

Agent Swarm & Team extension for pi-coding-agent. Single to 128 subagents: parallel swarm (item-template) and collaborative team (role-based with mailbox). Live TUI progress, rate-limit-aware retries, concurrency control, crash recovery. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code), team patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew).

Goal: replace both the third-party `subagent` extension and `worktree`, becoming the unified sub-agent orchestration solution for the pi ecosystem.

## When to Read Companion Files

| File          | Directive                                                              | Trigger                                                        |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `PLAN.md`     | Architecture design, module specs, API contracts. Read before coding.  | Any code change, new module, API design                        |
| `README.md`   | User-facing setup, install, and feature descriptions.                  | User onboarding, release announcements                         |
| `CHANGELOG.md`| Release history and version tracking. Update when releasing.           | Before creating a release, before investigating regression     |
| `LOCAL_CI.md` | Local CI checklist. Run ALL checks BEFORE committing.                  | Before every commit, before reporting task completion          |
| `OPS.md`      | Release operations checklist. Run through ALL items when publishing.   | Before every release                                           |
| `docs/architecture.md` | Detailed architecture design, data flows, design rationale.     | Understanding module interactions, onboarding new contributors |

## Commands

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `npm install`       | Install dependencies                         |
| `npm run build`     | Compile TS → `dist/`                         |
| `npm run typecheck` | `tsc --noEmit` — type validation             |
| `npm run dev`       | `tsc --watch` — incremental compilation      |
| `npm test`          | Run all tests via vitest (TBD)               |

## Development Environment

- Node.js >= 18, npm as package manager
- TypeScript 5.x with `NodeNext` module resolution
- Extension auto-discovered via `pi.extensions: ["./dist"]` in `package.json`
- Types imported from `@earendil-works/pi-coding-agent` (runtime) and `@earendil-works/pi-tui` (TUI components)
- Test the extension by symlinking `dist/` into `~/.pi/agent/extensions/pi-swarm` or installing via `pi install npm:pi-swarm`

## Architecture

```
src/
├── index.ts              # Entry: default export, registers tool + command + hooks
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
│   ├── tool.ts           # AgentTeam tool registration (pi.registerTool)
│   ├── command.ts        # /swarm-team slash command handler
│   ├── mailbox.ts        # JSONL mailbox system (inbox/outbox/delivery)
│   ├── task-graph.ts     # Phase dependency graph (DAG)
│   └── supervisor.ts     # Team supervisor (decomposition + assignment + synthesis)
├── tui/
│   ├── progress.ts       # AgentSwarmProgressComponent (live braille progress bars)
│   ├── swarm-markers.ts  # SwarmModeMarkerComponent (activated/deactivated/ended)
│   └── permission-prompt.ts # Permission prompt dialog for manual mode
└── state/
    ├── persistence.ts    # Durable state (manifest, tasks, events, atomic writes)
    └── recovery.ts       # Crash recovery (stale run detection, cleanup)
```

### Layer Dependency

`tui/` + `state/` → `swarm/` + `team/` → `shared/` → `index.ts`

`shared/` is the core with zero pi or tui imports. `swarm/` and `team/` compose shared primitives. `tui/` implements Component from pi-tui. `state/` is pure Node.js filesystem. `index.ts` wires everything.

## Key Design Decisions

| Decision                 | Choice                                                         |
| ------------------------ | -------------------------------------------------------------- |
| Sub-agent execution      | Spawn `pi --print` child processes (JSON Lines event stream)   |
| Concurrency strategy     | Two-phase: ramp-up (5 + 1/700ms) → rate-limit (capacity model)|
| Rate-limit handling      | Auto suspend + retry with exponential backoff (3s/6s/12s/…)   |
| Context isolation        | Each sub-agent runs in a fresh pi process, no parent context   |
| Model selection          | Optional; passed via settings. Defaults to parent agent's model|
| Tool whitelist           | All tools available to sub-agents by default                   |
| Persistence              | Durable file-based state; resume if not completed; disband when done |
| TUI progress             | Braille progress bars (`⣀⣤⣶⣿`) with 80ms frame animation    |
| Swarm output format      | `<agent_swarm_result>` XML (compatible with kimi-code)         |
| Team communication       | JSONL mailbox (inbox.jsonl / outbox.jsonl)                     |
| Team workflow            | Sequential phases with dependency graph (DAG)                  |
| Dual mode               | `/swarm` (parallel) + `/swarm-team` (collaborative)            |

## Credit

This project ports the AgentSwarm architecture from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) to the pi-coding-agent extension ecosystem. The concurrency controller (SubagentBatch), tool definition (AgentSwarm), TUI progress component, and swarm mode state machine are all directly adapted from kimi-code's implementation. Thank you to the kimi-code team for their excellent design.

## Change Map

- **Adding a new shared utility**: Create `shared/<name>.ts` → export → import in consumers; must not import from `swarm/`, `team/`, `tui/`, or `state/`
- **Adding a new tool**: Create `swarm/<name>.ts` or `team/<name>.ts` with `register*` function → import and call in `index.ts`
- **Adding a new command**: Create handler in `swarm/command.ts` or `team/command.ts` → register with `pi.registerCommand` in `index.ts`
- **Adding a TUI component**: Create `tui/<name>.ts` implementing `Component` from `@earendil-works/pi-tui`
- **Adding persistence**: Add to `state/persistence.ts` → update `state/recovery.ts` if needed
- **Changing concurrency strategy**: Modify `shared/controller.ts` → update PLAN.md and docs/architecture.md
- **Changing the team workflow**: Modify `team/supervisor.ts` or `team/task-graph.ts` → update PLAN.md

## First Places to Inspect

- `PLAN.md` — full architecture design and module specs
- `docs/architecture.md` — detailed design rationale, data flows, comparisons
- `src/shared/controller.ts` — concurrency controller (most complex module, ported from kimi-code SubagentBatch)
- `src/swarm/tool.ts` — AgentSwarm tool definition
- `src/team/supervisor.ts` — Team supervisor (goal decomposition + phase orchestration)
- `src/team/mailbox.ts` — JSONL mailbox system (inspired by pi-crew)
- `src/tui/progress.ts` — TUI progress panel (ported from kimi-code AgentSwarmProgressComponent)
- `src/state/persistence.ts` — Durable state with atomic writes
- `src/index.ts` — extension entry, all registrations

# General Project Rules

## Coding Rules

- Layer boundaries: `tui/` + `utils/` must not import from `swarm/`. `swarm/` is the core.
- Tool registration: Every tool file exports a `register*(pi: ExtensionAPI)` function. Registration happens in `index.ts` default export.
- Output format: AgentSwarm tool returns `<agent_swarm_result>` XML (compatible with kimi-code). Never mix formats.
- Error handling: Catch blocks must log the error and context. Do not swallow errors silently.
- Tool descriptions: Write clear, specific `description` strings — these are what the LLM reads to decide when to call.
- PRs: One vertical slice per PR — build a complete module, then merge. No big-bang PRs.
- AGENTS.md: Update this file whenever a new module, tool, command, or data flow is created.

## Testing Rules

- Type correctness: Run `npm run typecheck` after every change. This is the minimum verification gate.
- Integration testing: Symlink `dist/` into `~/.pi/agent/extensions/pi-swarm` and verify tool calls in a live Pi session.
- Verification: Test with 2-3 items first, then scale to 10+ to verify concurrency behavior.

## Verification Before Completion

- Every module: `npm run typecheck` passes with zero errors.
- AgentSwarm tool: callable from Pi, returns valid `<agent_swarm_result>` XML.
- /swarm command: responds correctly to `on`, `off`, and task inputs.
- TUI progress: renders correctly with live braille animation.
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
- Extension API: Import types from `@earendil-works/pi-coding-agent` runtime package. Use `ExtensionAPI`, `ExtensionContext` — do not redefine these types.
- Tool naming: The AgentSwarm tool is named `AgentSwarm` (matching kimi-code convention). Commands use `/swarm` prefix.
- Pi --print mode: Sub-agents communicate via `pi --print` JSON Lines output. Parse `message_end` and `tool_result_end` events to track progress.

## Agent Checklist

Before committing or creating a PR, verify ALL of the following:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` succeeds with `dist/index.js` and `dist/index.d.ts` present
- [ ] `npm test` passes with zero failures (when tests exist)
- [ ] PLAN.md updated if architecture, API, or module specs changed
- [ ] docs/architecture.md updated if design rationale or data flows changed
- [ ] README.md updated if user-facing features changed
- [ ] AGENTS.md updated if new module/tool/command/hook/data flow was added
- [ ] Credit to MoonshotAI/kimi-code preserved in README.md and docs/architecture.md
- [ ] All code comments, JSDoc, commit messages in English
- [ ] Completion report: 做了什么 → 结果 → 已确认 → 需要你决策 → 待跟进
- [ ] Address user as 老板, default to Chinese, explain in business terms, don't dump code
- [ ] Code comments explain business purpose + implementation logic + edge cases (in Chinese)
- [ ] No empty catch blocks — handle or propagate every error

</general-project-rules>
