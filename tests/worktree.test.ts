/**
 * tests/worktree.test.ts — integration tests for worktree cleanup.
 *
 * Covers:
 *   #109 — cleanupWorktree preserves uncommitted changes when staging fails
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { createWorktree, cleanupWorktree } from "../src/shared/worktree.js";

let tmpRepo: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10000 })
    .toString()
    .trim();
}

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-wt-"));
  git(["init"], tmpRepo);
  git(["config", "user.email", "test@test.com"], tmpRepo);
  git(["config", "user.name", "Test"], tmpRepo);
  fs.writeFileSync(path.join(tmpRepo, "README.md"), "init");
  git(["add", "README.md"], tmpRepo);
  git(["commit", "-m", "init"], tmpRepo);
});

afterEach(() => {
  // Clean up worktrees and tmp repo
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: tmpRepo,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    // best effort
  }
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

describe("#109 cleanupWorktree preserves uncommitted changes on staging failure", () => {
  it("preserves the worktree and reports hasChanges when git add fails", () => {
    const worktree = createWorktree(tmpRepo, "test-109", undefined);
    expect(worktree).toBeDefined();
    const wt = worktree!;

    // Create an uncommitted change in the worktree
    fs.writeFileSync(path.join(wt.path, "new-file.txt"), "important data");

    // Block `git add` by creating a stale index.lock in the worktree's git dir.
    // git status --porcelain can still read the index; only writes (git add) are blocked.
    const gitDir = git(["rev-parse", "--git-dir"], wt.path);
    const indexLock = path.isAbsolute(gitDir)
      ? path.join(gitDir, "index.lock")
      : path.join(wt.path, gitDir, "index.lock");
    fs.writeFileSync(indexLock, "");

    const result = cleanupWorktree(tmpRepo, wt, "test agent #109");

    // The worktree must be preserved (not destroyed) because there are uncommitted changes.
    expect(result.hasChanges).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(true);
    // The uncommitted file must still be there.
    expect(fs.existsSync(path.join(wt.path, "new-file.txt"))).toBe(true);

    // Clean up the preserved worktree.
    try {
      fs.rmSync(wt.path, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("removes the worktree when there are no changes", () => {
    const worktree = createWorktree(tmpRepo, "test-clean", undefined);
    expect(worktree).toBeDefined();
    const wt = worktree!;

    const result = cleanupWorktree(tmpRepo, wt, "clean agent");
    expect(result.hasChanges).toBe(false);
    expect(fs.existsSync(wt.path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #129 — cleanupWorktree treats gitignored untracked files as "has changes"
// ---------------------------------------------------------------------------

describe("#129 cleanupWorktree preserves gitignored untracked files", () => {
  it("preserves the worktree when the only artifact is gitignored (e.g. dist/)", () => {
    // #129: an agent may produce files that match .gitignore patterns
    // (build artifacts, logs, caches). git status --porcelain returns empty
    // for these, so the empty-status branch fires and removeWorktree()
    // deletes the entire worktree directory — destroying the agent's work.
    // The fix: a shallow scan of the worktree root for any non-.git entry
    // marks the worktree as having content worth preserving.
    const worktree = createWorktree(tmpRepo, "test-129", undefined);
    expect(worktree).toBeDefined();
    const wt = worktree!;

    // Create a tracked .gitignore that matches dist/, then commit it so
    // git status does not flag it as untracked.
    fs.writeFileSync(path.join(wt.path, ".gitignore"), "dist/\n");
    git(["add", ".gitignore"], wt.path);
    git(["commit", "-m", "add gitignore"], wt.path);
    // Create a gitignored artifact (the kind of file agents typically produce)
    const distDir = path.join(wt.path, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "artifact.txt"), "important data");

    // git status --porcelain should be empty (the file is gitignored)
    const statusOutput = git(["status", "--porcelain"], wt.path);
    expect(statusOutput).toBe("");

    // cleanupWorktree must preserve the worktree (not destroy it) because
    // there is user-generated content, even though git considers the
    // working tree clean.
    const result = cleanupWorktree(tmpRepo, wt, "test agent #129");
    expect(result.hasChanges).toBe(true);
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(fs.existsSync(path.join(distDir, "artifact.txt"))).toBe(true);

    // Clean up the preserved worktree.
    try {
      fs.rmSync(wt.path, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("still removes the worktree when truly empty (only .git present)", () => {
    const worktree = createWorktree(tmpRepo, "test-129-clean", undefined);
    expect(worktree).toBeDefined();
    const wt = worktree!;

    const result = cleanupWorktree(tmpRepo, wt, "empty agent");
    expect(result.hasChanges).toBe(false);
    expect(fs.existsSync(wt.path)).toBe(false);
  });
});
