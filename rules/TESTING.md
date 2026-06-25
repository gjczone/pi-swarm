# Testing Rules

## Principles

1. **Test Early**: Write tests before or alongside code (TDD when possible)
2. **Test Often**: Run `npm test` frequently during development
3. **Test Everything**: Test all code paths, including error paths
4. **Test Independently**: Tests should not depend on each other
5. **Test Fast**: Tests should complete in under 10 seconds

## Test Framework

- **Framework**: vitest 4.x
- **Runner**: `npm test` (runs `vitest run`)
- **Type check**: `npm run typecheck` (runs `tsc --noEmit`) -- minimum verification gate
- **Full CI**: `npm run ci` (typecheck + test + build + dist verify)

## Test Files

| File                       | Tests | Scope                                      |
| -------------------------- | ----- | ------------------------------------------ |
| `controller.test.ts`       | 8     | Concurrency controller (ramp-up, rate-limit, abort) |
| `keyword-mode.test.ts`     | 10    | Swarm mode keyword detection               |
| `render.test.ts`           | 7     | XML result rendering                       |
| `smoke.test.ts`            | 31    | Persistence, recovery, state management    |
| `swarm-tool.test.ts`       | 12    | AgentSwarm tool registration and execution |
| `task-graph.test.ts`       | 11    | Phase dependency graph (DAG)               |
| `team-dashboard.test.ts`   | 15    | TUI team dashboard rendering               |
| `tui-truncation.test.ts`   | 13    | TUI text truncation                        |
| **Total**                  | **107** | **8 test files, 0 failures, 0 skipped** |

## Test Structure

### Test File Organization

```
tests/
├── controller.test.ts        # Matches module under test
├── smoke.test.ts             # Integration/smoke tests
├── render.test.ts            # Output format tests
└── ...
```

### Test Naming

```typescript
// WRONG: test('works')
// RIGHT: test('handles rate-limit errors by retrying')
// RIGHT: test('respects max concurrency cap')
```

### Test Organization

```typescript
describe('SubagentBatchController', () => {
  describe('concurrency', () => {
    test('respects max concurrency cap', () => { ... });
  });
  describe('rate-limiting', () => {
    test('handles rate-limit errors by retrying', () => { ... });
  });
});
```

## Test Patterns

### AAA Pattern (Arrange, Act, Assert)

```typescript
test('respects max concurrency cap', async () => {
  // Arrange
  const controller = new SubagentBatchController({ maxConcurrency: 2 });
  const tasks = createTasks(5);

  // Act
  await controller.run(tasks);

  // Assert
  expect(controller.activeCount).toBeLessThanOrEqual(2);
});
```

### Mock Strategy

- Use mocks for the `SubagentBatchLauncher` interface to test controller behavior
- Mock external dependencies (pi CLI, file system) when testing pure logic
- Use real implementations for integration/smoke tests

```typescript
const mockLauncher: SubagentBatchLauncher = {
  spawn: vi.fn().mockResolvedValue({ agentId: 'test-1', handle: mockHandle }),
  resume: vi.fn().mockResolvedValue({ agentId: 'test-1', handle: mockHandle }),
  retry: vi.fn().mockResolvedValue({ agentId: 'test-1', handle: mockHandle }),
};
```

## Test Coverage

### Coverage Requirements

| Coverage Type    | Minimum |
| ---------------- | ------- |
| Critical paths   | 100%    |
| Error handling   | 100%    |
| Happy path       | 90%     |

### Critical Code Requiring Full Coverage

- `shared/controller.ts` -- concurrency control, rate-limit handling, abort
- `shared/spawner.ts` -- process spawning, timeout, cleanup
- `state/persistence.ts` -- atomic writes, crash safety
- `team/mailbox.ts` -- message delivery, acknowledgment

## Verification

- **Type correctness**: Run `npm run typecheck` after every change
- **All tests pass**: `npm test` -- 107 tests across 8 test files
- **Integration**: Symlink `dist/` into `~/.pi/agent/extensions/pi-swarm` and verify tool calls
- **Concurrency**: Test with 2-3 items first, then scale to 10+ to verify concurrency behavior

## Anti-Patterns

| Anti-Pattern       | Detection                        | Fix                              |
| ------------------ | -------------------------------- | -------------------------------- |
| Flaky tests        | Tests that pass/fail randomly    | Fix root cause (race conditions) |
| Slow tests         | Tests > 5 seconds                | Optimize or split                |
| Brittle tests      | Tests break with unrelated changes | Write flexible assertions      |
| Test interdependence | Tests depend on execution order | Make tests independent           |
| Happy-path only    | No error case tests              | Add error path tests             |
