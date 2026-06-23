# pi-swarm

> **Early version — stability not guaranteed.** This is an initial release. Expect rough edges. Bug reports, feedback, issues, and PRs are very welcome.

Agent Swarm & Team for [pi](https://github.com/earendil-works/pi). The first **100% dynamic multi-agent extension** — no preset agent files, no static profiles. Every subagent is created on-the-fly by the main agent based on the current task.

## What It Does

Two modes:

**Swarm** — parallel agents. Like kimi-code's AgentSwarm: one template, many items, all running at once. Each agent gets a dedicated git worktree for filesystem isolation. The main agent auto-cleans worktrees when the swarm finishes.

**Team** — collaborative agents. Like Claude Code's agent teams or pi-crew: role-based agents (explorer, planner, coder, reviewer, tester) working in sequence. Each phase agent reads context from previous phases via a shared mailbox. Every agent also runs in its own git worktree.

Everything is dynamic. The main agent decides how many agents to spawn and what each one should do. No `agents/*.md` files. No static configuration. Just describe the task and let it run.

## Install

```bash
pi install npm:pi-swarm@latest
```

Restart pi. Done.

## How to Use

### Swarm — "Do this to all of these"

Just talk naturally. The LLM picks up the intent and calls AgentSwarm:

```
Review every file in src/ for bugs — use a swarm
```

```
Run a security audit on these five packages in parallel: auth, api, db, cache, middleware
```

Or use the slash command explicitly:

```
/swarm Find deprecated API usage across the entire codebase
```

### Team — "Plan this, then build it, then review it"

```
Implement user login with JWT — use a team with planner, coder, and reviewer
```

```
Add Redis caching — first explore the codebase, then plan, implement, review, and test
```

Or the slash command:

```
/swarm-team Refactor the authentication module end-to-end
```

### Resume Failed Work

If some agents fail, the LLM gets `resume_agent_ids` in the result and can retry:

```
Two of the five reviews failed — retry those
```

## How It Works

### Git Worktree Isolation

Every subagent runs in its own `git worktree`. This means:

- Each agent has an isolated working directory — no file conflicts
- The main agent's working tree stays clean
- Worktrees are auto-created on spawn and **auto-cleaned** when the agent finishes
- Failed/cancelled agents also get their worktrees cleaned up

No manual worktree management. The extension handles creation and cleanup automatically.

### Dynamic Agent Creation

There are no preset agent profiles. When you ask for a swarm or team:

1. The main agent analyzes the task
2. It decides: swarm (parallel items) or team (sequential phases)
3. For swarm: it generates the `prompt_template` + `items` array
4. For team: it sets up phases, roles, and a supervisor
5. Each subagent is a fresh `pi --print` child process with a clean context window
6. All agents inherit the main agent's model and have access to all tools

## Settings

Completely optional. The default max concurrency is **5** — works well for most setups without hitting rate limits.

To change it, add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "pi-swarm": {
    "maxConcurrency": 3
  }
}
```

Priority: project settings > global settings > `PI_SWARM_MAX_CONCURRENCY` env var.

Lower values are safer for API rate limits. Higher values (10-20) work if your provider allows it.

## What It's Like

| If you know... | pi-swarm is like... |
|---------------|-------------------|
| kimi-code | The AgentSwarm tool and `/swarm` command — same item-template pattern, same TUI progress bars |
| Claude Code agent teams | The `/swarm-team` command — role-based agents collaborating in sequence |
| pi-crew | The mailbox system and supervisor — agents communicate via JSONL files, phases advance through a dependency graph |
| CrewAI | The hierarchical team model — supervisor decomposes goals, workers execute, results chain together |

## Vibe Coding

100% vibe-coded with deepseek-v4-pro. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Team patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Multi-agent design informed by LangGraph, CrewAI, OpenAI Swarm, and AutoGen.

## License

MIT
