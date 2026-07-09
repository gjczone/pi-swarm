/**
 * shared/pi-settings — single canonical reader for `.pi/settings.json`.
 *
 * #142: extracted from `src/shared/controller.ts` and `src/shared/profiles.ts`
 * which had two byte-identical implementations. The helper is a thin wrapper
 * around fs.readFileSync + JSON.parse that returns null on any error
 * (missing file, unreadable, malformed). Callers interpret null as
 * "no settings present" and apply their own default.
 *
 * Note: `state/settings.ts:resolveRunRetentionMs` is intentionally NOT
 * refactored to use this helper — it has different error-handling
 * requirements (logs on corrupt JSON, separate ENOENT behavior) and
 * changing it would expand the scope of #142.
 */

import * as fs from "node:fs";

/**
 * Read and parse a `.pi/settings.json`-shaped file.
 * Returns null on any error (missing file, unreadable, malformed JSON).
 * The caller is responsible for treating null as "use defaults".
 */
export function readPiSettings(
  filePath: string,
): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
