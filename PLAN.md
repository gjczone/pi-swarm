# pi-swarm Implementation Plan (v2 — Dual Mode)

---

## 1. Product Vision

**pi-swarm** is a unified multi-agent extension for pi-coding-agent with two operational modes:

| Mode      | Command              | Trigger                        | Pattern                                          |
| --------- | -------------------- | ------------------------------ | ------------------------------------------------ |
| **Swarm** | `/swarm <task>`      | User or LLM calls `AgentSwarm` | Parallel, item-template, homogeneous agents      |
| **Team**  | `/swarm-team <task>` | User or LLM calls `SwarmTeam`  | Collaborative, role-based, mailbox communication |

Both modes share the same underlying infrastructure: subagent spawning (`pi --print`), concurrency control, rate-limit handling, and TUI progress rendering.

**Long-term goal**: Replace both third-party `subagent` and `worktree` extensions as the unified sub-agent orchestration solution.

---

## 2. Research Summary

### 2.1 Key References

| Source           | What We Take                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **kimi-code**    | AgentSwarm tool definition, SubagentBatch concurrency controller, swarm-mode state machine, braille TUI progress                    |
| **pi-crew**      | Mailbox system (JSONL inbox/outbox), task graph with dependencies, durable file-based state, worktree isolation, supervisor pattern |
| **LangGraph**    | Shared application state pattern, supervisor node with tool-wrapped workers, Send API for fan-out                                   |
| **CrewAI**       | Hierarchical team with role/task delegation, task context chaining, structured output                                               |
| **OpenAI Swarm** | Function-call handoff (`transfer_to_agent`), context_variables passing                                                              |
| **AutoGen**      | HandoffMessage first-class primitive, event-driven agent runtime                                                                    |

### 2.2 What Claude Code Has

Claude Code has a **hooks system** (shell scripts triggered by lifecycle events) but **no built-in multi-agent "teams" or "swarm" concept**. Its subagent model runs a single subagent at a time. There is no native "letter passing" pattern — that's our innovation.

### 2.3 The Mailbox Pattern (from pi-crew)

Agents communicate by reading/writing JSONL files in a shared mailbox directory:

```
.pi/swarm/state/runs/{runId}/
  mailbox/
    inbox.jsonl       # Messages addressed to this agent/team
    outbox.jsonl      # Messages sent by this agent/team
    delivery.json     # Delivery state tracking
    tasks/{taskId}/
      inbox.jsonl     # Per-task message inbox
      outbox.jsonl    # Per-task message outbox
```

Each message is a JSON object with `message_id`, `from`, `to`, `type`, `payload`. Agents poll their inbox for new messages.

**This is the "letter passing" pattern** — agents write JSON files as letters, other agents read them to collaborate.

---

## 3. Architecture

```
pi-swarm/
├── package.json
├── tsconfig.json
├── README.md
├── PLAN.md                       # This file
├── AGENTS.md
├── LOCAL_CI.md
├── OPS.md
└── src/
    ├── index.ts                  # Entry: default export, registers tools + commands + hooks
    ├── shared/
    │   ├── types.ts              # Shared type definitions (messages, tasks, state)
    │   ├── spawner.ts            # Sub-agent process spawner (pi --print)
    │   ├── controller.ts         # Concurrency controller (ramp-up + rate-limit + abort)
    │   └── render.ts             # Result rendering (XML for swarm, JSON for team)
    ├── swarm/
    │   ├── tool.ts               # AgentSwarm tool (parallel, item-template)
    │   ├── command.ts            # /swarm slash command
    │   └── mode.ts               # SwarmMode state machine
    ├── team/
    │   ├── tool.ts               # SwarmTeam tool (collaborative, mailbox-based)
    │   ├── command.ts            # /swarm-team slash command
    │   └── mailbox.ts            # Mailbox system (JSONL inbox/outbox/delivery)
    ├── tui/
    │   ├── progress.ts           # Braille progress bar panel
    │   └── swarm-markers.ts      # Swarm mode markers
    └── state/
        ├── persistence.ts        # Durable state (manifest, tasks, events)
        └── recovery.ts           # Crash recovery, stale run detection
```

