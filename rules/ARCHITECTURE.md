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

- **Out-of-process subagents via `spawn`, not in-process** — Crash isolation. A subagent crash never corrupts parent state. 
- **Two-phase concurrency (normal → rate-limit)** — Rate limits are inevitable at scale. The normal phase maximizes throughput; the rate-limit phase prevents cascading failures with capacity tracking and exponential backoff (3s/6s/12s/…).
- **File-based mailbox (JSONL), not a message broker** — Zero runtime dependencies. Every message is a file inspectable with `cat` or `jq`. JSONL supports append-only concurrent writes without file-level coordination.
- **Atomic writes for all state mutations** — `writeAtomic` (temp-file + rename) is mandatory for every JSON/JSONL write. A crash mid-write leaves the original file intact. Direct `fs.writeFileSync` on state files is forbidden.
- **Dual mode sharing `shared/` infrastructure** — Both `/swarm` (parallel, homogeneous) and `/swarm-team` (sequential, role-based) share the same controller, spawner, and render modules. Adding a third mode should reuse `shared/`, not fork.
- **Worktree isolation by default for git repos** — Each subagent runs in a temporary git worktree under `/tmp/`. Non-git repos silently fall back to cwd. This prevents parallel agents from interfering with each other's file changes.
- **30-minute staleness threshold for crash recovery** — Long enough for a legitimate run, short enough to detect actual crashes. Matches pi's default subagent timeout.

## Named Subagents (~/.pi/agents/*.md) Design

### Motivation

Users need to reuse complex agent configurations across swarm runs without repeating prompt/system prompt in every tool call. The existing settings.json-based custom profiles work but require JSON editing and provide no discoverability. File-based agent definitions (one file = one agent) are self-documenting, shareable, and easy to manage with `ls ~/.pi/agents/`.

### Agent File Format

Files live under `~/.pi/agents/` (user-global) and `.pi/agents/` (project-scoped). Each file is a Markdown document with YAML frontmatter:

```markdown
---
name: rust-audit
description: Rust code audit specialist with safety analysis
# Capability flags (recommended primary mechanism — works everywhere)
allowWrite: false
allowBashWrite: false
# Tool allowlist (optional, overrides capability defaults)
# When set, ONLY these tools are available to the subagent.
# Tool names are pi tool identifiers as seen by the LLM.
# Omit to let capability flags determine the tool set.
tools:
  - read
  - bash
# Tool denylist (optional, subtracts from resolved tool set)
disallowedTools:
  - Swarm
  - SwarmCoordinator
  - SendMessage
# Model routing (optional): "small" auto-resolves from settings
model: small
# Output format: "free" (default) or "structured"
outputFormat: structured
---

You are a Rust code audit specialist operating in READ-ONLY mode.

CRITICAL RULES:
- Focus on memory safety, unsafe blocks, concurrency bugs

## REQUIRED OUTPUT FORMAT

Scope: <summary>
Findings:
  - [P0/P1/P2/P3] <file:line> — <description>
```

### Tool Permission Model (pi-swarm specific)

pi-swarm runs on pi-coding-agent, which has a dynamic tool set varying by installation (community extensions, MCP servers, user-installed tools). The tool permission model uses **three layers**:

| Layer | Mechanism | Scope | When to use |
|---|---|---|---|
| 1. Capability flags | `allowWrite`, `allowBashWrite` | Universal | **Default/recommended.** Works regardless of installed tools. |
| 2. Tool allowlist | `tools: [...]` | Explicit | Power users who know their exact tool inventory. When set, ONLY listed tools are available. |
| 3. Tool denylist | `disallowedTools: [...]` | Subtractive | Power users who want to block specific tools (e.g. prevent subagents from launching sub-sub-agents). |

**Resolution order**:
1. If `tools` allowlist is set → use that exact list (capability flags still filter native tools)
2. If `disallowedTools` is set → start from capability-derived tool set, subtract disallowed items
3. If neither → use capability flags only (current default behavior)
4. `allowWrite=false` always removes `edit` and `write` from the resolved set
5. `allowBashWrite=false` keeps `bash` but instructs read-only via system prompt

**Important**: Tool names are pi tool identifiers as registered with `pi.registerTool()`. Common native tools include: `read`, `edit`, `bash`, `write`, `search`, `think`, `web_fetch`, `batch_web_fetch`, `agent_browser`, `mcp`, `workflow`. pi-swarm registers: `Swarm`, `SwarmCoordinator`, `SendMessage`, `TaskStop`, `SwarmStatus`. The exact set varies by user installation — capability flags are the portable choice.

### Resolution Chain

Agent lookup order (first match wins):

```
1. Project-scoped file:  .pi/agents/<name>.md            ← highest priority
2. User-global file:     ~/.pi/agents/<name>.md
3. Settings custom:      .pi/settings.json → pi-swarm.subagents
4. Built-in profiles:    explore, plan, general, review
5. Fallback:             general                          ← lowest priority
```

The same `resolveProfile()` function handles all sources. File agents, settings custom profiles, and built-in profiles all resolve to the same `AgentProfile` interface, so consumers (Swarm tool, Coordinator tool, etc.) do not need to distinguish the source.

### Module Architecture

```
                    ┌─────────────────────┐
                    │   shared/agents.ts   │ ← NEW: file scanning, frontmatter parsing
                    │  loads .md files     │
                    │  → AgentProfile[]    │
                    └────────┬────────────┘
                             │ merged with
                             ▼
              ┌──────────────────────────────┐
              │    shared/profiles.ts         │ ← MODIFIED: resolveProfile() searches
              │  resolveProfile(name) →       │   file agents before settings/built-in
              │    AgentProfile               │
              └────────┬─────────────────────┘
                       │ consumed by
              ┌────────┴────────────┐
              │  Swarm / Coordinator │ ← MODIFIED: agentType param
              │  tools               │
              └─────────────────────┘
```

All new code lives in `shared/` layer (pure Node.js, no pi/tui imports). `profiles.ts` imports `loadFileAgents()` from `agents.ts` but not vice versa.

### File Agent vs agentType Naming

- File `rust-audit.md` → agent name = `rust-audit` (derived from filename, dropping `.md`)
- Frontmatter `name` field overrides the filename-derived name (optional)
- Reference via `agentType: "rust-audit"` in Swarm/Coordinator calls
- `agentType` and `profile` are **mutually exclusive** in tool parameters
