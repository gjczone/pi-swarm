# LLM Review Guide for pi-swarm

You are reviewing **pi-swarm**, a pi-coding-agent extension that provides multi-agent orchestration: parallel swarm agents and collaborative team agents. This guide focuses your review on **real bugs and reliability issues only**.

## Project Context

- **What it is**: A TypeScript extension for [pi](https://github.com/earendil-works/pi) that registers two tools (`AgentSwarm`, `AgentTeam`) and two commands (`/swarm`, `/swarm-team`). Agents are spawned as `pi --print` child processes.
- **Size**: 19 source modules, ~4500 LOC, 55 tests.
- **Runtime**: Node.js >= 18, runs inside pi's extension host. Linux + macOS.
- **Dependencies**: `@earendil-works/pi-tui` (TUI components), `typebox` (schema). Everything else is custom.
- **Concurrency model**: Two-phase scheduler ported from kimi-code. Normal phase (5 initial + 1/700ms ramp-up), rate-limit phase (capacity tracking + exponential backoff).
- **Team model**: Sequential phases (explore → plan → implement → review → test) with JSONL mailbox for inter-agent messages.
- **State**: Durable file-based state under `.pi/swarm/state/`, crash recovery on session start.

## Review Rules

### DO report these (P0 — must fix)

1. **Logic errors**: conditions that can never be true, off-by-one, inverted booleans, dead code that masks bugs.
2. **Type safety holes**: `any` casts that bypass validation, missing null checks that would crash at runtime, type assertions that are actually wrong.
3. **Concurrency bugs**: race conditions in the controller, promise handling errors, missing await, unhandled rejections that could crash pi.
4. **Resource leaks**: child processes that could become zombies, file handles not closed, event listeners not removed, timeouts not cleared.
5. **Security issues**: command injection in spawn args, path traversal in file operations, user-controlled data reaching `exec`/`spawn`.
6. **Data corruption**: state persistence writes that could produce unreadable JSON, atomic write failures that silently corrupt, mailbox operations that could interleave lines.
7. **API contract violations**: tool `execute` return types that don't match `AgentToolResult`, missing required fields, wrong parameter schemas that would confuse the LLM.
8. **Incorrect behavior**: the XML output format deviating from the documented `<agent_swarm_result>` spec, the controller not respecting `PI_SWARM_MAX_CONCURRENCY`, abort handling losing completed results.

### DO report these (P1 — reliability risk)

1. **Missing error handling**: try/catch blocks that don't handle specific expected errors (ENOENT, EPERM, rate-limit detection), leaving the LLM with a raw stack trace.
2. **Silent failures**: operations that can fail without the caller knowing (best-effort file writes that skip on error without any log, `catch {}` that swallows important exceptions).
3. **Inconsistent state**: scenarios where a run manifest says "running" but no agents are active, or task state shows "completed" but the result is missing.
4. **LLM-facing tool description issues**: parameter descriptions that are misleading, missing constraint documentation (e.g., "must be only tool call" not stated), examples that don't work.
5. **Settings/precedence bugs**: the concurrency setting not being read from the correct location, environment variable override not working, project settings not overriding global.
6. **Edge cases**: empty items array, single item (newly supported — verify), resume with unknown agent IDs, concurrent mailbox writes, controller with 0 tasks.
7. **Performance**: O(n²) operations in the controller that could matter at 128 agents, excessive file I/O in hot paths, synchronous operations on the main thread.

### DO NOT report these (ignore — not useful)

- Code style, formatting, variable naming, line length, JSDoc completeness.
- "Consider renaming X to Y", "This function could be split" — unless there's a concrete bug caused by the structure.
- Test coverage percentages, missing test categories.
- Dependency version suggestions (unless there's a known CVE).
- "Use const instead of let" or other linting-level suggestions.
- TypeScript strictness (`strictNullChecks`, `noUncheckedIndexedAccess`).
- Missing docs, missing comments — the project has dedicated docs files.
- "This could be a class instead of an interface" or similar architecture opinions.
- Suggestions to add features not currently implemented.

## Key Files to Review

Read these in order. The most critical modules are listed first.

### Tier 1 — Core Logic (highest risk)

| File | What to check |
|------|--------------|
| `src/shared/controller.ts` | Two-phase scheduler correctness. Race conditions. Abort handling. Rate-limit detection. `finished` flag guards. |
| `src/shared/spawner.ts` | Child process lifecycle. JSON Lines parsing robustness. Signal/timeout handling. Zombie process risk. |
| `src/swarm/tool.ts` | Input validation. Spec creation edge cases (1 item, 128 items, resume). TypeBox schema vs actual params. |
| `src/team/tool.ts` | Phase loop correctness. Abort propagation between phases. Partial state return on error. supervisor scope. |

### Tier 2 — State & Recovery

| File | What to check |
|------|--------------|
| `src/state/persistence.ts` | Atomic write correctness. Directory creation race conditions. JSON parse error handling. Orphaned temp files. |
| `src/state/recovery.ts` | Staleness detection logic. Cleanup safety (deleting wrong directories). 7-day / 30-min thresholds. |

### Tier 3 — Team Infrastructure

| File | What to check |
|------|--------------|
| `src/team/mailbox.ts` | JSONL append correctness. Concurrent write safety. Path construction (no traversal). Delivery state consistency. |
| `src/team/task-graph.ts` | Dependency validation. Skip propagation correctness. Serialization round-trip. Duplicate phase name handling. |
| `src/team/supervisor.ts` | Phase prompt construction. Result synthesis XML escaping. Dependency context injection. |

### Tier 4 — TUI & Entry

| File | What to check |
|------|--------------|
| `src/tui/progress.ts` | Render contract (lines <= width). Animation cleanup on dispose. Null state handling. |
| `src/index.ts` | Auto-gitignore logic. Duplicate handler registration. ExtensionAPI type usage. |
| `src/swarm/command.ts` | Permission mode handling. Empty/null args. |
| `src/swarm/mode.ts` | Reminder injection/destruction pairing. Status update consistency. |

### Tests (reference only)

| File | What to cross-check |
|------|-------------------|
| `tests/swarm-tool.test.ts` | Tests for 1-item support, 0-item rejection, duplicate prompt rejection. |
| `tests/controller.test.ts` | Concurrency cap, abort behavior, rate-limit retry. |
| `tests/render.test.ts` | XML escaping, resume hint logic. |
| `tests/task-graph.test.ts` | Dependency ordering, skip propagation, serialization. |
| `tests/smoke.test.ts` | Module imports, persistence round-trip, supervisor integration. |

## How to Submit Findings

For each issue, provide:

```
### [P0|P1] Short title

**File**: `src/path/to/file.ts:line`

**Problem**: Describe the bug or reliability risk in 2-3 sentences.

**Impact**: What actually goes wrong? When would it happen?

**Fix**: Suggest the minimal code change.
```

Skip any finding that doesn't meet the P0/P1 bar. Do not submit more than 15 findings total — prioritize the most impactful ones.

## Quick Sanity Checklist

Before starting the detailed review, do these quick checks and report anything that fails:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` produces all 19 expected `.js` files in `dist/`
- [ ] `npm test` — all 55 tests pass
- [ ] `grep -r "TODO\|FIXME\|HACK\|XXX" src/` — any leftover markers?
- [ ] `grep -r "\.crew" src/` — any remaining references to deprecated `.crew/` path?
- [ ] `grep -r "console\.\(log\|error\)" src/` — are there debug logs that should be removed?
- [ ] Does `src/index.ts` register both `AgentSwarm` and `AgentTeam` tools?
- [ ] Does `swarm/tool.ts` allow 1 item (not still requiring 2)?
- [ ] Does `state/persistence.ts` always use `.pi/swarm/` (never `.crew/`)?
