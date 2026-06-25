# @gjczone/pi-swarm

> **Early release — stability not guaranteed.** This is an initial version. Expect rough edges. Bug reports, feedback, feature requests, and PRs are very welcome.

Think of it as **kimi-code's AgentSwarm + Claude Code's agent teams** — inside pi. Parallel swarm agents and collaborative role-based teams, all dynamically spawned with no preset configuration.

## What It Does

**Swarm** — 1 to 128 parallel agents. Like kimi-code's AgentSwarm: one template, many items, running simultaneously. Also works for single subagent delegation. Each agent is an isolated `pi --print` child process with its own context window.

**Team** — collaborative agents. Like Claude Code's agent teams or pi-crew: role-based agents (explorer, planner, coder, reviewer, tester) working in sequence. Each phase agent receives context from previous phases via a shared mailbox. Every agent runs as an independent child process. Optional per-role model tier routing: use a cheaper/faster model for exploration while keeping reasoning-heavy roles on the default model.

**Worktree Isolation** — each subagent runs in a temporary git worktree by default, so parallel agents cannot interfere with each other's file changes. On completion, changes are committed to a named branch for safe merging. Non-git repos fall back to regular directory mode.

**Real-time Mailbox** — team agents can send and receive messages during execution, not just between phases. Messages are delivered in near-real-time via file polling.

All agents are created on-the-fly. No `agents/*.md` files. The main agent decides what to spawn based on the task.

## Install

```bash
pi install npm:@gjczone/pi-swarm@latest
```

## How to Use

### Swarm — "Do this to all of these" (or just one)

Use for 1 to 128 items — same interface, same isolation.

```
Audit src/auth.ts for security issues — use a subagent
```

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

Press `Ctrl+C` during a swarm or team run. Completed agents are preserved and results are final (no post-cancellation mutation). In-progress agents are cancelled gracefully and their partial work discarded. For teams, completed phases are saved and returned as partial results. Timeout errors are correctly surfaced instead of being lost in abort/exit races.

## Runtime Files

State is stored under `.pi/swarm/state/`. The extension auto-creates `.pi/` if it doesn't exist, and auto-appends `.pi/swarm/state/` to the project's `.gitignore`.

```
.pi/swarm/state/runs/{runId}/
  manifest.json          # Run metadata, agent IDs, timestamps
  tasks.json             # Task graph, per-phase status
  events.jsonl           # Append-only event log
  agents/{agentId}/
    status.json          # Per-agent status snapshot
    output.log           # Full agent session output (header, raw stdout, footer)
  mailbox/               # Team inter-agent messages
    inbox.jsonl
    outbox.jsonl
    delivery.json
    tasks/{roleName}/
      inbox.jsonl        # Per-role real-time inbox
      outbox.jsonl       # Per-role real-time outbox
```

Worktree branches (`pi-agent-{agentId}`) are created in the local git repo when agents make changes. Merge them with `git merge pi-agent-{agentId}` or let the tool handle it automatically.

Runs auto-clean: completed runs deleted after 7 days, stale runs (30min no heartbeat) marked abandoned.

## Settings

Default max concurrency is **5**. Recommended: **3-10**. Can be set to any positive integer.

| Settings file               | Scope                       |
| --------------------------- | --------------------------- |
| `.pi/settings.json`         | Project (current directory) |
| `~/.pi/agent/settings.json` | Global (all projects)       |

```json
{
  "pi-swarm": {
    "maxConcurrency": 8
  }
}
```

Priority: project settings > global settings > `PI_SWARM_MAX_CONCURRENCY` env var.

Lower values (3-5) are safer for API rate limits. Values above 10 work if your provider allows high concurrent requests. No hard upper limit.

## Team Model Tier

When using `SwarmTeam`, you can configure a lightweight model for exploration roles to reduce costs:

```json
{
  "pi-swarm": {
    "smallModel": "deepseek/deepseek-v4-flash"
  }
}
```

The `explorer` and `tester` roles (when assigned to a phase) automatically use the small model. Other roles (`planner`, `coder`, `reviewer`, `fixer`) use the default model unless overridden. No preset agents — you define phases and assign roles via the tool schema. Per-phase overrides are available via `modelTier` and `model` fields.

## Credits

100% vibe-coded with deepseek-v4-pro, doubao-seed-2.1-pro, and doubao-seed-2.1-turbo. Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Code implementation patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Agent team workflow approach inspired by Claude Code. Thank you to all these projects for their excellent work.

## License

[MIT](LICENSE)
