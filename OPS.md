# OPS.md

Release operations checklist for pi-swarm. Run through EVERY step in order when publishing a new version.

## Prerequisites

- All code changes merged to `master`
- Working directory clean (`git status` shows no uncommitted changes)
- LOCAL_CI passed (all steps)
- GitHub CLI (`gh`) authenticated
- npm account with publish access (`NPM_TOKEN` set in repo secrets)

## Release Checklist

### 1. Documentation Sync

- [ ] `CHANGELOG.md` — add `## [X.Y.Z] - YYYY-MM-DD` section at top with all changes since last tag
- [ ] `README.md` — update if features, env vars, or usage changed
- [ ] `AGENTS.md` — update if new modules, tools, or commands added
- [ ] `PLAN.md` — mark completed phases
- [ ] `docs/architecture.md` — update if design changed

### 2. Version Bump

```bash
npm version patch   # or minor, major
```

This updates `package.json`, creates a git tag `vX.Y.Z`, and commits.

### 3. Local CI

```bash
npm run ci
```

Must pass: typecheck → 55 tests → build → dist verified.

### 4. Push

```bash
git push origin master --tags
```

### 5. Create GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "$(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d')"
```

This auto-extracts the current version section from CHANGELOG.md as release notes.
Creating a Release triggers the `publish.yml` workflow → npm publish.

### 6. Verify npm Publish

Wait ~30s for Actions to complete, then:

```bash
npm view pi-swarm version    # should match X.Y.Z
npm view pi-swarm dist-tags  # should show 'latest': 'X.Y.Z'
```

### 7. Verify Pi Install

```bash
pi install npm:pi-swarm@latest
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK".

### 8. Git Clean State

```bash
git status   # working directory clean, on master
```

### 9. Update GitHub About

```bash
gh repo edit \
  --description "Agent Swarm & Team orchestration for pi-coding-agent. Dual-mode: parallel swarm + collaborative teams with mailbox. Ported from kimi-code." \
  --website "https://www.npmjs.com/package/pi-swarm" \
  --add-topic "pi-package,pi-coding-agent,agent-swarm,multi-agent,subagent,parallel,team,swarm"
```

### 10. Self-Improvement

- [ ] Did any step deviate from this checklist? → Update OPS.md.
- [ ] Did any companion `.md` file go stale? → Update it.
- [ ] Did LOCAL_CI miss a regression? → Add a check.

## Quick Reference

```bash
# Full release in one go (after docs synced):
npm version patch
npm run ci
git push origin master --tags
gh release create v$(node -p "require('./package.json').version") \
  --title "v$(node -p "require('./package.json').version")" \
  --notes "$(sed -n '/^## \['$(node -p "require('./package.json').version")'\]/,/^## \[/p' CHANGELOG.md | sed '$d')"
# Wait for Actions, then verify:
npm view pi-swarm version
```
