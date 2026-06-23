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
