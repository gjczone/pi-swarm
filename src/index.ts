/**
 * pi-swarm — Agent Swarm extension for pi-coding-agent.
 *
 * Entry point.  Registered as the default export.  Wires together
 * the AgentSwarm tool, /swarm command, swarm-mode state machine,
 * and TUI progress components.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentSwarmTool } from "./swarm/tool.js";
import { registerCoordinatorTools } from "./swarm/coordinator.js";
import {
  registerSwarmCommand,
  type SwarmCommandHost,
} from "./swarm/command.js";
import { registerTeamCommand } from "./team/command.js";
import { recoverRuns } from "./state/recovery.js";
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from "./tui/swarm-markers.js";
import { pruneWorktrees } from "./shared/worktree.js";
import { ensureGitignore } from "./shared/gitignore.js";

// ---------------------------------------------------------------------------
// Default export — extension entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Keyword mode resolver (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Return "swarm" when the input contains the word "swarm", otherwise null.
 */
export function resolveKeywordMode(text: string): "swarm" | null {
  const t = text.toLowerCase();
  if (t.includes("swarm")) return "swarm";
  return null;
}

export default function (pi: ExtensionAPI): void {
  // ---- State ----

  let swarmMode: "swarm" | null = null;

  const log = (_msg: string): void => {
    // Silent by default — pi extensions should not print startup noise.
    // Only showError writes to console for genuine errors.
  };

  // ---- Command Host ----

  const commandHost: SwarmCommandHost = {
    pi,
    get swarmActive() {
      return swarmMode !== null;
    },
    setSwarmActive(active: boolean, _trigger: "manual" | "task" | "tool") {
      swarmMode = active ? "swarm" : null;
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
        console.error(
          "[pi-swarm] Failed to check active model availability, assuming no model.",
        );
        return false;
      }
    },
  };

  // ---- Lifecycle hooks ----

  pi.on("session_start", async () => {
    swarmMode = null;

    // Ensure .pi/swarm/state/ is gitignored
    ensureGitignore(process.cwd());

    // Best-effort cleanup of orphaned worktrees from previous crashes
    try {
      pruneWorktrees(process.cwd());
    } catch {
      // Non-git repos or worktree prune failures are non-fatal
    }

    // Run recovery: detect stale/abandoned runs, clean up expired ones
    try {
      const result = recoverRuns(process.cwd());
      if (result.abandoned.length > 0) {
        log(`Recovery: ${result.abandoned.length} abandoned run(s) marked.`);
      }
      if (result.cleanedUp.length > 0) {
        log(`Recovery: ${result.cleanedUp.length} expired run(s) cleaned up.`);
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
    swarmMode = null;
  });

  // ---- Keyword trigger: auto-activate swarm mode when user mentions it ----

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    const mode = resolveKeywordMode(event.text);
    if (mode === null) return;
    if (swarmMode !== null) return; // Already active

    swarmMode = mode;
    log(`Swarm mode auto-activated (keyword: ${mode}).`);
    pi.sendMessage?.({
      customType: "swarm:marker",
      content: "active",
      display: false,
    });
  });

  // ---- Tool & Command Registration ----

  // Register a renderer for swarm:marker custom messages so the
  // activated/deactivated/ended markers render as a labelled line in
  // the conversation transcript. 业务说明：当 swarm 模式开启/关闭/结束时，
  // 通过 sendMessage 发送 swarm:marker 消息；此处注册渲染器将其显示为
  // 一行带标签的状态标记。
  pi.registerMessageRenderer<unknown>("swarm:marker", (message) => {
    const content = typeof message.content === "string" ? message.content : "";
    const state = resolveMarkerState(content);
    return new SwarmModeMarkerComponent(state);
  });

  registerAgentSwarmTool(pi);
  registerCoordinatorTools(pi);
  registerSwarmCommand(pi, commandHost);
  registerTeamCommand(pi, commandHost);
}

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

/** Map a swarm:marker message content string to a marker state. */
function resolveMarkerState(content: string): SwarmModeMarkerState {
  switch (content) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    case "ended":
      return "ended";
    default:
      return "active";
  }
}
