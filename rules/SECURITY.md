# Security Rules

## Security Concerns

This project is a CLI extension, not a web application. Security concerns are limited to:

### Path Traversal

Agent IDs are used to construct file paths for state directories. Unvalidated IDs could escape the intended directory via `..` or path separators.

**Mitigation**:
- `validateId()` -- regex sanitization for all agent IDs
- `resolveAgentStateDir()` -- path containment check after resolution
- Applied in `spawnSubagent`, `resumeSubagent`, and `createAgentSwarmSpecs`

```typescript
// REQUIRED: validate all agent IDs before using as path components
function validateId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
```

### Child Process Spawning

The extension spawns child processes via `pi --print`. This is inherent to the design and cannot be avoided.

**Mitigation**:
- No user-supplied arguments are passed directly to the shell
- Commands are constructed from trusted internal values
- SIGTERM + SIGKILL fallback for zombie process prevention

### File System Access

The extension reads and writes files under `.pi/swarm/state/` for state persistence.

**Mitigation**:
- `writeAtomic` (temp-file + rename) for crash-safe writes
- Path containment checks via `resolveAgentStateDir`
- No access outside the project's `.pi/` directory

## What This Project Does NOT Have

- No authentication or authorization
- No secrets or encryption
- No user input sanitization (beyond agent ID validation)
- No HTTP endpoints
- No database connections
- No environment variable secrets

## Rules

- NEVER skip path validation for agent IDs
- NEVER construct file paths from untrusted input without validation
- NEVER pass user-supplied arguments directly to child process spawn
- NEVER store sensitive data in state files (tokens, API keys, passwords)
