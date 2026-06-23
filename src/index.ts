/**
 * pi-swarm — Agent Swarm extension for pi-coding-agent.
 *
 * Entry point.  Registered as the default export.  Wires together
 * the AgentSwarm tool, /swarm command, swarm-mode state machine,
 * and TUI progress components.
 *
 * Credit: AgentSwarm architecture ported from MoonshotAI/kimi-code.
 * Team/mailbox patterns inspired by pi-crew.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentSwarmTool } from "./swarm/tool.js";
import { registerSwarmCommand, type SwarmCommandHost } from "./swarm/command.js";
import { registerAgentTeamTool } from "./team/tool.js";
import { registerTeamCommand } from "./team/command.js";
import { recoverRuns } from "./state/recovery.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Auto-gitignore
// ---------------------------------------------------------------------------

const GITIGNORE_ENTRY = ".pi/swarm/state/";

/**
 * Ensure `.pi/swarm/state/` is listed in the project's `.gitignore`.
 * Appends the entry if the file exists but doesn't contain it.
 * Creates `.gitignore` if neither `.gitignore` nor any `*ignore` file exists.
 */
function ensureGitignore(cwd: string): void {
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

/**
 * Find the project's gitignore file.
 * Checks `.gitignore` first, then any `*ignore` file (e.g., `.dockerignore` is skipped).
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

// ---------------------------------------------------------------------------
// Default export — extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  // ---- State ----

  let swarmActive = false;

  const log = (msg: string): void => {
    // Use console for logging since ExtensionAPI does not expose logger directly.
    console.error(`[pi-swarm] ${msg}`);
  };

  // ---- Command Host ----

  const commandHost: SwarmCommandHost = {
    pi,
    get swarmActive() {
      return swarmActive;
    },
    setSwarmActive(active: boolean, _trigger: "manual" | "task" | "tool") {
      swarmActive = active;
    },
    sendNormalUserInput(prompt: string) {
      pi.sendMessage({
        customType: "swarm:user_input",
        content: prompt,
        display: false,
      });
    },
    showStatus(message: string) {
      log(message);
    },
    showError(message: string) {
      console.error(`[pi-swarm] ERROR: ${message}`);
    },
    hasModel(): boolean {
      try {
        const tools = pi.getActiveTools?.();
        return tools !== undefined && tools.length > 0;
      } catch {
        return true;
      }
    },
    getPermissionMode(): string {
      return "auto";
    },
    async setPermissionMode(_mode: string): Promise<void> {
      // Permission mode integration TBD
    },
  };

  // ---- Lifecycle hooks ----

  pi.on("session_start", async () => {
    log("Session started — swarm extension loaded.");
    swarmActive = false;

    // Ensure .pi/swarm/state/ is gitignored
    ensureGitignore(process.cwd());

    // Run recovery: detect stale/abandoned runs, clean up expired ones
    try {
      const result = recoverRuns(process.cwd());
      if (result.abandoned.length > 0) {
        log(
          `Recovery: ${result.abandoned.length} abandoned run(s) marked.`,
        );
      }
      if (result.cleanedUp.length > 0) {
        log(
          `Recovery: ${result.cleanedUp.length} expired run(s) cleaned up.`,
        );
      }
      if (result.resumable.length > 0) {
        log(
          `Recovery: ${result.resumable.length} run(s) available for resume.`,
        );
      }
    } catch (err) {
      log(`Recovery error (non-fatal): ${String(err)}`);
    }
  });

  pi.on("agent_end", async () => {
    // Auto-exit task-mode swarm after the turn completes.
  });

  pi.on("session_shutdown", async () => {
    log("Session shutting down.");
    swarmActive = false;
  });

  // ---- Tool & Command Registration ----

  registerAgentSwarmTool(pi);
  registerSwarmCommand(pi, commandHost);
  registerAgentTeamTool(pi);
  registerTeamCommand(pi);

  log("Extension loaded — AgentSwarm + AgentTeam tools + /swarm, /swarm-team commands registered.");
}
