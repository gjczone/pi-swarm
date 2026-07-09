/**
 * tests/recovery-retention.test.ts — tests for #133 run retention setting.
 *
 * Covers:
 *   #133 — `pi-swarm.runRetentionMs` is read from `.pi/settings.json`
 *   with a 7-day default. Malformed or missing values fall back to the
 *   default and log a console.error. The configured value is also
 *   exercised end-to-end through `recoverRuns`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveRunRetentionMs } from "../src/state/settings.js";
import {
  resolveSwarmRoot,
  createManifest,
  type RunManifest,
} from "../src/state/persistence.js";
import { recoverRuns } from "../src/state/recovery.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-ret-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe("resolveRunRetentionMs (#133)", () => {
  it("returns 7-day default when .pi/settings.json is absent", () => {
    // No .pi/settings.json written — must fall back to the canonical 7d.
    expect(resolveRunRetentionMs(tmpDir)).toBe(SEVEN_DAYS_MS);
  });

  it("returns 7-day default when settings.json has no pi-swarm section", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ unrelated: true }),
    );
    expect(resolveRunRetentionMs(tmpDir)).toBe(SEVEN_DAYS_MS);
  });

  it("returns the configured value when runRetentionMs is a positive integer", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({
        "pi-swarm": { runRetentionMs: 30 * 24 * 60 * 60 * 1000 },
      }),
    );
    expect(resolveRunRetentionMs(tmpDir)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to default and logs when runRetentionMs is not a positive number", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "pi-swarm": { runRetentionMs: -1 } }),
    );
    expect(resolveRunRetentionMs(tmpDir)).toBe(SEVEN_DAYS_MS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("falls back to default and logs when runRetentionMs is non-numeric", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "pi-swarm": { runRetentionMs: "ten days" } }),
    );
    expect(resolveRunRetentionMs(tmpDir)).toBe(SEVEN_DAYS_MS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("falls back to default when runRetentionMs is an unsafe integer (e.g. 1e308)", () => {
    // #133 hardening: Number.MAX_SAFE_INTEGER is the cap. A user setting
    // 1e308 would otherwise pin retention at "effectively infinite" and
    // effectively disable cleanup — reject it.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "pi-swarm": { runRetentionMs: 1e308 } }),
    );
    expect(resolveRunRetentionMs(tmpDir)).toBe(SEVEN_DAYS_MS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("falls back to default and logs when settings.json is malformed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      "{ not valid json",
    );
    expect(resolveRunRetentionMs(tmpDir)).toBe(SEVEN_DAYS_MS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// End-to-end — recoverRuns honors the configured retention
// ---------------------------------------------------------------------------

describe("recoverRuns honors pi-swarm.runRetentionMs (#133)", () => {
  function makeManifest(
    runId: string,
    overrides: Partial<RunManifest> = {},
  ): RunManifest {
    return {
      runId,
      type: "swarm",
      status: "completed",
      goal: "retention-test",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 60_000,
      agentIds: [],
      ...overrides,
    };
  }

  it("a short retention (1s) causes a 1-hour-old completed run to be cleaned up", () => {
    // 1s retention — a run completed 1h ago is far past the threshold.
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "pi-swarm": { runRetentionMs: 1_000 } }),
    );
    const swarmRoot = resolveSwarmRoot(tmpDir);
    const runId = "old-completed";
    createManifest(
      swarmRoot,
      makeManifest(runId, { completedAt: Date.now() - 60 * 60 * 1000 }),
    );

    const result = recoverRuns(tmpDir);
    expect(result.cleanedUp).toContain(runId);
  });

  it("the default 7d retention preserves a 1-hour-old completed run", () => {
    // No .pi/settings.json — must use the 7-day default.
    const swarmRoot = resolveSwarmRoot(tmpDir);
    const runId = "recent-completed";
    createManifest(
      swarmRoot,
      makeManifest(runId, { completedAt: Date.now() - 60 * 60 * 1000 }),
    );

    const result = recoverRuns(tmpDir);
    expect(result.cleanedUp).not.toContain(runId);
  });
});
