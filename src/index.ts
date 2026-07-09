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
  if (/\bswarm\b/i.test(text)) return "swarm";
  return null;
}

export default function (pi: ExtensionAPI): void {
  // ---- State ----

  let swarmMode: "swarm" | null = null;
  let swarmTrigger: "manual" | "task" | "tool" | null = null;

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
    setSwarmActive(active: boolean, trigger: "manual" | "task" | "tool") {
      swarmMode = active ? "swarm" : null;
      swarmTrigger = active ? trigger : null;
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
    } catch (err) {
      // Non-git repos or worktree prune failures are non-fatal but visible (#130)
      console.error(`[pi-swarm] pruneWorktrees: ${(err as Error).message}`);
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
      // Recovery failure is non-fatal but must be visible (#130) — the
      // log() helper is silent by design for normal startup messages.
      console.error(`[pi-swarm] recoverRuns: ${(err as Error).message}`);
    }
  });

  pi.on("agent_end", async () => {
    // Auto-exit task-mode swarm after the turn completes so it does not
    // stay active through subsequent turns (#156). Manual/tool activation
    // persists across turns.
    if (swarmTrigger === "task") {
      swarmMode = null;
      swarmTrigger = null;
    }
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
  // the conversation transcript. Business: when swarm mode turns on, off,
  // or ends, sendMessage emits a swarm:marker message; this handler
  // registers a renderer that displays it as a single labeled status
  // marker.
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
