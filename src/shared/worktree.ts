/**
 * worktree - Git worktree isolation for subagents.
 *
 * Creates a temporary git worktree so an agent works on an isolated copy of the repo.
 * On completion:
 *   - If no changes: worktree is removed.
 *   - If changes exist: committed to a new branch, worktree is removed.
 *   - The caller is responsible for merging the branch back (see mergeBranch).
 *
 * Safety:
 *   - Non-git repos silently fall back to cwd (no worktree created).
 *   - Symbolic links to node_modules are created to avoid reinstalling dependencies.
 *   - Each worktree is created from HEAD in detached mode; changes are committed to a
 *     uniquely-named branch to avoid collisions.
 *
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  originalBranch: string;
  originalHead: string;
  repoCwd: string;
  mailboxLinkCreated?: boolean;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;
  commitSha?: string;
  error?: string;
}

export interface MergeResult {
  success: boolean;
  branch: string;
  error?: string;
  mergedCommit?: string;
}

/**
 * Detect whether cwd is inside a git repository.
 */
export function isGitRepository(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    // Non-git directory is a normal case — silent fallback. (#185)
    // Only real I/O or permission failures would need logging, but
    // git rev-parse exits non-zero for any non-repo path, making it
    // impossible to distinguish without parsing stderr. Keep silent
    // to avoid noise on every agent spawn in non-git projects.
    return false;
  }
}

/**
 * Get the current branch name or "HEAD" if detached.
 */
function getCurrentBranch(cwd: string): string {
  try {
    const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    return name || "HEAD";
  } catch (err) {
    // Log so git failures are visible. (#185)
    console.error(
      `[pi-swarm] getCurrentBranch: git command failed in ${cwd}: ${(err as Error).message}`,
    );
    return "HEAD";
  }
}

/**
 * Get the current HEAD commit SHA.
 */
function getCurrentHead(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch (err) {
    // Log so git failures are visible. (#185)
    console.error(
      `[pi-swarm] getCurrentHead: git command failed in ${cwd}: ${(err as Error).message}`,
    );
    return "";
  }
}

/**
 * Check if the working directory is clean (no uncommitted changes).
 */
