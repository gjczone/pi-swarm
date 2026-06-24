# Changelog

All notable changes to pi-swarm will be documented in this file.

## [0.4.0] - 2026-06-24

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
