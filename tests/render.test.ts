/**
 * tests/render.test.ts — unit tests for XML result rendering.
 */

import { describe, it, expect } from "vitest";
import { renderSwarmResults } from "../src/shared/render.js";
import type { SwarmSpawnSpec, SwarmResumeSpec } from "../src/shared/types.js";

// Use the internal SwarmRunResult type (matches the render function's input)
interface SwarmRunResult {
  readonly spec: SwarmSpawnSpec | SwarmResumeSpec;
  readonly agentId?: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly state?: "started" | "not_started";
  readonly result?: string;
  readonly error?: string;
}

function makeSpawnSpec(index: number, item: string): SwarmSpawnSpec {
  return {
    kind: "spawn",
    index,
    item,
    prompt: `Process ${item}`,
  };
}

function makeResumeSpec(
  index: number,
  agentId: string,
): SwarmResumeSpec {
  return {
    kind: "resume",
    index,
    agentId,
    prompt: "continue",
  };
}

describe("renderSwarmResults", () => {
  it("renders a single completed result", () => {
    const results: SwarmRunResult[] = [
      {
        spec: makeSpawnSpec(1, "src/a.ts"),
        agentId: "swarm-001",
        status: "completed",
        result: "No bugs found.",
      },
    ];

    const xml = renderSwarmResults(results);

    expect(xml).toContain("<agent_swarm_result>");
    expect(xml).toContain("<summary>completed: 1</summary>");
    expect(xml).toContain('agent_id="swarm-001"');
    expect(xml).toContain('outcome="completed"');
    expect(xml).toContain("No bugs found.");
    expect(xml).toContain("</agent_swarm_result>");
  });

  it("renders mixed completed and failed results", () => {
    const results: SwarmRunResult[] = [
      {
        spec: makeSpawnSpec(1, "a.ts"),
        agentId: "a1",
        status: "completed",
        result: "OK",
      },
      {
        spec: makeSpawnSpec(2, "b.ts"),
        agentId: "a2",
        status: "failed",
        error: "File not found",
      },
    ];

    const xml = renderSwarmResults(results);

    expect(xml).toContain("completed: 1, failed: 1");
    expect(xml).toContain("<resume_hint>");
    expect(xml).toContain('outcome="failed"');
    expect(xml).toContain("File not found");
  });

  it("renders resume specs with mode attribute", () => {
    const results: SwarmRunResult[] = [
      {
        spec: makeResumeSpec(1, "old-agent"),
        agentId: "old-agent",
        status: "completed",
        result: "Resumed and finished.",
      },
    ];

    const xml = renderSwarmResults(results);

    expect(xml).toContain('mode="resume"');
    expect(xml).toContain("Resumed and finished.");
  });

  it("escapes XML special characters", () => {
    const results: SwarmRunResult[] = [
      {
        spec: makeSpawnSpec(1, 'file"with"quotes'),
        agentId: "agent-1",
        status: "completed",
        result: "Result with <tags> & symbols",
      },
    ];

    const xml = renderSwarmResults(results);

    // Item attribute should have escaped quotes
    expect(xml).toContain("&quot;");
    // Body should have escaped angle brackets
    expect(xml).toContain("&lt;tags&gt;");
    expect(xml).toContain("&amp;");
  });

  it("does not include resume hint when all completed", () => {
    const results: SwarmRunResult[] = [
      {
        spec: makeSpawnSpec(1, "a"),
        agentId: "a1",
        status: "completed",
        result: "ok",
      },
      {
        spec: makeSpawnSpec(2, "b"),
        agentId: "a2",
        status: "completed",
        result: "ok",
      },
    ];

    const xml = renderSwarmResults(results);

    expect(xml).not.toContain("<resume_hint>");
  });

  it("renders aborted results with state", () => {
    const results: SwarmRunResult[] = [
      {
        spec: makeSpawnSpec(1, "a"),
        status: "aborted",
        state: "not_started",
        error: "Cancelled by user.",
      },
    ];

    const xml = renderSwarmResults(results);

    expect(xml).toContain('outcome="aborted"');
    expect(xml).toContain('state="not_started"');
    expect(xml).toContain("aborted: 1");
  });

  it("handles empty results gracefully", () => {
    const xml = renderSwarmResults([]);

    expect(xml).toContain("<agent_swarm_result>");
    expect(xml).toContain("<summary></summary>");
    expect(xml).toContain("</agent_swarm_result>");
  });
});
