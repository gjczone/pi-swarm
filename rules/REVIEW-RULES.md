# REVIEW-RULES.md for pi-swarm

You are reviewing **pi-swarm**, a dual-mode multi-agent orchestration extension for pi-coding-agent that supports parallel swarm (item-template) and collaborative team (role-based with mailbox) execution. This guide focuses your review on real bugs and reliability issues only.

## Project Context

- **What it is**: TypeScript extension for `pi-coding-agent` that spawns subagent child processes (`pi --print`) with concurrency control, rate-limit retries, TUI progress rendering, and durable crash recovery.
- **Size**: 25 source modules, ~12,000 lines of TypeScript, 203 tests (17 test files, 0 failures).
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

4. **Resource leaks**: **P0 (#184)**: `killProc`/timeout sets `settledState.settled=true` without resolving the `parseEventStream` promise — `cleanup()` never called, mailbox poll `setInterval` (800ms) and `logStream` leak forever, process hangs. Child processes that receive SIGTERM but never SIGKILL (timer races in `ProcessKillState`). Worktrees left on disk after abandoned runs. Temp system prompt file `sys-{agentId}.md` never deleted (#190). `setInterval` animation timers and mailbox poll intervals that outlive their components.

5. **Security issues**: path traversal via `agentId` / `runId` / `taskId` in `resolveAgentStateDir` and `resolveTaskMailboxPaths` (validated with `validateId` + `ensureWithinRoot` — safe pattern `[a-zA-Z0-9_-]+` blocks `..` and `/`). Git command argument injection — all `execFileSync("git", ...)` calls use array args, not string concatenation (safe). `validateRecipient` checks existence via `existsSync` (#113 fixed). **P0 (#188)**: `GITIGNORE_ENTRY` pattern `.pi/swarm/state/` in `.pi/.gitignore` matches wrong path — ALL state files (mailboxes, logs, manifests) committable to git. **P0 (#178)**: coordinator inbox path missing "state" segment — files outside `.gitignore` coverage. **P1 (#192)**: `.pi` symlink staged by `git add -A`, committed to agent branch, merged to main.

6. **Data corruption**: `appendJsonLine` in `mailbox.ts` now uses `appendLine` (O_APPEND + fsync) — atomic per-write for small messages (#106 fixed). `appendEvent` in `persistence.ts` likewise uses `appendLine`. `writeAtomic` is used for manifest, tasks, status, and delivery state. Direct message `sendMessage` writes outbox before task inbox (record-first) — crash between writes causes silent message loss (#179). `readJsonLines` logs corrupted lines (capped at `MAX_PER_LINE_LOGS`) — acceptable.

### DO report these (P1 — reliability risk)

7. **Missing error handling**: empty `catch` blocks that silently discard errors — `sendMessage` broadcast delivery now surfaces per-recipient errors (#115 fixed), `pruneWorktrees` / `removeWorktree` catch blocks now log (#135 fixed). **Still open**: 7 empty catches in `spawner.ts` (#182), 10 empty catches in `worktree.ts` (#185), 1 empty catch in `persistence.ts` (#187). AGENTS.md §0 forbids empty catch blocks — all must log what operation failed, the input context, and the original error message.

8. **Silent failures**: operations that can fail with no observable side effect — `updateHeartbeat` returns early if manifest can't be read (#162 fixed — now logs), `registerAgentInManifest` returns early with no error. NOTE: `supervisor.ts` has been REMOVED — `saveTaskState` team loop no longer exists.

9. **Inconsistent state**: NOTE: `supervisor.ts` and `task-graph.ts` have been REMOVED — team phase mutation concerns (`completePhase`, `failPhase`, `startReadyPhases`) are no longer applicable.

10. **LLM-facing tool descriptions**: `AgentSwarm` and `SwarmTeam` tool descriptions are long and complex. Verify they accurately describe all current parameters (especially `small_model`, per-phase `model`/`tools` overrides, `max_agents`). Incorrect or missing parameter descriptions cause the LLM to call the tool with wrong arguments or miss capabilities entirely.

11. **Settings/precedence bugs**: model resolution in `getPhaseExecutionConfig()` has 7 precedence levels (phase model, phase modelTier, role model, auto-route by role, default). Verify that all paths are tested, especially the interaction between `phase.modelTier === "default"` and `roleConfig.model`, and the `phase.tools` override of `roleConfig.tools`.

12. **Edge cases**: empty `items` array with valid `resume_agent_ids` (should work — tested in `hasMinimumAgentSwarmInputs`), 128-item boundary (exactly 128 items), duplicate prompts detected only by string equality after template substitution, `prompt_template` with `{{item}}` as a substring of another word, zero `maxAgents` passed to team tool (defaults to 4 but what about explicit 0?).

13. **Performance**: `emitProgress()` in `controller.ts` iterates `this.states` and `this.active` (Set iteration + Array.from) on every lifecycle event — O(n²) potential with 128 agents firing rapidly. Mailbox poll interval (800ms) reads entire outbox file on every tick.

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

| File                       | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/controller.ts` | Finish/fail/abort race conditions: `this.finished` guard in `handleAttemptOutcome`/`handleAttemptError` vs `finish()`/`fail()` calls from batch abort — guards are correct (Node.js single-threaded, no true concurrency). **P1 (#191)**: `handleRateLimit` (line 715-741) increments `retryCount` with NO max retry count — permanent rate limit (exhausted quota, invalid key) causes infinite retry, swarm hangs indefinitely. `rateLimitCapacity` clamped to 1. `emitProgress` O(n²) potential with 128 agents. `resolveSwarmMaxConcurrency` throws on invalid config. `getSettingsMaxConcurrency` type assertion. Heartbeat: `heartbeatInFlight` flag prevents races (#163 fixed), logs on failure (#162 fixed).                                                                                                                                                                    |     |
| `src/shared/spawner.ts`    | Process lifecycle: `settled`/`done` flags vs `resolveOnce`/`rejectOnce` race during simultaneous abort and close. **P0 (#184)**: `killProc` and timeout handler set `settledState.settled = true` WITHOUT resolving the `parseEventStream` promise — close handler sees `settled` and returns early, `settle()` never called, promise hangs forever, mailbox poll interval + logStream leak. **P1 (#182)**: 7 empty catch blocks silently discard mailbox parse errors, I/O faults, cleanup failures. **P1 (#189)**: `readNewMailboxLines` offset stuck after outbox file recreation (`fileSize <= offset` returns unchanged offset). **P1 (#190)**: temp system prompt file `sys-{agentId}.md` never deleted in `cleanup()`. Mailbox poll interval cleared in `cleanup()` (correct). `createWorktree` failure silently returns `undefined` — spawned process then runs in shared `cwd`. |

### Tier 2 — State & Recovery

| File                       | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/state/persistence.ts` | `writeAtomic` uses `fs.renameSync` — atomic on POSIX. `appendEvent` now uses `appendLine` (O_APPEND + fsync, #106 fixed). `readJsonLines` logs corrupted lines (#137 fixed — capped at `MAX_PER_LINE_LOGS`). `updateHeartbeat` logs on manifest read failure (#162 fixed) and uses `heartbeatWriteInFlight` flag to prevent races (#163 fixed). **P1 (#187)**: `listActiveRuns` `validateId` catch silently drops invalid runIds — no audit log.                                                                                                                                                                     |
| `src/state/recovery.ts`    | Stale run detection: `STALE_RUN_THRESHOLD_MS` is 30 minutes. `hasUnfinishedTasks` checks agent status. `getResumableAgents` uses case-insensitive status comparison (#164 fixed — `.toLowerCase()`). `validateId` on agentIds (#126 fixed — path traversal blocked). Recovery deletes orphaned directories. Heartbeat updated periodically (#107 fixed).                                                                                                                                                                                                                                                             |
| `src/shared/worktree.ts`   | **P1 (#186)**: `cleanupWorktree` catch block removes worktree when `git status --porcelain` fails — `hadChanges` is false (set after status succeeds), `hasAnyWorktreeChanges()` never called, agent work silently destroyed. `hasAnyWorktreeChanges` (#129 fix) exists but only called on success path. **P1 (#185)**: 10 empty catch blocks across git operations return silent defaults. **P1 (#192)**: `.pi` symlink staged by `git add -A`, committed to agent branch, merged to main. `createWorktree` symlinks `node_modules` and project context entries. `mergeBranch` attempts `merge --abort` on failure. |

### Tier 3 — Infrastructure

| File                       | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/team/mailbox.ts`      | `appendJsonLine` now uses `appendLine` (O_APPEND + fsync) — atomic per-write (#106 fixed). **P1 (#179)**: direct message `sendMessage` writes outbox before task inbox (record-first) — crash causes silent message loss; broadcast is deliver-first (correct). Broadcast delivery discovers recipients dynamically via `readdirSync` (#115 fixed — per-recipient errors surfaced). `validateRecipient` checks existence via `existsSync` (#113 fixed). `readJsonLines` logs corrupted lines (capped at `MAX_PER_LINE_LOGS`). `ackMessages`/`ackTaskMessages` REMOVED (#135/#137) — ack files only read, never written, no TOCTOU race. |
| `src/swarm/tool.ts`        | Dynamic description (`buildSwarmDescription`) scans agents at registration time. `createAgentSwarmSpecs` validates `{{item}}` appears exactly once (#165 fixed) and detects duplicate prompts. **P1 (#181)**: description text says "1-20 subagents" but schema `maxItems: 128` — LLM underuses batch capacity. `resume_agent_ids` entries call `validateId` — error caught and reported. `renderResult` regex parsing of XML summary.                                                                                                                                                                                                  |
| `src/swarm/coordinator.ts` | **P0 (#178)**: `getAgentInboxPath` and `coordDir` use `path.join(swarmRoot, "runs", runId, ...)` missing "state" segment — inbox files written outside `.gitignore` coverage, never cleaned by `deleteRunState`, invisible to crash recovery. **P1 (#180)**: inline `items.map` bypasses `createAgentSwarmSpecs` duplicate detection. `activeRuns` Map cleaned via `completionPromise.finally` (#160 fixed). RunId uses random suffix (#128 fixed).                                                                                                                                                                                     |

### Tier 4 — Shared utilities (new)

| File                      | What to check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/agents.ts`    | Frontmatter YAML parser (`parseSimpleYaml`) is a hand-rolled subset — verify edge cases. `matchItemToAgent()` two-phase routing — longest pattern wins, equal-length tie goes to later-inserted agent (#112 fixed — project overrides user). **P1 (#183)**: `matchGlobPattern()` no-wildcard branch uses `endsWith` — pattern `"a.ts"` matches `"xa.ts"`, false positive routing. Multi-wildcard now uses `globToRegex` (#111 fixed). `buildAgentListing()` truncation at 3 items. `loadFileAgents()` cache uses `cwd` as key. |
| `src/shared/pi-invoke.ts` | `FORBIDDEN_SUBAGENT_TOOLS` hard-blocks pi-swarm tools at arg-build time — verified complete (all 5 tools: Swarm, SwarmTeam, SendMessage, TaskStop, SwarmStatus). `buildSubagentArgs()` filter always runs (`resolveProfileTools()` always returns explicit list). `getPiInvocation()` detects runtime from `process.argv`.                                                                                                                                                                                              |

### Tier 5 — TUI & Entry

| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | `ensureGitignore` writes to `.pi/.gitignore` (#123 fixed — no longer writes project-root `.gitignore`). `resolveKeywordMode` uses `/\bswarm\b/i` word boundary (#157 fixed — "swarming"/"swarmy" do NOT trigger). **P0 (#188)**: `GITIGNORE_ENTRY = ".pi/swarm/state/"` in `.pi/.gitignore` matches wrong path (`.pi/.pi/swarm/state/`) — state files NOT gitignored. Must be `swarm/state/`. `resolveMarkerState` default returns "active" for unknown content. |
| `src/shared/render.ts` | `renderTeamResults` has been REMOVED entirely — only `renderSwarmResults` exists. This is NOT a finding anymore. `escapeXml` does not escape single quotes but all attribute construction uses double quotes (safe). `toSwarmRunResults` uses generic `T extends SwarmSpec` (#146 fixed — no cast needed). |
| `src/tui/progress.ts` | `snapshotToProgressState` uses `.map()` to create deep copy — NOT a finding (mutations don't corrupt controller data). `render()` truncates to `MAX_VISIBLE_MEMBERS` with "... N more" indication (agents 21+ are visible). `update()` stores reference but controller creates new objects each snapshot. |

### Tier 6 — Shared infrastructure

| File                          | What to check                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/gitignore.ts`     | **P0 (#188)**: `GITIGNORE_ENTRY = ".pi/swarm/state/"` written to `.pi/.gitignore` — git interprets patterns with middle `/` as relative to `.gitignore` directory, so this matches `.pi/.pi/swarm/state/` (nonexistent), NOT `.pi/swarm/state/`. All state files committable to git. Fix: change to `swarm/state/`. |
| `src/shared/atomic-append.ts` | `appendLine` uses O_APPEND + fsync. Atomic per-write for small messages. Used by `mailbox.ts` and `persistence.ts`. NOT a finding.                                                                                                                                                                                  |
| `src/shared/profiles.ts`      | `loadUserProfiles` searches `[project, global]` order; `if (profiles[name]) continue` ensures project-level takes precedence (#158 fixed). `resolveProfile` chain: file agents (project then user) > settings custom > built-in. `resolveProfileTools()` always returns explicit array.                             |
| `src/swarm/specs.ts`          | `createAgentSwarmSpecs` validates `{{item}}` appears exactly once (#165 fixed) via `split().length - 1`. Duplicate prompt detection via `seenPrompts` Map. `MAX_AGENT_SWARM_SUBAGENTS = 128`.                                                                                                                       |
| `src/swarm/mode.ts`           | `SwarmMode` state machine: `enter`/`exit`/`restoreEnter` with `SwarmModeTrigger` ("manual"/"task"/"tool"). `shouldAutoExit` for task/tool triggers. `exit` pops enter reminder or injects exit reminder.                                                                                                            |
| `src/shared/pi-settings.ts`   | `readPiSettings` reads `.pi/settings.json` with schema validation. Returns `{ value, error }` tuple.                                                                                                                                                                                                                |
| `src/shared/xml.ts`           | `escapeXmlAttr` and `escapeXmlBody` for XML output. `escapeXmlAttr` escapes `&`, `<`, `>`, `"` (not single quotes — safe because all attrs use double quotes).                                                                                                                                                      |

### Tests — Reference only

| File                               | What to check                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/smoke.test.ts`              | Covers persistence, recovery, mailbox, concurrency config. Does not cover actual process spawning or rate limiting.                                 |
| `tests/controller.test.ts`         | Rate-limit phase transitions, batch abort with partial results, max concurrency enforcement, `scheduleNextRateLimitWakeup` past-time branch (#125). |
| `tests/render.test.ts`             | XML output format for completed, failed, aborted, and mixed outcomes. Check escape handling for special characters.                                 |
| `tests/swarm-tool.test.ts`         | Input validation: missing `prompt_template` with items, missing `{{item}}` placeholder, duplicate prompts, 129 items.                               |
| `tests/agents.test.ts`             | Frontmatter parsing, file loading, profile integration, `resolveProfileTools()` allowlist/denylist, `matchItemToAgent()` routing.                   |
| `tests/mailbox.test.ts`            | Message delivery, acknowledgment, concurrent write safety.                                                                                          |
| `tests/tui-truncation.test.ts`     | Text truncation utilities used across all TUI components.                                                                                           |
| `tests/coordinator.test.ts`        | SwarmTeam runId collision (#128), activeRuns cleanup (#160), placeholder validation.                                                         |
| `tests/worktree.test.ts`           | `cleanupWorktree` preserves gitignored untracked files (#129), worktree preservation on commit failure (#109).                                      |
| `tests/keyword-mode.test.ts`       | `resolveKeywordMode` word-boundary matching (#157).                                                                                                 |
| `tests/pi-invoke.test.ts`          | `FORBIDDEN_SUBAGENT_TOOLS` filtering, `buildSubagentArgs` arg construction.                                                                         |
| `tests/persistence-state.test.ts`  | `writeAtomic`, `appendEvent`, `readJsonLines`, manifest operations.                                                                                 |
| `tests/recovery-retention.test.ts` | Stale run detection, `getResumableAgents`, retention period cleanup.                                                                                |
| `tests/atomic-append.test.ts`      | `appendLine` O_APPEND + fsync behavior.                                                                                                             |
| `tests/mailbox-poll.test.ts`       | Mailbox polling, offset advancement, `readNewMailboxLines`.                                                                                         |
| `tests/index-gitignore.test.ts`    | `ensureGitignore` writes to `.pi/.gitignore` (#123).                                                                                                |
| `tests/pi-settings.test.ts`        | `readPiSettings` schema validation.                                                                                                                 |

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
- [ ] `npm test` — all 203 tests pass, 17 test files, 0 failures
- [ ] `grep -r "TODO\|FIXME\|HACK\|XXX" src/` — any leftover markers?
- [ ] `grep -r "catch\s*{" src/` — are there empty catch blocks swallowing errors? (see #182, #185, #187)
- [ ] `grep -rn "\.only(" tests/` — no `.only()` calls left in test files
- [ ] `grep -rn "as " src/shared/types.ts` — verify type assertions are not masking structural mismatches
- [ ] `grep -rn "appendFileSync\|appendFile" src/` — verify all JSONL appends use `appendLine` (O_APPEND + fsync), not raw `fs.appendFileSync`
- [ ] `grep -rn "execFileSync\|execSync" src/shared/worktree.ts` — verify all git commands use argument arrays (not string concatenation) to prevent injection
- [ ] Verify layer boundaries: `grep -rn "from.*swarm\|from.*team" src/tui/ src/state/` returns no matches
- [ ] Verify no stale file references: `grep -rn "task-graph\|supervisor\|team/tool" rules/` returns no matches (these files were removed)

## Known Fixed Issues

The following issues have been fixed. Do NOT re-report them:

#107 (heartbeat not updated), #108 (mailbox non-transactional appends), #110 (ensureGitignore outside .pi/), #112 (matchItemToAgent precedence), #113 (validateRecipient accepts non-existent), #115 (broadcast message loss), #122 (broadcast outbox/inbox writes), #123 (ensureGitignore writes project-root .gitignore), #125 (scheduleNextRateLimitWakeup past-time), #127 (duplicate prompt detection in production), #128 (runId collision), #129 (cleanupWorktree gitignored untracked files), #135 (ackMessages TOCTOU), #137 (readJsonLines silent drop), #156 (swarm state machine), #157 (resolveKeywordMode substring), #158 (loadUserProfiles precedence), #159 (settled variables unsynchronized), #160 (activeRuns Map leak), #161 (sendMessage broadcast non-atomic), #162 (updateHeartbeat silent fail), #163 (updateHeartbeatIfNeeded race), #164 (getResumableAgents strict comparison), #165 (createAgentSwarmSpecs {{item}} count), #166 (mailbox addendum path exposure).

## New Findings (This Review — #178-#192)

| Issue | P   | File                         | Finding                                                                                                                       |
| ----- | --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| #184  | P0  | `spawner.ts:520-529`         | `killProc`/timeout sets `settledState.settled=true` without resolving promise — hangs forever, leaks mailbox poll + logStream |
| #188  | P0  | `gitignore.ts:20`            | `GITIGNORE_ENTRY = ".pi/swarm/state/"` matches wrong path in `.pi/.gitignore` — ALL state files committable to git            |
| #178  | P0  | `coordinator.ts:148,388`     | Inbox path missing "state" segment — files outside `.gitignore`, never cleaned, invisible to recovery                         |
| #179  | P1  | `mailbox.ts:203-205`         | Direct message writes outbox before task inbox — crash causes silent message loss                                             |
| #180  | P1  | `coordinator.ts:376`         | SwarmTeam bypasses `createAgentSwarmSpecs` — no duplicate-prompt detection                                             |
| #181  | P1  | `tool.ts:5,97,137`           | Descriptions say "1-20" but schema allows 128 — LLM underuses batch capacity                                                  |
| #182  | P1  | `spawner.ts` (7 locations)   | 7 empty catch blocks silently discard mailbox and cleanup errors                                                              |
| #183  | P1  | `agents.ts:493`              | `matchGlobPattern` no-wildcard branch uses `endsWith` — false positive routing                                                |
| #185  | P1  | `worktree.ts` (10 locations) | 10 empty catch blocks across git operations return silent defaults                                                            |
| #186  | P1  | `worktree.ts:295-385`        | `cleanupWorktree` destroys agent work when `git status --porcelain` fails                                                     |
| #187  | P1  | `persistence.ts:355`         | `listActiveRuns` empty catch silently drops runIds failing path-traversal validation                                          |
| #189  | P1  | `spawner.ts:65`              | `readNewMailboxLines` offset stuck after outbox file recreation — agent misses all new messages                               |
| #190  | P1  | `spawner.ts:347-352`         | System prompt temp file never cleaned up — disk leak                                                                          |
| #191  | P1  | `controller.ts:715-741`      | Rate-limit retry has no max count — permanent rate limit causes infinite retry                                                |
| #192  | P1  | `worktree.ts:154-162`        | `.pi` symlink staged by `git add -A`, committed to agent branch, merged to main                                               |
