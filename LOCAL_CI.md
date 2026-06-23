# LOCAL_CI.md

Local CI checklist for pi-swarm. Run ALL checks before committing or merging.

## Prerequisites

- Node.js >= 18
- npm
- Pi CLI (for step 7 only -- skip if not installed)

## Checklist

### 1. Install Dependencies

```bash
npm install
```

**Pass**: "added N packages" or "up to date", exit code 0.
**Common fix**: `rm -rf node_modules && npm install`

### 2. Type Check

```bash
npm run typecheck
```

**Pass**: no output, exit code 0.
**Common fix**: read the TypeScript error, fix the type mismatch, re-run.

### 3. Format Check

```bash
npx prettier --check "src/**/*.ts" "tests/**/*.ts"
```

**Pass**: no output, exit code 0.
**Common fix**: `npx prettier --write "src/**/*.ts" "tests/**/*.ts"`

### 4. Unit Tests

```bash
npm test
```

**Pass**: 54 tests pass, 0 failures across 5 test files.
**Common fix**: read the failing test output, fix the code, re-run.

### 5. Build

```bash
npm run build
```

**Pass**: exit code 0, `dist/index.js` and `dist/index.d.ts` exist.
**Common fix**: fix TypeScript compilation errors, re-run.

### 6. Verify dist Output

```bash
test -f dist/index.js && test -f dist/index.d.ts && echo "OK" || echo "FAIL"
```

**Pass**: prints "OK".
**Common fix**: run `npm run build` first.

### 7. Dist Module Count

```bash
test $(find dist -name "*.js" | wc -l) -ge 17 && echo "OK: $(find dist -name '*.js' | wc -l) modules" || echo "FAIL: too few modules"
```

**Pass**: prints "OK: N modules" with N >= 17.
**Common fix**: new source files not compiled? Check tsconfig.json includes.

### 8. Pi Integration Smoke Test

```bash
# Symlink dist/ to extensions directory
ln -sf "$(pwd)/dist" ~/.pi/agent/extensions/pi-swarm

# Start pi and verify extension loads without errors
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK" (no extension error in output). Swarm mode should activate.
**Common fix**: ensure symlink points to correct `dist/` directory.
**Skip**: if Pi CLI is not installed, skip this step and note it in the completion report.

### 9. Manual Tool Call Verification (E2E)

```bash
# In a pi session, ask the LLM to call AgentSwarm with a simple task
pi -p "Use AgentSwarm to check two files: src/index.ts and package.json - just list what they contain" 2>&1 | grep -E "(agent_swarm_result|Extension error)"
```

**Pass**: output contains `<agent_swarm_result>` and no "Extension error".
**Common fix**: check tool registration in `index.ts`, verify `pi --print` mode works.
**Skip**: requires API key configured; skip if not available.

### 10. Concurrency Smoke Test

```bash
# Test with 5 items to verify ramp-up behavior
PI_SWARM_MAX_CONCURRENCY=3 pi -p "Use AgentSwarm with items: a,b,c,d,e and prompt_template 'Process {{item}}'" 2>&1
```

**Pass**: all 5 sub-agents complete, concurrency capped at 3.
**Skip**: requires API key configured; skip if not available.

### 11. Test Coverage

```bash
npx vitest run --coverage 2>&1 | tail -20
```

**Pass**: coverage report generated with reasonable percentages.
**Skip**: if `@vitest/coverage-v8` is not installed.

### 12. Full CI Pipeline

```bash
npm run ci
```

This runs: `npm run typecheck && npm test && npm run build && test -f dist/index.js && test -f dist/index.d.ts`
**Pass**: exit code 0.

## Quick Run (All at Once)

```bash
npm install && npm run typecheck && npm test && npm run build && test -f dist/index.js && test -f dist/index.d.ts && echo "ALL PASS" || echo "SOME FAILED"
```

This runs steps 1, 2, 4, 5, 6 in order. Run remaining steps (3, 7, 8, 9, 10) manually.
