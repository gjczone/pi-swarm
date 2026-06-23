# @gjczone/pi-swarm

> **Early release — stability not guaranteed.** This is an initial version. Expect rough edges. Bug reports, feedback, feature requests, and PRs are very welcome.

Think of it as **kimi-code's AgentSwarm + Claude Code's agent teams** — inside pi. Parallel swarm agents and collaborative role-based teams, all dynamically spawned with no preset configuration.

## What It Does

**Swarm** — parallel agents. Like kimi-code's AgentSwarm: one template, many items, running simultaneously. Each agent is an isolated `pi --print` child process with its own context window.

**Team** — collaborative agents. Like Claude Code's agent teams or pi-crew: role-based agents (explorer, planner, coder, reviewer, tester) working in sequence. Each phase agent receives context from previous phases via a shared mailbox. Every agent runs as an independent child process.

All agents are created on-the-fly. No `agents/*.md` files. The main agent decides what to spawn based on the task.

## Install

```bash
pi install npm:@gjczone/pi-swarm@latest
```

## How to Use

### Swarm — "Do this to all of these"

Just talk naturally:

```
Review every file in src/ for bugs — use a swarm
```

```
Run a security audit on these five packages in parallel: auth, api, db, cache, middleware
```

Or the slash command:

```
/swarm Find deprecated API usage across the codebase
```

### Team — "Plan this, build it, review it"

```
Implement user login with JWT — use a team with planner, coder, and reviewer
```

```
Add Redis caching — explore the codebase first, then plan, implement, review, test
```

Or:

```
/swarm-team Refactor the auth module end-to-end
```

### Resume Failed Work

If agents fail, the LLM gets `resume_agent_ids` and can retry:

```
Two of the five swarm reviews failed — retry those
```

### Cancel Mid-Run

Press `Ctrl+C` during a swarm or team run. Completed agents are preserved. In-progress agents are cancelled gracefully. For teams, completed phases are saved and returned as partial results.

## Runtime Files

State is stored under `.pi/swarm/state/`. The extension auto-creates `.pi/` if it doesn't exist, and auto-appends `.pi/swarm/state/` to the project's `.gitignore`.

```
.pi/swarm/state/runs/{runId}/
  manifest.json          # Run metadata, agent IDs, timestamps
  tasks.json             # Task graph, per-phase status
  events.jsonl           # Append-only event log
  agents/{agentId}/
    status.json          # Per-agent status snapshot
  mailbox/               # Team inter-agent messages
    inbox.jsonl
    outbox.jsonl
    delivery.json
```

Runs auto-clean: completed runs deleted after 7 days, stale runs (30min no heartbeat) marked abandoned.

## Settings

Default max concurrency is **5**. Recommended: **3-10**. Can be set to any positive integer.

| Settings file | Scope |
|---------------|-------|
| `.pi/settings.json` | Project (current directory) |
| `~/.pi/agent/settings.json` | Global (all projects) |

```json
{
  "pi-swarm": {
    "maxConcurrency": 8
  }
}
```

Priority: project settings > global settings > `PI_SWARM_MAX_CONCURRENCY` env var.

Lower values (3-5) are safer for API rate limits. Values above 10 work if your provider allows high concurrent requests. No hard upper limit.

## Credits

100% vibe-coded with deepseek-v4-pro. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Team patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Multi-agent design informed by LangGraph, CrewAI, OpenAI Swarm, and AutoGen.

## License

[MIT](LICENSE)
