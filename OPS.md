# OPS.md

Release operations checklist for pi-swarm. Run through EVERY step in order when publishing a new version.

## Prerequisites

- All code changes merged to `master`, working directory clean
- `LOCAL_CI.md` passed (all steps)
- `gh` CLI authenticated
- `NPM_TOKEN` set in repo Secrets -> Actions

---

## Phase 1: Documentation Sync

Before bumping the version, cross-check all changed files against companion files.

### 1.0 Discover All .md Files

Identify every companion .md file and cross-reference with changed source code:

```bash
# Discover all .md files in the project (excluding node_modules, dist, .git)
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.git/*" | sort

# List files changed since the last version tag
git diff --name-only v$(node -p 'require("./package.json").version')..HEAD
```

Cross-reference changed source files against the checklist below:

| Source change                      | .md files to check                                                  |
| ---------------------------------- | ------------------------------------------------------------------- |
| `src/shared/types.ts` changed      | `AGENTS.md` (architecture), `PLAN.md`, `docs/architecture.md`       |
| `src/shared/controller.ts` changed | `PLAN.md`, `docs/architecture.md`                                   |
| `src/shared/render.ts` changed     | `PLAN.md`, `AGENTS.md` (architecture)                               |
| `src/swarm/tool.ts` changed        | `AGENTS.md` (tools), `README.md` (usage)                            |
| `src/team/*.ts` changed            | `AGENTS.md` (architecture), `CHANGELOG.md`                          |
| `src/tui/*.ts` changed (new)       | `AGENTS.md` (architecture tree, Change Map), `docs/architecture.md` |
| `src/state/*.ts` changed           | `PLAN.md`, `docs/architecture.md`                                   |
| `package.json` changed             | `README.md` (install)                                               |
| `.github/workflows/` changed       | `LOCAL_CI.md`                                                       |
| Test count/file changed            | `LOCAL_CI.md`, `LLM-REVIEW-GUIDE.md`, `AGENTS.md`                   |
| Release process changed            | `OPS.md` (this file)                                                |
| `scripts/release.sh` changed       | `OPS.md`

### 1.1 CHANGELOG.md

- [ ] Add `## [X.Y.Z] - YYYY-MM-DD` section at the TOP (after header, before older versions)
- [ ] Include subsections: Added, Changed, Fixed, Documentation
- [ ] Reference issue/PR numbers for each entry
- [ ] CRITICAL: generate entries from ALL commits since last tag: `git log vPREV..HEAD --oneline --reverse`

### 1.2 README.md

- [ ] Update feature descriptions if features changed
- [ ] Update install commands if package name/scope changed
- [ ] Update settings/schema if config keys changed
- [ ] Update Runtime Files diagram if directory structure changed

### 1.3 AGENTS.md

- [ ] Update architecture tree if new files were added/removed
- [ ] Update Change Map if new modules created
- [ ] Update test counts (55 -> 67 -> ...)
- [ ] Update tool/command tables if tools or commands changed

### 1.4 PLAN.md

- [ ] Mark completed implementation phases `[x]`
- [ ] Update architecture diagram if layer structure changed
- [ ] Update design decisions if any were revised

### 1.5 docs/architecture.md

- [ ] Update layer architecture diagram if new modules added
- [ ] Update data flow diagrams if integration pattern changed
- [ ] Update TUI Components section if new components added
- [ ] Update design decisions log if decisions changed

### 1.6 LOCAL_CI.md

- [ ] Update test count in Step 4 (90 tests, 8 test files — adjust as needed)
- [ ] Update dist module count minimum in Step 7 (20+ modules)
- [ ] Add new steps if new tooling (linter, formatter, test framework) added

### 1.7 LLM-REVIEW-GUIDE.md

- [ ] Update LOC count, test count, file lists if they changed
- [ ] Update Key Files tables if new files were added/removed
- [ ] Update Quick Sanity Checklist if verification patterns changed

### 1.8 OPS.md (this file)

- [ ] Verify all phases still reflect current workflow
- [ ] Add new steps if the release process evolved

**Pass**: every companion file has been opened and checked. Any file that documents something changed in this release has been updated.

