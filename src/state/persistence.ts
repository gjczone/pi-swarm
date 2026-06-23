/**
 * state/persistence — durable file-based state for swarm and team runs.
 *
 * Every run has a manifest file, a task state file, and an append-only
 * event log.  This module provides atomic reads and writes so crash
 * recovery can rebuild correct state.
 *
 * Directory layout:
 *   .pi/swarm/state/runs/{runId}/
 *     manifest.json        -- run metadata, status, agent IDs
 *     tasks.json           -- task graph & per-task status
 *     events.jsonl         -- append-only event log
 *     agents/{agentId}/
 *       status.json        -- per-agent status
 *       output.log         -- agent stdout capture
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the crew root directory.
 *
 * If the project already has a `.pi/` directory, use `.pi/swarm/`.
 * Otherwise use `.crew/` (default for fresh projects).
 */
export function resolveCrewRoot(cwd: string): string {
  const piDir = path.join(cwd, ".pi");
  if (fs.existsSync(piDir)) {
    return path.join(piDir, "swarm");
  }
  return path.join(cwd, ".crew");
}

/** Resolve the state directory for a specific run. */
export function resolveRunStateDir(
  crewRoot: string,
  runId: string,
): string {
  return path.join(crewRoot, "state", "runs", runId);
}

/** Resolve per-agent state directory. */
export function resolveAgentStateDir(
  crewRoot: string,
  runId: string,
  agentId: string,
): string {
  return path.join(
    crewRoot,
    "state",
    "runs",
    runId,
    "agents",
    agentId,
  );
}

// ---------------------------------------------------------------------------
// Run manifest
// ---------------------------------------------------------------------------

export interface RunManifest {
  readonly runId: string;
  readonly type: "swarm" | "team";
  status: "running" | "completed" | "failed" | "abandoned";
  goal?: string;
  startedAt: number;
  completedAt?: number;
  agentIds: string[];
}

/**
 * Create a new run manifest and write it to disk.
 */
export function createManifest(
  crewRoot: string,
  manifest: RunManifest,
): void {
  const dir = resolveRunStateDir(crewRoot, manifest.runId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Read a run manifest from disk.
 * Returns null if the manifest does not exist.
 */
export function readManifest(
  crewRoot: string,
  runId: string,
): RunManifest | null {
  const filePath = path.join(
    resolveRunStateDir(crewRoot, runId),
    "manifest.json",
  );
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as RunManifest;
  } catch {
    return null;
  }
}

/**
 * Update a run manifest (overwrites the file atomically).
 */
export function updateManifest(
  crewRoot: string,
  manifest: RunManifest,
): void {
  const dir = resolveRunStateDir(crewRoot, manifest.runId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

/**
 * Persist task state (task graph) to disk.
 */
export function saveTaskState(
  crewRoot: string,
  runId: string,
  data: Record<string, unknown>,
): void {
  const dir = resolveRunStateDir(crewRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(
    path.join(dir, "tasks.json"),
    JSON.stringify(data, null, 2),
  );
}

/**
 * Load task state from disk.
 * Returns null if the file does not exist.
 */
export function loadTaskState(
  crewRoot: string,
  runId: string,
): Record<string, unknown> | null {
  const filePath = path.join(
    resolveRunStateDir(crewRoot, runId),
    "tasks.json",
  );
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/**
 * Append an event to the run's event log.
 */
export function appendEvent(
  crewRoot: string,
  runId: string,
  event: Record<string, unknown>,
): void {
  const dir = resolveRunStateDir(crewRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "events.jsonl");
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Read all events from the run's event log.
 */
export function readEvents(
  crewRoot: string,
  runId: string,
): Record<string, unknown>[] {
  const filePath = path.join(
    resolveRunStateDir(crewRoot, runId),
    "events.jsonl",
  );
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return [];
    return raw
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((e): e is Record<string, unknown> => e !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

/**
 * Save per-agent status.
 */
export function saveAgentStatus(
  crewRoot: string,
  runId: string,
  agentId: string,
  status: Record<string, unknown>,
): void {
  const dir = resolveAgentStateDir(crewRoot, runId, agentId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(
    path.join(dir, "status.json"),
    JSON.stringify(status, null, 2),
  );
}

/**
 * Load per-agent status.
 */
export function loadAgentStatus(
  crewRoot: string,
  runId: string,
  agentId: string,
): Record<string, unknown> | null {
  const filePath = path.join(
    resolveAgentStateDir(crewRoot, runId, agentId),
    "status.json",
  );
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * List all active run IDs in the state directory.
 */
export function listActiveRuns(crewRoot: string): string[] {
  const runsDir = path.join(crewRoot, "state", "runs");
  if (!fs.existsSync(runsDir)) return [];

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Delete the entire run state directory.
 */
export function deleteRunState(
  crewRoot: string,
  runId: string,
): void {
  const dir = resolveRunStateDir(crewRoot, runId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

/**
 * Write a file atomically using a temp file + rename.
 * On POSIX rename is atomic; on Windows it replaces the target.
 */
function writeAtomic(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp." + randomId();
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Best effort
    }
    throw err;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
