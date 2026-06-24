# Changelog

All notable changes to pi-swarm will be documented in this file.

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
- Environment variable config: `PI_SWARM_MAX_CONCURRENCY`, `PI_SWARM_CREW_ROOT`
- macOS + Linux support, Node.js >= 18

### Credit

- AgentSwarm architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- Team mailbox patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew)
- 100% vibe-coded with deepseek-v4-pro
