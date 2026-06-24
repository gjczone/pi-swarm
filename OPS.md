# OPS.md

Release operations checklist for pi-swarm.

## Prerequisites

- All changes merged to `master`, working directory clean
- `LOCAL_CI.md` passed (all steps)
- `gh` CLI authenticated
- `NPM_TOKEN` set in repo Secrets → Actions

---

## Phase 1: Documentation Sync

Before bumping the version, cross-check all changed files against companion files:

- Language count changed → update README, AGENTS, etc.
- New tool/hook/command added → update AGENTS tables, PLAN.md.
- Project description/philosophy changed → update README intro.

Per-file checklist:

- [ ] `CHANGELOG.md` — new version section at top with all changes since last tag
- [ ] `README.md` — install instructions, usage examples, settings, runtime files correct
- [ ] `AGENTS.md` — architecture tree, change map, tool/hook/command tables match current code
- [ ] `PLAN.md` — completed phases marked, new designs reflected
- [ ] `docs/architecture.md` — design changes, data flows reflected
- [ ] `LOCAL_CI.md` — test count, steps, dist module count match current state
- [ ] `LLM-REVIEW-GUIDE.md` — LOC count, test count, file lists, tier assignments match current code
- [ ] `OPS.md` — this file, no stale steps

**Pass**: every changed file has been cross-checked against relevant companion files. No companion file documents a feature or count that no longer matches the code.

---

## Phase 2: Version Bump & Build

```bash
npm version patch   # or minor / major
```

Updates `package.json`, creates git tag, commits.

Update CHANGELOG: change `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`.

```bash
git add CHANGELOG.md && git commit -m "release: vX.Y.Z"
```

**Pass**: version is consistent across `package.json` and git tag. Build succeeds. Tests pass.

---

## Phase 3: Local CI

Reference `LOCAL_CI.md`. Run ALL steps. **NEVER** proceed to Phase 4 if any step fails.

```bash
npm run ci
```

**Pass**: typecheck → 55 tests → build → dist verified. All green, 0 failures.

---

## Phase 4: Push & GitHub Release

```bash
git push origin master --tags
```

Release notes MUST be auto-extracted from the current version's CHANGELOG section:

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "$(sed -n '/^## \[X\.Y\.Z\]/,/^## \[/p' CHANGELOG.md | sed '$d')"
```

**Pass**: release notes contain "Added", "Changed" sections from CHANGELOG — verified by running `gh release view vX.Y.Z` and inspecting the output. A release whose notes consist only of a CHANGELOG reference is a failing release.

---

## Phase 5: Post-Release Verification

### 5.1 npm Registry

Wait ~30s for Actions publish:

```bash
npm view @gjczone/pi-swarm version     # must match X.Y.Z
npm view @gjczone/pi-swarm dist-tags   # must show 'latest': 'X.Y.Z'
```

### 5.2 Pi Install

```bash
pi install npm:@gjczone/pi-swarm@latest
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

### 5.3 GitHub Release Page

```bash
gh release view vX.Y.Z
```

**Pass**: registry version matches, install succeeds, smoke test passes, release page populated. **NEVER** mark this phase complete from the publish command alone — the registry must be queried independently.

---

## Phase 6: Cleanup

```bash
git branch -r | grep -E "(feature|fix)/"  # list temporary branches
git push origin --delete <branch>          # delete each
git status                                 # clean, on master
```

**Pass**: no temporary branches remaining on remote. On master branch. Working directory clean.

---

## Phase 7: Self-Improvement Retrospective

**NEVER** skip this phase. If you fixed something during this release that OPS.md didn't cover, commit the OPS.md update in the same release — deferral is forbidden.

### 7.1 Companion File Audit

For each file, ask: **"Did this release change anything that this file documents?"** If yes, update it now — **NEVER** defer.

| File | Check |
|------|-------|
| `CHANGELOG.md` | New version section exists and is complete |
| `README.md` | Feature descriptions, install commands, settings match code |
| `AGENTS.md` | Architecture tree, tool/command tables, version number |
| `PLAN.md` | Completed phases marked, new designs reflected |
| `LOCAL_CI.md` | All CI steps still valid, test count correct |
| `OPS.md` | This file — any steps missing, wrong order, or weak Pass criteria? |
| `LLM-REVIEW-GUIDE.md` | (if exists) Review rules, risk tiers, and sanity checks still accurate |
| `docs/architecture.md` | (if exists) Design rationale, data flows, comparisons |
| `api.d.ts` | (if exists) All API endpoints match current implementation |

**Pass**: every file in the table above has been opened and checked. Any file that documents something changed in this release has been updated.

### 7.2 Process Retrospective

Answer each question. **NEVER** leave a "yes" answer without acting on it in the same release.

- Were there manual steps NOT documented in OPS.md? → Add them now.
- Did any companion file go stale and only get caught late? → Add a check to Phase 1.
- Did any Pass criteria fail to catch a real problem? → Strengthen the criteria now.
- Did any automation miss something? → Fix the automation now.
- Were there "I forgot to do X" moments? → Add a checklist item now.

**Pass**: all "yes" answers have been resolved with a concrete change committed in this release. No open items deferred.

---

## Release Checklist (Summary)

1. [ ] Documentation sync completed — all companion files cross-checked (Phase 1)
2. [ ] Each companion file verified against this release's changes (Phase 1)
3. [ ] Version bump + build succeeded — version consistent across all surfaces (Phase 2)
4. [ ] Local CI passed — 0 failures (Phase 3)
5. [ ] Release published — notes verified via `gh release view`, not just from publish command (Phase 4)
6. [ ] Post-release verification passed — registry queried, install tested, smoke test run (Phase 5)
7. [ ] Temporary branches deleted — `git branch -r` shows no feature/fix branches (Phase 6)
8. [ ] On main branch, working directory clean (Phase 6)
9. [ ] Companion file audit completed — every file in table opened and checked (Phase 7.1)
10. [ ] Process retrospective completed — all "yes" answers resolved and committed (Phase 7.2)

## Quick Release

```bash
# After docs synced and Phase 1 passed:
V=$(npm version patch | sed 's/^v//')
npm run ci
git push origin master --tags
gh release create "v$V" --title "v$V" \
  --notes "$(sed -n '/^## \['$V'\]/,/^## \[/p' CHANGELOG.md | sed '$d')"
sleep 30
npm view @gjczone/pi-swarm version
```
