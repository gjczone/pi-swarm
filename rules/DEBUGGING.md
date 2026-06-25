# Debugging Rules

## Principles

1. **Reproduce First**: Always reproduce the bug before fixing
2. **Isolate**: Isolate the problem to the smallest possible scope
3. **Verify**: Verify the fix works and doesn't break other things
4. **Document**: Document the bug and the fix
5. **Prevent**: Add tests to prevent regression

## Debugging Workflow

### 1. Read LOCAL_CI.md First

Before investigating any test failure, read `LOCAL_CI.md` for the exact reproduction commands.

### 2. Build Before Debugging

`npm run build` must succeed before any runtime debugging -- run it after every code change.

```bash
npm run build
```

### 3. Reproduce the Bug

```bash
# For test failures
npm test -- --reporter=verbose 2>&1 | grep -A 20 "FAIL"

# For type errors
npm run typecheck 2>&1
```

### 4. Isolate the Problem

- Check the failing test output for the specific assertion that failed
- Read the test file to understand what it's testing
- Read the source file under test to find the root cause

## Debugging Artifacts

### Event Log

Check `events.jsonl` under `.pi/swarm/state/runs/{runId}/` for the append-only event log of a failed run.

```bash
cat .pi/swarm/state/runs/<runId>/events.jsonl | jq .
```

### Per-Agent Status

Inspect per-agent status at `.pi/swarm/state/runs/{runId}/agents/{agentId}/status.json`.

```bash
cat .pi/swarm/state/runs/<runId>/agents/<agentId>/status.json | jq .
```

### Per-Agent Output Log

Full agent session output (header, raw stdout, footer) is written to `output.log` in the agent state directory.

```bash
cat .pi/swarm/state/runs/<runId>/agents/<agentId>/output.log
```

### Crash Recovery

`state/recovery.ts` detects stale runs (30min no heartbeat) on session start and marks them abandoned.

```bash
# Check for stale runs
ls .pi/swarm/state/runs/ | while read runId; do
  cat .pi/swarm/state/runs/$runId/manifest.json | jq '.status'
done
```

## Common Bug Categories

### Concurrency Bugs

- Check `controller.test.ts` for existing concurrency test patterns
- Look for race conditions in `spawner.ts` (resolveOnce/rejectOnce helpers)
- Verify abort handling doesn't lose results or deliver duplicates

### Process Management Bugs

- Check `spawner.ts` for zombie process issues (SIGKILL fallback after 5s grace)
- Verify `cleanup()` properly removes listeners and timeouts
- Check `exited` flag usage (not `proc.killed` which is unreliable)

### State Persistence Bugs

- Verify `writeAtomic` (temp-file + rename) is used for all JSON/JSONL mutations
- Check for partial write scenarios on crash
- Verify `resolveAgentStateDir` path containment check

### Mailbox Bugs

- Check message acknowledgment in `ackTaskMessages`
- Verify `delivery.json` state tracking
- Look for cross-phase message leakage

## Anti-Patterns

| Anti-Pattern           | Detection                          | Fix                               |
| ---------------------- | ---------------------------------- | --------------------------------- |
| Fix without reproduce  | Skipping reproduction              | Always reproduce first            |
| Fixing symptoms        | Patching output without root cause | Find and fix root cause           |
| No regression test     | Fix without test                   | Add test that catches the bug     |
| Console.log debugging  | Leaving debug logs in code         | Remove after debugging            |
| Guessing               | Assuming the problem               | Read the code and logs first      |
