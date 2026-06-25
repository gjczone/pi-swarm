/**
 * swarm/command — /swarm slash command handler.
 *
 * Supports:
 *   /swarm on       — enable swarm mode (manual trigger)
 *   /swarm off      — disable swarm mode
 *   /swarm          — toggle swarm mode
 *   /swarm <task>   — enable swarm mode + send task (one-shot)
 *
 * Ported from MoonshotAI/kimi-code's swarm command.
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
      "Turn swarm mode on/off, or run a one-shot swarm task. " +
      "Usage: /swarm on|off, or /swarm <task>",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const prompt = args.trim();
      const mode = swarmModeSubcommand(prompt);

      // Subcommand: on / off
      if (mode !== undefined) {
        await applySwarmMode(host, mode, `/swarm ${prompt}`, ctx);
        return;
      }

      // No args: toggle
      if (prompt.length === 0) {
        await applySwarmMode(host, !host.swarmActive, "/swarm", ctx);
        return;
      }

      // Task mode: enable swarm + send prompt
      if (!host.hasModel()) {
        host.showError("No model configured. Please set a model first.");
        return;
      }

      await startSwarmTask(host, prompt, ctx);
    },
  });
}

// ---------------------------------------------------------------------------
// Command logic
// ---------------------------------------------------------------------------

async function applySwarmMode(
  host: SwarmCommandHost,
  enabled: boolean,
  commandText: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (enabled && host.swarmActive) {
    host.showStatus("Swarm mode is already on.");
    return;
  }
  if (!enabled && !host.swarmActive) {
    host.showStatus("Swarm mode is already off.");
    return;
  }

  if (enabled) {
    host.setSwarmActive(true, "manual");
    host.showStatus("Swarm mode enabled.");

    // Insert swarm mode marker (via pi.sendMessage for TUI rendering)
    host.pi.sendMessage?.({
      customType: "swarm:marker",
      content: "active",
      display: true,
    });
  } else {
    host.setSwarmActive(false, "manual");
    host.showStatus("Swarm mode disabled.");

    host.pi.sendMessage?.({
      customType: "swarm:marker",
      content: "inactive",
      display: true,
    });
  }
}

async function startSwarmTask(
  host: SwarmCommandHost,
  prompt: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Enable swarm mode if not already active
  if (!host.swarmActive) {
    host.setSwarmActive(true, "task");
  }

  // TUI marker
  host.pi.sendMessage?.({
    customType: "swarm:marker",
    content: "active",
    display: true,
  });

  // Send the prompt
  host.sendNormalUserInput(prompt);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function swarmModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === "on") return true;
  if (command === "off") return false;
  return undefined;
}
