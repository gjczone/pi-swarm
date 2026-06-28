/**
 * swarm/command — /swarm slash command handler.
 *
 * Supports:
 *   /swarm               — show usage hint
 *   /swarm <task>        — directly invoke the Swarm tool with the given task
 *
 * Also accepts on/off to enable/disable swarm mode.
 * Architecture reference: AgentSwarm pattern.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SwarmModeTrigger } from "./mode.js";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface SwarmCommandHost {
  /** The pi extension API. */
  readonly pi: ExtensionAPI;
  /** Current swarm mode state. */
  swarmActive: boolean;
  /** Set swarm mode state. */
  setSwarmActive(active: boolean, trigger: SwarmModeTrigger): void;
  /** Log / status helpers. */
  /** Send a normal user input prompt. */
  sendNormalUserInput(prompt: string): void;
  /** Show a status message to the user. */
  showStatus(message: string): void;
  /** Show an error message to the user. */
  showError(message: string): void;
  /** Check if a model is configured. */
  hasModel(): boolean;
}

export function registerSwarmCommand(
  pi: ExtensionAPI,
  host: SwarmCommandHost,
): void {
  pi.registerCommand("swarm", {
    description:
      "Run a one-shot Swarm task. " +
      'Usage: /swarm <task description and items>',
    async handler(args: string, ctx: ExtensionCommandContext) {
      const prompt = args.trim();

      if (prompt.length === 0) {
        // Show usage hint
        const tools = host.pi.getAllTools?.() ?? [];
        const swarmTool = tools.find((t) => t.name === "Swarm");
        if (swarmTool) {
          ctx.ui?.notify?.("/swarm <task description>", "info");
        } else {
          ctx.ui?.notify?.("Swarm tool not available.", "error");
        }
        return;
      }

      if (!host.hasModel()) {
        host.showError("No model configured. Please set a model first.");
        return;
      }

      // Activate swarm mode
      if (!host.swarmActive) {
        host.setSwarmActive(true, "task");
      }
      host.pi.sendMessage?.({
        customType: "swarm:marker",
        content: "active",
        display: true,
      });

      // Direct invocation: tell LLM to call the tool
      host.sendNormalUserInput(
        `Use the Swarm tool with this task: ${prompt}`,
      );
    },
  });
}