---

## Phase 2: Version Bump & Build

### 2.1 Run Release Script

```bash
./scripts/release.sh patch   # or minor, major
```

This script handles:

- `npm version` bump in `package.json`
- `npm run build` + `npm run ci` (typecheck + test + build + dist verify)
- Git commit + annotated tag `vX.Y.Z`
- Push to `origin master --tags`
- Auto-extract current version section from `CHANGELOG.md` for GitHub Release notes
- `gh release create vX.Y.Z` with CHANGELOG-derived notes (triggers npm publish via GitHub Actions)
- Auto-delete merged remote temporary branches (cleanup after PR merge)
- Wait for npm publish
- Update local Pi extension + global npm install

### 2.2 Commit CHANGELOG.md (if release.sh didn't capture it)

If CHANGELOG.md was updated after the release script ran:

```bash
git add CHANGELOG.md && git commit -m "docs: update CHANGELOG.md for vX.Y.Z"
git push origin master
```

**Pass**: version is consistent across `package.json` and git tag. All CI steps pass. GitHub Release created.

---

## Phase 3: Local CI

Reference `LOCAL_CI.md`. Run ALL steps. NEVER proceed if any step fails.

```bash
npm run ci
```

Plus manual steps from LOCAL_CI.md:

- Format check: `npx prettier --check "src/**/*.ts" "tests/**/*.ts"`
- Dist module count: `test $(find dist -name "*.js" | wc -l) -ge 20`
- Pi integration smoke test (symlink or npm install)

**Pass**: typecheck -> 90 tests -> build -> dist verified. All green, 0 failures. Prettier: zero warnings. Dist: 20+ .js modules.

---

## Phase 4: Push & GitHub Release

```bash
git push origin master --tags
```

Release notes MUST be auto-extracted from CHANGELOG:

```bash
V=X.Y.Z
gh release create "v$V" \
  --title "v$V" \
  --notes "$(sed -n '/^## \['$V'\]/,/^## \[/p' CHANGELOG.md | sed '$d')"
```

**Pass**: release notes contain "Added", "Changed" sections from CHANGELOG. Verified via `gh release view vX.Y.Z` — notes must include actual change descriptions, NOT just a CHANGELOG reference.

---

## Phase 5: Post-Release Verification

### 5.1 Wait for npm Publish

GitHub Actions triggers npm publish on Release creation. Wait 30-60s:

```bash
sleep 30
```

### 5.2 Verify npm Registry

```bash
npm view @gjczone/pi-swarm version     # must match X.Y.Z
npm view @gjczone/pi-swarm dist-tags   # must show 'latest': 'X.Y.Z'
```

**Pass**: registry version matches, latest tag correct.

### 5.3 Update Local npm Install

Update the globally-cached npm package so future `pi install` or `npx` calls use the new version:

```bash
npm install -g @gjczone/pi-swarm@latest --legacy-peer-deps
```

**Pass**: installs without errors.

### 5.4 Update Local Pi Extension

```bash
pi install npm:@gjczone/pi-swarm@latest
```

Then smoke test:

```bash
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK". Extension loads without errors.

### 5.5 Verify All Installations Match

```bash
# Check all surfaces report the same version
echo "npm registry: $(npm view @gjczone/pi-swarm version)"
echo "package.json:  $(node -p 'require("./package.json").version')"
echo "pi extension:  $(cat ~/.pi/agent/npm/node_modules/@gjczone/pi-swarm/package.json 2>/dev/null | grep '"version"' | sed 's/.*"//;s/".*//')"
echo "global npm:    $(npm ls -g @gjczone/pi-swarm 2>/dev/null | grep @gjczone/pi-swarm | sed 's/.*@//;s/ .*//')"
```

**Pass**: all four surfaces report the same version `X.Y.Z`.

### 5.6 E2E Smoke Test

```bash
# Single-agent swarm (verifies AgentSwarm tool + spawner + controller)
pi -p "Use AgentSwarm with prompt_template 'Echo: {{item}}' and items [hello] and description 'smoke test'" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```

**Pass**: prints "OK". No extension errors.

### 5.7 GitHub Release Page

```bash
gh release view vX.Y.Z
```

**Pass**: release page populated with correct notes.

---

## Phase 6: Cleanup

```bash
# Verify no temporary branches remain on remote
git branch -r | grep -E "(feature|fix)/"  # expect empty

