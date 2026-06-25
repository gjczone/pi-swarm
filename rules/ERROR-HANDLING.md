# Error Handling Rules

## Principles

1. Every `catch` branch MUST either handle the error with a log or propagate it
2. Empty catch blocks are forbidden
3. Log: what operation failed, the input context, and the original error message

## Error Handling Patterns

### Catch Blocks

```typescript
// WRONG: empty catch block
try {
  await riskyOperation();
} catch (e) {
  // nothing
}

// WRONG: silent catch
try {
  await riskyOperation();
} catch (e) {
  return defaultValue;
}

// CORRECT: log and handle
try {
  await riskyOperation();
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[pi-swarm] riskyOperation failed: ${err.message}`, { context });
  throw err;
}

// CORRECT: log and return fallback
try {
  await riskyOperation();
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[pi-swarm] riskyOperation failed, using fallback: ${err.message}`);
  return fallbackValue;
}
```

### Once-Guard Pattern

Used in `spawner.ts` to prevent duplicate resolution when abort and process exit race:

```typescript
const resolveOnce = (value: T) => {
  if (done) return;
  done = true;
  resolve(value);
};

const rejectOnce = (err: Error) => {
  if (done) return;
  done = true;
  reject(err);
};
```

### Abort Handling

```typescript
// Track abort reason to distinguish timeout from user cancellation
let abortReason: "timeout" | "user-cancel" | undefined;

handle.onAbort((reason) => {
  abortReason = reason;
  cleanup();
  rejectOnce(new Error(`Aborted: ${reason}`));
});
```

## Error Propagation

- Errors should be propagated up the call stack unless they can be meaningfully handled at the current level
- Use typed errors where possible (Error subclass or discriminated union)
- Never swallow errors from child processes -- log and propagate

## Process Error Handling

### Child Process Errors

```typescript
proc.on("error", (err) => {
  console.error(`[pi-swarm] Process error for ${agentId}: ${err.message}`);
  rejectOnce(err);
});

proc.on("close", (code) => {
  if (code !== 0) {
    console.error(`[pi-swarm] Process exited with code ${code} for ${agentId}`);
  }
  resolveOnce(output);
});
```

### Timeout Handling

```typescript
const timer = setTimeout(() => {
  console.error(`[pi-swarm] Timeout after ${timeoutMs}ms for ${agentId}`);
  proc.kill("SIGTERM");
  // SIGKILL fallback after 5s grace period
  killTimer = setTimeout(() => {
    if (!exited) {
      proc.kill("SIGKILL");
    }
  }, 5000);
}, timeoutMs);
```

## Anti-Patterns

| Anti-Pattern           | Detection                       | Fix                                    |
| ---------------------- | ------------------------------- | -------------------------------------- |
| Empty catch block      | `catch (e) {}`                  | Log error and handle or propagate      |
| Silent error           | Catch without log               | Add console.error with context         |
| Swallowed promise      | `.catch(() => {})`             | Log or propagate                       |
| Generic error message  | `throw new Error("error")`     | Include specific context               |
| Missing cleanup        | Error without resource cleanup  | Use try/finally for cleanup            |
