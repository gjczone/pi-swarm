/**
 * team/command — /swarm-team slash command handler.
 *
 * Supports:
 *   /swarm-team <goal>   — launch a team run for the given goal
 *
 * The command delegates to the AgentTeam tool internally.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTeamCommand(
  pi: ExtensionAPI,
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

      // Send the goal as a user prompt — the LLM can then decide
      // whether to call AgentTeam or handle it differently.
      pi.sendMessage({
        customType: "swarm_team:prompt",
        content: `Launch a team to: ${prompt}`,
        display: true,
      });
    },
  });
}
