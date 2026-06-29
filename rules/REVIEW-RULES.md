# REVIEW-RULES.md for pi-swarm

You are reviewing **pi-swarm**, a dual-mode multi-agent orchestration extension for pi-coding-agent that supports parallel swarm (item-template) and collaborative team (role-based with mailbox) execution. This guide focuses your review on real bugs and reliability issues only.

## Project Context

- **What it is**: TypeScript extension for `pi-coding-agent` that spawns subagent child processes (`pi --print`) with concurrency control, rate-limit retries, TUI progress rendering, and durable crash recovery.
- **Size**: 20 source modules, ~9,900 lines of TypeScript, 91 tests (7 test files, 0 failures).
- **Runtime**: Node.js >= 18, TypeScript 6.x with `NodeNext` module resolution. Compiled to `dist/` via `tsc`.
- **Dependencies**: `@earendil-works/pi-coding-agent` (peer — extension API), `@earendil-works/pi-tui` (TUI components), `typebox` (schema validation).
- **Key architecture facts**:
  - Layer boundaries: `tui/` and `state/` MUST NOT import from `swarm/` or `team/`. `shared/` has zero pi or tui imports.
  - Two-phase concurrency: ramp-up (5 initial + 1/700ms) then rate-limit phase (capacity tracking with exponential backoff).
  - Subagents run as independent `pi --print` child processes; the parent parses JSON Lines event streams.
  - Mailbox communication uses JSONL files with atomic writes for inter-agent message passing during team runs.

## Review Rules

### DO report these (P0 — must fix)

1. **Logic errors**: conditions that can never be true (`if (this.finished) return` guards that mask double-completion bugs), off-by-one in phase index calculations, inverted booleans in abort/signal checks, dead code in `switch`/`if` branches that should trigger but never do.

2. **Type safety holes**: `as` casts that bypass TypeScript checking — payloads cast from `Record<string, unknown>` to concrete types without runtime validation (e.g., `params as { goal: string; ... }` in tool execute functions), `ctxRaw as ExtensionContext` without null checks, `JSON.parse` results cast to interfaces without structural verification.

3. **Concurrency bugs**: race conditions between controller `finish()` / `fail()` / `finishWithUserCancellation()` and in-flight `handleAttemptOutcome()` calls, abort signal timing between `settled` flag and process close events in spawner, multiple `resolveOnce` / `rejectOnce` calls in the event stream parser.

4. **Resource leaks**: child processes that receive SIGTERM but never SIGKILL (timer races in `ProcessKillState`), worktrees left on disk after abandoned runs (`cleanupWorktree` caught silently in error paths), `WriteStream` handles not closed in all error paths of `spawnSubagent`, `setInterval` animation timers and mailbox poll intervals that outlive their components.

5. **Security issues**: path traversal via `agentId` / `runId` / `taskId` in `resolveAgentStateDir` and `resolveTaskMailboxPaths` (already validated with `validateId` + `ensureWithinRoot` — verify completeness), git command argument injection in `execFileSync("git", ...)` calls (branch names derived from user-controlled `agentDescription`), recipient validation in `validateRecipient` only checks pattern but not whether the recipient actually exists.

6. **Data corruption**: `appendJsonLine` in `mailbox.ts` uses `fs.appendFileSync` — NOT atomic, so a crash mid-write leaves partial JSON lines in inbox/outbox. `appendEvent` in `persistence.ts` has the same problem. `writeAtomic` is used for manifest, tasks, status, and delivery state but NOT for JSONL appends. Reading partially-written lines in `readJsonLines` silently drops them via the `catch { return null }` filter, causing message loss.

### DO report these (P1 — reliability risk)

7. **Missing error handling**: catch blocks with `// Best effort` comments that silently discard errors — `sendMessage` broadcast delivery to roles swallows errors, `pruneWorktrees` / `removeWorktree` catch blocks discard all failures, `createWorktree` symlink failures silently skipped. While intentional for robustness, these can mask real system issues.

8. **Silent failures**: operations that can fail with no observable side effect — `updateHeartbeat` returns early if manifest can't be read, `registerAgentInManifest` returns early with no error, `saveTaskState` failures in `supervisor.ts` team loop are not retried or reported.

9. **Inconsistent state**: team run state saved after each batch via `saveTaskState` but supervisor phase mutations (`completePhase`, `failPhase`, `skipPhase`) happen before the batch completes — if `saveTaskState` fails, the in-memory state is inconsistent with disk. The `startReadyPhases` method marks phases as `running` in the task graph before sending them to the controller, creating stale states if the batch launch fails.

