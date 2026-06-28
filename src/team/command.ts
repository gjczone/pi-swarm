/**
 * team/command — /swarm-team slash command handler.
 *
 * /swarm-team <goal> — directs the LLM to use the Swarm tool with mailbox enabled
 * for collaborative multi-step workflows.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SwarmCommandHost } from "../swarm/command.js";

export function registerTeamCommand(
  pi: ExtensionAPI,
  host: SwarmCommandHost,
): void {
  pi.registerCommand("swarm-team", {
    description:
      "Launch a collaborative Swarm with mailbox. " +
      "Usage: /swarm-team <goal>",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const prompt = args.trim();

      if (prompt.length === 0) {
        ctx.ui?.notify?.("/swarm-team <goal>", "info");
        return;
      }

      if (!host.hasModel()) {
        host.showError("No model configured. Please set a model first.");
        return;
      }

      if (!host.swarmActive) {
        host.setSwarmActive(true, "task");
      }
      host.pi.sendMessage?.({
        customType: "swarm:marker",
        content: "active",
        display: true,
      });

      host.sendNormalUserInput(
        `Use the Swarm tool with mailbox: true to accomplish this goal: ${prompt}`,
      );
    },
  });
}
