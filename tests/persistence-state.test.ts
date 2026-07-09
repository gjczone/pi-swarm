/**
 * tests/persistence-state.test.ts — tests for state persistence invariants.
 *
 * Covers:
 *   #106p — appendEvent writes complete, atomic JSONL lines
 *   #107 — updateHeartbeat updates lastHeartbeatAt so recovery uses real activity
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { getResumableAgents, recoverRuns } from "../src/state/recovery.js";

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

// ---------------------------------------------------------------------------
// #126 — readManifest distinguishes ENOENT from corruption; getResumableAgents
//        validates agentId before any filesystem operation
// ---------------------------------------------------------------------------

describe("#126 manifest corruption and agentId safety", () => {
  it("readManifest returns null silently for missing manifest (ENOENT)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = readManifest(swarmRoot, "does-not-exist");
    expect(result).toBeNull();
    // ENOENT should NOT log — it is the normal "absent" case.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("readManifest logs and returns null for corrupted JSON", () => {
    const runId = "corrupt-run";
    const runDir = path.join(swarmRoot, "state", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "manifest.json"), "{ this is not json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = readManifest(swarmRoot, runId);
    expect(result).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    const firstCall = errSpy.mock.calls[0]?.[0];
    expect(String(firstCall)).toContain("corrupted JSON");
    errSpy.mockRestore();
  });

  it("getResumableAgents skips path-traversal agentIds and logs a warning", () => {
    const runId = "traversal-run";
    // Inject a corrupted manifest with traversal-style agentIds
    const runDir = path.join(swarmRoot, "state", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const manifest: RunManifest = {
      runId,
      type: "swarm",
      status: "running",
      goal: "test",
      startedAt: Date.now(),
      agentIds: [
        "../../etc/passwd",
        "valid-agent",
        "../escape",
        "agent/../../bad",
      ],
    };
    fs.writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = getResumableAgents(swarmRoot, runId);
    // The traversal entries must NOT be present
    expect(result.has("../../etc/passwd")).toBe(false);
    expect(result.has("../escape")).toBe(false);
    expect(result.has("agent/../../bad")).toBe(false);
    // The valid agent is included (status: "not_started" since no dir exists)
    expect(result.has("valid-agent")).toBe(true);
    expect(result.get("valid-agent")).toBe("not_started");
    // Each unsafe id produces a console.error
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    errSpy.mockRestore();
  });

  it("getResumableAgents returns empty map when manifest is missing", () => {
    const result = getResumableAgents(swarmRoot, "no-such-run");
    expect(result.size).toBe(0);
  });
});
