/**
 * tests/smoke.test.ts — smoke tests that verify core modules load and
 * basic operations work without requiring a running pi instance.
 *
 * These tests validate the extension can be imported and basic
 * functionality works. They do NOT spawn real pi child processes.
 */

import { describe, it, expect, afterAll } from "vitest";
import { SubagentBatchController } from "../src/shared/controller.js";
import { renderSwarmResults, toSwarmRunResults } from "../src/shared/render.js";
import { TaskGraph, DEFAULT_TEAM_PHASES } from "../src/team/task-graph.js";
import { TeamSupervisor } from "../src/team/supervisor.js";
import { resolveSwarmMaxConcurrency } from "../src/shared/controller.js";
import {
  resolveCrewRoot,
  createManifest,
  readManifest,
  deleteRunState,
  type RunManifest,
} from "../src/state/persistence.js";
import { recoverRuns } from "../src/state/recovery.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Import verification
// ---------------------------------------------------------------------------

describe("Module imports", () => {
  it("imports controller module", () => {
    expect(SubagentBatchController).toBeDefined();
    expect(typeof SubagentBatchController).toBe("function");
  });

  it("imports render module", () => {
    expect(renderSwarmResults).toBeDefined();
    expect(typeof renderSwarmResults).toBe("function");
  });

  it("imports task-graph module", () => {
    expect(TaskGraph).toBeDefined();
  });

  it("imports supervisor module", () => {
    expect(TeamSupervisor).toBeDefined();
  });

  it("imports persistence module", () => {
    expect(resolveCrewRoot).toBeDefined();
    expect(createManifest).toBeDefined();
    expect(readManifest).toBeDefined();
  });

  it("imports recovery module", () => {
    expect(recoverRuns).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Environment variable parsing
// ---------------------------------------------------------------------------

describe("Environment config", () => {
  it("returns undefined when no settings exist", () => {
    const result = resolveSwarmMaxConcurrency("/tmp/nonexistent");
    expect(result).toBeUndefined();
  });

  it("throws on non-integer value", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "abc";
    expect(() => resolveSwarmMaxConcurrency("/tmp/nonexistent")).toThrow(
      /positive integer/,
    );
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });

  it("throws on zero", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "0";
    expect(() => resolveSwarmMaxConcurrency("/tmp/nonexistent")).toThrow(
      /positive integer/,
    );
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });

  it("throws on negative", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "-5";
    expect(() => resolveSwarmMaxConcurrency("/tmp/nonexistent")).toThrow(
      /positive integer/,
    );
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });

  it("parses env var when no settings file exists", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "10";
    const result = resolveSwarmMaxConcurrency("/tmp/nonexistent");
    expect(result).toBe(10);
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });
});

// ---------------------------------------------------------------------------
// Basic controller integration
// ---------------------------------------------------------------------------

describe("Controller integration", () => {
  it("resolves empty batch immediately", async () => {
    const mockLauncher = {
      spawn: async () => {
        throw new Error("should not be called");
      },
      resume: async () => {
        throw new Error("should not be called");
      },
      retry: async () => {
        throw new Error("should not be called");
      },
    };

    const controller = new SubagentBatchController(mockLauncher, []);
    const results = await controller.run();

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Persistence smoke
// ---------------------------------------------------------------------------

describe("Persistence smoke", () => {
  const tmpDir = path.join(os.tmpdir(), `pi-swarm-smoke-${Date.now()}`);

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates and reads a manifest", () => {
    const manifest: RunManifest = {
      runId: "test-run-001",
      type: "swarm",
      status: "running",
      goal: "Test goal",
      startedAt: Date.now(),
      agentIds: ["agent-1", "agent-2"],
    };

    createManifest(tmpDir, manifest);

    const read = readManifest(tmpDir, "test-run-001");
    expect(read).not.toBeNull();
    expect(read!.runId).toBe("test-run-001");
    expect(read!.type).toBe("swarm");
    expect(read!.status).toBe("running");
    expect(read!.agentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("returns null for non-existent manifest", () => {
    const result = readManifest(tmpDir, "nonexistent");
    expect(result).toBeNull();
  });

  it("deletes run state", () => {
    const manifest: RunManifest = {
      runId: "test-run-002",
      type: "team",
      status: "completed",
      startedAt: Date.now(),
      agentIds: [],
    };

    createManifest(tmpDir, manifest);
    expect(readManifest(tmpDir, "test-run-002")).not.toBeNull();

    deleteRunState(tmpDir, "test-run-002");
    expect(readManifest(tmpDir, "test-run-002")).toBeNull();
  });

  it("recovery returns empty for clean directory", () => {
    const result = recoverRuns(tmpDir);
    expect(result.resumable).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect(result.cleanedUp.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Task graph integration
// ---------------------------------------------------------------------------

describe("Task graph integration", () => {
  it("completes full default workflow", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    for (const name of graph.getPhaseNames()) {
      const result = graph.startPhase(name);
      expect(result.ok).toBe(true);
      graph.completePhase(name, `Done: ${name}`);
    }

    expect(graph.isComplete()).toBe(true);
    expect(graph.overallStatus()).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Supervisor integration
// ---------------------------------------------------------------------------

describe("Supervisor integration", () => {
  it("initializes with default phases", () => {
    const supervisor = new TeamSupervisor({
      cwd: process.cwd(),
      crewRoot: os.tmpdir(),
      runId: "test-supervisor-001",
      goal: "Test goal",
    });

    expect(supervisor.state.status).toBe("running");
    expect(supervisor.state.taskGraph.getPhaseNames()).toEqual([
      "explore",
      "plan",
      "implement",
      "review",
      "test",
    ]);
  });

  it("starts and completes the first phase", () => {
    const supervisor = new TeamSupervisor({
      cwd: process.cwd(),
      crewRoot: os.tmpdir(),
      runId: "test-supervisor-002",
      goal: "Test goal",
    });

    const next = supervisor.startNextPhase();
    expect(next).not.toBeNull();
    if (next) {
      expect(next.phase.phase.name).toBe("explore");
      expect(next.role).toBe("explorer");
      expect(next.prompt).toContain("Test goal");
      expect(next.prompt).toContain("explore");
    }
  });

  it("synthesizes result XML", () => {
    const supervisor = new TeamSupervisor({
      cwd: process.cwd(),
      crewRoot: os.tmpdir(),
      runId: "test-supervisor-003",
      goal: "Test",
    });

    supervisor.completePhase("explore", "Found files.");
    supervisor.completePhase("plan", "Plan ready.");
    supervisor.completePhase("implement", "Code written.");
    supervisor.completePhase("review", "Approved.");
    supervisor.completePhase("test", "All passing.");

    supervisor.finalize();

    const xml = supervisor.synthesizeResult();
    expect(xml).toContain("<agent_team_result>");
    expect(xml).toContain('outcome="completed"');
    expect(xml).toContain("explore");
    expect(xml).toContain("</agent_team_result>");
  });
});
