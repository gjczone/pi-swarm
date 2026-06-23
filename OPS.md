# OPS.md

Release operations checklist for pi-swarm.

## Prerequisites

- All changes merged to `master`, working directory clean
- `LOCAL_CI.md` passed (all steps)
- `gh` CLI authenticated
- `NPM_TOKEN` set in repo Secrets → Actions

## Release Steps

### 1. Documentation Audit

Check and update these files before every release:

- [ ] `README.md` — install instructions, usage examples, settings, runtime files correct
- [ ] `CHANGELOG.md` — new version section at top with all changes since last tag
- [ ] `AGENTS.md` — architecture tree, change map match current code
- [ ] `PLAN.md` — completed phases marked
- [ ] `docs/architecture.md` — design changes reflected
- [ ] `LOCAL_CI.md` — test count, steps match current state
- [ ] `OPS.md` — this file, no stale steps

### 2. Version Bump

```bash
npm version patch   # or minor / major
```

Updates `package.json`, creates git tag, commits.

### 3. Local CI

```bash
npm run ci
```

Must pass: typecheck → 54 tests → build → dist verified.

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

Creates the Release + auto-triggers `publish.yml` → npm publish.

### 6. Verify npm Publish

Wait ~30s for Actions:

```bash
npm view @gjczone/pi-swarm version     # must match X.Y.Z
npm view @gjczone/pi-swarm dist-tags   # must show 'latest': 'X.Y.Z'
```

### 7. Verify Pi Install

```bash
pi install npm:@gjczone/pi-swarm@latest
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

### 8. Verify GitHub Release Page

```bash
gh release view vX.Y.Z
```

Check: release notes populated from CHANGELOG, not empty or default.

### 9. Git Clean State

```bash
git status   # clean, on master
```

### 10. Retrospective

- [ ] Any step deviate from this checklist? → Update OPS.md
- [ ] Any doc go stale? → Update it
- [ ] LOCAL_CI miss a regression? → Add a check

## Quick Release

```bash
# After docs synced:
V=$(npm version patch | sed 's/^v//')
npm run ci
git push origin master --tags
gh release create "v$V" --title "v$V" \
  --notes "$(sed -n '/^## \['$V'\]/,/^## \[/p' CHANGELOG.md | sed '$d')"
sleep 30
npm view @gjczone/pi-swarm version
```

## Release Page Content

The GitHub Release page is auto-populated from `CHANGELOG.md`. Always update CHANGELOG **before** creating the release. The `sed` command extracts the current version section — ensure the version header format is exactly `## [X.Y.Z] - YYYY-MM-DD`.

## GitHub About

If project description, topics, or homepage change:

```bash
gh repo edit \
  --description "..." \
  --homepage "https://www.npmjs.com/package/@gjczone/pi-swarm" \
  --add-topic "topic-name"
```
