/**
 * tests/pi-settings.test.ts — tests for the extracted readPiSettings helper.
 *
 * Covers:
 *   #142 — `readPiSettings` is the single shared implementation used by
 *   both `src/shared/controller.ts` and `src/shared/profiles.ts`. The
 *   helper is a thin wrapper around fs.readFileSync + JSON.parse.
 *   #147 — contract changed from `T | null` to `{ value, error }` so
 *   callers that need to log on read/parse failure (e.g.
 *   `state/settings.ts:resolveRunRetentionMs`) can distinguish ENOENT
 *   from a real I/O fault.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readPiSettings } from "../src/shared/pi-settings.js";

let tmpDir: string;
let settingsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-rps-"));
  settingsFile = path.join(tmpDir, "settings.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readPiSettings (#142 / #147)", () => {
  it("returns { value: null } (no error) when the file does not exist", () => {
    // ENOENT is the common case — a fresh repo with no settings file.
    // Must not produce an error so callers that log on error are silent.
    const result = readPiSettings(settingsFile);
    expect(result.value).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it("returns { value: null, error } when the file is empty (JSON parse error)", () => {
    // Empty file is a real parse failure, not ENOENT — must surface the error.
    fs.writeFileSync(settingsFile, "");
    const result = readPiSettings(settingsFile);
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(/JSON|parse/i);
  });

  it("returns { value } on success", () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ "pi-swarm": { maxConcurrency: 8 } }),
    );
    const result = readPiSettings(settingsFile);
    expect(result.value).toEqual({ "pi-swarm": { maxConcurrency: 8 } });
    expect(result.error).toBeUndefined();
  });

  it("returns { value: null, error } when the JSON is malformed", () => {
    fs.writeFileSync(settingsFile, "{ not valid json");
    const result = readPiSettings(settingsFile);
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(/JSON|parse/i);
  });

  it("returns { value: null, error } when the path points at a directory", () => {
    // Path is a directory — fs.readFileSync throws EISDIR. The helper
    // must surface this as an error (not as ENOENT).
    const dirPath = path.join(tmpDir, "is-a-dir");
    fs.mkdirSync(dirPath);
    const result = readPiSettings(dirPath);
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error?.message).toMatch(/EISDIR|directory|read/i);
  });
});