# Delete any leftover branches
git push origin --delete <branch>

# Verify local state
git status                                 # clean, on master
git branch                                 # only master
```

**Pass**: no temporary branches remaining on remote. On master branch. Working directory clean.

---

## Phase 7: Self-Improvement Retrospective

NEVER skip this phase. If you fixed something during this release that OPS.md didn't cover, commit the OPS.md update in the same release.

### 7.1 Companion File Audit

For each file in the table below, open it and ask: **"Did this release change anything that this file documents?"** If yes, update it now.

| File                   | Check                                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `CHANGELOG.md`         | New version section exists and is complete                          |
| `README.md`            | Feature descriptions, install commands, settings match code         |
| `AGENTS.md`            | Architecture tree, tool/command tables, test count, version number  |
| `PLAN.md`              | Completed phases marked, new designs reflected                      |
| `docs/architecture.md` | Design rationale, data flows, TUI components                        |
| `LOCAL_CI.md`          | All CI steps still valid, test count correct, dist count correct    |
| `LLM-REVIEW-GUIDE.md`  | Review rules, risk tiers, file lists, sanity checks                 |
| `OPS.md`               | This file -- any steps missing, wrong order, or weak Pass criteria? |

### 7.2 Process Retrospective

Answer each question. NEVER leave a "yes" answer without acting on it in the same release.

- Were there manual steps NOT documented in OPS.md? -> Add them now.
- Did any companion file go stale and only get caught late? -> Add a check to Phase 1.
- Did any Pass criteria fail to catch a real problem? -> Strengthen the criteria now.
- Did any automation miss something? -> Fix the automation now.
- Were there "I forgot to do X" moments? -> Add a checklist item now.

**Pass**: all "yes" answers have been resolved with a concrete change committed in this release. No open items deferred.

---

## Release Checklist (Summary)

1. [ ] Documentation sync completed — all companion files cross-checked (Phase 1)
2. [ ] CHANGELOG.md updated with new version entry (Phase 1.1)
3. [ ] README.md synced (Phase 1.2)
4. [ ] AGENTS.md synced (Phase 1.3)
5. [ ] PLAN.md synced (Phase 1.4)
6. [ ] docs/architecture.md synced (Phase 1.5)
7. [ ] LOCAL_CI.md synced (Phase 1.6)
8. [ ] LLM-REVIEW-GUIDE.md synced (Phase 1.7)
9. [ ] Release script executed successfully (Phase 2.1)
10. [ ] CHANGELOG.md committed if updated after script (Phase 2.2)
11. [ ] Local CI passed — 0 failures (Phase 3)
12. [ ] Release published — notes verified via `gh release view` (Phase 4)
13. [ ] npm registry shows correct version (Phase 5.2)
14. [ ] Local npm install updated and verified (Phase 5.3)
15. [ ] Local Pi extension updated and smoke-tested (Phase 5.4)
16. [ ] All four installation surfaces match (Phase 5.5)
17. [ ] E2E smoke test passed — AgentSwarm tool call succeeds (Phase 5.6)
18. [ ] GitHub release page verified (Phase 5.7)
19. [ ] Temporary branches deleted (Phase 6)
20. [ ] On master branch, working directory clean (Phase 6)
21. [ ] Companion file audit completed (Phase 7.1)
22. [ ] Process retrospective completed (Phase 7.2)

## Quick Release

```bash
# After docs synced and Phase 1 passed:
./scripts/release.sh patch   # or minor / major
# Script handles: bump -> build -> CI -> commit -> tag -> push -> GitHub Release -> npm wait -> local update
```

After the script completes, verify:
```bash
npm view @gjczone/pi-swarm version
pi install npm:@gjczone/pi-swarm@latest
pi -p "/swarm on" 2>&1 | grep -q "Extension error" && echo "FAIL" || echo "OK"
```