function isWorkingTreeClean(cwd: string): boolean {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    return status.length === 0;
  } catch (err) {
    // Log so git failures are visible. (#185)
    console.error(
      `[pi-swarm] isWorkingTreeClean: git command failed in ${cwd}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * #129: detect any user-produced content in the worktree, including
 * gitignored files (build artifacts, logs, cache). The plain
 * `git status --porcelain` would return empty when an agent writes
 * to a gitignored path (e.g. dist/), causing the empty-status branch
 * to fire and silently destroy the agent's work. The `--ignored`
 * flag surfaces ignored untracked files as `!! path` entries.
 *
 * Returns true if the porcelain output is non-empty.
 */
function hasAnyWorktreeChanges(worktreePath: string): boolean {
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--ignored", "--untracked-files=all"],
      {
        cwd: worktreePath,
        stdio: "pipe",
        timeout: 10000,
      },
    )
      .toString()
      .trim();
    return status.length > 0;
  } catch (err) {
    console.error(
      `[pi-swarm] hasAnyWorktreeChanges: failed to read status for ${worktreePath}: ${(err as Error).message}`,
    );
    // Could not read status — be conservative: assume there are
    // changes and preserve the worktree.
    return true;
  }
}

/**
 * Files/directories to symlink from repo root into worktree for project context.
 * These contain project rules, config, and state that subagents need access to.
 */
const PROJECT_CONTEXT_ENTRIES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".pi",
  ".cursorrules",
  ".cursor",
  "docs",
  "rules",
];

/**
 * Create a temporary worktree for a subagent.
 * Returns undefined if not in a git repo or worktree creation fails.
 *
 * Business: create a temporary git worktree for sub-agents to provide
 * directory isolation. The worktree is created at HEAD (detached) so the
 * main branch is not polluted. Project context files (AGENTS.md, .pi,
 * etc.) and the mailbox directory are symlinked so the sub-agent can
 * access project rules and read/write mailbox messages in real time.
 * The original branch name and HEAD SHA are recorded for later merge.
 */
export function createWorktree(
  cwd: string,
  agentId: string,
  mailboxPath?: string,
): WorktreeInfo | undefined {
  if (!isGitRepository(cwd)) return undefined;

  try {
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch (err) {
    // Log so the caller can trace why worktree creation was skipped. (#185)
    console.error(
      `[pi-swarm] createWorktree: rev-parse HEAD failed in ${cwd}: ${(err as Error).message}`,
    );
    return undefined;
  }

  const originalBranch = getCurrentBranch(cwd);
  const originalHead = getCurrentHead(cwd);
  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });

    // Add local exclude so symlinks don't get committed by git add -A (#192)
    try {
      const gitDir = join(worktreePath, ".git");
      let actualGitDir: string;
      if (existsSync(gitDir)) {
        const gitStat = statSync(gitDir);
        if (gitStat.isDirectory()) {
          actualGitDir = gitDir;
        } else {
          // Worktree: .git is a file containing the path to the actual git dir
          const content = readFileSync(gitDir, "utf-8").trim();
          const prefix = "gitdir: ";
          actualGitDir = content.startsWith(prefix)
            ? content.slice(prefix.length)
            : content;
          // Resolve relative paths
          if (!actualGitDir.startsWith("/")) {
            actualGitDir = join(worktreePath, actualGitDir);
          }
        }
      } else {
        actualGitDir = gitDir;
      }
      const excludeDir = join(actualGitDir, "info");
      mkdirSync(excludeDir, { recursive: true });
      const excludeFile = join(excludeDir, "exclude");
      const excludeEntries = [...PROJECT_CONTEXT_ENTRIES, "node_modules"]
        .map((e) => `/${e}`)
        .join("\n");
      writeFileSync(excludeFile, `\n${excludeEntries}\n`, { flag: "a" });
    } catch (err) {
      console.error(
        `[pi-swarm] createWorktree: failed to write local exclude for ${worktreePath}: ${(err as Error).message}`,
      );
    }

    // Symlink node_modules to avoid reinstalling dependencies in every worktree
    try {
      const nodeModulesSource = join(cwd, "node_modules");
      const nodeModulesTarget = join(worktreePath, "node_modules");
      if (existsSync(nodeModulesSource) && !existsSync(nodeModulesTarget)) {
        symlinkSync(nodeModulesSource, nodeModulesTarget, "dir");
      }
    } catch (err) {
      // node_modules symlink failure is non-fatal but visible. (#185)
      console.error(
        `[pi-swarm] createWorktree: failed to symlink node_modules for ${worktreePath}: ${(err as Error).message}`,
      );
    }

    // Symlink project context files that are not tracked by git
    // (AGENTS.md, .pi config, etc.) so subagents inherit project rules
    let mailboxLinkCreated = false;
    for (const entry of PROJECT_CONTEXT_ENTRIES) {
      const sourcePath = join(cwd, entry);
      const targetPath = join(worktreePath, entry);
      if (!existsSync(sourcePath) || existsSync(targetPath)) continue;
      try {
        const stat = statSync(sourcePath);
        symlinkSync(
          sourcePath,
          targetPath,
          stat.isDirectory() ? "dir" : "file",
        );
      } catch (err) {
        // Per-entry symlink failure is non-fatal but visible (#130)
        console.error(
          `[pi-swarm] createWorktree: failed to symlink ${entry} for ${worktreePath}: ${(err as Error).message}`,
        );
      }
    }

    // Symlink mailbox directory into worktree so subagents can read/write messages in real time
    if (mailboxPath && existsSync(mailboxPath)) {
      const mailboxTarget = join(worktreePath, ".pi", "swarm", "mailbox-link");
      try {
        mkdirSync(dirname(mailboxTarget), { recursive: true });
        if (!existsSync(mailboxTarget)) {
          symlinkSync(mailboxPath, mailboxTarget, "dir");
          mailboxLinkCreated = true;
        }
      } catch (err) {
        // Mailbox link failure is non-fatal but visible (#130)
        console.error(
          `[pi-swarm] createWorktree: failed to symlink mailbox for ${worktreePath}: ${(err as Error).message}`,
        );
      }
    }

    return {
      path: worktreePath,
      branch,
      originalBranch,
      originalHead,
      repoCwd: cwd,
      mailboxLinkCreated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create worktree: ${message}`, { cause: err });
  }
}

