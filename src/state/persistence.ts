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
import { appendLine } from "../shared/atomic-append.js";

/**
 * #140: per-line log cap for corrupted JSONL entries. Mirrors the
 * MAX_PER_LINE_LOGS constant in src/team/mailbox.ts (introduced by
 * #137) to bound log volume on heavily corrupt files. The events
 * log and the mailbox JSONL can both be read at high frequency, so
 * a single corrupt file must not produce N log entries per read.
 */
const MAX_PER_LINE_LOGS = 5;

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
  readonly type: "swarm" | "team" | "coordinator";
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
 * Returns null if the manifest does not exist or is corrupted (#126).
 *
 * ENOENT is treated as "absent" and returns null silently. JSON parse
 * errors and other I/O failures are logged via console.error so operators
 * know a manifest is corrupted, but the null contract is preserved.
 */
export function readManifest(
  swarmRoot: string,
  runId: string,
): RunManifest | null {
  const filePath = path.join(
    resolveRunStateDir(swarmRoot, runId),
    "manifest.json",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    console.error(
      `[pi-swarm] readManifest: failed to read ${filePath}: ${(err as Error).message}`,
    );
    return null;
  }
  try {
    return JSON.parse(raw) as RunManifest;
  } catch (err) {
    console.error(
      `[pi-swarm] readManifest: corrupted JSON in ${filePath}: ${(err as Error).message}`,
    );
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

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

/**
 * Append an event to the run's event log.
 *
 * #106p + #134: O_APPEND + fsync via `appendLine` replaces the previous
 * read-modify-write path. Each line is durable on disk before the call
 * returns, and a SIGKILL mid-call cannot leave a torn line (the OS
 * guarantees O_APPEND is atomic for writes that fit in a single record).
 * For a long-running run (1000+ events), the previous path read and
 * rewrote the entire log on every append — this version is O(1).
 */
export function appendEvent(
  swarmRoot: string,
  runId: string,
  event: Record<string, unknown>,
): void {
  const dir = resolveRunStateDir(swarmRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "events.jsonl");
  appendLine(filePath, JSON.stringify(event) + "\n");
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
    let corruptedCount = 0;
    const messages: Record<string, unknown>[] = [];
    for (const line of raw.trim().split("\n")) {
      try {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      } catch (err) {
        // #140: per-line log only for the first MAX_PER_LINE_LOGS
        // occurrences to bound log volume; the summary below records
        // the total. Same cap-and-summarize pattern as #137.
        corruptedCount += 1;
        if (corruptedCount <= MAX_PER_LINE_LOGS) {
          console.error(
            `[pi-swarm] readEvents: corrupted JSONL line in ${filePath}: ${(err as Error).message}. Line: ${line.slice(0, 200)}.`,
          );
        }
      }
    }
    if (corruptedCount > MAX_PER_LINE_LOGS) {
      console.error(
        `[pi-swarm] readEvents: skipped ${corruptedCount} corrupted line(s) in ${filePath} (logged first ${MAX_PER_LINE_LOGS})`,
      );
    }
    return messages;
  } catch (err) {
    // #140: ENOENT is the common case (a fresh run that has not yet
    // appended any events). Suppress the log for ENOENT, log other
    // faults. Mirrors the #137 readAckIds pattern.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code !== "ENOENT") {
      console.error(
        `[pi-swarm] readEvents: failed to read events file ${filePath}: ${(err as Error).message}. Returning empty array.`,
      );
    }
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
  } catch (err) {
    // #140: missing status file is the common case (the agent has not
    // yet written its first status update). Suppress the log for
    // ENOENT; log other faults (EACCES, EIO, corrupt JSON) so a real
    // I/O issue is visible. Mirrors the #137 readAckIds pattern.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code !== "ENOENT") {
      console.error(
        `[pi-swarm] loadAgentStatus: failed to read or parse status ${filePath}: ${(err as Error).message}. Returning null.`,
      );
    }
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
    } catch (cleanupErr) {
      // Temp cleanup failure is non-fatal but visible (#130)
      console.error(
        `[pi-swarm] writeAtomic: failed to remove temp ${tmpPath}: ${(cleanupErr as Error).message}`,
      );
    }
    throw err;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
