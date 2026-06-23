# pi-swarm

Agent Swarm & Team orchestration extension for [pi-coding-agent](https://github.com/earendil-works/pi). Launch multiple subagents in parallel, or orchestrate collaborative role-based teams with mailbox communication.

## Install

```bash
pi install npm:pi-swarm@latest
```

Or add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "packages": ["pi-swarm"]
}
```

The extension auto-loads on next pi session. Verify with:

```bash
pi -p "/swarm on"
# Should show "Swarm mode enabled" — no "Extension error"
```

## What You Get

Two LLM-visible tools and two slash commands:

| Tool | Command | When to Use |
|------|---------|-------------|
| `AgentSwarm` | `/swarm` | Same task, many items — run them in parallel |
| `AgentTeam` | `/swarm-team` | Complex task needing multiple roles in sequence |

## Usage

### Swarm — Parallel Agents

**Natural language** (no slash command needed):

```
Review every file in src/ for bugs — launch a swarm
```

```
Check these five packages for outdated dependencies in parallel: pkg-a, pkg-b, pkg-c, pkg-d, pkg-e
```

```
Run the same audit on all 20 TypeScript files — use AgentSwarm
```

**With slash command**:

```
/swarm Review all .ts files in src/ for security issues
```

**With tool call** (LLM makes this automatically):

```
AgentSwarm({
  description: "Security review",
  prompt_template: "Review {{item}} for security vulnerabilities.",
  items: ["src/auth.ts", "src/api.ts", "src/db.ts"]
})
```

**Resume failed agents**:

```
AgentSwarm({
  description: "Retry failed reviews",
  resume_agent_ids: { "swarm-abc": "continue from where you left off" }
})
```

### Team — Collaborative Agents

**Natural language**:

```
Implement user login with JWT and tests — use a team with planner, coder, and reviewer
```

```
Add Redis caching — explore the codebase first, then plan, then implement, then review
```

**With slash command**:

```
/swarm-team Add end-to-end encryption to the messaging module
```

**With tool call**:

```
AgentTeam({
  goal: "Add Redis caching layer to the session store",
  description: "Redis session cache",
  phases: [
    { name: "explore", role: "explorer" },
    { name: "implement", role: "coder" }
  ]
})
```

### Parameters

#### AgentSwarm Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `description` | Yes | What this swarm does (shown in TUI) |
| `prompt_template` | Yes* | Template with `{{item}}` placeholder. *Required when `items` is provided |
| `items` | Yes* | Array of values to fill `{{item}}`. *At least 2, unless `resume_agent_ids` is given |
| `subagent_type` | No | Agent profile name. Default: `coder` |
| `resume_agent_ids` | No | Map of `agentId → prompt` to resume failed agents |

#### AgentTeam Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `goal` | Yes | High-level goal for the team |
| `description` | Yes | Short description for the run |
| `phases` | No | Custom phases. Default: explore → plan → implement → review → test |
| `roles` | No | Per-role model/tools overrides |
| `max_agents` | No | Max concurrent agents. Default: 4 |
| `resume_agent_ids` | No | Resume failed phase agents |

## How They Work

### Swarm Mode

Agents run **independently in parallel** — no communication between them. Each gets the same template with a different item. Results aggregate into one XML report.

```
Template: "Review {{item}} for bugs"
Items:    [file-a.ts, file-b.ts, file-c.ts]

Agent #1 ── Review file-a.ts ──→ result
Agent #2 ── Review file-b.ts ──→ result    ← all at once
Agent #3 ── Review file-c.ts ──→ result

→ <agent_swarm_result> completed: 3, failed: 0 </agent_swarm_result>
```

### Team Mode

Agents work **sequentially** through phases. Each phase agent receives output from previous phases as context. Communication happens via a shared mailbox (JSONL files).

```
explore → plan → implement → review → test
   ↓        ↓        ↓          ↓       ↓
explorer  planner   coder    reviewer  tester
   ↓        ↓        ↓          ↓       ↓
context:  context:  context:   context:  context:
(none)   explore   explore+   explore+  explore+
          output    plan       plan+     plan+
                   output     impl      impl+
                              output    review
                                        output

→ <agent_team_result> Phases completed: 5/5 </agent_team_result>
```

## TUI

During swarm or team execution, a live progress panel appears above the input:

```
┌─ Agent Swarm ──────────────────────────────────────┐
│  Working...                                          │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  #1 ⣿⣿⣿⣿⣿⣶⣀  Working...  src/auth/login.ts    │
│  #2 ✓ Completed.                 src/auth/types.ts  │
│  #3 ✗ Failed: syntax error       src/auth/middle.ts │
│  completed: 1, failed: 1, working: 1, queued: 1     │
└─────────────────────────────────────────────────────┘
```

- Braille bars animate at 80ms intervals
- Completed agents show full bars and results
- Failed agents show errors inline
- Summary line tracks totals

## Settings

All configuration via environment variables — no settings file needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_SWARM_MAX_CONCURRENCY` | unlimited | Hard cap on parallel agents |

### Concurrency Tuning

By default, swarm launches aggressively:
- 5 agents start immediately
- 1 more every 700ms
- No upper limit

To cap concurrency (e.g., to avoid API rate limits):

```bash
PI_SWARM_MAX_CONCURRENCY=3 pi
```

Invalid values (non-integer, zero, negative) fail the AgentSwarm call immediately so misconfiguration never silently degrades.

### State Directory

Runs persist to `.pi/swarm/state/` (or `.crew/state/` if no `.pi/` exists). The state directory contains run manifests, task state, event logs, and mailbox files. Completed runs auto-clean after 7 days. Stale runs (30+ min no heartbeat) are marked abandoned on session start.

## Output Format

Results return as structured XML the LLM can parse:

**AgentSwarm**:
```xml
<agent_swarm_result>
<summary>completed: 3, failed: 1</summary>
<subagent agent_id="swarm-abc" item="src/auth.ts" outcome="completed">
All good — no vulnerabilities.
</subagent>
</agent_swarm_result>
```

**AgentTeam**:
```xml
<agent_team_result>
<summary>Phases completed: 5/5. Succeeded: 5.</summary>
<phase name="explore" role="explorer" outcome="completed">Found auth module.</phase>
<phase name="plan" role="planner" outcome="completed">Create 2 files, modify 3.</phase>
</agent_team_result>
```

## Vibe Coding

100% vibe-coded with deepseek-v4-pro. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (AgentSwarm, SubagentBatch, TUI progress). Team patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew) (mailbox, supervisor). Multi-agent design informed by LangGraph, CrewAI, OpenAI Swarm, and AutoGen research.

## License

MIT