/**
 * Clean up the worktree after agent completion.
 *
 * Steps:
 * 1. Check for changes in worktree.
 * 2. If no changes: remove worktree, return { hasChanges: false }.
 * 3. If changes: add + commit to a new branch based on the commit, remove worktree.
 *
 * Note: This function does NOT merge back to the original branch.
 * Call mergeBranch() after all agents in a batch complete for safe merging.
 *
 * Business: clean up the worktree after a sub-agent finishes. If the
 * worktree has changes, commit them to a new branch — do NOT auto-merge.
 * Merges run sequentially after the batch completes to avoid race
 * conditions.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  let hadChanges = false;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    })
      .toString()
      .trim();

    // #129: porcelain-only change detection ignores .gitignore-matched
    // untracked files (build artifacts, logs, cache). If the agent wrote
    // anything — tracked or gitignored — we must preserve the worktree
    // so the user can recover it. hasAnyWorktreeChanges runs
    // `git status --ignored --untracked-files=all` to surface any
    // gitignored content the agent produced.
    if (!status && !hasAnyWorktreeChanges(worktree.path)) {
      removeWorktree(cwd, worktree.path);
      return { hasChanges: false };
    }

    // #109: Track that uncommitted changes exist BEFORE attempting to stage
    // them. If staging or commit fails, the worktree must be preserved so the
    // user can recover the changes manually instead of being silently destroyed.
    hadChanges = true;

    // Stage all changes
    execFileSync("git", ["add", "-A"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    });

    // Commit in worktree
    const safeDesc = agentDescription.slice(0, 200);
    const commitMsg = `pi-agent: ${safeDesc}`;
    execFileSync("git", ["commit", "-m", commitMsg], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    });

    // Get the commit SHA from worktree
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();

    // #203: Create branch pointing to the commit BEFORE removing the worktree.
    // Previously the worktree was removed first, so if branch creation failed
    // the commit became unreachable (orphaned). Creating the branch first
    // ensures the commit is always reachable; if branch creation fails the
    // worktree is preserved for manual recovery.
    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName, commitSha], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (err) {
      // Branch name collision — log and retry with a timestamped name. (#185)
      console.error(
        `[pi-swarm] cleanupWorktree: branch ${branchName} already exists, retrying with timestamp: ${(err as Error).message}`,
      );
      branchName = `${worktree.branch}-${Date.now()}`;
      try {
        execFileSync("git", ["branch", branchName, commitSha], {
          cwd,
          stdio: "pipe",
          timeout: 5000,
        });
      } catch (err2) {
        // Branch creation failed — preserve the worktree for manual recovery
        // instead of orphaning the commit. (#203)
        console.error(
          `[pi-swarm] cleanupWorktree: branch creation failed for ${branchName}: ${(err2 as Error).message}. Worktree preserved at ${worktree.path} for manual recovery.`,
        );
        return { hasChanges: true, commitSha, error: String(err2) };
      }
    }

    // Branch created successfully — now safe to remove the worktree.
    removeWorktree(cwd, worktree.path);

    return { hasChanges: true, branch: branchName };
  } catch (err) {
    // #109: If uncommitted changes were detected, preserve the worktree for
    // manual recovery regardless of whether staging/commit succeeded.
    if (hadChanges) {
      console.error(
        `[pi-swarm] Failed to commit changes for agent: ${err instanceof Error ? err.message : String(err)}. Worktree preserved at ${worktree.path} for manual recovery.`,
      );
      return { hasChanges: true, error: String(err) };
    }
    // #186: Before removing, check if the worktree has any changes (tracked
    // or gitignored). If git status --porcelain failed (hadChanges is false
    // here), hasAnyWorktreeChanges conservatively returns true on error,
    // preserving the worktree for manual recovery instead of destroying
    // the agent's work.
    if (hasAnyWorktreeChanges(worktree.path)) {
      console.error(
        `[pi-swarm] cleanupWorktree: git status failed (${err instanceof Error ? err.message : String(err)}). Worktree has changes — preserving at ${worktree.path} for manual recovery.`,
      );
      return { hasChanges: true, error: String(err) };
    }
    try {
      removeWorktree(cwd, worktree.path);
    } catch (err2) {
      // best effort cleanup — log so failures are visible. (#185)
      console.error(
        `[pi-swarm] cleanupWorktree: removeWorktree failed for ${worktree.path}: ${(err2 as Error).message}`,
      );
    }
    return { hasChanges: false };
  }
}

/**
 * Merge a branch into the current branch.
 * Must be called when the working directory is clean (no parallel agents running).
 * Uses --no-ff --no-edit to create a merge commit preserving history.
 *
 * Business: merge a sub-agent's branch into the current branch. Must be
 * called with a clean working tree (sequentially, after all parallel
 * agents finish). On conflict, return the error and keep the branch for
 * manual resolution.
 */
