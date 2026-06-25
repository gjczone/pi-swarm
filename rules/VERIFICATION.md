# Verification Rules

## Overview

Verification rules for pi-swarm. Every change MUST pass through these gates before commit, push, merge, or release.

## Verification Principles

1. **Verify Early**: Run typecheck after every code change; do not batch.
2. **Verify Often**: Run `npm test` after every logic change; do not wait until the end.
3. **Verify Everything**: No code path is exempt -- tools, commands, TUI, state, shared utilities all get verified.
4. **Verify Automate**: Use `npm run ci` for the full pipeline; do not run steps manually when automation exists.
5. **Verify Completely**: A passing typecheck alone is not enough; tests, build, and dist verification must all pass.

## Verification Types

| Type | Purpose | When | How |
|------|---------|------|-----|
| **Type Check** | Catch type errors early | Every code change | `npm run typecheck` |
| **Unit Tests** | Validate individual modules | Every logic change | `npm test` |
| **Build** | Ensure compilation succeeds | Every change | `npm run build` |
| **Dist Verify** | Confirm output artifacts exist | Every build | `test -f dist/index.js && test -f dist/index.d.ts` |
| **Format Check** | Enforce consistent style | Before commit | `npx prettier --check "src/**/*.ts" "tests/**/*.ts"` |
| **Integration Smoke** | Verify extension loads in Pi | Before merge | `pi -p "/swarm on"` |
| **E2E Tool Call** | Verify AgentSwarm returns valid XML | Before release | Pi session with AgentSwarm call |
| **Concurrency Smoke** | Verify ramp-up behavior | Before release | Multi-item AgentSwarm run with concurrency cap |
| **Full CI Pipeline** | End-to-end validation | Before push | `npm run ci` |

## Verification Workflow

### Pre-Commit Verification

NEVER skip these before any commit.

```bash
# Type check -- must pass with zero errors
npm run typecheck

# Unit tests -- must pass 107 tests, 0 failures across 8 test files
npm test

# Format check
npx prettier --check "src/**/*.ts" "tests/**/*.ts"
```

### Pre-Push Verification

NEVER skip these before pushing to remote.

```bash
# Full CI pipeline: typecheck + test + build + dist verify
npm run ci

# Verify dist output
test -f dist/index.js && test -f dist/index.d.ts && echo "OK" || echo "FAIL"

# Module count check -- must have >= 19 compiled modules
test $(find dist -name "*.js" | wc -l) -ge 19 && echo "OK" || echo "FAIL: too few modules"
```

### Pre-Merge Verification

NEVER skip these before merging a PR.

```bash
# Full CI pipeline
npm run ci

# Pi integration smoke test (skip if Pi CLI not installed)
ln -sf "$(pwd)/dist" ~/.pi/agent/extensions/pi-swarm
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

### Pre-Release Verification

NEVER skip these before creating a release.

```bash
# Full CI pipeline
npm run ci

# Integration smoke test
ln -sf "$(pwd)/dist" ~/.pi/agent/extensions/pi-swarm
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"

# E2E tool call -- AgentSwarm must return valid <agent_swarm_result> XML
pi -p "Use AgentSwarm to check two files: src/index.ts and package.json" 2>&1 | grep -E "(agent_swarm_result|Extension error)"