### 3.1 Shared Infrastructure

Both Swarm and Team modes share:

- **Spawner** (`shared/spawner.ts`): Launch `pi --print` child processes, parse JSONL event stream
- **Controller** (`shared/controller.ts`): Two-phase ramp-up (5 + 1/700ms), rate-limit phase, abort handling
- **Progress** (`tui/progress.ts`): Fixed-width tool-call-driven braille bars with baseline track
- **Persistence** (`state/`): Durable file-based state for crash recovery

### 3.2 Mode: Swarm (Parallel)

```
User: /swarm Review all files in src/ for bugs
       or LLM calls AgentSwarm({prompt_template, items})

  ┌─────────────────────────────────────────────┐
  │              Swarm Controller               │
  │                                             │
  │  items: [src/a.ts, src/b.ts, src/c.ts]     │
  │  template: "Review {{item}} for bugs"       │
  │                                             │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
  │  │ Agent #1  │  │ Agent #2  │  │ Agent #3  │  │
  │  │ src/a.ts  │  │ src/b.ts  │  │ src/c.ts  │  │
  │  └──────────┘  └──────────┘  └──────────┘  │
  │       ↓              ↓              ↓       │
  │  ┌──────────────────────────────────────┐  │
  │  │        <agent_swarm_result>          │  │
  │  │  completed: 2, failed: 1             │  │
  │  └──────────────────────────────────────┘  │
  └─────────────────────────────────────────────┘
```

**Key characteristics:**

- All agents run the same prompt template with different items
- No inter-agent communication — they work independently
- Results aggregated into `<agent_swarm_result>` XML
- Max 128 subagents, ramp-up concurrency control

### 3.3 Mode: Team (Collaborative)

```
User: /swarm-team Implement user authentication with tests
       or LLM calls SwarmTeam({goal, roles, phases})

  ┌─────────────────────────────────────────────┐
  │           Team Supervisor                   │
  │                                             │
  │  1. Decompose goal into task graph          │
  │  2. Assign tasks to role agents             │
  │  3. Monitor mailbox for results             │
  │  4. Validate & synthesize                   │
  └──────────────┬──────────────────────────────┘
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │Planner│  │Coder │  │Reviewer│
  │      │  │      │  │      │
  │ inbox│  │ inbox│  │ inbox│
  │outbox│  │outbox│  │outbox│
  └──┬───┘  └──┬───┘  └──┬───┘
     │         │         │
     │  ┌──────┼─────────┘
     │  │      │
     ▼  ▼      ▼
  ┌──────────────────────────┐
  │     Shared Mailbox       │
  │                          │
  │  .pi/swarm/mailbox/          │
  │    inbox.jsonl           │
  │    outbox.jsonl          │
  │    delivery.json         │
  └──────────────────────────┘
```

**Key characteristics:**

- Supervisor decomposes goal into phased tasks
- Each agent has a role (planner, coder, reviewer, tester)
- Agents communicate via shared mailbox (JSONL files)
- Task graph with dependencies: planner → coder → reviewer → tester
- Supervisor monitors progress and can reassign/retry

---

## 4. SwarmTeam Tool Design

### 4.1 Input Schema

```typescript
interface SwarmTeamInput {
  goal: string; // High-level goal description
  description: string; // Team run description
  roles?: AgentRoleConfig[]; // Custom role definitions (optional)
  phases?: TeamPhase[]; // Custom phase definitions (optional)
  max_agents?: number; // Max concurrent agents (default: 4)
  small_model?: string; // Lightweight model for exploration roles (optional)
  artifacts_dir?: string; // Where to write output artifacts
}
```

