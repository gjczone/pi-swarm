# API Rules

## Extension API

### Type Imports

Import types from `@earendil-works/pi-coding-agent` runtime package. Use `ExtensionAPI`, `ExtensionContext` -- do not redefine these types.

```typescript
// CORRECT
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// WRONG -- redefining types
interface ExtensionAPI { ... }
```

### Tool Registration

Every tool file exports a `register*(pi: ExtensionAPI)` function. Registration happens in `index.ts` default export.

```typescript
// In swarm/tool.ts or team/tool.ts
export function registerAgentSwarm(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "AgentSwarm",
    description: "...",
    parameters: { ... },
    execute: async (params, context) => { ... },
  });
}

// In index.ts
export default function activate(ctx: ExtensionContext) {
  registerAgentSwarm(ctx.pi);
  registerSwarmTeam(ctx.pi);
  // ...
}
```

### Tool Naming

| Tool         | Module         | Purpose                              |
| ------------ | -------------- | ------------------------------------ |
| `AgentSwarm` | `swarm/tool.ts`  | Parallel item-template agents        |
| `SwarmTeam`  | `team/tool.ts`   | Collaborative role-based team agents |

### Command Registration

Commands use `pi.registerCommand` with `/swarm` and `/swarm-team` prefixes.

| Command       | Module            | Purpose                    |
| ------------- | ----------------- | -------------------------- |
| `/swarm`      | `swarm/command.ts`  | Activate/deactivate swarm mode |
| `/swarm-team` | `team/command.ts`   | Activate team mode         |

### Tool Descriptions

Write clear, specific `description` strings -- these are what the LLM reads to decide when to call.

```typescript
// GOOD: specific about what the tool does and when to use it
description: "Launch multiple subagents from one prompt template. Use when many subagents should run the same kind of task over different inputs."

// BAD: vague description
description: "Run tasks in parallel"
```

## TUI Component API

### Component Interface

TUI components implement `Component` from `@earendil-works/pi-tui`.

```typescript
import type { Component, Container, Text, Spacer } from "@earendil-works/pi-tui";
```

### Widget Registration

Use `setWidget(key, (tui, theme) => component, opts)` -- capture the `tui` reference and pass it to your component so animation timers can call `tui.requestRender()`.

### Render Callbacks

If the component uses `setInterval` for animation, accept a `requestRender` callback and call it on each animation tick so the TUI framework knows to redraw.

## Pi CLI Integration

### Sub-agent Execution

Sub-agents communicate via `pi --print` JSON Lines output. Parse `message_end` and `tool_result_end` events to track progress.

### Schema Validation

Use `typebox` for runtime parameter validation in tool definitions.

```typescript
import { Type } from "typebox";

const schema = Type.Object({
  prompt_template: Type.String(),
  items: Type.Array(Type.String()),
  description: Type.String(),
});
```

## Output Format

- AgentSwarm tool returns `<agent_swarm_result>` XML (compatible with kimi-code)
- SwarmTeam tool returns `<swarm_team_result>` XML
- Never mix output formats
