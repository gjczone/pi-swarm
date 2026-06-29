/**
 * state/recovery — crash recovery and stale run detection.
 *
 * On session start, scans for incomplete runs.  If the parent Pi
 * process is no longer alive, marks the run as abandoned.  Completed
 * runs older than 7 days are cleaned up automatically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveSwarmRoot,
  listActiveRuns,
  readManifest,
  updateManifest,
  deleteRunState,
  loadAgentStatus,
  type RunManifest,
  appendEvent,
} from "./persistence.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Runs completed more than this many ms ago are eligible for cleanup. */
const COMPLETED_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Runs with status "running" older than this without a heartbeat are stale. */
const STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  /** Runs that were active and can be resumed. */
  readonly resumable: RunManifest[];
  /** Runs that were abandoned (dead parent process). */
  readonly abandoned: RunManifest[];
  /** Runs that were cleaned up (expired completed runs). */
  readonly cleanedUp: string[];
}

/**
 * Run recovery on session start.
 *
 * - Marks stale "running" runs as abandoned.
 * - Cleans up expired completed runs.
 * - Returns lists of resumable and abandoned runs.
 */
export function recoverRuns(cwd: string): RecoveryResult {
  const swarmRoot = resolveSwarmRoot(cwd);
  const runsDir = path.join(swarmRoot, "state", "runs");

  if (!fs.existsSync(runsDir)) {
    return { resumable: [], abandoned: [], cleanedUp: [] };
  }

  const runIds = listActiveRuns(swarmRoot);
  const now = Date.now();
  const resumable: RunManifest[] = [];
  const abandoned: RunManifest[] = [];
  const cleanedUp: string[] = [];

  for (const runId of runIds) {
    const manifest = readManifest(swarmRoot, runId);
    if (!manifest) {
      const manifestPath = path.join(
        swarmRoot,
        "state",
        "runs",
        runId,
        "manifest.json",
      );
      if (fs.existsSync(manifestPath)) {
        // Manifest exists but is unreadable/corrupt — preserve for debugging
        console.error(
          `[pi-swarm] Run ${runId}: manifest exists but is unreadable, preserving run directory`,
        );
      } else {
        // Orphaned directory — safe to clean up
        try {
          deleteRunState(swarmRoot, runId);
          cleanedUp.push(runId);
        } catch {
          // Best effort
        }
      }
      continue;
    }

    switch (manifest.status) {
      case "running": {
        // Check for staleness using last heartbeat if available
        const lastActivity = manifest.lastHeartbeatAt ?? manifest.startedAt;
        const age = now - lastActivity;
        if (age > STALE_RUN_THRESHOLD_MS) {
          // Mark as abandoned
          const updated: RunManifest = {
            ...manifest,
            status: "abandoned",
            completedAt: now,
          };
          updateManifest(swarmRoot, updated);
          appendEvent(swarmRoot, runId, {
            type: "run.abandoned",
            reason: "stale",
            timestamp: new Date().toISOString(),
          });
          abandoned.push(updated);
        } else {
          // Still potentially resumable
          resumable.push(manifest);
        }
        break;
      }
      case "completed":
      case "failed": {
        // Clean up expired runs
        const completedAt = manifest.completedAt ?? manifest.startedAt;
        const age = now - completedAt;
        if (age > COMPLETED_RUN_RETENTION_MS) {
          try {
            deleteRunState(swarmRoot, runId);
            cleanedUp.push(runId);
          } catch {
            // Best effort
          }
        }
        break;
      }
      case "abandoned":
        // Already abandoned — check if we should clean up
        {
          const abandonedAt = manifest.completedAt ?? manifest.startedAt;
          if (now - abandonedAt > COMPLETED_RUN_RETENTION_MS) {
            try {
              deleteRunState(swarmRoot, runId);
              cleanedUp.push(runId);
            } catch {
              // Best effort
            }
          }
        }
        break;
    }
  }

  return { resumable, abandoned, cleanedUp };
}

/**
 * Check whether a run has unfinished tasks.
 * Used to decide whether to offer resume or start fresh.
 */
export function hasUnfinishedTasks(swarmRoot: string, runId: string): boolean {
  const manifest = readManifest(swarmRoot, runId);
  if (!manifest) return false;
  if (manifest.status === "completed") return false;
  if (manifest.status !== "running") return false;

  // Check if any agent status files indicate unfinished work
  const agentsDir = path.join(swarmRoot, "state", "runs", runId, "agents");
  if (!fs.existsSync(agentsDir)) return true;

  // Check each agent directory for non-terminal status
  const agentDirs = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const agentId of agentDirs) {
    const status = loadAgentStatus(swarmRoot, runId, agentId);
    if (!status) return true;
    const state = String(status.status ?? status.state ?? "");
    if (state === "running" || state === "started" || state === "") {
      return true;
    }
  }

  return false;
}

/**
 * Get resumable agent IDs from a run.
 * Returns a map of agentId → last known status.
 */
export function getResumableAgents(
  swarmRoot: string,
  runId: string,
): Map<string, string> {
  const manifest = readManifest(swarmRoot, runId);
  const result = new Map<string, string>();

  if (!manifest) return result;

  for (const agentId of manifest.agentIds) {
    const statusDir = path.join(
      swarmRoot,
      "state",
      "runs",
      runId,
      "agents",
      agentId,
    );
    if (!fs.existsSync(statusDir)) {
      // Agent was never started
      result.set(agentId, "not_started");
      continue;
    }

    const statusRecord = loadAgentStatus(swarmRoot, runId, agentId);
    if (!statusRecord) {
      // status.json missing or unreadable — treat as unknown, not resumable
      result.set(agentId, "unknown");
      continue;
    }

    const agentStatus = String(statusRecord.status ?? statusRecord.state ?? "");
    // Non-terminal states — agent can be resumed
    if (
      agentStatus === "running" ||
      agentStatus === "started" ||
      agentStatus === "spawned" ||
      agentStatus === "suspended"
    ) {
      result.set(agentId, "resumable");
    } else if (
      agentStatus === "completed" ||
      agentStatus === "failed" ||
      agentStatus === "aborted"
    ) {
      // Terminal states — agent should not be resumed
      result.set(agentId, agentStatus);
    } else {
      // Unknown status — treat as not resumable
      result.set(agentId, "unknown");
    }
  }

  return result;
}
