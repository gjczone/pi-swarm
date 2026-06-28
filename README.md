# pi-swarm

Agent Swarm & Team extension for pi-coding-agent. Run 1 to 128 parallel subagents or collaborative role-based teams — no preset configuration needed.

## Installation

```bash
pi install npm:@gjczone/pi-swarm@latest
```

## Core Features

| Feature | When to Use | What It Does |
|---------|-------------|--------------|
| **Swarm** | Run the same task across many items in parallel | Spawns 1-20 subagents from an item template. Optional mailbox mode for inter-agent communication. |
| **/swarm** | Trigger a swarm from chat | Shortcut for the Swarm tool. Usage: `/swarm <task>` |
| **/swarm-team** | Trigger a collaborative swarm | Shortcut for Swarm with mailbox enabled. Usage: `/swarm-team <goal>` |
| **Mailbox Mode** | Need agents to share findings | When `mailbox: true`, agents get inbox/outbox and can exchange messages during execution. |
| **Worktree Isolation** | Parallel agents modifying the same repo | Each subagent runs in a temporary git worktree. Changes commit to named branches for safe merging. Non-git repos fall back to regular directories. |
| **Live TUI Progress** | Monitor running swarms | Braille progress bars, grid layout, scrolling model output. Single-agent compact mode. |
| **Rate-Limit Retry** | Avoid API quota exhaustion | Auto-suspends on rate-limit errors and retries with exponential backoff (3s, 6s, 12s...). |
| **Crash Recovery** | Survive unexpected termination | Durable file-based state. Resume incomplete runs automatically. Completed runs auto-clean after 7 days. |

## Usage Examples

### Swarm — parallel or collaborative

```
Review every file in src/ for bugs — use a swarm
```

```
Run a security audit on these five packages in parallel: auth, api, db, cache, middleware
```

```
Implement user login with JWT — use a swarm with mailbox so agents can collaborate
```

```
Add Redis caching — explore first, then implement based on findings
```

### Cancel mid-run

Press `Ctrl+C` during a swarm run. Completed agents are preserved, in-progress agents are cancelled gracefully.

## Settings

Default max concurrency is **5**. Adjust in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "pi-swarm": {
    "maxConcurrency": 8
  }
}
```

Configure a lightweight model for simple/exploratory subagent tasks. The LLM reads this setting and passes `model` explicitly when appropriate:

```json
{
  "pi-swarm": {
    "smallModel": "deepseek/deepseek-v4-flash"
  }
}
```

When to use small model: exploration, straightforward execution, tasks with clear instructions.
When NOT to use: review, planning, complex analysis, architecture decisions.

## Supported Platforms

| Platform | Status |
|----------|--------|
| pi-coding-agent | Required runtime |
| Node.js >= 18 | Required |
| Linux / macOS / Windows | Supported |

## Credits

Architecture references [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Team communication patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Agent team workflow approach inspired by Claude Code.

## License

[MIT](LICENSE)


