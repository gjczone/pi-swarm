/**
 * team/command — /swarm-team slash command handler.
 *
 * Supports:
 *   /swarm-team <goal>   — launch a team run for the given goal
 *
 * The command delegates to the SwarmTeam tool internally.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SwarmCommandHost } from "../swarm/command.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamCommand(
  pi: ExtensionAPI,
  host: SwarmCommandHost,
): void {
  pi.registerCommand("swarm-team", {
    description:
      "Launch a collaborative team of role-based agents to complete a complex task. " +
      "Usage: /swarm-team <goal>",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const prompt = args.trim();

      if (prompt.length === 0) {
        ctx.ui?.notify?.(
          "Usage: /swarm-team <goal>",
          "warning",
        );
        return;
      }

      if (!host.hasModel()) {
        host.showError("No model configured. Please set a model first.");
        return;
      }

      // Activate swarm mode if not already active
      if (!host.swarmActive) {
        if (host.getPermissionMode() === "manual") {
          const confirmed = await ctx.ui?.confirm(
            "Swarm Team",
            "Starting a swarm team task. Switch to auto permission mode?",
          );
          if (!confirmed) {
            host.showStatus("Swarm team task cancelled.");
            return;
          }
          await host.setPermissionMode("auto");
        }
        host.setSwarmActive(true, "task");
      }

      // TUI marker
      host.pi.sendMessage?.({
        customType: "swarm:marker",
        content: "active",
        display: true,
      });

      // Send the goal as a user prompt — the LLM will call SwarmTeam
      host.sendNormalUserInput(
        `Use the SwarmTeam tool to accomplish this goal: ${prompt}`,
      );
    },
  });
}
