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

### File-based Agent Definitions

For agent configurations that are self-documenting, shareable, and easy to manage, create `.md` files in `~/.pi/agents/` (user-global) or `.pi/agents/` (project-scoped).

Each `.md` file defines one named agent — reference it with `agentType` in Swarm/Coordinator calls.

#### Quick Example

Save this as `~/.pi/agents/rust-audit.md`:

```markdown
---
name: rust-audit
description: Rust code audit specialist with memory safety analysis
allowWrite: false
allowBashWrite: false
model: small
outputFormat: structured
disallowedTools:
  - Swarm
  - SwarmCoordinator
---

You are a Rust code audit specialist operating in READ-ONLY mode.

Focus on:
- Memory safety issues (unsafe blocks, raw pointers, lifetime violations)
- Concurrency bugs (Send/Sync, data races, deadlocks)
- Unsafe code blocks — verify each one has a proper safety comment
- Common crate misuse

## REQUIRED OUTPUT FORMAT

Scope: <one-sentence summary>
Findings:
  - [P0/P1/P2/P3] <file:line> — <description>
  (P0=memory safety, P1=likely bug, P2=should fix, P3=style/nit)
```

Then use it in any swarm call:

```
agentType: "rust-audit"
```

#### Reference

| Frontmatter key    | Required | Type             | Description |
|--------------------|----------|------------------|-------------|
| `name`             | Yes*     | string           | Agent name. Defaults to filename if omitted. |
| `description`      | Yes      | string           | One-line purpose. Shown in agent list and tool descriptions. |
| `allowWrite`       | No       | boolean          | Whether agent can use edit/write tools. Default: `true`. |
| `allowBashWrite`   | No       | boolean          | Whether agent can run write-mode bash commands. Default: `true`. |
| `model`            | No       | string           | Model routing: `"small"` (auto-resolve), or explicit `"provider/modelId"`. Omit to inherit. |
| `outputFormat`     | No       | `"free"` or `"structured"` | Agent output format. Default: `"free"`. |
| `tools`            | No       | string[]         | **Explicit tool allowlist.** When set, ONLY these tools are available to the agent. |
| `disallowedTools`  | No       | string[]         | **Tool denylist.** Subtracts from the resolved tool set. |

The Markdown **body** (after `---`) becomes the agent's **system prompt**.

#### Tool Permission Model

pi-swarm runs on pi-coding-agent, which has a dynamic tool set varying by installation (community extensions, MCP servers, user-installed tools). The permission model uses three layers:

| Layer | Mechanism | When to use |
|-------|-----------|-------------|
| **Capability flags** | `allowWrite`, `allowBashWrite` | **Default/recommended.** Works on any pi installation regardless of installed tools. |
| **Tool allowlist** | `tools: [read, bash]` | Power users who know their exact tool inventory. When set, **only** listed tools are available. |
| **Tool denylist** | `disallowedTools: [Swarm]` | Power users who want to block specific tools (e.g. prevent subagents from spawning sub-sub-agents). |

**Resolution order**:
1. If `tools` allowlist is set → use that exact list (capability flags still filter native tools)
2. If `disallowedTools` is set → start from capability-derived tool set, subtract disallowed items
3. If neither → use capability flags only
4. `allowWrite: false` always removes `edit` and `write` from the resolved set
5. `allowBashWrite: false` keeps `bash` but instructs read-only via system prompt (recommended to add a read-only rule to the prompt body as well)

**Tool names** are pi tool identifiers as registered with `pi.registerTool()`. Common native tools include: `read`, `edit`, `bash`, `write`, `search`, `think`, `web_fetch`, `batch_web_fetch`, `agent_browser`, `mcp`, `workflow`. pi-swarm registers: `Swarm`, `SwarmCoordinator`, `SendMessage`, `TaskStop`, `SwarmStatus`. The exact set varies by installation — capability flags are the portable choice.

#### Resolution Priority

When the same agent name exists in multiple locations, the first match wins:

```
1. .pi/agents/<name>.md       ← Project-scoped (highest priority)
2. ~/.pi/agents/<name>.md     ← User-global
3. pi-swarm.subagents in settings.json  ← Settings-defined
4. Built-in profiles           ← explore, plan, general, review
5. Fallback: general
```

#### `agentType` vs `profile`

Both parameters go through the same `resolveProfile()` function. The `profile` parameter accepts built-in names (`"explore"`, `"plan"`, `"general"`, `"review"`) and settings.json custom profiles. The `agentType` parameter accepts file-based agent names. They are **mutually exclusive** — use one or the other, not both.

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
