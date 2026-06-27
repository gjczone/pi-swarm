# ARCHITECTURE.md

## Layer Boundaries

| Layer | May import from | Must NOT import from |
|-------|----------------|---------------------|
| `shared/` | Node.js stdlib only | `swarm/`, `team/`, `tui/`, `state/` |
| `swarm/` | `shared/` | `team/`, `tui/`, `state/` |
| `team/` | `shared/` | `swarm/`, `tui/`, `state/` |
| `tui/` | `shared/`, `@earendil-works/pi-tui` | `swarm/`, `team/`, `state/` |
| `state/` | `shared/`, Node.js fs | `swarm/`, `team/`, `tui/` |
| `index.ts` | All layers | None (entry point) |

**Evidence**: Grepping `from "\.\."` across directories confirms zero cross-layer violations. No file in `shared/` imports from `swarm/`, `team/`, `tui/`, or `state/`. No file in `tui/` or `state/` imports from `swarm/` or `team/`.

## Dependency Direction

```
tui/ + state/ --> swarm/ + team/ --> shared/ --> index.ts
```

All dependency flow moves inward toward `shared/` and `index.ts`. `shared/` is the core with zero pi or tui imports.

## Forbidden Imports

- `shared/**` → `swarm/**`, `team/**`, `tui/**`, `state/**`
- `tui/**` → `swarm/**`, `team/**`
- `state/**` → `swarm/**`, `team/**`, `tui/**`
- `swarm/**` → `team/**`
- `team/**` → `swarm/**`

Cross-layer communication goes through `index.ts` (tool registration, command handlers) or `shared/` exports (types, utilities).

## Key Modules

| Module | Role | Why it matters |
|--------|------|----------------|
| `shared/types.ts` | Type definitions, `SubagentBatchLauncher` interface | The single seam between the controller and the process-spawning backend. Tests inject mock launchers through this interface. |
| `shared/controller.ts` | Two-phase concurrency controller | Most complex module. Ramp-up (5 + 1/700ms) → rate-limit phase with capacity model and exponential backoff. Must never block a test suite. |
| `shared/spawner.ts` | Child process lifecycle | Manages spawn → event parsing → result extraction → worktree cleanup. The only module that calls `pi --print`. |
| `team/mailbox.ts` | JSONL inter-agent messaging | All team agent communication flows through this. Atomic writes required — `writeAtomic` from `state/persistence.ts` is the only permitted write primitive. |
| `team/task-graph.ts` | Phase DAG with dependency propagation | When a phase fails, all downstream phases are auto-skipped. Serialization must be round-trip safe (`toJSON` ↔ `fromJSON`). |
| `index.ts` | Entry point, all registrations | The only file that imports from `@earendil-works/pi-coding-agent`. Every tool/command/hook is wired here via `pi.registerTool`, `pi.registerCommand`, `pi.on`. |

## Architectural Decisions

- **Out-of-process subagents via `spawn`, not in-process** — Crash isolation. A subagent crash never corrupts parent state. Same model used by pi-crew and pi's built-in subagent example.
- **Two-phase concurrency (normal → rate-limit)** — Rate limits are inevitable at scale. The normal phase maximizes throughput; the rate-limit phase prevents cascading failures with capacity tracking and exponential backoff (3s/6s/12s/…).
- **File-based mailbox (JSONL), not a message broker** — Zero runtime dependencies. Every message is a file inspectable with `cat` or `jq`. JSONL supports append-only concurrent writes without file-level coordination.
- **Atomic writes for all state mutations** — `writeAtomic` (temp-file + rename) is mandatory for every JSON/JSONL write. A crash mid-write leaves the original file intact. Direct `fs.writeFileSync` on state files is forbidden.
- **Dual mode sharing `shared/` infrastructure** — Both `/swarm` (parallel, homogeneous) and `/swarm-team` (sequential, role-based) share the same controller, spawner, and render modules. Adding a third mode should reuse `shared/`, not fork.
- **Worktree isolation by default for git repos** — Each subagent runs in a temporary git worktree under `/tmp/`. Non-git repos silently fall back to cwd. This prevents parallel agents from interfering with each other's file changes.
- **30-minute staleness threshold for crash recovery** — Long enough for a legitimate run, short enough to detect actual crashes. Matches pi's default subagent timeout.
