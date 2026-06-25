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
// Security: ID validation and path containment
// ---------------------------------------------------------------------------

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function validateId(id: string, kind: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new Error(
      `Invalid ${kind}: must be a non-empty string up to 128 characters`,
    );
  }
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid ${kind}: "${id}" contains unsafe characters (only a-z, A-Z, 0-9, _, - allowed)`,
    );
  }
}

function ensureWithinRoot(resolvedPath: string, root: string): void {
  const normalizedRoot = path.resolve(root) + path.sep;
  const normalizedPath = path.resolve(resolvedPath);
  if (
    !normalizedPath.startsWith(normalizedRoot) &&
    normalizedPath !== path.resolve(root)
  ) {
    throw new Error(`Path traversal detected: ${resolvedPath} escapes ${root}`);
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the crew root directory.
 *
 * Always uses `.pi/swarm/` under the project root.  Creates `.pi/`
 * if it does not already exist.
 */
export function resolveSwarmRoot(cwd: string): string {
  const piDir = path.join(cwd, ".pi");
  if (!fs.existsSync(piDir)) {
    fs.mkdirSync(piDir, { recursive: true });
  }
  const swarmDir = path.join(piDir, "swarm");
  if (!fs.existsSync(swarmDir)) {
    fs.mkdirSync(swarmDir, { recursive: true });
  }
  return swarmDir;
}

/** Resolve the state directory for a specific run. */
export function resolveRunStateDir(swarmRoot: string, runId: string): string {
  validateId(runId, "runId");
  const runsDir = path.join(swarmRoot, "state", "runs");
  const dir = path.join(runsDir, runId);
  ensureWithinRoot(dir, runsDir);
  return dir;
}

/** Resolve per-agent state directory. */
export function resolveAgentStateDir(
  swarmRoot: string,
  runId: string,
  agentId: string,
): string {
  validateId(agentId, "agentId");
  const runDir = resolveRunStateDir(swarmRoot, runId);
  const agentsDir = path.join(runDir, "agents");
  const dir = path.join(agentsDir, agentId);
  ensureWithinRoot(dir, agentsDir);
  return dir;
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
  lastHeartbeatAt?: number;
  agentIds: string[];
  error?: string;
}

/**
 * Create a new run manifest and write it to disk.
 */
export function createManifest(swarmRoot: string, manifest: RunManifest): void {
  const dir = resolveRunStateDir(swarmRoot, manifest.runId);
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
  swarmRoot: string,
  runId: string,
): RunManifest | null {
  const filePath = path.join(
    resolveRunStateDir(swarmRoot, runId),
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
export function updateManifest(swarmRoot: string, manifest: RunManifest): void {
  const dir = resolveRunStateDir(swarmRoot, manifest.runId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Update the heartbeat timestamp for a running manifest.
 */
export function updateHeartbeat(swarmRoot: string, runId: string): void {
  const manifest = readManifest(swarmRoot, runId);
  if (!manifest) return;
  if (manifest.status !== "running") return;
  manifest.lastHeartbeatAt = Date.now();
  updateManifest(swarmRoot, manifest);
}

/**
 * Register an agent ID in the run manifest.
 * Called when a new agent spawns so the manifest tracks all agents in the run.
 */
export function registerAgentInManifest(
  swarmRoot: string,
  runId: string,
  agentId: string,
): void {
  const manifest = readManifest(swarmRoot, runId);
  if (!manifest) return;
  if (!manifest.agentIds.includes(agentId)) {
    manifest.agentIds.push(agentId);
    updateManifest(swarmRoot, manifest);
  }
}

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

/**
 * Persist task state (task graph) to disk.
 */
export function saveTaskState(
  swarmRoot: string,
  runId: string,
  data: Record<string, unknown>,
): void {
  const dir = resolveRunStateDir(swarmRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, "tasks.json"), JSON.stringify(data, null, 2));
}

/**
 * Load task state from disk.
 * Returns null if the file does not exist.
 */
export function loadTaskState(
  swarmRoot: string,
  runId: string,
): Record<string, unknown> | null {
  const filePath = path.join(
    resolveRunStateDir(swarmRoot, runId),
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
  swarmRoot: string,
  runId: string,
  event: Record<string, unknown>,
): void {
  const dir = resolveRunStateDir(swarmRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "events.jsonl");
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Read all events from the run's event log.
 */
export function readEvents(
  swarmRoot: string,
  runId: string,
): Record<string, unknown>[] {
  const filePath = path.join(
    resolveRunStateDir(swarmRoot, runId),
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
  swarmRoot: string,
  runId: string,
  agentId: string,
  status: Record<string, unknown>,
): void {
  const dir = resolveAgentStateDir(swarmRoot, runId, agentId);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, "status.json"), JSON.stringify(status, null, 2));
}

/**
 * Load per-agent status.
 */
export function loadAgentStatus(
  swarmRoot: string,
  runId: string,
  agentId: string,
): Record<string, unknown> | null {
  const filePath = path.join(
    resolveAgentStateDir(swarmRoot, runId, agentId),
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
 * Create a writable stream for the agent's output.log file.
 * Returns undefined if swarmRoot/runId are not provided.
 */
export function createAgentLogStream(
  swarmRoot: string | undefined,
  runId: string | undefined,
  agentId: string,
): fs.WriteStream | undefined {
  if (!swarmRoot || !runId) return undefined;
  const dir = resolveAgentStateDir(swarmRoot, runId, agentId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "output.log");
  return fs.createWriteStream(logPath, { flags: "a", encoding: "utf-8" });
}

/**
 * List all active run IDs in the state directory.
 * Only returns IDs that match the safe ID pattern.
 */
export function listActiveRuns(swarmRoot: string): string[] {
  const runsDir = path.join(swarmRoot, "state", "runs");
  if (!fs.existsSync(runsDir)) return [];

  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        validateId(name, "runId");
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * Delete the entire run state directory.
 */
export function deleteRunState(swarmRoot: string, runId: string): void {
  const dir = resolveRunStateDir(swarmRoot, runId);
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
export function writeAtomic(filePath: string, content: string): void {
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