### 4.2 Built-in Roles

```typescript
type AgentRole =
  | "planner"
  | "coder"
  | "reviewer"
  | "tester"
  | "explorer"
  | "fixer";

interface AgentRoleConfig {
  role: AgentRole;
  model?: string; // Model override for this role
  tools?: string[]; // Tool allowlist (default: all)
  system_prompt?: string; // Role-specific system prompt addition
}
```

### 4.3 Default Team Phases

```
Phase 1: Explore    — [explorer] Understand codebase context
Phase 2: Plan       — [planner]   Design implementation approach
Phase 3: Implement  — [coder]     Write the code changes
Phase 4: Review     — [reviewer]  Review for correctness & quality
Phase 5: Test       — [tester]    Verify with tests
Phase 6: Fix        — [fixer]     Address review feedback (optional, loops back)
```

### 4.4 Mailbox Message Format

```json
{
  "message_id": "uuid",
  "run_id": "uuid",
  "timestamp": "2026-06-23T10:30:00Z",
  "from": "supervisor",
  "to": "coder",
  "type": "task_assignment",
  "payload": {
    "phase": "implement",
    "goal": "Implement login endpoint",
    "dependsOn": ["explore", "plan"],
    "dependencyResults": {
      "explore": "Found 3 relevant modules: auth, session, middleware.",
      "plan": "Implementation plan: 4 files to create, 2 to modify."
    }
  }
}
```

### 4.5 Team Output Format

```xml
<swarm_team_result>
<summary>Phases completed: 5/6. Succeeded: 5, Failed: 0, Skipped: 1.</summary>
<total_duration_ms>18432</total_duration_ms>
<phase name="explore" role="explorer" outcome="completed" agent_id="team-abc1" duration_ms="5210">
### Key Files Examined
- src/auth/login.ts (LoginHandler, validateCredentials)
- src/auth/session.ts (SessionManager, createSession)

### Root Cause
The login flow uses bcrypt for password hashing but doesn't verify...
</phase>
<phase name="plan" role="planner" outcome="completed" agent_id="team-abc2" duration_ms="8120">
### Implementation Plan
1. Add password verification step in LoginHandler
2. Create test cases for valid/invalid/expired scenarios
3. Update session creation to include auth timestamp
</phase>
<supervisor_synthesis>
### Team Run: Implement user login with JWT

### Phase Outcomes
- [DONE] **explore** (explorer) — Key Files Examined
- [DONE] **plan** (planner) — Implementation Plan
- [DONE] **implement** (coder) — Changes made
- [DONE] **review** (reviewer) — Approved
- [SKIP] **test** (tester)

### Key Deliverables
#### explore (explorer)
### Key Files Examined
- src/auth/login.ts...
#### plan (planner)
### Implementation Plan
1. Add password verification...
</supervisor_synthesis>
</swarm_team_result>
```

### 4.6 Per-Role Model Tier Routing

To optimize cost, SwarmTeam supports routing exploration roles to a cheaper/faster model:

- `small_model` parameter configures a lightweight model (e.g., `deepseek/deepseek-v4-flash`)
- `explorer` role automatically uses the small model when configured
- All other roles (`planner`, `coder`, `reviewer`, `tester`, `fixer`, `supervisor`) use the default model
- Per-phase override available via `modelTier` (`"small"` or `"default"`) or `model` (explicit name)
- Resolution priority: phase-level model > phase-level modelTier > role-level config > auto-route > default

---

## 5. Concurrency Controller (from kimi-code)

### 5.1 Normal Phase

| Parameter       | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Initial launch  | 5 agents                                                  |
| Ramp interval   | 700ms per additional agent                                |
| Max concurrency | `PI_SWARM_MAX_CONCURRENCY` env var (unlimited by default) |
| Max total       | 128 agents                                                |

### 5.2 Rate-Limit Phase

