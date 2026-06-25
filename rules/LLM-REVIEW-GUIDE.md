# LLM Review Guide

## Quick Reference

| Metric         | Value                    |
| -------------- | ------------------------ |
| Source files   | 21                       |
| Total LOC      | 7,483                    |
| Test files     | 8                        |
| Total tests    | 107                      |
| Test failures  | 0                        |
| Skipped tests  | 0                        |

## File Inventory

### High-Risk Files (review carefully)

| File                      | LOC  | Risk    | Why                                           |
| ------------------------- | ---- | ------- | --------------------------------------------- |
| `shared/controller.ts`    | 952  | HIGH    | Concurrency control, rate-limit, abort races  |
| `shared/spawner.ts`       | 771  | HIGH    | Process spawning, timeout, zombie prevention  |
| `team/supervisor.ts`      | 879  | HIGH    | Goal decomposition, phase orchestration       |
| `team/tool.ts`            | 615  | MEDIUM  | Tool registration, schema validation          |
| `swarm/tool.ts`           | 585  | MEDIUM  | Tool registration, output.log persistence     |

### Medium-Risk Files

| File                      | LOC  | Risk    | Why                                           |
| ------------------------- | ---- | ------- | --------------------------------------------- |
| `team/mailbox.ts`         | 268  | MEDIUM  | Data integrity, atomic writes                 |
| `team/task-graph.ts`      | 264  | MEDIUM  | DAG validation, dependency resolution         |
| `state/persistence.ts`    | 384  | MEDIUM  | Atomic writes, crash safety                   |
| `state/recovery.ts`       | 217  | MEDIUM  | Stale run detection, cleanup                  |
| `shared/worktree.ts`      | 458  | MEDIUM  | Git worktree management                       |

### Low-Risk Files

| File                      | LOC  | Risk    | Why                                           |
| ------------------------- | ---- | ------- | --------------------------------------------- |
| `tui/progress.ts`         | 358  | LOW     | Display only                                  |
| `tui/team-dashboard.ts`   | 325  | LOW     | Display only                                  |
| `tui/permission-prompt.ts`| 129  | LOW     | Display only                                  |
| `tui/swarm-markers.ts`    | 74   | LOW     | Display only                                  |
| `shared/types.ts`         | 369  | LOW     | Type definitions only                         |
| `shared/render.ts`        | 159  | LOW     | XML formatting                                |
| `shared/pi-invoke.ts`     | 74   | LOW     | CLI helper                                    |
| `swarm/command.ts`        | 147  | LOW     | Command handler                               |
| `swarm/mode.ts`           | 137  | LOW     | State machine                                 |
| `team/command.ts`         | 59   | LOW     | Command handler                               |
| `index.ts`                | 259  | LOW     | Registration wiring                           |

## Review Checklist

### DO NOT REPORT

- Style preferences (indentation, brace placement, naming that matches existing patterns)
- "Should use library X instead" when current implementation works
- Missing JSDoc on internal helper functions
- Test count changes (tests are added/removed with features)

### ALWAYS REPORT

- Empty catch blocks
- Race conditions in concurrent code
- Missing path validation for user-influenced input
- Data loss scenarios (non-atomic writes, missing cleanup)
- Process zombie leaks (missing SIGKILL fallback)
- Cross-layer import violations
- Type safety bypasses (`as any`, `@ts-ignore`)

### Quick Sanity Check

```bash
npm run typecheck  # must pass with 0 errors
npm test           # must pass 107 tests, 0 failures
npm run build      # must produce dist/index.js and dist/index.d.ts
```