10. **LLM-facing tool descriptions**: `AgentSwarm` and `SwarmTeam` tool descriptions are long and complex. Verify they accurately describe all current parameters (especially `small_model`, per-phase `model`/`tools` overrides, `max_agents`). Incorrect or missing parameter descriptions cause the LLM to call the tool with wrong arguments or miss capabilities entirely.

11. **Settings/precedence bugs**: model resolution in `getPhaseExecutionConfig()` has 7 precedence levels (phase model, phase modelTier, role model, auto-route by role, default). Verify that all paths are tested, especially the interaction between `phase.modelTier === "default"` and `roleConfig.model`, and the `phase.tools` override of `roleConfig.tools`.

12. **Edge cases**: empty `items` array with valid `resume_agent_ids` (should work — tested in `hasMinimumAgentSwarmInputs`), 128-item boundary (exactly 128 items), duplicate prompts detected only by string equality after template substitution, `prompt_template` with `{{item}}` as a substring of another word, zero `maxAgents` passed to team tool (defaults to 4 but what about explicit 0?), team phases with circular dependencies (not validated at construction time).

13. **Performance**: `emitProgress()` in `controller.ts` iterates `this.states` and `this.active` (Set iteration + Array.from) on every lifecycle event — O(n²) potential with 128 agents firing rapidly. Mailbox poll interval (800ms) reads entire outbox file on every tick. `buildPhasePrompt` concatenates large dependency result strings that can exceed context limits.

### DO NOT report these (ignore — not useful)

- Code style, formatting, variable naming, line length, JSDoc completeness.
- Rename suggestions, function-split suggestions — unless there is a concrete bug caused by the structure.
- Test coverage percentages, missing test categories.
- Dependency version suggestions (unless there is a known CVE).
- Linting-level suggestions (`const` vs `let`, `===` vs `==`).
- TypeScript strictness flags.
- Missing docs, missing comments — the project manages docs separately.
- Architecture opinions ("use class instead of interface", "extract this to a separate file").
- Feature suggestions not currently implemented.
- Missing emoji or decorative elements (the project forbids them by design).

## Key Files to Review

### Tier 1 — Core Logic (highest risk)

| File                       | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/controller.ts` | Finish/fail/abort race conditions: `this.finished` guard in `handleAttemptOutcome`/`handleAttemptError` vs `finish()`/`fail()` calls from batch abort. `rateLimitCapacity` shrinking below 1 (clamped to 1 but verify edge). `isAtConcurrencyLimit` only checks `this.maxConcurrency` — the rate limit phase's `rateLimitCapacity` is checked separately in `scheduleRateLimitLaunch`. `emitProgress` reads `activeIndices` from Set but modifies `active` concurrently. `resolveSwarmMaxConcurrency` throws on invalid config values — verify callers handle this. `getSettingsMaxConcurrency` type assertion `settings["pi-swarm"] as Record<string, unknown>` may be wrong shape.                                                                                               |
| `src/shared/spawner.ts`    | Process lifecycle: `settled`/`done` flags vs `resolveOnce`/`rejectOnce` race during simultaneous abort and close. Post-abort cleanup (`settled = true`) sets `abortReason` before killing process, but the close handler's `processBuffer` + `buildResult` can race. `MAX_LINE_BUFFER_SIZE` enforcement — if buffer exceeds 10MB, process is killed but the `settled` check at line 713 may already be past. Mailbox poll interval is never cleared if `settled` happens before `mailboxPollHandle` is assigned. Log stream not closed if process errors before `logStream` header is fully written. `createWorktree` failure silently returns `undefined` — spawned process then runs in shared `cwd`.                                                                            |
| `src/team/supervisor.ts`   | `startReadyPhases` marks phases as `running` in the task graph BEFORE sending to controller — if batch launch fails, phases are stuck in `running` state. `failPhase` BFS skip walks all phase names for each failed node (O(n²) for complex graphs). `buildPhasePrompt` concatenates ALL dependency results into prompt with no length limit — can exceed model context window. `synthesizeResult` truncates per-phase output to 50K chars but `extractExcerpt` only takes first 500 chars for synthesis — inconsistent truncation. `generateMessageId` uses `Date.now().toString(36)` — two messages in the same millisecond will collide. `parseAgentMessages` regex `[\s\S]*?` inside `<mailbox_message>` tags can match across multiple tags if the closing tag is malformed. |

### Tier 2 — State & Recovery

| File                       | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/state/persistence.ts` | `writeAtomic` uses `fs.renameSync` — atomic on POSIX, not on Windows (acceptable per platform targets, but verify). `appendEvent` uses `fs.appendFileSync` instead of `writeAtomic` — crash during append writes partial lines. `readJsonLines` silently drops unparseable lines, losing messages permanently. `createManifest` calls `writeAtomic` but does not verify the write succeeded. `listActiveRuns` filters by `validateId` pattern — runs with non-matching IDs are invisible to recovery.                                                                                                                |
| `src/state/recovery.ts`    | Stale run detection: `STALE_RUN_THRESHOLD_MS` is 30 minutes — runs with active child processes but no heartbeat update will be marked abandoned. `hasUnfinishedTasks` checks agent status but uses loose state string comparison (`"running" \|\| "started" \|\| ""`). `getResumableAgents` returns all agent IDs from manifest as "resumable" if they have a directory on disk — does not verify the actual status is resumable. Recovery deletes orphaned directories but only if `manifest.json` doesn't exist — an orphaned directory with a stale manifest will never be cleaned.                               |
| `src/shared/worktree.ts`   | `cleanupWorktree` failure falls through to `return { hasChanges: false }` — worktree may remain on disk with changes. `createWorktree` symlinks `node_modules` and project context entries — broken symlinks from moved/deleted repos cause `existsSync` + `statSync` failures caught silently. `mergeBranch` attempts `merge --abort` on failure but the original error message might be lost. `PROJECT_CONTEXT_ENTRIES` hardcoded list may miss project-specific config files that subagents need. `isWorkingTreeClean` invoked before merge but concurrent operations can dirty the tree between check and merge. |

