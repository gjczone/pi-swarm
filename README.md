# pi-swarm

Agent Swarm extension for pi-coding-agent. Run 1-20 subagents in parallel from a shared prompt template, with optional mailbox mode for inter-agent communication.

## Installation

```bash
pi install npm:@gjczone/pi-swarm@latest
```

## Quick Start

### Swarm — parallel execution

```
Review every file in src/ for bugs — use a swarm
```

Or trigger from chat: `/swarm <task>`

The LLM calls the `Swarm` tool, spawning one subagent per item. Each runs in an isolated git worktree with live TUI progress.

### Collaborative execution (mailbox mode)

```
Implement user login with JWT — use a swarm with mailbox so agents can collaborate
```

Or trigger from chat: `/swarm-team <goal>`

When `mailbox: true`, agents exchange messages during execution via shared inbox/outbox files. The spawner polls outboxes and delivers messages to recipient inboxes in real time.

### Cancel mid-run

Press `Ctrl+C`. Completed agents are preserved; in-progress agents are cancelled gracefully.

## Settings

Default max concurrency: **5**. Adjust in `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "pi-swarm": {
    "maxConcurrency": 8,
    "smallModel": "deepseek/deepseek-v4-flash"
  }
}
```

| Setting          | Default   | Description                                    |
| ---------------- | --------- | ---------------------------------------------- |
| `maxConcurrency` | 5         | Max parallel subagents                         |
| `smallModel`     | (inherit) | Lightweight model for simple/exploratory tasks |

## Supported Platforms

| Platform                | Status           |
| ----------------------- | ---------------- |
| pi-coding-agent         | Required runtime |
| Node.js >= 18           | Required         |
| Linux / macOS / Windows | Supported        |

## Credits

Architecture references [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code). Team communication patterns inspired by [pi-crew](https://github.com/baphuongna/pi-crew). Agent team workflow approach inspired by Claude Code.

## License

[MIT](LICENSE)
