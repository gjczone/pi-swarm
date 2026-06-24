/**
 * tests/task-graph.test.ts — unit tests for TaskGraph (team phase DAG).
 */

import { describe, it, expect } from "vitest";
import { TaskGraph, DEFAULT_TEAM_PHASES } from "../src/team/task-graph.js";

describe("TaskGraph", () => {
  it("initializes with default phases in queued state", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    const names = graph.getPhaseNames();
    expect(names).toEqual(["explore", "plan", "implement", "review", "test"]);

    for (const name of names) {
      const phase = graph.getPhase(name);
      expect(phase).toBeDefined();
      expect(phase!.status).toBe("queued");
    }
  });

  it("starts a phase with no dependencies", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    const result = graph.startPhase("explore");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.phase.status).toBe("running");
      expect(result.phase.startedAt).toBeGreaterThan(0);
    }
  });

  it("prevents starting a phase whose dependency is not completed", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    // plan depends on explore, which is still queued
    const result = graph.startPhase("plan");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not completed");
    }
  });

  it("allows starting a phase after its dependency completes", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    // Complete explore
    let result = graph.startPhase("explore");
    expect(result.ok).toBe(true);
    graph.completePhase("explore", "Found auth module.");

    // Now plan can start
    result = graph.startPhase("plan");
    expect(result.ok).toBe(true);
  });

  it("skips downstream phases when a dependency fails", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    // Start and fail plan's dependency (explore)
    graph.startPhase("explore");
    graph.failPhase("explore", "Could not find codebase.");

    // Now try to start plan — should still be blocked
    const result = graph.startPhase("plan");
    expect(result.ok).toBe(false);
  });

  it("detects overall completion", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    for (const name of graph.getPhaseNames()) {
      graph.startPhase(name);
      graph.completePhase(name, `Result for ${name}`);
    }

    expect(graph.isComplete()).toBe(true);
    expect(graph.overallStatus()).toBe("completed");
  });

  it("reports failed when any phase fails", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    graph.startPhase("explore");
    graph.completePhase("explore", "OK");

    graph.startPhase("plan");
    graph.failPhase("plan", "Design error");

    // Skip the rest
    for (const name of ["implement", "review", "test"]) {
      graph.skipPhase(name);
    }

    expect(graph.isComplete()).toBe(true);
    expect(graph.overallStatus()).toBe("failed");
  });

  it("returns undefined for unknown phase", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    expect(graph.getPhase("nonexistent")).toBeUndefined();
  });

  it("serializes and deserializes correctly", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    graph.startPhase("explore");
    graph.completePhase("explore", "Result");

    const json = graph.toJSON();
    const restored = TaskGraph.fromJSON(json, DEFAULT_TEAM_PHASES);

    expect(restored.getPhase("explore")!.status).toBe("completed");
    expect(restored.getPhase("explore")!.result).toBe("Result");
    expect(restored.getPhase("plan")!.status).toBe("queued");
  });

  it("getCurrentPhase returns first non-terminal phase", () => {
    const graph = new TaskGraph(DEFAULT_TEAM_PHASES);

    expect(graph.getCurrentPhase()!.phase.name).toBe("explore");

    graph.startPhase("explore");
    graph.completePhase("explore", "done");

    expect(graph.getCurrentPhase()!.phase.name).toBe("plan");
  });

  it("throws on duplicate phase names", () => {
    expect(() => {
      new TaskGraph([
        { name: "a", role: "explorer" },
        { name: "a", role: "planner" },
      ]);
    }).toThrow(/Duplicate phase name/);
  });
});
