# Logging Rules

## Logging Strategy

This project uses `console.log`, `console.error`, and `console.warn` for logging. There is no structured logger (no winston, pino, or similar). Logs go to stderr for pi CLI integration.

## Log Prefix

All logs from the extension use `[pi-swarm]` as a prefix for easy identification:

```typescript
console.log("[pi-swarm] Starting agent swarm run");
console.error("[pi-swarm] Process error for agent-1: timeout");
console.warn("[pi-swarm] Rate limit detected, suspending");
```

## Log Levels

| Level   | Usage                                             | Example                                    |
| ------- | ------------------------------------------------- | ------------------------------------------ |
| `log`   | Normal operation events                           | Run started, agent completed, phase done   |
| `error` | Errors that need attention                        | Process crash, timeout, invalid state      |
| `warn`  | Recoverable issues                                | Rate limit hit, stale run detected         |

## What to Log

### Always Log

- Process spawn/resume/retry events
- Process exit codes (non-zero)
- Timeout events
- Rate limit detections
- Crash recovery actions
- Stale run detection

### Never Log

- Sensitive data (tokens, API keys, passwords)
- Full agent output (use output.log file instead)
- High-frequency events in tight loops

## Logging in Error Handlers

Every catch block MUST log the error with context:

```typescript
// GOOD: logs what failed, the input, and the error
catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[pi-swarm] Failed to write manifest for run ${runId}: ${err.message}`);
  throw err;
}

// BAD: no log
catch (e) {
  throw e;
}
```

## Tool Output Rules

Tool output text returned to the LLM must be minimal, structured, and free of noise:

- No emoji, no decorative Unicode, no ANSI escape codes
- No "friendly" filler phrases -- be direct and factual
- Consistent heading hierarchy
- Numerical data in tables or key-value pairs, not prose
- Truncation explicitly flagged
- No trailing whitespace, no excessive blank lines
