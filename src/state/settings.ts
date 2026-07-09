/**
 * state/settings — typed resolver for `.pi/settings.json` fields owned by
 * pi-swarm.
 *
 * #133: project policies (e.g. retention period for completed runs) live
 * in the project settings file rather than source code, so operators can
 * adjust them per-project without rebuilding. The resolver falls back to
 * documented defaults when the file is missing or malformed, and logs a
 * console.error explaining why so misconfiguration is visible.
 * #147: switched to the shared `readPiSettings` helper. The helper
 * returns `{ value, error }` so ENOENT is silent and other failures
 * are surfaced for logging.
 */

import * as path from "node:path";
import { readPiSettings } from "../shared/pi-settings.js";

/** Default retention for completed/failed/abandoned runs (7 days, in ms). */
const DEFAULT_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
 * the default and logs a console.error. Missing files are silent (the
 * common case for any fresh project); other I/O faults and malformed
 * JSON are logged.
 */
export function resolveRunRetentionMs(cwd: string): number {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  const { value, error } = readPiSettings(settingsPath);
  if (error) {
    // #147: log the I/O or parse fault. ENOENT is suppressed by
    // readPiSettings, so this fires only for real failures.
    console.error(
      `[pi-swarm] resolveRunRetentionMs: failed to read or parse ${settingsPath}: ${error.message}. Falling back to default.`,
    );
    return DEFAULT_RUN_RETENTION_MS;
  }
  if (value === null) {
    // No settings file — silent default.
    return DEFAULT_RUN_RETENTION_MS;
  }

  const parsed = value as ProjectSettings;
  const swarm = parsed["pi-swarm"];
  if (!swarm || !("runRetentionMs" in swarm)) {
    // No attempt to configure — silent default.
    return DEFAULT_RUN_RETENTION_MS;
  }

  const v = swarm.runRetentionMs;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    console.error(
      `[pi-swarm] resolveRunRetentionMs: invalid runRetentionMs in ${settingsPath}; expected positive integer ms, got ${JSON.stringify(v)}. Falling back to default.`,
    );
    return DEFAULT_RUN_RETENTION_MS;
  }

  return v;
}
