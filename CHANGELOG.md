# Changelog

All notable changes to pi-swarm will be documented in this file.

## [0.1.0] - 2026-06-23

### Features

- **AgentSwarm tool**: Parallel subagent orchestration with item-template pattern (`{{item}}` placeholder). Ported from MoonshotAI/kimi-code.
- **AgentTeam tool**: Collaborative role-based agents (explorer/planner/coder/reviewer/tester) with sequential phase execution and dependency graph. Inspired by pi-crew.
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
