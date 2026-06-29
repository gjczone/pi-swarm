# CODING.md

TypeScript coding rules for pi-swarm.

---

## 1. Layer Boundaries

Layer dependency chain: `tui/` + `state/` → `swarm/` + `team/` → `shared/` → `index.ts`

| Layer      | May import from                                     | Must NOT import from                                                 |
| ---------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `shared/`  | Node.js stdlib (`node:*`)                           | `swarm/`, `team/`, `tui/`, `state/`, `@earendil-works/pi-*` packages |
| `tui/`     | `shared/`, `@earendil-works/pi-tui`                 | `swarm/`, `team/`                                                    |
| `state/`   | `shared/`, Node.js stdlib only                      | `swarm/`, `team/`, `tui/`                                            |
| `swarm/`   | `shared/`, `tui/`, `state/`, `@earendil-works/pi-*` | —                                                                    |
| `team/`    | `shared/`, `tui/`, `state/`, `@earendil-works/pi-*` | —                                                                    |
| `index.ts` | All layers                                          | —                                                                    |

Evidence: `PLAN.md` layer dependency section; confirmed by grep — zero `@earendil-works/pi-tui` imports in `src/shared/`, zero `../swarm/` or `../team/` imports in `src/tui/` or `src/state/`.

`shared/` is pure logic and Node.js stdlib. `tui/` and `state/` are peer layers; neither depends on the other.

---

## 2. Tool & Command Registration

Every tool and command module exports a `register*` function. Registration is wired in `index.ts` default export.

```typescript
// swarm/tool.ts
export function registerAgentSwarmTool(pi: ExtensionAPI): void { ... }

// index.ts
import { registerAgentSwarmTool } from "./swarm/tool.js";
export default function (pi: ExtensionAPI): void {
  registerAgentSwarmTool(pi);
}
```

Evidence: `grep "export function register" src/` → 4 register functions across `swarm/tool.ts`, `team/tool.ts`, `swarm/command.ts`, `team/command.ts`. All called in `src/index.ts`.

---

## 3. Output Format

AgentSwarm tool output MUST use the `<agent_swarm_result>` XML format. Do NOT mix this output with plain text or other shapes — the parent LLM parses the XML structure.

Evidence: `src/shared/render.ts` exports `renderSwarmResults()` building this exact format.

---

## 4. Sub-agent Execution

Sub-agents run as independent `pi --print` child processes producing a JSON Lines event stream. The spawner parses `message_end` and `tool_result_end` events to track progress and accumulate results.

Evidence: `src/shared/spawner.ts` — each subagent runs as an independent `pi --print` child process; parses the JSON Lines event stream.

---

## 5. Naming & Import Conventions

File and directory names: `kebab-case` (e.g., `team-dashboard.ts`, `task-graph.ts`, `pi-invoke.ts`, `swarm-markers.ts`). Evidence: directory listing.

Import order and format:

```typescript
// 1. Node.js builtins (node: prefix)
import * as fs from "node:fs";
import { join } from "node:path";

// 2. Third-party packages
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

// 3. Local modules (relative paths, .js extension)
import { renderSwarmResults } from "../shared/render.js";
import { validateId } from "../state/persistence.js";
```

Evidence: `src/index.ts` lines 12-27; `src/swarm/tool.ts` lines 10-44. All Node.js builtins use the `node:` prefix (18 imports across the codebase).

---

## 6. Tool Output Text

All tool output text returned to the LLM must be minimal, structured, and free of noise:

- No emoji, decorative Unicode, or ANSI escape codes
- No "friendly" filler phrases
- Numerical data in tables or key-value pairs, not prose
- Truncation must be explicitly flagged

Evidence: `AGENTS.md` Project-Specific Rules.

---

## 7. Comments

Code comments and JSDoc are in **English only** (LANGUAGE RULE). Comments must explain business purpose, implementation logic, and edge cases.

Evidence: `AGENTS.md` LANGUAGE RULE; `src/shared/spawner.ts` and `src/shared/render.ts` follow this pattern with business-purpose JSDoc.

---

## Error Handling

### Non-fatal / Best-effort Operations

Operations that are not critical to the primary task (cleanup, recovery, gitignore management) should catch and log without propagating. Mark these clearly with `// Best effort` or `// Non-fatal` comments.

Evidence: `src/index.ts` lines 50-52 (`// Best effort` on gitignore write), 176-178 (`// Non-git repos or worktree prune failures are non-fatal`).
