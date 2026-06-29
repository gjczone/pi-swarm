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