- First rate limit → stop ramp, enter rate-limit phase
- Capacity starts at ready normal launches (min 1)
- Rate-limited tasks requeue with exponential backoff: 3s → 6s → 12s → doubling
- Capacity shrinks by 1 per rate limit (min 1), at most once per 2000ms
- If no rate limit for 3 minutes → capacity recovers by 1
- If only one task remains and it's rate-limited → fail fast (don't suspend forever)

### 5.3 Abort Handling

- User cancellation (Ctrl+C) → preserve completed results, mark active as aborted
- Non-user cancellation → reject the entire batch

---

## 6. TUI Components

### 6.1 Swarm Progress Panel

```
┌─ Agent Swarm ──────────────────────────────────┐
│  Working...                                     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  #1 ⣿⣿⣿⣿⣿⣶⣀  Working...  src/auth/login.ts    │
│  #2 ✓ Completed.                 src/auth/types.ts  │
│  #3 ✗ Failed: syntax error       src/auth/middle.ts │
│  #4 ⣀⣀⣀⣀⣀⣀⣀  Queued...     src/auth/utils.ts  │
│  completed: 1, failed: 1, working: 1, queued: 1     │
└─────────────────────────────────────────────────────┘
```

**Wiring**: The `SubagentBatchController` accepts an optional `onProgress`
callback that receives a `BatchProgressSnapshot` at every lifecycle transition
(task started, completed, failed, rate-limited, batch finished). The
`AgentSwarm` tool passes this callback through, converting each snapshot to a
`SwarmProgressState` via `snapshotToProgressState` and pushing it to an
`AgentSwarmProgressComponent` installed above the editor via
`ctx.ui.setWidget`. The widget is torn down in a `finally` block so it never
lingers after the run. Non-TUI modes (print/rpc/json) skip the widget entirely.

**Swarm markers**: `/swarm` and `/swarm-team` commands (and the keyword auto
trigger) send `swarm:marker` custom messages. `index.ts` registers a
`MessageRenderer` for `swarm:marker` that renders a `SwarmModeMarkerComponent`
line (activated / deactivated / ended) in the transcript.

### 6.2 Team Dashboard

```
┌─ Team: Implement Auth ─────────────────────────┐
│  Status: running  |  Phase: 3/6 (Implement)     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  explore   ✓ completed (explorer)               │
│  plan      ✓ completed (planner)                │
│  implement ⣿⣿⣿⣿⣶⣀ working (coder)             │
│  review    ○ queued                             │
│  test      ○ queued                             │
│  fix       ○ queued                             │
│  ─────────────────────────────────────────────  │
│  Mailbox: 3 new messages in inbox               │
│  Artifacts: plan.md, login.patch                │
└─────────────────────────────────────────────────┘
```

---

## 7. Persistence & Recovery

### 7.1 State Directory

```
.pi/swarm/state/
  runs/{runId}/
    manifest.json        # Run metadata, status, agent IDs
    tasks.json           # Task graph & per-task status
    events.jsonl         # Append-only event log
    agents/{agentId}/
      status.json        # Per-agent status
      output.log         # Agent output
```

### 7.2 Crash Recovery

- On session start, scan for incomplete runs
- If a run has `status: running` but the parent Pi process is dead → mark as `abandoned`
- Unfinished tasks → can be resumed via `resume_agent_ids`
- Completed runs → kept for reference, cleaned up after 7 days

---

## 8. Implementation Phases

### Phase 1: Foundation (complete)

- [x] Project scaffolding (package.json, tsconfig, directory structure)
- [x] PLAN.md, AGENTS.md, LOCAL_CI.md, OPS.md
- [x] Shared types (`shared/types.ts`)
- [x] Pi CLI invocation helper (`shared/spawner.ts`)

### Phase 2: Swarm Mode

