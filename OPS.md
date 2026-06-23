# OPS.md

Release operations checklist for pi-swarm. Run through EVERY step in order when publishing a new version.

## Prerequisites

- All code changes merged to `main`
- Working directory clean (`git status` shows no uncommitted changes)
- Local CI passed (all steps in `LOCAL_CI.md`)
- GitHub CLI (`gh`) authenticated

## Phase 1: Documentation Sync

Before bumping the version, ensure ALL documentation is up to date with the changes in this release.

### 1.0 General .md Sync Check

- [ ] Scan ALL changed files in this release and cross-check against the .md file list below
- [ ] If new tool/command/hook added: update PLAN.md, AGENTS.md, README.md
- [ ] If concurrency parameters changed: update README.md env var table
- [ ] If API contracts changed: update PLAN.md section 5

### 1.1 CHANGELOG.md

- [ ] Add `## [X.Y.Z] - YYYY-MM-DD` section at the TOP
- [ ] Include subsections: Features, Bug Fixes, Refactoring, Documentation
- [ ] Reference issue/PR numbers for each entry
- [ ] Generate from ALL commits since last version tag: `git log vPREV..HEAD --oneline --reverse`

### 1.2 README.md

- [ ] Update feature list if features added/removed/changed
- [ ] Update install instructions if changed
- [ ] Update env var table if concurrency settings changed
- [ ] Verify credit section still present and accurate

### 1.3 AGENTS.md

- [ ] Update Architecture tree if new files were added/removed
- [ ] Update Change Map if development workflows changed
- [ ] Update Key Design Decisions table if decisions changed

### 1.4 PLAN.md

- [ ] Update module specs if APIs changed
- [ ] Update implementation phases (mark completed phases)

## Phase 2: Version Bump & Build

### 2.1 Version Bump

```bash
npm version patch   # or minor, major
```

This updates `package.json` and creates a git tag.

### 2.2 Build

```bash
npm run build
```

### 2.3 Verify Version Consistency

```bash
echo "package.json: $(node -p 'require("./package.json").version')"
git tag -l "v*" | tail -1
```

Both should show the same version.

## Phase 3: Local CI (Full Run)

Run ALL steps from `LOCAL_CI.md`:

```bash
npm install && npm run typecheck && npm run build && test -f dist/index.js && test -f dist/index.d.ts && echo "CI PASS" || echo "CI FAIL"
```

Every step must pass before proceeding.

## Phase 4: Git & GitHub

### 4.1 Push Changes

```bash
git push origin main --tags
```

### 4.2 Create GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "$(sed -n '/^## \[X.Y.Z\]/,/^## \[/p' CHANGELOG.md | head -n -1)"
```

If `CHANGELOG.md` doesn't exist yet, write release notes manually.

## Phase 5: npm Publish

### 5.1 Publish to npm

```bash
npm publish
```

**Pass**: package published without errors.

### 5.2 Verify npm Registry

```bash
npm view pi-swarm version
```

**Pass**: output matches the released version.

## Phase 6: Post-Release Verification

### 6.1 Global Install

```bash
npm install -g pi-swarm@latest
```

**Pass**: installs the new version without errors.

### 6.2 Pi Extension

```bash
pi install npm:pi-swarm@latest
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK".

## Phase 7: Cleanup

### 7.1 Git Clean State

```bash
git status
git branch
```

**Pass**: on `main` branch, working directory clean.

## Phase 8: Self-Improvement Retrospective

After every release, review the OPS process itself and ALL companion .md files for staleness.

| File          | Check                                                   |
| ------------- | ------------------------------------------------------- |
| `CHANGELOG.md`| New version section exists and is complete              |
| `README.md`   | Feature list, install commands, env vars match code     |
| `AGENTS.md`   | Architecture tree, design decisions match code          |
| `PLAN.md`     | Module specs, API contracts match current code          |
| `LOCAL_CI.md` | All CI steps still valid                                |
| `OPS.md`      | This file — were any steps missing or wrong?            |

- [ ] Were there any manual steps NOT documented in OPS.md? → Add them now.
- [ ] Did any companion file go stale? → Add a check to Phase 1.0.
- [ ] Did any Pass criteria fail to catch a real problem? → Strengthen the criteria.
- [ ] Were there any "I forgot to do X" moments? → Add a checklist item.

**Rule**: If you fixed something during this release that OPS.md didn't cover, commit the OPS.md update in the same release.

## Release Checklist (Summary)

```
[ ] 1.  CHANGELOG.md updated with new version entry
[ ] 2.  README.md synced
[ ] 3.  AGENTS.md synced (architecture, change map, design decisions)
[ ] 4.  PLAN.md synced (module specs, API contracts)
[ ] 5.  npm version bump executed
[ ] 6.  Build successful
[ ] 7.  Version consistent across surfaces
[ ] 8.  Local CI passed
[ ] 9.  Git push origin main --tags
[ ] 10. GitHub Release created
[ ] 11. npm publish successful
[ ] 12. npm registry shows correct version
[ ] 13. Global install verified
[ ] 14. Pi extension smoke-tested
[ ] 15. Git clean state confirmed
[ ] 16. Self-improvement retrospective completed
[ ] 17. All companion .md files audited for staleness
```
