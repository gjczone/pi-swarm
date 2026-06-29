/**
 * tests/coordinator.test.ts — unit tests for coordinator helpers.
 *
 * Covers:
 *   #102 — resolveAgentId returns undefined for unknown agents
 *   #103 — SwarmStatus honors the runId filter
 *   #104 — runToSummary counts unique agentIds, not agent_started events
 */

import { describe, it, expect } from "vitest";
import {
  resolveAgentId,
  runToSummary,
  summarizeRuns,
  type ActiveCoordinatorRun,
} from "../src/swarm/coordinator.js";
import type {
  SubagentEvent,
  SubagentResult,
  SwarmSpec,
} from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  agentId: string,
  agentName: string,
  eventType: "agent_started" | "agent_completed" = "agent_started",
  runId = "run-1",
): SubagentEvent<SwarmSpec> {
  return { runId, agentId, agentName, eventType, timestamp: Date.now() };
}

function makeResult(
  agentId: string,
  status: "completed" | "failed" | "aborted" = "completed",
): SubagentResult<SwarmSpec> {
  return {
    task: {
      kind: "spawn",
      data: { kind: "spawn", index: 1, item: agentId, prompt: "p" },
      profileName: "general",
      parentToolCallId: "t",
      prompt: "p",
      description: "d",
      swarmIndex: 1,
      runInBackground: false,
    },
    agentId,
    status,
    result: status === "completed" ? "ok" : undefined,
    error: status !== "completed" ? "err" : undefined,
  };
}

function makeRun(opts: {
  runId?: string;
  events?: SubagentEvent<SwarmSpec>[];
  results?: SubagentResult<SwarmSpec>[];
  description?: string;
  completed?: boolean;
}): ActiveCoordinatorRun {
  const runId = opts.runId ?? "run-1";
  const results = opts.results ?? [];
  return {
    runId,
    handle: {
      runId,
      getResults: () => results,
      sendMessage: () => undefined,
      stopAgent: () => undefined,
      abort: () => undefined,
      completion: Promise.resolve(results),
    },
    results,
    events: opts.events ?? [],
    swarmRoot: "/tmp",
    description: opts.description,
    completed: opts.completed ?? false,
    completionPromise: Promise.resolve(results),
  };
}

// ---------------------------------------------------------------------------
// #102 — resolveAgentId
// ---------------------------------------------------------------------------

describe("#102 resolveAgentId", () => {
  it("returns the agentId when an event's agentName matches", () => {
    const run = makeRun({ events: [makeEvent("a-1", "explorer")] });
    expect(resolveAgentId(run, "explorer")).toBe("a-1");
  });

  it("returns undefined when no event matches the name", () => {
    const run = makeRun({ events: [makeEvent("a-1", "explorer")] });
    expect(resolveAgentId(run, "nonexistent")).toBeUndefined();
  });

  it("resolves by agentId when the name does not match but the id does", () => {
    const run = makeRun({ events: [makeEvent("a-1", "explorer")] });
    // Passing the agentId directly should also resolve.
    expect(resolveAgentId(run, "a-1")).toBe("a-1");
  });

  it("returns undefined for an empty events list", () => {
    const run = makeRun({ events: [] });
    expect(resolveAgentId(run, "anything")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #104 — runToSummary counts unique agents
// ---------------------------------------------------------------------------

describe("#104 runToSummary unique agent count", () => {
  it("counts unique agentIds, not duplicate agent_started events from retries", () => {
    // Agent a-1 started twice (retry emits agent_started again) but is one agent.
    const run = makeRun({
      events: [
        makeEvent("a-1", "alpha"),
        makeEvent("a-1", "alpha"), // retry — duplicate agent_started
        makeEvent("b-2", "beta"),
      ],
      results: [makeResult("a-1"), makeResult("b-2")],
    });

    const summary = runToSummary(run);

    expect(summary).toContain("Agents: 2 total");
    expect(summary).toContain("2 completed");
    expect(summary).not.toContain("3 total");
  });

  it("reports still-running count correctly from unique agents", () => {
    const run = makeRun({
      events: [
        makeEvent("a-1", "alpha"),
        makeEvent("b-2", "beta"),
        makeEvent("b-2", "beta"), // retry
      ],
      results: [makeResult("a-1")], // only a-1 completed; b-2 still running
    });

    const summary = runToSummary(run);

    expect(summary).toContain("Agents: 2 total");
    expect(summary).toContain("1 completed");
    expect(summary).toContain("1 running");
  });
});

// ---------------------------------------------------------------------------
// #103 — summarizeRuns honors runId filter
// ---------------------------------------------------------------------------

describe("#103 summarizeRuns runId filter", () => {
  it("returns summaries for all runs when no runId is provided", () => {
    const runs = [
      makeRun({ runId: "run-a", description: "Alpha" }),
      makeRun({ runId: "run-b", description: "Beta" }),
    ];
    const out = summarizeRuns(runs);
    expect(out).toContain("run-a");
    expect(out).toContain("run-b");
  });

  it("returns only the requested run when runId is provided", () => {
    const runs = [
      makeRun({ runId: "run-a", description: "Alpha" }),
      makeRun({ runId: "run-b", description: "Beta" }),
    ];
    const out = summarizeRuns(runs, "run-a");
    expect(out).toContain("run-a");
    expect(out).not.toContain("run-b");
  });

  it("reports a not-found message when the runId does not match any run", () => {
    const runs = [makeRun({ runId: "run-a" })];
    const out = summarizeRuns(runs, "nonexistent");
    expect(out).toMatch(/not found|no run/i);
  });
});
