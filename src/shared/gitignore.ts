/**
 * shared/gitignore — auto-manage .pi/.gitignore entries for pi-swarm state.
 *
 * Ensures `swarm/state/` is listed in `.pi/.gitignore` so durable
 * runtime state is never committed. Only operates when the project is an
 * actual git repository (#110) and only writes to `.pi/.gitignore`
 * (#123) — never the project-root `.gitignore`, which would be an
 * unwanted side effect in projects that opt out of gitignore.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isGitRepository } from "./worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PI_GITIGNORE_PATH = ".pi/.gitignore";
const GITIGNORE_ENTRY = "swarm/state/";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure `swarm/state/` (relative to `.pi/`) is listed in `.pi/.gitignore`.
 *
 * Behavior (#123):
 *   - If cwd is not a git repository: do nothing (#110).
 *   - If `.pi/.gitignore` exists and contains the entry: no-op.
 *   - If `.pi/.gitignore` exists but lacks the entry: append it.
 *   - If `.pi/.gitignore` does not exist: create it inside `.pi/`.
 *
 * Never writes to the project-root `.gitignore`. Every filesystem
 * error is surfaced via `console.error` (AGENTS.md §0 Quality Gates).
 */
export function ensureGitignore(cwd: string): void {
  if (!isGitRepository(cwd)) {
    return;
  }

  const targetPath = path.join(cwd, PI_GITIGNORE_PATH);
  const targetDir = path.dirname(targetPath);

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    let content = "";
    try {
      content = fs.readFileSync(targetPath, "utf-8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.error(
          `[pi-swarm] ensureGitignore: failed to read ${targetPath}: ${(err as Error).message}`,
        );
        return;
      }
    }

    if (content.includes(GITIGNORE_ENTRY)) return;

    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(
      targetPath,
      `${content}${separator}${GITIGNORE_ENTRY}\n`,
      "utf-8",
    );
  } catch (err) {
    console.error(
      `[pi-swarm] ensureGitignore: failed to update ${targetPath}: ${(err as Error).message}`,
    );
  }
}