- [x] Concurrency controller (`shared/controller.ts`) — full SubagentBatch
- [x] Result renderer (`shared/render.ts`) — XML output
- [x] AgentSwarm tool (`swarm/tool.ts`) — `pi.registerTool`
- [x] SwarmMode state machine (`swarm/mode.ts`)
- [x] `/swarm` command (`swarm/command.ts`)

### Phase 3: Team / Mailbox Mode

- [x] Mailbox system (`team/mailbox.ts`) — JSONL inbox/outbox
- [ ] Task graph (`team/task-graph.ts`) — phases with dependencies (planned)
- [ ] Team supervisor (`team/supervisor.ts`) — task decomposition & assignment (planned)
- [ ] SwarmTeam tool (`team/tool.ts`) — `pi.registerTool` (planned)
- [x] `/swarm-team` command (`team/command.ts`)

### Phase 4: TUI

- [x] Progress component (`tui/progress.ts`) — fixed-width braille bars
- [x] Swarm markers (`tui/swarm-markers.ts`)
- [x] Wire `onProgress` callback through controller → tool → widget
- [x] Register `swarm:marker` message renderer in `index.ts`
- [ ] Team dashboard (`tui/team-dashboard.ts`) — planned
- [ ] Permission prompt (`tui/permission-prompt.ts`) — planned

### Phase 5: Persistence & Integration

- [x] Durable state (`state/persistence.ts`)
- [x] Crash recovery (`state/recovery.ts`)
- [x] Main entry (`index.ts`) — wire everything together
- [x] Lifecycle hooks (session_start, session_shutdown)
- [x] Build verification, smoke tests

### Phase 5.5: Bug Fixes & Enhancements

- [x] Subagent output capture fix — accumulate tool outputs, handle string content
- [x] Per-agent output.log persistence — write full session output to agent state dir
- [x] Supervisor context passing — dependency results in task_assignment, message acknowledgment
- [x] Per-role model tier routing — small_model for explorer, per-phase overrides
- [x] Enhanced result format — per-phase output, duration_ms, supervisor_synthesis

- [x] README.md with credits

### Phase 6: Worktree Isolation & Real-time Mailbox

- [x] Git worktree module (`shared/worktree.ts`) — create, cleanup, merge, prune
- [x] Spawner worktree integration — auto-create worktree for git repos, symlink project context
- [x] Real-time mailbox communication — outbox polling at ~1.25Hz, prompt injection with mailbox instructions
- [x] Mailbox worktree symlinking — mailbox directory accessible from within worktrees
- [x] Token usage tracking — per-agent usage accumulation, throttled onUsage callbacks, totalUsage in snapshots
- [x] Controller result immutability — `if (this.finished) return` guards in outcome/error handlers
- [x] Spawner abort/exit race fix — resolveOnce/rejectOnce helpers, abortReason tracking
- [x] Mailbox atomic writes — all JSONL/JSON mutations use writeAtomic (temp-file + rename)
- [x] Path traversal prevention — validateId + resolveAgentStateDir for all agent ID inputs
- [x] Zombie process SIGKILL fix — exited flag on close event, no premature timer cancellation
- [x] Recovery corrupt manifest preservation — preserve unreadable manifests for debugging
- [x] Permission mode removal — swarm activates directly without permission prompts

---

## 9. Design Decisions (Confirmed)

| Decision                  | Choice                                                              |
| ------------------------- | ------------------------------------------------------------------- |
| Model selection           | Optional per-agent; passed via settings; defaults to parent model   |
| Parameter passing         | All agents receive parent config + task instructions                |
| Context isolation         | Each agent runs in independent `pi --print` process                 |
| Tool whitelist            | All tools available by default                                      |
| Persistence               | Durable file-based state; resume incomplete runs; disband completed |
| Inter-agent communication | Mailbox pattern: JSONL files in `.pi/swarm/mailbox/`                |
| Team supervision          | Supervisor agent decomposes goal, assigns to role agents, validates |
| Language                  | 100% English in all code, comments, docs, commits                   |
