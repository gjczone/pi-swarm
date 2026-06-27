# pi-swarm

Agent Swarm & Team extension for pi-coding-agent. Run 1 to 128 parallel subagents or collaborative role-based teams — no preset configuration needed.

## Installation

```bash
pi install npm:@gjczone/pi-swarm@latest
```

## Core Features

| Feature | When to Use | What It Does |
|---------|-------------|--------------|
| **AgentSwarm** | Run the same task across many items in parallel | Spawns 1-128 isolated subagents from an item template. Each runs in its own `pi --print` process. |
| **SwarmTeam** | Execute multi-step workflows with specialized roles | Role-based agents (explorer, planner, coder, reviewer, tester) collaborate in phases with a shared mailbox. Each phase receives context from previous phases. |
| **/swarm command** | Trigger a swarm from the chat | Shortcut for the AgentSwarm tool. `on` / `off` to toggle swarm mode. |
| **/swarm-team command** | Trigger a team from the chat | Shortcut for the SwarmTeam tool. |
| **Worktree Isolation** | Parallel agents modifying the same repo | Each subagent runs in a temporary git worktree. Changes commit to named branches for safe merging. Non-git repos fall back to regular directories. |
| **Live TUI Progress** | Monitor long-running swarms or teams | Braille progress bars for swarm agents, phase dashboard for teams. Updates in real time. |
| **Rate-Limit Retry** | Avoid API quota exhaustion | Auto-suspends on rate-limit errors and retries with exponential backoff (3s, 6s, 12s...). |
| **Crash Recovery** | Survive unexpected termination | Durable file-based state. Resume incomplete runs automatically. Completed runs auto-clean after 7 days. |

## Usage Examples

### Swarm — run the same task across many items

```
Review every file in src/ for bugs — use a swarm
```

```
Run a security audit on these five packages in parallel: auth, api, db, cache, middleware
```

### Team — plan, build, and review in phases

```
Implement user login with JWT — use a team with planner, coder, and reviewer
```

```
Add Redis caching — explore the codebase first, then plan, implement, review, test
```

### Resume failed work

If agents fail, the LLM receives `resume_agent_ids` and can retry:

```
Two of the five swarm reviews failed — retry those
```

### Cancel mid-run

Press `Ctrl+C` during a swarm or team run. Completed agents are preserved, in-progress agents are cancelled gracefully.

## Settings

Default max concurrency is **5**. Adjust in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "pi-swarm": {
    "maxConcurrency": 8
  }
}
```

For team mode, configure a lightweight model for exploration roles to reduce costs:

```json
{
  "pi-swarm": {
    "smallModel": "deepseek/deepseek-v4-flash"
  }
}
```

## Supported Platforms

| Platform | Status |
|----------|--------|
| pi-coding-agent | Required runtime |
| Node.js >= 18 | Required |
| Linux / macOS / Windows | Supported |

## Credits

Architecture ported from [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Team communication patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Agent team workflow approach inspired by Claude Code.

## License

[MIT](LICENSE)

## Contributing

Development guide: [AGENTS.md](./AGENTS.md), release: `bash scripts/release.sh`.
