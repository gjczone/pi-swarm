/**
 * shared/pi-settings — single canonical reader for `.pi/settings.json`.
 *
 * #142: extracted from `src/shared/controller.ts` and `src/shared/profiles.ts`
 * which had two byte-identical implementations.
 *
 * #147: contract changed from `T | null` to `{ value, error }` so callers
 * that need to log on read/parse failure (e.g.
 * `state/settings.ts:resolveRunRetentionMs`) can distinguish ENOENT
 * from a real I/O fault. ENOENT is the common case (a fresh repo with
 * no settings file) and produces `{ value: null }` with no error;
 * callers that treat the absence as silent use `result.value`. Callers
 * that need to log on real failures check `result.error`.
 */

import * as fs from "node:fs";

/**
 * Read and parse a `.pi/settings.json`-shaped file.
 *
 * - File missing (ENOENT) → `{ value: null }` (no error). ENOENT is the
 *   common case for a fresh repo; the helper treats it as "no settings
 *   present" and returns the silent default.
 * - Read or parse failure → `{ value: null, error: { code, message } }`.
 *   Callers that need to log on real faults inspect this.
 * - Success → `{ value: <parsed object> }`.
 */
export type ReadPiSettingsResult = {
  readonly value: Record<string, unknown> | null;
  readonly error?: { code?: string; message: string };
};

export function readPiSettings(filePath: string): ReadPiSettingsResult {
  if (!fs.existsSync(filePath)) {
    return { value: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return { value: JSON.parse(raw) as Record<string, unknown> };
  } catch (err) {
    return {
      value: null,
      error: {
        code: (err as NodeJS.ErrnoException).code,
        message: (err as Error).message,
      },
    };
  }
}
