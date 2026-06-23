# pi-swarm

Agent Swarm & Team for [pi](https://github.com/earendil-works/pi) — the first **100% dynamic multi-agent extension**. No preset agent definitions. The main agent spawns temporary subagents on-the-fly based on the task at hand.

Think of it as **kimi-code's AgentSwarm** + **Claude Code's subagent delegation** + **CrewAI's role-based teams** — all inside pi, with zero static configuration.

## What It Does

Two modes, one extension:

| Mode | Like... | What happens |
|------|---------|-------------|
| **Swarm** | kimi-code AgentSwarm, OpenAI Swarm | Same task on many items, all in parallel. 5 agents launch immediately, more every 700ms. |
| **Team** | CrewAI, LangGraph Supervisor | Complex tasks broken into phases. Agents collaborate through a shared mailbox. Each gets context from previous phases. |

**All agents are dynamically created.** No `agents/*.md` files, no static profiles. The main agent decides what subagents to spawn based on the task.

## Install

```bash
pi install npm:pi-swarm@latest
```

Restart pi. You're done.

## How to Use

### Swarm — "Do this to all of these"

Just talk naturally:

```
Review every file in src/ for bugs — use a swarm
```

```
Run a security audit on these five packages in parallel: auth, api, db, cache, middleware
```

```
Check all 20 TypeScript files for type errors — AgentSwarm
```

Or use the slash command:

```
/swarm Find deprecated API usage across the entire codebase
```

### Team — "Plan this, build it, review it"

```
Implement user login with JWT — use a team with planner, coder, and reviewer
```

```
Add Redis caching — first explore the codebase, then plan, implement, review, and test
```

Or use the slash command:

```
/swarm-team Add end-to-end encryption to the messaging module
```

### Resume Failed Work

If some agents fail (rate limits, errors), the LLM sees which ones failed and can resume them:

```
AgentSwarm failed 2 out of 5 reviews — retry those
```

The tool output includes `resume_agent_ids` — the LLM just passes them back.

## Settings

Add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "pi-swarm": {
    "maxConcurrency": 5
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrency` | unlimited | Hard cap on parallel agents. Set lower to avoid API rate limits. |

If not set in `settings.json`, falls back to `PI_SWARM_MAX_CONCURRENCY` env var.

## How It Compares

| Feature | pi-swarm | pi subagent | kimi-code swarm | CrewAI |
|---------|----------|-------------|-----------------|--------|
| Parallel agents | Yes | Limited | Yes | Via tasks |
| Team collaboration | Yes (mailbox) | No | No | Yes (hierarchical) |
| Dynamic agents | 100% dynamic | Preset profiles | Item-template | Role definitions |
| TUI progress | Braille bars | Overlay | Braille bars | CLI logs |
| Rate-limit handling | Auto retry | No | Auto retry | No |
| Crash recovery | Auto-detect | No | No | No |

## Output

Results return as structured XML the LLM reads directly:

**Swarm**:
```xml
<agent_swarm_result>
<summary>completed: 3, failed: 1</summary>
<subagent agent_id="swarm-abc" item="src/auth.ts" outcome="completed">
No vulnerabilities found.
</subagent>
</agent_swarm_result>
```

**Team**:
```xml
<agent_team_result>
<summary>Phases completed: 5/5. Succeeded: 5.</summary>
<phase name="plan" role="planner" outcome="completed">Design ready.</phase>
</agent_team_result>
```

## How Agents Are Created

Every subagent is a fresh `pi --print` child process. The main agent passes:
- The task prompt (template with `{{item}}` filled in, or phase-specific instructions)
- Model configuration (inherits from main agent, overridable)
- Tool access (all tools available)
- No context inheritance — each agent has a clean context window

This means:
- **No static agent files.** No `agents/planner.md`, no `agents/coder.md`. 100% dynamic.
- **No context pollution.** Each agent sees only its task, not the full conversation.
- **Crash isolation.** One agent crashing doesn't affect others or the main session.

## Vibe Coding

100% vibe-coded with deepseek-v4-pro. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (AgentSwarm, SubagentBatch, TUI). Team patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Design informed by LangGraph, CrewAI, OpenAI Swarm, and AutoGen.

## License

MIT