# Concurrency smoke test -- verify ramp-up with capped concurrency
PI_SWARM_MAX_CONCURRENCY=3 pi -p "Use AgentSwarm with items: a,b,c,d,e and prompt_template 'Process {{item}}'" 2>&1
```

## Current Project Evidence

These are the verified baseline metrics. Any regression below these values is a failure.

| Metric | Baseline | Command |
|--------|----------|---------|
| Type errors | 0 | `npm run typecheck` |
| Test files | 8 | `npm test` |
| Tests passed | 107 | `npm test` |
| Tests failed | 0 | `npm test` |
| Tests skipped | 0 | `npm test` |
| Build output | `dist/index.js` + `dist/index.d.ts` | `npm run build` |
| Compiled modules | >= 19 | `find dist -name "*.js" | wc -l` |
| Concurrency strategy | 5 + 1/700ms ramp-up | Manual smoke test |
| TUI animation | Braille progress bars at 80ms | Visual verification |
| Output format | `<agent_swarm_result>` XML | E2E tool call |
| LOCAL_CI steps | 12 | Reference `LOCAL_CI.md` |

## Verification Checklist

### Code Quality

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npx prettier --check` passes with no differences
- [ ] No empty catch blocks -- every error branch handles or propagates
- [ ] All code comments, JSDoc, strings in English
- [ ] No emoji or decorative Unicode in source files
- [ ] Layer boundaries respected: `tui/` + `state/` do not import from `swarm/` or `team/`; `shared/` has zero pi or tui imports

### Testing

- [ ] `npm test` passes -- 107 tests, 0 failures, 0 skipped
- [ ] No flaky tests (same result on 3 consecutive runs)
- [ ] New code has corresponding test coverage
- [ ] Tests cover both happy path and error paths

### Build Artifacts

- [ ] `npm run build` succeeds with exit code 0
- [ ] `dist/index.js` exists and is non-empty
- [ ] `dist/index.d.ts` exists and is non-empty
- [ ] Module count >= 19

### Integration

- [ ] Extension loads in Pi without "Extension error"
- [ ] AgentSwarm tool returns valid `<agent_swarm_result>` XML
- [ ] `/swarm on` activates swarm mode
- [ ] `/swarm off` deactivates swarm mode
- [ ] TUI progress renders with live braille animation
- [ ] Concurrency ramp-up follows 5 + 1/700ms strategy

### Documentation

- [ ] `PLAN.md` updated if architecture, API, or module specs changed
- [ ] `docs/architecture.md` updated if design rationale changed
- [ ] `README.md` updated if user-facing features changed
- [ ] `CHANGELOG.md` updated with version entry for releases
- [ ] `AGENTS.md` updated if new module/tool/command/hook/data flow was added
- [ ] `LLM-REVIEW-GUIDE.md` LOC count, test count, file lists match current code

## Verification Commands Reference

```bash
# Single step commands
npm run typecheck          # TypeScript type checking (tsc --noEmit)
npm test                   # Run all tests (vitest)
npm run build              # Compile TS to dist/
npx prettier --check "src/**/*.ts" "tests/**/*.ts"  # Format check
npx prettier --write "src/**/*.ts" "tests/**/*.ts"   # Auto-fix formatting

# Multi-step pipelines
npm run ci                 # typecheck + test + build + dist verify

# Quick all-at-once (steps 1, 2, 4, 5, 6 from LOCAL_CI.md)
npm install && npm run typecheck && npm test && npm run build && test -f dist/index.js && test -f dist/index.d.ts

# Artifacts check
test -f dist/index.js && test -f dist/index.d.ts && echo "OK" || echo "FAIL"
test $(find dist -name "*.js" | wc -l) -ge 19 && echo "OK" || echo "FAIL"

# Symlink for Pi integration testing
ln -sf "$(pwd)/dist" ~/.pi/agent/extensions/pi-swarm
```

## Verification Anti-Patterns

| Anti-Pattern | Detection | Fix |
|--------------|-----------|-----|
| Commit without typecheck | Commit precedes `npm run typecheck` | Always typecheck first |
| Push without CI | Push precedes `npm run ci` | Always run full CI before push |
| Skip test on "trivial" change | No test run for small edits | Every change gets tested |
| Ignore failing test | Comment out or skip failing test | Fix the root cause |
| Build then skip dist check | `npm run build` without verifying artifacts | Always check `dist/index.js` and `dist/index.d.ts` exist |
| Manual-only verification | No CI automation, manual checks only | Use `npm run ci` |
| Stale baseline | Metrics drift without updating this file | Update baseline when intentional |
| Layer violation undetected | `tui/` or `state/` imports `swarm/` or `team/` | Typecheck catches this; enforce in review |
