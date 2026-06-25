# Architecture Rules

## Layer Architecture

```
tui/ + state/ -> swarm/ + team/ -> shared/ -> index.ts
```

### Layer Responsibilities

| Layer      | Responsibility                                   | Imports From              |
| ---------- | ------------------------------------------------ | ------------------------- |
| `shared/`  | Core logic, types, process management            | Node.js stdlib only       |
| `swarm/`   | AgentSwarm tool, /swarm command, mode state machine | `shared/`               |
| `team/`    | SwarmTeam tool, mailbox, supervisor, task graph   | `shared/`                 |
| `tui/`     | TUI components (progress bars, dashboards)        | `shared/`, `@earendil-works/pi-tui` |
| `state/`   | Persistence, crash recovery                       | `shared/`, Node.js fs     |
| `index.ts` | Entry point, registration, wiring                 | All layers                |

### Layer Rules

- `shared/` MUST NOT import from `swarm/`, `team/`, `tui/`, or `state/`
- `tui/` and `state/` MUST NOT import from `swarm/` or `team/`
- `swarm/` and `team/` MUST NOT import from each other
- All cross-layer communication goes through `index.ts` or `shared/` exports

## Module Inventory

### shared/ (6 files, 2783 LOC)

| File              | LOC  | Purpose                                    |
| ----------------- | ---- | ------------------------------------------ |
| `controller.ts`   | 952  | Concurrency controller (ramp-up + rate-limit + abort) |
| `spawner.ts`      | 771  | Sub-agent process spawner (pi --print)     |
| `worktree.ts`     | 458  | Worktree management (git worktree isolation) |
| `types.ts`        | 369  | Shared type definitions                    |
| `render.ts`       | 159  | Result rendering (<agent_swarm_result> XML) |
| `pi-invoke.ts`    | 74   | pi CLI invocation helper                   |

### swarm/ (3 files, 869 LOC)

| File         | LOC  | Purpose                                    |
| ------------ | ---- | ------------------------------------------ |
| `tool.ts`    | 585  | AgentSwarm tool registration               |
| `command.ts` | 147  | /swarm slash command handler               |
| `mode.ts`    | 137  | SwarmMode state machine (enter/exit/reminders) |

### team/ (5 files, 2081 LOC)

| File            | LOC  | Purpose                                    |
| --------------- | ---- | ------------------------------------------ |
| `supervisor.ts` | 879  | Team supervisor (decomposition + assignment + synthesis) |
| `tool.ts`       | 615  | SwarmTeam tool registration                |
| `mailbox.ts`    | 268  | JSONL mailbox system (inbox/outbox/delivery) |
| `task-graph.ts` | 264  | Phase dependency graph (DAG)               |
| `command.ts`    | 59   | /swarm-team slash command handler          |

### tui/ (4 files, 886 LOC)

| File                | LOC  | Purpose                                    |
| ------------------- | ---- | ------------------------------------------ |
| `team-dashboard.ts` | 325  | SwarmTeam live phase progress dashboard    |
| `progress.ts`       | 358  | AgentSwarmProgressComponent (braille bars) |
| `permission-prompt.ts` | 129 | Permission prompt dialog for manual mode  |
| `swarm-markers.ts`  | 74   | SwarmModeMarkerComponent                   |

### state/ (2 files, 601 LOC)

| File            | LOC  | Purpose                                    |
| --------------- | ---- | ------------------------------------------ |
| `persistence.ts`| 384  | Durable state (manifest, tasks, events, atomic writes) |
| `recovery.ts`   | 217  | Crash recovery (stale run detection, cleanup) |

## Dependency Injection

The controller uses the `SubagentBatchLauncher` interface to abstract subagent execution. This makes the controller testable -- tests inject a mock launcher.

```typescript
interface SubagentBatchLauncher {
  spawn(options: SpawnOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: ResumeOptions): Promise<SubagentHandle>;
  retry(agentId: string, options: RetryOptions): Promise<SubagentHandle>;
}
```

## Change Map

When adding new modules, follow these patterns:

| Change Type | Where | Pattern |
| ----------- | ----- | ------- |
| New shared utility | `shared/<name>.ts` | Export function, import in consumers |
| New type | `shared/types.ts` | Add type, import in consumers |
| New tool | `swarm/<name>.ts` or `team/<name>.ts` | `register*` function, wire in `index.ts` |
| New command | `swarm/command.ts` or `team/command.ts` | Handler function, register in `index.ts` |
| New TUI component | `tui/<name>.ts` | Implement `Component` from pi-tui |
| New persistence | `state/persistence.ts` | Export function, update recovery if needed |
