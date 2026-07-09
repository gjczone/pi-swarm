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
  readEvents,
  loadAgentStatus,
  resolveRunStateDir,
  resolveAgentStateDir,
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

  it("getResumableAgents normalizes status casing (#164)", () => {
    const runId = "case-run";
    const runDir = path.join(swarmRoot, "state", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const manifest: RunManifest = {
      runId,
      type: "swarm",
      status: "running",
      goal: "test",
      startedAt: Date.now(),
      agentIds: ["agent-cap"],
    };
    fs.writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    const agentDir = path.join(runDir, "agents", "agent-cap");
    fs.mkdirSync(agentDir, { recursive: true });
    // Non-standard casing ("Running") as if produced by another runtime version.
    fs.writeFileSync(
      path.join(agentDir, "status.json"),
      JSON.stringify({ status: "Running", agentId: "agent-cap" }),
    );

    const result = getResumableAgents(swarmRoot, runId);
    expect(result.get("agent-cap")).toBe("resumable");
  });
});

// ---------------------------------------------------------------------------
// #140 — readEvents / loadAgentStatus log errors instead of silently
// returning. Per the #137 pattern: ENOENT is the common case (file not
// yet created) and is suppressed; other I/O faults log and return the
// safe default. readEvents inner catch uses the MAX_PER_LINE_LOGS cap.
// ---------------------------------------------------------------------------

describe("#140 readEvents / loadAgentStatus log instead of swallowing", () => {
  it("readEvents silently returns [] when the events file is missing (ENOENT — common case)", () => {
    // ENOENT: a fresh run that has not yet written any events is the
    // common case. Per the #137 review, suppress the log.
    const runId = "no-events-run";
    fs.mkdirSync(resolveRunStateDir(swarmRoot, runId), { recursive: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(readEvents(swarmRoot, runId)).toEqual([]);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("readEvents logs and skips corrupted lines, returns valid ones", () => {
    const runId = "events-corrupt";
    const dir = resolveRunStateDir(swarmRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    const eventsFile = path.join(dir, "events.jsonl");
    const valid1 = JSON.stringify({ type: "ok", seq: 1 });
    const valid2 = JSON.stringify({ type: "ok", seq: 2 });
    const corrupt = "{ not valid";
    fs.writeFileSync(eventsFile, `${valid1}\n${corrupt}\n${valid2}\n`);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readEvents(swarmRoot, runId);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: "ok", seq: 1 });
      expect(result[1]).toEqual({ type: "ok", seq: 2 });
      expect(errSpy).toHaveBeenCalled();
      const log = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toContain(eventsFile);
      expect(log).toMatch(/[Cc]orrupted/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("readEvents caps per-line corruption logs at MAX_PER_LINE_LOGS and emits a summary", () => {
    // #140 review: a heavily corrupt file would otherwise produce N log
    // entries per read. Cap at MAX_PER_LINE_LOGS (5) per-line + summary.
    const runId = "events-spam";
    const dir = resolveRunStateDir(swarmRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    const eventsFile = path.join(dir, "events.jsonl");
    const corruptLines = Array.from({ length: 20 }, (_, i) => `{ invalid ${i}`);
    fs.writeFileSync(eventsFile, corruptLines.join("\n") + "\n");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readEvents(swarmRoot, runId);
      expect(result).toEqual([]);
      // Per-line logs ≤ 5 + 1 summary = 6 total
      const perLineCount = errSpy.mock.calls.filter((c) =>
        /[Cc]orrupted JSONL line/.test(String(c[0])),
      ).length;
      const summaryCount = errSpy.mock.calls.filter((c) =>
        /skipped 20 corrupted line/.test(String(c[0])),
      ).length;
      expect(perLineCount).toBeLessThanOrEqual(5);
      expect(summaryCount).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("loadAgentStatus silently returns null when the status file is missing (ENOENT — common case)", () => {
    // ENOENT: an agent that has not yet written its status file is the
    // common case. Per the #137 review, suppress the log.
    const runId = "agent-no-status";
    const agentId = "agent-1";
    fs.mkdirSync(resolveAgentStateDir(swarmRoot, runId, agentId), {
      recursive: true,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadAgentStatus(swarmRoot, runId, agentId)).toBeNull();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("loadAgentStatus logs and returns null when the status file is corrupt", () => {
    const runId = "agent-corrupt";
    const agentId = "agent-1";
    const dir = resolveAgentStateDir(swarmRoot, runId, agentId);
    fs.mkdirSync(dir, { recursive: true });
    const statusFile = path.join(dir, "status.json");
    fs.writeFileSync(statusFile, "{ not valid json");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadAgentStatus(swarmRoot, runId, agentId)).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      const log = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toContain(statusFile);
    } finally {
      errSpy.mockRestore();
    }
  });
});