### Tier 3 — Infrastructure

| File                     | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/team/mailbox.ts`    | `appendJsonLine` not atomic — crash during write corrupts the JSONL file with partial lines. `sendMessage` appends to BOTH inbox and outbox — two non-atomic writes, can create inconsistency. Broadcast delivery iterates hardcoded role list; custom roles not covered. `ackMessages` reads entire inbox, filters by ID, then rewrites with `writeAtomic` — race between read and write can lose newly-arrived messages. `validateRecipient` allows "broadcast" as a special value but doesn't validate against actual roles. `readJsonLines` silently drops corrupted lines — message loss with no error.                                                                  |
| `src/team/task-graph.ts` | `startPhase` dependency check uses `depState.status !== "completed"` — phases in "failed" or "skipped" status are not "completed" but the error message says "not completed" not "failed/skipped". `completePhase` and `failPhase` silently return for unknown phase names — caller may not realize the operation was a no-op. `fromJSON` restores phase state with type assertions (`as PhaseStatus`) — no validation that the value is a valid status. Circular dependency detection is absent — a cycle in `dependsOn` causes infinite stall with no error.                                                                                                                |
| `src/swarm/tool.ts`      | Dynamic description (`buildSwarmDescription`) scans agents at registration time — verify `clearFileAgentsCache()` + `loadFileAgents()` is called safely. Per-item auto-routing via `matchItemToAgent()` — verify null-safety when no agents are defined. `createAgentSwarmSpecs` validates prompt template has `{{item}}` but doesn't check that it appears exactly once. `duplicate prompt` detection uses exact string comparison after template substitution — different items that produce the same resolved prompt are treated as duplicates. `resume_agent_ids` entries call `validateId` on the agentId but this throws — is the error caught and reported to the LLM as a clear message? `renderResult` regex parsing of XML summary is fragile — a malformed XML output breaks the display.                                                                                                                                   |
| `src/team/tool.ts`       | Phase loop: `currentPhases = supervisor.startReadyPhases()` inside `while` — if `startReadyPhases` returns phases that then fail, the loop may repeat forever if failure doesn't skip all dependent phases correctly. Batch controller instantiated with `maxConcurrency: Math.min(maxConcurrency, tasks.length)` — if all agents fail, controller returns results that include `undefined` entries (array length mismatched with `currentPhases`). `catch` block catches `controller.run()` failures but the `batchResults` variable may be undefined. `renderResult` regex `/\[^>\]*outcome="(\w+)"/g` — `\w+` only matches word characters, missing outcomes with hyphens. |

### Tier 4 — Shared utilities (new)

| File                       | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/agents.ts`     | Frontmatter YAML parser (`parseSimpleYaml`) is a hand-rolled subset — verify edge cases: empty frontmatter, no trailing newline, inline lists vs indented lists, comments, quoted strings with special chars, YAML values that look like numbers (`0123`, `1.2e3`). `matchItemToAgent()` two-phase routing — longest pattern wins, verify that patterns of equal length pick the first match deterministically (Map insertion order is filesystem-dependent). `matchGlobPattern()` minimal glob implementation — verify no false positives with special patterns like `*.*`, `prefix*suffix*middle`, or patterns starting with `*`. `buildAgentListing()` truncation at 3 items with "..." — verify no off-by-one when exactly 3 items. `loadFileAgents()` cache uses `cwd` as key — verify cache is invalidated on `process.env.HOME` changes (used in tests). |
| `src/shared/pi-invoke.ts`  | `FORBIDDEN_SUBAGENT_TOOLS` hard-blocks pi-swarm tools at arg-build time — verify this Set stays in sync when new tools are added. `buildSubagentArgs()` filter only runs when `opts.tools` is non-empty — with `resolveProfileTools()` now always returning an explicit list this is always true, but verify no code path passes `undefined` tools (e.g. resume mode, retry mode). `getPiInvocation()` detects runtime from `process.argv` — verify edge case when run outside pi (standalone npm package).                                                                                                      |