export function mergeBranch(cwd: string, branchName: string): MergeResult {
  // #203: Stash dirty working directory before merging so multiple sequential
  // merges (e.g. after a parallel swarm) do not all fail on the first dirty
  // state. The stash is restored after the merge attempt, regardless of
  // outcome. When the WD is already clean, no stash is created.
  let stashed = false;
  try {
    if (!isWorkingTreeClean(cwd)) {
      execFileSync("git", ["stash", "push", "-u", "-m", "pi-swarm-merge"], {
        cwd,
        stdio: "pipe",
        timeout: 10000,
      });
      stashed = true;
    }

    // Verify the branch exists
    try {
      execFileSync("git", ["rev-parse", "--verify", branchName], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (err) {
      // Branch not found — return error. Log for traceability. (#185)
      console.error(
        `[pi-swarm] mergeBranch: branch '${branchName}' not found: ${(err as Error).message}`,
      );
      return {
        success: false,
        branch: branchName,
        error: `Branch '${branchName}' not found.`,
      };
    }

    // Check if already merged by seeing if the branch commit is an ancestor of HEAD
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", branchName, "HEAD"], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
      // Already merged; clean up branch
      try {
        execFileSync("git", ["branch", "-d", branchName], {
          cwd,
          stdio: "pipe",
          timeout: 5000,
        });
      } catch (err) {
        // Branch deletion failure is non-fatal but visible (#130)
        console.error(
          `[pi-swarm] mergeBranch: failed to delete already-merged branch ${branchName}: ${(err as Error).message}`,
        );
      }
      return { success: true, branch: branchName };
    } catch {
      // Not yet merged, proceed — merge-base --is-ancestor exits non-zero
      // when the branch is NOT an ancestor, which is the normal case here.
    }

    // Attempt merge with --no-ff --no-edit
    execFileSync("git", ["merge", "--no-ff", "--no-edit", branchName], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });

    // Clean up feature branch after successful merge
    try {
      execFileSync("git", ["branch", "-d", branchName], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (err) {
      // Branch deletion failure is non-fatal but visible. (#185)
      console.error(
        `[pi-swarm] mergeBranch: failed to delete merged branch ${branchName}: ${(err as Error).message}`,
      );
    }

    return { success: true, branch: branchName };
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    // Attempt to abort if a merge is in progress
    try {
      execFileSync("git", ["merge", "--abort"], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (err) {
      // Merge abort may fail if no merge was in progress — log for visibility. (#185)
      console.error(
        `[pi-swarm] mergeBranch: merge --abort failed (may be expected if no merge was in progress): ${(err as Error).message}`,
      );
    }

    if (
      stderr.includes("CONFLICT") ||
      stderr.includes("Automatic merge failed")
    ) {
      return {
        success: false,
        branch: branchName,
        error: `Merge conflicts detected. Resolve manually: git merge ${branchName}`,
      };
    }
    return {
      success: false,
      branch: branchName,
      error: `Auto-merge failed: ${stderr}`,
    };
  } finally {
    // #203: Restore stashed changes so the working directory is returned to
    // its pre-merge state. This allows sequential merges to proceed even
    // when the working directory had uncommitted changes.
    if (stashed) {
      try {
        execFileSync("git", ["stash", "pop"], {
          cwd,
          stdio: "pipe",
          timeout: 10000,
        });
      } catch (err) {
        // Stash pop failure is non-fatal but visible — the user's changes
        // remain in the stash and can be recovered with `git stash pop`.
        console.error(
          `[pi-swarm] mergeBranch: git stash pop failed (changes remain in stash): ${(err as Error).message}`,
        );
      }
    }
  }
}

function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch (err) {
    console.error(
      `[pi-swarm] removeWorktree: failed to remove ${worktreePath}: ${(err as Error).message}. Falling back to prune.`,
    );
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (err) {
      console.error(
        `[pi-swarm] removeWorktree: prune also failed: ${(err as Error).message}`,
      );
    }
  }
}

export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch (err) {
    // best effort — log so failures are visible (#185), except "not a git
    // repository", which is expected whenever pi starts outside a repo.
    const msg = String((err as Error | undefined)?.message ?? err ?? "");
    if (!/not a git repository/i.test(msg)) {
      console.error(
        `[pi-swarm] pruneWorktrees: git worktree prune failed in ${cwd}: ${(err as Error).message}`,
      );
    }
  }
}
