# pi-swarm

Agent Swarm extension for pi-coding-agent. Run 1-20 subagents in parallel from a shared prompt template, with optional mailbox mode for inter-agent communication and non-blocking coordinator mode for multi-turn orchestration.

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

### Agent Profiles

Four built-in profiles control agent capabilities:

| Profile   | Write Files | Bash Write | Model        | Use Case                              |
| --------- | ----------- | ---------- | ------------ | ------------------------------------- |
| `general` | Yes         | Yes        | Inherit      | Default. Full access for implementation |
| `explore` | No          | No         | Small        | Codebase exploration, file finding     |
| `plan`    | No          | No         | Inherit      | Architecture design, implementation plans |
| `review`  | No          | No         | Inherit      | Code review with severity levels       |

The `explore`, `plan`, and `review` profiles restrict agents to read-only operations. Profile selection affects tool availability, model routing, system prompt, and output format.

**Custom profiles** can be defined in `.pi/settings.json` (project or global):

```json
{
  "pi-swarm": {
    "maxConcurrency": 8,
    "smallModel": "deepseek/deepseek-v4-flash",
    "subagents": {
      "security-auditor": {
        "description": "Security-focused code reviewer",
        "allowWrite": false,
        "allowBashWrite": false,
        "model": "inherit",
        "outputFormat": "structured",
        "systemPrompt": "You are a security auditor. Focus on OWASP Top 10, injection attacks, and auth bypasses."
      }
    }
  }
}
```

### Coordinator Mode — non-blocking swarm

```
Launch subagents to review 3 modules — use SwarmCoordinator
```

Unlike the blocking `Swarm` tool, `SwarmCoordinator` returns immediately with a `runId`. The main agent stays active and can orchestrate agents across conversation turns:

- `SendMessage(runId, agentName, message)` — send instructions to a running agent
- `TaskStop(runId, agentName)` — stop an individual agent
- `SwarmStatus()` — check progress and results of active runs

Agents continue running in the background across turns until they complete or are stopped. Use this when you need to launch agents and then react to their progress or give them additional instructions while they work.

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
    "smallModel": "deepseek/deepseek-v4-flash",
    "subagents": {}
  }
}
```

| Setting          | Default   | Description                                              |
| ---------------- | --------- | -------------------------------------------------------- |
| `maxConcurrency` | 5         | Max parallel subagents                                   |
| `smallModel`     | (inherit) | Lightweight model for explore profile and simple tasks   |
| `subagents`      | (none)    | User-defined custom agent profiles (name → config map)   |

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