### Tier 5 — TUI & Entry
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`         | `ensureGitignore` writes to `.gitignore` without user consent — modifies files outside `.pi/`. `findGitignore` returns `null` if a non-standard ignore file exists (`*ignore` pattern) — means no `.gitignore` is created, state directory may be tracked. `resolveMarkerState` default returns "active" for unknown content — unrecognized markers appear as active mode. Keyword auto-activation on `input` event triggers on ANY message containing "swarm" — could activate accidentally from unrelated text. |
| `src/shared/render.ts` | `renderTeamResults` is a hardcoded placeholder returning "Not yet implemented" — team output goes through `supervisor.synthesizeResult()`, not this function. If any code path calls `renderTeamResults`, the output is wrong. `escapeXml` does not escape single quotes in attribute values (only `"` is escaped) — the caller in `render.ts` uses `attr="value"` so this is safe, but verify all attribute construction uses double quotes.                                                                     |
| `src/tui/progress.ts`  | `AgentSwarmProgressComponent.update()` sets state and invalidates but does not deep-copy `members` array — mutations in the controller's snapshot data will corrupt the UI. `complete()` modifies `member.phase` in place on the shared `members` array — controller's snapshot data is mutated. `render()` truncates to max 20 members — agents beyond 20 are invisible in the UI with no indication.                                                                                                            |

### Tests — Reference only

| File                           | What to check                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/smoke.test.ts`          | Covers persistence, recovery, task graph, supervisor, mailbox, concurrency config. Does not cover actual process spawning or rate limiting. |
| `tests/controller.test.ts`     | Verify that controller tests exercise rate-limit phase transitions, batch abort with partial results, and max concurrency enforcement.      |
| `tests/render.test.ts`         | Verify XML output format for completed, failed, aborted, and mixed outcomes. Check escape handling for special characters.                  |
| `tests/swarm-tool.test.ts`     | Verify input validation: missing `prompt_template` with items, missing `{{item}}` placeholder, duplicate prompts, 129 items.                |
| `tests/agents.test.ts`         | Verify frontmatter parsing (lists, booleans, quotes, comments), file loading (user/project/override), profile integration (file agent vs built-in priority), `resolveProfileTools()` allowlist/denylist, and `matchItemToAgent()` routing (pattern longest-match, keyword case-insensitive, empty map, no match). |
| `tests/task-graph.test.ts`     | Verify dependency chain completion, failure cascade skip, serialization round-trip, and duplicate phase name rejection.                     |
| `tests/mailbox.test.ts`        | If exists, verify message delivery, acknowledgment, and concurrent write safety.                                                            |
| `tests/team-dashboard.test.ts` | Verify dashboard state conversion from `TeamProgressSnapshot`.                                                                              |
| `tests/tui-truncation.test.ts` | Verify text truncation utilities used across all TUI components.                                                                            |

## How to Submit Findings

```
### [P0|P1] Short title

**File**: `src/path/to/file.ts:line`

**Problem**: Describe the bug or reliability risk in 2-3 sentences.

**Impact**: What actually goes wrong? When would it happen?

**Fix**: Suggest the minimal code change.
```

Skip any finding that does not meet the P0/P1 bar. Do not submit more than 15 findings total — prioritize the most impactful ones.

## Quick Sanity Checklist

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run build` produces `dist/index.js` and `dist/index.d.ts`
- [ ] `npm test` — all 91 tests pass, 7 test files, 0 failures
- [ ] `grep -r "TODO\|FIXME\|HACK\|XXX" src/` — any leftover markers?
- [ ] `grep -r "catch\s*{" src/` — are there empty catch blocks swallowing errors?
- [ ] `grep -rn "\.only(" tests/` — no `.only()` calls left in test files
- [ ] `grep -rn "as " src/shared/types.ts` — verify type assertions are not masking structural mismatches
- [ ] `grep -rn "appendFileSync\|appendFile" src/` — verify all JSONL appends are acceptable (not every append needs to be atomic, but review each)
- [ ] `grep -rn "execFileSync\|execSync" src/shared/worktree.ts` — verify all git commands use argument arrays (not string concatenation) to prevent injection
- [ ] Verify layer boundaries: `grep -rn "from.*swarm\|from.*team" src/tui/ src/state/` returns no matches
