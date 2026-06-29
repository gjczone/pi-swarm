/**
 * tests/persistence-state.test.ts — tests for state persistence invariants.
 *
 * Covers:
 *   #106p — appendEvent writes complete, atomic JSONL lines
 *   #107 — updateHeartbeat updates lastHeartbeatAt so recovery uses real activity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveSwarmRoot,
  createManifest,
  readManifest,
  updateManifest,
  appendEvent,
  updateHeartbeat,
  type RunManifest,
} from "../src/state/persistence.js";
import { recoverRuns } from "../src/state/recovery.js";

let tmpDir: string;
let swarmRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-pst-"));
  swarmRoot = resolveSwarmRoot(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManifest(
  runId: string,
  overrides: Partial<RunManifest> = {},
): RunManifest {
  return {
    runId,
    type: "swarm",
    status: "running",
    goal: "test",
    startedAt: Date.now(),
    agentIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// #106p — appendEvent atomic JSONL writes
// ---------------------------------------------------------------------------

describe("#106p appendEvent writes complete lines", () => {
  it("appends events as complete, parseable JSONL lines", () => {
    const runId = "evt-run";
    createManifest(swarmRoot, makeManifest(runId));

    for (let i = 0; i < 30; i += 1) {
      appendEvent(swarmRoot, runId, { type: "test", seq: i });
    }

    const eventsFile = path.join(
      swarmRoot,
      "state",
      "runs",
      runId,
      "events.jsonl",
    );
    const raw = fs.readFileSync(eventsFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(30);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// #107 — updateHeartbeat updates lastHeartbeatAt
// ---------------------------------------------------------------------------

describe("#107 updateHeartbeat", () => {
  it("sets lastHeartbeatAt on a running manifest", () => {
    const runId = "hb-run";
    createManifest(swarmRoot, makeManifest(runId));

    const before = readManifest(swarmRoot, runId);
    expect(before!.lastHeartbeatAt).toBeUndefined();

    updateHeartbeat(swarmRoot, runId);

    const after = readManifest(swarmRoot, runId);
    expect(after!.lastHeartbeatAt).toBeTypeOf("number");
    expect(after!.lastHeartbeatAt).toBeGreaterThan(0);
  });

  it("prevents a live run from being marked stale by recoverRuns", () => {
    const runId = "hb-stale-run";
    // Simulate a run that started 2 hours ago but had a heartbeat 1 minute ago.
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const oneMinuteAgo = Date.now() - 60 * 1000;
    createManifest(swarmRoot, makeManifest(runId, { startedAt: twoHoursAgo }));
    // Manually set a recent heartbeat via updateManifest (simulating controller calls)
    const m = readManifest(swarmRoot, runId)!;
    m.lastHeartbeatAt = oneMinuteAgo;
    updateManifest(swarmRoot, m);

    // recoverRuns expects the project cwd, not the resolved swarmRoot
    const result = recoverRuns(tmpDir);
    // A run with a recent heartbeat must NOT be marked abandoned.
    expect(result.abandoned.some((m) => m.runId === runId)).toBe(false);
  });

  it("a run with a stale heartbeat IS marked abandoned", () => {
    const runId = "hb-old-run";
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    createManifest(
      swarmRoot,
      makeManifest(runId, {
        startedAt: twoHoursAgo,
        lastHeartbeatAt: twoHoursAgo, // heartbeat as old as start
      }),
    );

    // recoverRuns expects the project cwd, not the resolved swarmRoot
    const result = recoverRuns(tmpDir);
    expect(result.abandoned.some((m) => m.runId === runId)).toBe(true);
  });
});
