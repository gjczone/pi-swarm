/**
 * tests/pi-settings.test.ts — tests for the extracted readPiSettings helper.
 *
 * Covers:
 *   #142 — `readPiSettings` is the single shared implementation used by
 *   both `src/shared/controller.ts` and `src/shared/profiles.ts`. The
 *   helper is a thin wrapper around fs.readFileSync + JSON.parse that
 *   returns null on any error (missing file, unreadable, malformed).
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

describe("readPiSettings (#142)", () => {
  it("returns null when the file does not exist", () => {
    expect(readPiSettings(settingsFile)).toBeNull();
  });

  it("returns null when the file is empty", () => {
    fs.writeFileSync(settingsFile, "");
    expect(readPiSettings(settingsFile)).toBeNull();
  });

  it("parses a valid settings.json and returns the object", () => {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ "pi-swarm": { maxConcurrency: 8 } }),
    );
    const result = readPiSettings(settingsFile);
    expect(result).toEqual({ "pi-swarm": { maxConcurrency: 8 } });
  });

  it("returns null when the JSON is malformed", () => {
    fs.writeFileSync(settingsFile, "{ not valid json");
    expect(readPiSettings(settingsFile)).toBeNull();
  });

  it("returns null when the path points at a directory", () => {
    // A directory at the path — fs.readFileSync throws EISDIR, the
    // catch returns null. The helper must not crash.
    const dirPath = path.join(tmpDir, "is-a-dir");
    fs.mkdirSync(dirPath);
    expect(readPiSettings(dirPath)).toBeNull();
  });
});
