/**
 * shared/gitignore — auto-manage .gitignore entries for pi-swarm state.
 *
 * Ensures `.pi/swarm/state/` is listed in the project's `.gitignore` so
 * durable runtime state is never committed. Only operates when the project
 * is an actual git repository (#110): creating .gitignore in non-git
 * directories is unwanted side-effect pollution.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isGitRepository } from "./worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITIGNORE_ENTRY = ".pi/swarm/state/";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure `.pi/swarm/state/` is listed in the project's `.gitignore`.
 *
 * Behavior:
 *   - If cwd is not a git repository: do nothing (#110).
 *   - If `.gitignore` exists and contains the entry: no-op.
 *   - If `.gitignore` exists but lacks the entry: append it.
 *   - If no `.gitignore` exists (and no other `*ignore` file): create one.
 *
 * All filesystem errors are swallowed (best-effort, non-fatal).
 */
export function ensureGitignore(cwd: string): void {
  // #110: Never manage .gitignore outside of a git repository.
  if (!isGitRepository(cwd)) {
    return;
  }

  const gitignorePath = findGitignore(cwd);
  if (!gitignorePath) {
    // No gitignore file exists — create one
    try {
      fs.writeFileSync(
        path.join(cwd, ".gitignore"),
        `${GITIGNORE_ENTRY}\n`,
        "utf-8",
      );
    } catch {
      // Best effort
    }
    return;
  }

  try {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.includes(GITIGNORE_ENTRY)) return; // Already present

    // Append with a leading newline if the file doesn't end with one
    const separator = content.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(
      gitignorePath,
      `${separator}${GITIGNORE_ENTRY}\n`,
      "utf-8",
    );
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the project's gitignore file.
 * Checks `.gitignore` first, then returns null if only non-standard `*ignore`
 * files exist (e.g. `.dockerignore`) — those must not be polluted.
 */
function findGitignore(cwd: string): string | null {
  // Standard .gitignore
  const standard = path.join(cwd, ".gitignore");
  if (fs.existsSync(standard)) return standard;

  // Check for any other *ignore file (but prefer .gitignore)
  try {
    const entries = fs.readdirSync(cwd);
    for (const entry of entries) {
      if (entry.endsWith("ignore") && entry !== ".gitignore") {
        // Found a non-standard ignore file — use .gitignore instead (don't pollute others)
        return null;
      }
    }
  } catch {
    // Can't read directory
  }

  return null;
}
