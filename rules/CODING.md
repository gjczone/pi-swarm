# Coding Rules

## Principles

1. **Readability**: Code should be easy to read and understand
2. **Maintainability**: Code should be easy to modify and extend
3. **Testability**: Code should be easy to test
4. **Simplicity**: Code should be as simple as possible
5. **Consistency**: Code should follow consistent patterns

## Naming Conventions

| Element     | Convention       | Example                                    |
| ----------- | ---------------- | ------------------------------------------ |
| Variable    | camelCase        | `agentId`, `maxConcurrency`                |
| Constant    | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`, `SMALL_MODEL_ROLES`     |
| Function    | camelCase        | `spawnSubagent`, `resolveAgentStateDir`    |
| Class       | PascalCase       | `SubagentBatchController`                  |
| Interface   | PascalCase       | `SubagentBatchLauncher`, `SubagentHandle`  |
| Type        | PascalCase       | `SwarmSpec`, `SubagentResult`, `ModelTier` |
| File        | kebab-case       | `team-dashboard.ts`, `task-graph.ts`       |
| Directory   | kebab-case       | `shared/`, `tui/`                          |

## Code Structure

### Function Rules

- NEVER write a function that does more than one thing. If the name needs "and" to describe its purpose, split it.
- This rule applies only to new or modified functions within the task scope.
- NEVER proactively refactor existing functions on this basis.

```typescript
// WRONG: function does two things
function validateAndSave(id: string, data: unknown) { ... }

// RIGHT: separate concerns
function validateId(id: string): void { ... }
function saveData(data: unknown): void { ... }
```

### File Boundaries

- One file = one business concept.
- Any file with a generic name (`utils`, `helpers`, `common`, `misc`) that spans multiple unrelated domains is a boundary violation -- regardless of line count.
- When a file directly touched by the task contains 2+ unrelated domains, extract each into its own file.
- NEVER create a module file that only re-exports another module's symbols -- inline the imports at call sites instead.

### Layer Boundaries

```
tui/ + state/ -> swarm/ + team/ -> shared/ -> index.ts
```

- `shared/` has zero pi or tui imports -- pure logic and Node.js stdlib
- `tui/` and `state/` MUST NOT import from `swarm/` or `team/`
- `swarm/` and `team/` compose shared primitives and register pi tools/commands
- `index.ts` wires everything together

### Import Organization

```typescript
// Standard library imports
import { join } from "node:path";

// Third-party imports
import { Type } from "typebox";

// Local imports
import { writeAtomic } from "../state/persistence.js";
```

## Error Handling

```typescript
// NEVER use empty catch blocks
// WRONG: catch (e) {}
// RIGHT: handle or log error

// NEVER swallow errors silently
// WRONG: catch (e) { /* ignore */ }
// RIGHT: throw or log error with context

// Every catch block MUST either handle the error with a log or propagate it
// Log: what operation failed, the input context, and the original error message
```

## Comments

- Comments must explain: business purpose, implementation logic, and edge cases.
- Use English for all code comments and JSDoc.
- Explain WHY, not WHAT.

```typescript
// GOOD: // Resolve the agent state directory with path containment check
//       // to prevent directory traversal via ".." or path separators
function resolveAgentStateDir(agentId: string): string { ... }

// BAD:  // Get the directory
function resolveAgentStateDir(agentId: string): string { ... }
```

## Code Quality

### DRY (Don't Repeat Yourself)

- NEVER duplicate shared business rules, cache keys, or classification logic across multiple locations.

### KISS (Keep It Simple, Stupid)

- When the requested approach is heavier than necessary, propose a simpler path.

### YAGNI (You Aren't Gonna Need It)

- NEVER add features for future use unless explicitly requested.

## Anti-Patterns

| Anti-Pattern      | Detection                   | Fix                             |
| ----------------- | --------------------------- | ------------------------------- |
| Magic numbers     | Hardcoded numbers           | Extract to constants            |
| Long functions    | Functions doing multiple things | Split into focused functions |
| Deep nesting      | Nesting > 3 levels          | Extract to functions            |
| Global variables  | Global state                | Use dependency injection        |
| Tight coupling    | High dependencies           | Use interfaces                  |
| Code duplication  | Duplicate code              | Extract to shared functions     |
| Dead code         | Unused code                 | Remove dead code                |
| Empty catch blocks | `catch (e) {}`             | Log or propagate error          |
