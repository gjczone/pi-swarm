/**
 * state/settings — typed resolver for `.pi/settings.json` fields owned by
 * pi-swarm.
 *
 * #133: project policies (e.g. retention period for completed runs) live
 * in the project settings file rather than source code, so operators can
 * adjust them per-project without rebuilding. The resolver falls back to
 * documented defaults when the file is missing or malformed, and logs a
 * console.error explaining why so misconfiguration is visible.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Default retention for completed/failed/abandoned runs (7 days, in ms). */
export const DEFAULT_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface PiSwarmSettings {
  runRetentionMs?: unknown;
}

interface ProjectSettings {
  "pi-swarm"?: PiSwarmSettings;
}

/**
 * Resolve the retention period (in ms) for completed/failed/abandoned runs.
 *
 * Priority:
 *   1. `<cwd>/.pi/settings.json` → `pi-swarm.runRetentionMs`
 *   2. `DEFAULT_RUN_RETENTION_MS` (7 days) when absent or invalid.
 *
 * The value must be a positive integer (ms). Anything else falls back to
 * the default and logs a console.error.
 */
export function resolveRunRetentionMs(cwd: string): number {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_RUN_RETENTION_MS;
    }
    console.error(
      `[pi-swarm] resolveRunRetentionMs: failed to read ${settingsPath}: ${(err as Error).message}. Falling back to default.`,
    );
    return DEFAULT_RUN_RETENTION_MS;
  }

  let parsed: ProjectSettings;
  try {
    parsed = JSON.parse(raw) as ProjectSettings;
  } catch (err) {
    console.error(
      `[pi-swarm] resolveRunRetentionMs: malformed ${settingsPath}: ${(err as Error).message}. Falling back to default.`,
    );
    return DEFAULT_RUN_RETENTION_MS;
  }

  const swarm = parsed["pi-swarm"];
  if (!swarm || !("runRetentionMs" in swarm)) {
    // No attempt to configure — silent default.
    return DEFAULT_RUN_RETENTION_MS;
  }

  const value = swarm.runRetentionMs;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    console.error(
      `[pi-swarm] resolveRunRetentionMs: invalid runRetentionMs in ${settingsPath}; expected positive integer ms, got ${JSON.stringify(value)}. Falling back to default.`,
    );
    return DEFAULT_RUN_RETENTION_MS;
  }

  return value;
}
