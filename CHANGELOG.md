# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-06-29

### Added

- **Agent Profiles (#99)**: Four built-in profiles (`explore`, `plan`, `general`, `review`) with capability-based tool restrictions, model routing, structured system prompts, and output formats. User-defined custom profiles can be added via `.pi/settings.json` under `pi-swarm.subagents`. Profiles determine whether an agent can write files or run write-capable bash commands.
- **Coordinator Mode (#98)**: Non-blocking swarm orchestration with four new tools:
  - `SwarmCoordinator` — launch a swarm and return immediately with a `runId`, staying in control across conversation turns.
  - `SendMessage` — send messages to running agents (or broadcast to all) via per-agent inbox files.
  - `TaskStop` — gracefully stop individual agents by name or ID.
  - `SwarmStatus` — check status and results of active coordinator runs.
- **Agent name derivation**: `deriveAgentName()` produces human-readable agent names from profile name, item prefix (colon/dash-delimited), or index fallback (`agent-N`).
- **Message inbox paths**: Coordinator agents read per-agent `messageInboxPath` files for incoming `SendMessage` deliveries during execution.

### Changed

- **Swarm tool** (`src/swarm/tool.ts`): Added `profile` parameter for agent profile selection. Each subagent now carries profile-derived behavior (tool restrictions, system prompt, model routing).
- **Spawner** (`src/shared/spawner.ts`): Added `messageInboxPath`, `agentName`, and `additionalSystemPrompt` fields to `RunSubagentOptions`. Subagents now receive profile-specific system prompts and coordinator inbox paths.
- **Controller** (`src/shared/controller.ts`): `runAsync()` method added for coordinator mode — runs agents in background and returns a `SwarmHandle` with `getResults()`, `sendMessage()`, `stopAgent()`, and `abort()`. Non-blocking operation with `onEvent` callback for lifecycle events.
- **Types** (`src/shared/types.ts`): Added `AgentProfile`, `BuiltinProfileName`, `AgentOutputFormat`, `SwarmHandle`, `SubagentEvent`, `CoordinatorOptions`, and profile-related fields to `BaseQueuedSubagentTask` and `RunSubagentOptions`.
- **Entry point** (`src/index.ts`): Imported and registered `registerCoordinatorTools()` for the four coordinator tools.

### Dependencies

- Added `prettier` as explicit devDependency (`^3.8.3`) to lock formatter version (#100).

## [0.7.2] - 2026-06-29

### Fixed

- **TUI progress panel crash with CJK labels (#20)**: Replaced custom `truncateText` and `visibleLen` in `progress.ts` with pi-tui's `truncateToWidth` and `visibleWidth`, which correctly account for wide characters (CJK takes 2 terminal columns). Subagent labels containing Chinese/Japanese/Korean text no longer cause "Rendered line exceeds terminal width" crashes.
- **`swarm-markers.ts` used local truncation**: Replaced local `truncateToWidth` with pi-tui's wide-char-aware implementation.

### Changed

- **AGENTS.md**: Updated shazam tool count from 9 to 7 (2 tools — `shazam_find_tests` and `shazam_safe_delete` — are not yet registered in pi-shazam).

### Removed

- Dead function `writeJsonLines` in `src/team/mailbox.ts` (zero callers).

## [0.7.1] - 2026-06-29

### Changed

- **TUI progress panel overhaul (#100)**: Replaced grid layout with fixed-width tool-call-driven progress bars. Each agent renders as a single line with 5 braille cells (baseline `⣀` when empty, 85% cap while working, full bar when completed). Tool labels (`read:`, `edit:`, `bash:`) align vertically across agents. Vertical layout for 1-4 agents, 2-column compact grid for 5+.

### Fixed

- **Mailbox messages never delivered (P0, #100)**: Wired `onMessage` callback in swarm tool — inter-agent messages are now delivered via `sendMessage()` to the recipient's per-task inbox. Previously, spawner polling detected outbox writes but the `onMessage` callback was undefined so messages were lost.
- **Broadcast delivery always broken in swarm mode (P1, #100)**: Replaced hardcoded team role list (`explorer`, `planner`, `coder`, ...) with dynamic `fs.readdirSync` scan of the tasks directory. Broadcast now works for both swarm mode (`agent-1`/`agent-2`/...) and team mode.
- **Mailbox prompt had wrong recipient names (#100)**: Agent prompt listed team roles as recipients instead of dynamic agent names. Now tells agents to discover recipients from the filesystem.

### Removed

- Orphaned `BRAILLE_SPINNER`, `frameIndex`, and `startAnimation()` dead code from TUI progress component.
- Brand name references (pi-crew, MoonshotAI, kimi-code, gotgenes) from source files (credit preserved in README.md).

## [0.7.0] - 2026-06-29

### Fixed

- **Log WriteStream crash (P0, #79)**: Added error handler on logStream WriteStream to prevent unhandled 'error' event from crashing the parent process on disk failure.
- **Mailbox TOCTOU race (P0, #80)**: Replaced read-filter-write ack pattern with append-only ack file (inboxAcks.jsonl). Acknowledged message IDs are appended to a separate file and filtered at read time, eliminating the race window.
- **Worktree data loss on commit failure (P0, #81)**: cleanupWorktree now tracks a changesStaged flag. On commit failure after changes were staged, the worktree is preserved for manual recovery rather than force-removed.
- **Dangling commit loss (#82)**: WorktreeCleanupResult now includes commitSha. When branch creation fails after a successful commit, the SHA is returned to the caller so the commit is not orphaned.
- **rateLimitCapacity unbounded (#83)**: Capped rateLimitCapacity at maxConcurrency in initialization, capacity recovery, and the launch guard to respect user-set concurrency limits during rate-limit phase.
- **Worktree failure silent fallback (#84)**: createWorktree now throws on failure in git repos. Spawner catches the error and logs a prominent warning instead of silently falling back to shared cwd.
- **getResumableAgents marks completed agents as resumable (#85)**: Now reads status.json to check actual agent state. Only non-terminal states (running, started, spawned, suspended) are marked resumable.
- **Corrupted JSONL lines silently dropped (#86)**: readJsonLines now logs warnings with file path and line preview for unparseable lines, plus a summary count at the end.
- **prompt_template placeholder validation (#87)**: Added runtime check that prompt_template contains exactly one {{item}} occurrence before spawning agents.
- **hasModel() false positive on error (#88)**: Changed catch block to return false (fail-closed) with a console.error log instead of true (fail-open).
- **isUserCancellation too broad (#89)**: Removed "abort" from keyword matching. Consolidated failedAttemptOutcome to use isUserCancellation. Prevents ECONNABORTED and system errors from being misclassified as user interrupts.

### Changed

- **GitHub Actions CI test matrix**: Removed Node 18 (vitest v4/rolldown requires Node 20+). Test matrix is now [ubuntu-latest, macos-latest] x ["22"].

### Dependencies

- Bumped typebox from 1.3.0 to 1.3.1 (#78)
- Bumped @earendil-works/pi-tui from 0.79.10 to 0.80.2 (#77)
- Bumped github/codeql-action from v3 to v4 (#76)
- Bumped actions/setup-node from v5 to v6 (#75)
- Bumped actions/upload-artifact from v4 to v7 (#74)

## [0.6.0] - 2026-06-28

### Added

- **Single unified Swarm tool**: Merged SwarmTeam into Swarm with optional `mailbox` parameter. Removed supervisor, task-graph, team-dashboard. One tool handles both parallel and collaborative modes.
- **Mailbox flag**: `mailbox: true` enables inter-agent mailbox communication. Default `false` keeps agents independent.
- **Model override**: `model` parameter to set subagent model. Pass `"small"` to auto-resolve from settings `pi-swarm.smallModel` in `~/.pi/agent/settings.json`.
- **Progress tick tracking**: Controller counts `onActivity` calls as `progressTick`. Braille bar fills based on real agent activity instead of frame animation.
- **onActivity forwarding**: Spawner now forwards model deltas (`content_block_delta`) and tool results (`tool_result`) as `onActivity` callbacks to the controller, enabling real-time scrolling output display.
- **AGENTS.md auto-loading**: Spawner auto-detects `AGENTS.md` in the project root and passes it via `--append-system-prompt` to subagent `pi --print` processes.

### Changed

- **TUI fully rewritten to kimi-code style**: Grid layout with braille progress bars, agent IDs (`001`, `002`), compact single-agent mode (no grid), mailbox count in header, bottom status line with `─` separator.
- **Tool renamed**: `AgentSwarm` → `Swarm`.
- **Parameters simplified**: Removed `subagent_type`, `resume_agent_ids`. Only `prompt_template`, `items`, `model`, `mailbox`, `description`.
- **Max items**: Reduced from 128 to 20 (`MAX_ITEM_COUNT`).
- **Header labels**: `─ Agent Swarm ─` for no-mailbox mode, `─ Swarm Team ─` with `Mailbox: N` when mailbox enabled.
- **Status line at bottom**: Moved from between header and grid to after grid, matching kimi-code layout.
- **All "kimi-code" references removed from source comments**: Replaced with neutral descriptions.
- **`swarmMode` type**: Cleaned up from `"swarm" | "team" | null` to `"swarm" | null`.
- **README.md**: Updated feature table, usage examples, settings, credits.

### Removed

- `src/team/supervisor.ts` (phase supervisor, no longer needed)
- `src/team/task-graph.ts` (phase DAG, no longer needed)
- `src/team/tool.ts` (separate SwarmTeam tool, merged into Swarm)
- `src/tui/team-dashboard.ts` (separate team TUI, kimi-code progress.ts used for everything)
- `src/tui/permission-prompt.ts` (dead code, unsed)
- `tests/team-dashboard.test.ts`, `tests/task-graph.test.ts` (corresponding tests)
- `rules/` companion files (LOCAL_CI.md, OPS.md, LLM-REVIEW-GUIDE.md — consolidated into AGENTS.md rules section)

### Fixed

- **LSP errors in tests**: Fixed `controller.test.ts` type compatibility issue with `QueuedSubagentTask` spread and `MockAgentConfig.result` optionality.
- **`MAX_ITEM_COUNT` unused**: Constant was defined but not referenced in schema. Now used.
- **Error message outdated**: "AgentSwarm failed" → "Swarm failed".

## [0.5.0] - 2026-06-28

### Added

- **Keyboard interaction for TUI panels (#66)**: Both AgentSwarmProgressComponent and TeamDashboardComponent now support `handleInput()` with j/k scrolling, Enter detail overlay, ? help overlay, g/G top/bottom navigation, and Tab/1/2/3 panel switching. Agents list, event log, dependency visualization, and mailbox panels are all keyboard-navigable.
- **Real-time agent activity tracking (#67)**: Added `currentTool` and `activity` fields to `BatchMemberStatus`. These are wired through the controller's `emitProgress()` to the TUI display, showing the current tool name and activity description inline in each agent row.
- **Debounced event-driven render scheduling (#68)**: Replaced the pure setInterval polling with a 75ms debounce window that coalesces rapid state changes, plus fallback polling at 800ms (active) / 2s (idle). The animation timer only triggers re-renders when active members or overlays exist.
- **Mailbox UI panel and dependency visualization (#69)**: TeamDashboard now has a 3rd panel showing mailbox messages (press 3), a 2nd panel showing phase dependency chains (press 2), and a phase detail overlay on Enter.
- **Progress density enhancements (#70)**: AgentSwarm now displays ETA estimation based on average completion time, an event log panel (press 2) showing recent progress events, and scroll indicators for overflow lists.

### Changed

- **Types**: Added `ProgressEvent`, `PhaseDependencyEdge`, `estimatedRemainingMs` and `eventLog` to `BatchProgressSnapshot`, `dependencyEdges` to `TeamProgressSnapshot`, `onActivity` callback to `RunSubagentOptions`.
- **Controller ETA calculation**: ETA now includes both queued and active tasks in the remaining count (previously only queued).
- **Rollup of 5 TUI issues (#66, #67, #68, #69, #70)**: All TUI-related enhancements merged as a single feature batch.

### Fixed

- **Scroll offset boundary in TUI components**: Fixed a bug where `scrollDown()` could set `scrollOffset` to a negative value when `memberCount < VISIBLE_MEMBERS`, because `memberCount - VISIBLE_MEMBERS` was used as `Math.min` argument without `Math.max(0, ...)` wrapping.
- **node_modules and .pi symlinks tracked in git**: Removed accidentally tracked `node_modules` and `.pi` symlinks from git index (introduced by subagent worktree auto-merge). Updated `.gitignore` to cover the entire `.pi/` directory instead of only `.pi/swarm/state/`.

## [0.4.1] - 2026-06-25

### Added

- **Git worktree isolation (#49)**: Each subagent now runs in a temporary git worktree by default, providing filesystem isolation so parallel agents cannot interfere with each other's changes. On completion, changes are committed to a named branch (`pi-agent-{agentId}`) and the worktree is cleaned up. `mergeBranch()` handles sequential merging after batch completion. Non-git repos silently fall back to cwd. Project context files (AGENTS.md, .pi config, rules/) and node_modules are symlinked into the worktree.
- **Real-time mailbox communication (#50)**: Team agents can now send and receive messages during execution (not just between phases). Each agent's prompt is injected with mailbox read/write instructions. The spawner polls the agent's outbox file at ~1.25Hz and delivers messages to recipients' inboxes via the `onMessage` callback. Mailbox directories are symlinked into worktrees for cross-boundary access.
- **Token usage tracking (#51)**: The controller now accumulates per-agent token usage (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`) and includes `totalUsage` and `startedAt` in every `BatchProgressSnapshot`. Usage is emitted at 5Hz via throttled `onUsage` callbacks for real-time TUI display. `message_delta` and `content_block_delta` events are now parsed for incremental usage and text accumulation.
- **Corrupt manifest preservation (#52)**: Recovery now preserves run directories with unreadable/corrupt manifests instead of deleting them, logging a warning for debugging. Only truly orphaned directories (no manifest file) are cleaned up.
- 107 tests across 8 test files (unchanged from 0.3.5).

### Changed

- **Permission mode removal**: Removed `getPermissionMode()`/`setPermissionMode()` stubs from the swarm command host. Swarm mode no longer prompts for permission mode switching — it activates directly. The permission prompt TUI component remains for future use.
- **Recovery smarter about corrupt state**: `recoverRuns()` now distinguishes between "manifest exists but is unreadable" (preserve for debugging) and "no manifest at all" (orphaned, safe to clean up).
- **Controller active-state lookup optimized**: `emitProgress()` now uses a `Set` for active index lookup instead of `Array.some()`, improving performance with large agent counts.
- **Controller rate-limit scheduling fixed**: `scheduleNextRateLimitWakeup()` now correctly computes `nextAllowedAt` as `Math.max(nextRateLimitLaunchAt, nextPendingReadyAt)` before taking the minimum with capacity recovery time.

### Fixed

- **Controller result mutation after cancellation (#43)**: `SubagentBatchController` could mutate the results array after `finish()` resolved when the user cancelled, because active attempts continued to deliver outcomes. Fixed by adding `if (this.finished) return` guards and aborting all active attempts in `finishWithUserCancellation()`.
- **Spawner abort/exit race condition (#44)**: `spawnSubagent` could lose timeout errors or deliver duplicate results when abort and process exit raced. Fixed by introducing `resolveOnce`/`rejectOnce` helpers with a `done` flag and tracking `abortReason`.
- **Mailbox non-atomic writes (#45)**: `writeJsonLines` and `updateDeliveryState` used direct `fs.writeFileSync`. Fixed by reusing `writeAtomic` (temp-file + rename) from `state/persistence.ts`, now exported for shared use.
- **Path traversal in resumeSubagent (#41)**: Agent ID was not validated when resolving the agent state directory. Fixed by using `resolveAgentStateDir` and `validateId` for all agent ID inputs.
- **Zombie process leak (#42)**: Child processes ignoring SIGTERM were not force-killed because the SIGKILL timer was cancelled prematurely. Fixed by introducing an `exited` flag set on process `close` event and replacing `proc.killed` checks.
- **Recovery corrupt manifest crash (#46)**: Recovery deleted run directories with corrupt manifests, losing debugging data. Fixed by preserving unreadable manifests and only cleaning up truly orphaned directories.
- **Permission mode stub errors (#47)**: `getPermissionMode()`/`setPermissionMode()` stubs could cause integration issues with host implementations. Fixed by removing the stubs entirely — swarm mode activates without permission prompts.

### Documentation

- Reorganized companion files into `rules/` directory (15 rule files).
- Updated AGENTS.md to reference `rules/` paths and added rules file reading table.
- Added `src/shared/worktree.ts` to architecture tree and Change Map.

## [0.3.5] - 2026-06-25

### Fixed

- **Controller result mutation after cancellation (#43)**: `SubagentBatchController` could mutate the results array after `finish()` resolved when the user cancelled, because active attempts continued to deliver outcomes. Fixed by adding `if (this.finished) return` guards in `handleAttemptOutcome` and `handleAttemptError`, and by aborting all active attempts in `finishWithUserCancellation()` before marking the batch finished. Results are now immutable once the controller settles.
- **Spawner abort/exit race condition (#44)**: `spawnSubagent` could lose timeout errors or deliver duplicate results when abort and process exit raced. Fixed by introducing `resolveOnce`/`rejectOnce` helpers with a `done` flag, tracking `abortReason` to distinguish timeout from user cancellation, and ensuring listeners and timeouts are cleaned up before settling the promise.
- **Mailbox non-atomic writes (#45)**: `writeJsonLines` (used by inbox/outbox/ack operations) and `updateDeliveryState` used direct `fs.writeFileSync` which could truncate files mid-write on crash, producing corrupted JSONL or partial JSON. Fixed by reusing the existing `writeAtomic` utility (temp-file + rename) from `state/persistence.ts`, which is now exported for shared use. All mailbox mutations are now crash-safe.
- **Path traversal in resumeSubagent (#41)**: Agent ID was not validated when resolving the agent state directory, allowing directory escape via `..` or path separators. Fixed by using `resolveAgentStateDir` (path containment check) and `validateId` (regex sanitization) for all agent ID inputs in `spawnSubagent`, `resumeSubagent`, and `createAgentSwarmSpecs`.
- **Zombie process leak - SIGKILL fallback not firing (#42)**: Child processes that ignored SIGTERM were not force-killed because the SIGKILL fallback timer was cancelled prematurely in `cleanup()`, and `proc.killed` was unreliable (returns true after any kill attempt, not actual termination). Fixed by introducing an `exited` flag set on process `close` event, removing timer cancellation from cleanup, and replacing `proc.killed` checks with `!killState.exited`. Processes ignoring SIGTERM are now force-killed after a 5-second grace period.

### Added

- 10 new tests covering atomic write cleanup, mailbox send/ack, delivery state persistence, controller result immutability after cancellation, ID validation, and path traversal prevention.
- `writeAtomic` exported from `src/state/persistence.ts` for use by other modules requiring crash-safe writes.

### Documentation

- Test count updated to 107 tests across 8 test files in AGENTS.md, LOCAL_CI.md, OPS.md, LLM-REVIEW-GUIDE.md.

## [0.3.4] - 2026-06-24

### Fixed

- **Parallel phase execution (#24)**: Independent SwarmTeam phases (no mutual dependencies) now execute concurrently instead of sequentially. `supervisor.startReadyPhases()` returns ALL phases with satisfied dependencies, and `tool.ts` launches them via `SubagentBatchController` with proper concurrency. Default pipeline (each phase depends on previous) remains sequential.
- **TUI dashboard rendering (#23)**: Fixed text overlap and layout corruption during execution. Robust truncation at all rendering levels prevents content from overflowing into adjacent lines. Consistent line count maintained across updates. Support for multiple concurrently running phases with individual braille bars.

### Changed

- `TeamDashboardState` now tracks `currentRoles[]` (array) for multi-phase rendering support.


## [0.3.3] - 2026-06-24

### Fixed

- **Subagent output capture (#25, #27, #29)**: Agent results were always "(no output)" because the event stream parser only read `message_end` events and ignored tool outputs. Fixed by accumulating tool output from `tool_result` events and handling both string-form and array-form message content. Added `cwd` support to spawner so subagents inherit the correct working directory. Added timeout handling for subagent processes.
- **Per-agent output.log persistence (#31)**: Subagents now write their full session output to `output.log` under the agent state directory. Includes headers, raw stdout, and footers for debugging. Run manifests track agent IDs and completion status for both AgentSwarm and SwarmTeam.
- **Supervisor context passing (#30)**: Phases now receive accumulated results from their dependencies instead of starting from scratch. `task_assignment` messages include full `dependsOn` lists and `dependencyResults` maps. Messages are acknowledged (deleted) after consumption to prevent cross-phase leakage when the same role runs multiple phases. All three message types (`task_assignment`, `handoff`, `task_result`) are now rendered with full context.
- **Spawner string content (#30)**: Fixed message content extraction to handle both string-form and array-form `msg.content` from `message_end` events.

### Added

- **Per-role model tier routing (#26)**: `SwarmTeam` now supports a `small_model` parameter for configuring a lightweight model used by exploration roles. `explorer` role automatically routes to the small model; all other roles use the default model. Phases support `modelTier` (`"small"` / `"default"`) and `model` (explicit name) overrides with a clear priority chain. Role configs support `model` and `tools` overrides. New `ModelTier` type and `SMALL_MODEL_ROLES` constant in shared types.
- **Enhanced SwarmTeam result format (#28)**: Result XML now includes actual per-phase output (instead of "(no output)" placeholders), `agent_id` and `duration_ms` attributes on each `<phase>`, `<total_duration_ms>` top-level element, and a `<supervisor_synthesis>` section with consolidated phase outcomes, error summaries, and key deliverables excerpts. Outputs longer than 12,000 characters are truncated with a note. XML escaping split into `escapeAttr()` (full) and `escapeBody()` (minimal, preserving markdown).

### Changed

- `model`, `tools`, `cwd` fields added to `RunSubagentOptions` and `BaseQueuedSubagentTask` for threading through the spawn chain.
- `TeamPhase` now supports `modelTier`, `model`, and `tools` fields for per-phase overrides.
- `TeamSupervisor` gains `getPhaseExecutionConfig()` for centralized model/tools/cwd resolution.

## [0.3.2] - 2026-06-24

### Fixed

- **TUI truncation crash (#20)**: All three TUI components (progress, permission-prompt, team-dashboard) now properly truncate rendered lines to fit terminal width, preventing "Rendered line exceeds terminal width" crashes. Fixed an off-by-one bug in `borderTop` dash calculation. Added truncation guards to `renderMemberRow`, `buildSummary`, `renderPhaseRow`, `buildHeader`, `buildFooter`, and `padLine`.
- **Keyword mode ambiguity (#21)**: Extracted `resolveKeywordMode()` function that correctly distinguishes "swarm" vs "swarm-team"/"swarm team" keywords with proper priority resolution. Replaced boolean `swarmActive` with `swarmMode` state machine (`"swarm" | "team" | null`).
- **Startup console noise (#21)**: Removed `console.error` output during normal extension loading — pi-swarm now loads silently like pi built-in extensions.
- **Visible auto-activation markers (#21)**: Keyword auto-activation markers now use `display: false` for transparent user experience.

### Removed

- **Dead code (#21)**: Removed unused functions `linkAbortSignal` (superseded by `linkAttemptSignals`), `extractRunId`, and `extractSwarmRoot`. Integrated `userCancellationReason` into `handleBatchAbort`.

### Documentation

- Test count updated to 90 tests across 8 test files in AGENTS.md, LOCAL_CI.md, OPS.md, LLM-REVIEW-GUIDE.md.

## [0.3.1] - 2026-06-24

### Fixed

- **TUI widget animation not rendering (#20)**: The `setWidget` factory functions in both `swarm/tool.ts` and `team/tool.ts` were discarding the `(tui, theme)` parameters from the TUI framework. This meant the braille animation timers called `invalidate()` to clear caches but never called `tui.requestRender()` to notify the framework to redraw — progress bars appeared frozen. Fixed by capturing the `tui` reference and passing a `requestRender` callback to both `AgentSwarmProgressComponent` and `TeamDashboardComponent`.

### Added

- **Rich tool call/result rendering (#20)**: Both `AgentSwarm` and `SwarmTeam` tools now implement `renderCall` and `renderResult` using `Container`/`Text`/`Spacer` from `@earendil-works/pi-tui`, matching the pattern used by the built-in pi-coding-agent subagent extension. Tool calls show agent count, prompt template preview, and phase lists. Tool results show success/failure icons with summary statistics.

## [0.3.0] - 2026-06-24

### Added

- **Team dashboard (#16)**: New `TeamDashboardComponent` (tui/team-dashboard.ts) for live phase progress during SwarmTeam runs. The `TeamSupervisor` emits `TeamProgressSnapshot` via an `onProgress` callback at every phase lifecycle transition. The tool converts snapshots and pushes them to a dashboard widget. Types `TeamProgressSnapshot`, `TeamPhaseStatus`, and `TeamProgressCallback` added to shared/types.ts. 12 new tests in tests/team-dashboard.test.ts.

### Changed

- **Internal tool function renamed (#17)**: `registerAgentTeamTool` renamed to `registerSwarmTeamTool` in src/team/tool.ts; import and call updated in src/index.ts for consistency with the `SwarmTeam` public name.
- **Naming unification (#18)**: `crewRoot` → `swarmRoot`, `resolveCrewRoot` → `resolveSwarmRoot`, `extractCrewRoot` → `extractSwarmRoot`, `PI_SWARM_CREW_ROOT` → `PI_SWARM_ROOT`, `<agent_team_result>` → `<swarm_team_result>` across all src/, tests/, and docs/\*.md files.

## [0.2.0] - 2026-06-24

### Added

- **TUI live progress (#1)**: AgentSwarm now renders a live braille progress panel above the editor during batch runs. The `SubagentBatchController` emits `BatchProgressSnapshot` via an `onProgress` callback at every lifecycle transition (start, complete, fail, rate-limit suspend, batch finish). The tool converts snapshots to `SwarmProgressState` and pushes them to an `AgentSwarmProgressComponent` widget. Non-TUI modes skip the widget.
- **Swarm markers**: `index.ts` registers a `MessageRenderer` for `swarm:marker` custom messages, rendering activated/deactivated/ended marker lines in the transcript.
- **`/swarm-team` command (#2)**: Enhanced to activate swarm mode, check/switch permission mode, emit a TUI marker, and delegate the goal to the SwarmTeam tool. A keyword auto-trigger (`swarm` / `swarm-team` in user input) activates swarm mode.

### Changed

- **Naming unification (#3)**: Renamed the team tool from `AgentTeam` to `SwarmTeam` (label "Swarm Team") across tool registration, descriptions, error messages, and documentation for consistency with the `/swarm-team` command and the `Swarm*` naming convention.

## [0.1.6] - 2026-06-24

### Changed

- **Dev dependencies**: typescript ^6.0.0 (was ^5.0.0), vitest ^4.0.0 (was ^1.6.1). All 55 tests pass with latest.

## [0.1.5] - 2026-06-24

### Changed

- Final audit: package.json metadata (description, keywords), OPS.md scoped name fixes, AGENTS.md description refresh.

## [0.1.4] - 2026-06-24

### Changed

- **Single-agent support**: AgentSwarm now accepts 1 item (was minimum 2). Use for single subagent delegation with the same tool interface. 1-128 items supported.

## [0.1.3] - 2026-06-24

### Fixed

- **README accuracy**: Removed false claims about git worktree isolation. Agents run as isolated `pi --print` child processes, not in git worktrees.
- **Auto-gitignore**: On session start, auto-appends `.pi/swarm/state/` to the project's `.gitignore`. Creates `.gitignore` if no ignore file exists.

## [0.1.2] - 2026-06-24

### Changed

- **Scoped package**: Renamed to `@gjczone/pi-swarm`. Install with `pi install npm:@gjczone/pi-swarm@latest`.
- **State directory**: Always uses `.pi/swarm/state/`. Creates `.pi/` if it doesn't exist. No longer falls back to `.crew/`.

### Documentation

- README: Fixed settings.json location table. Renamed "Vibe Coding" to "Credits".

## [0.1.1] - 2026-06-24

### Changed

- **Default max concurrency**: 5 (was unlimited). Configurable via settings.json or env var with no upper bound. Recommended range: 3-10.
- **Settings priority**: `.pi/settings.json` (project) > `~/.pi/agent/settings.json` (global) > `PI_SWARM_MAX_CONCURRENCY` env var > default 5.

### Fixed

- **Team abort handling**: Ctrl+C now stops team runs mid-execution. Completed phases are preserved and returned as partial results.
- **Team partial state**: Catastrophic errors return completed phase output instead of only an error message.
- **`isUserCancellation`**: Now handles string abort reasons (not just Error instances).

### Documentation

- README: Simplified to pi-native usage. Added git worktree explanation, runtime file layout, and cancel mid-run behaviour.
- README: Added stability warning banner. Added "Runtime Files" section.
- OPS.md: Streamlined 10-step release checklist with GitHub Release auto-generation.
- LOCAL_CI.md: Updated for 54-test suite.

## [0.1.0] - 2026-06-23

### Features

- **AgentSwarm tool**: Parallel subagent orchestration with item-template pattern (`{{item}}` placeholder). Ported from MoonshotAI/kimi-code.
- **SwarmTeam tool**: Collaborative role-based agents (explorer/planner/coder/reviewer/tester) with sequential phase execution and dependency graph. Inspired by pi-crew.
- **`/swarm` command**: Slash command for `on`, `off`, toggle, and one-shot `<task>` with permission mode integration.
- **`/swarm-team` command**: Slash command for launching collaborative team runs.
- **SubagentBatch concurrency controller**: Full port of kimi-code's two-phase scheduler (normal ramp-up + rate-limit phase) with exponential backoff retry, capacity tracking, and abort handling.
- **Braille TUI progress panel**: Live progress display with braille animation (`⣀⣤⣶⣿`), 80ms frame interval, per-agent status rows, and summary counts.
- **SwarmMode state machine**: Tracks manual/task/tool trigger modes with system reminder injection.
- **JSONL mailbox system**: File-based inter-agent communication for team mode (inbox.jsonl/outbox.jsonl/delivery.json).
- **Task graph with phase dependencies**: Directed acyclic graph for team phases with dependency validation, skip propagation, and serialization.
- **Team supervisor**: Goal decomposition, phase assignment, context-injected prompts, and result synthesis.
- **Durable file-based state**: Run manifests, task state, event logs with atomic writes under `.pi/swarm/state/`.
- **Crash recovery**: Automatic stale run detection (30min threshold), abandoned run marking, and expired run cleanup (7 days).
- **TUI permission prompt**: Manual-mode dialog for choosing auto/yolo before swarm start.
- **Swarm mode markers**: Conversation transcript markers for activated/deactivated/ended states.

### Infrastructure

- 19 TypeScript source modules (~4500 LOC), 100% English codebase
- 55 unit/smoke tests across 5 test files
- CI pipeline: typecheck, test (ubuntu + macos), build, security audit
- npm publish workflow triggered by GitHub Release
- `pi.extensions` auto-discovery via `package.json`
- Environment variable config: `PI_SWARM_MAX_CONCURRENCY`, `PI_SWARM_ROOT`
- macOS + Linux support, Node.js >= 18

### Credit

- AgentSwarm architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- Team mailbox patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew)
- 100% vibe-coded with deepseek-v4-pro, doubao-seed-2.1-pro, and doubao-seed-2.1-turbo
