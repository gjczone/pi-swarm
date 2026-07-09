/**
 * tests/swarm-tool.test.ts — unit tests for AgentSwarm spec creation.
 *
 * Tests the validation and spec creation logic from src/swarm/specs.ts.
 * Does not require a running pi instance.
 */

import { describe, it, expect } from "vitest";
import { createAgentSwarmSpecs } from "../src/swarm/specs.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentSwarmSpecs", () => {
  it("creates spawn specs for a simple item list", () => {
    const specs = createAgentSwarmSpecs({
      prompt_template: "Review {{item}} for bugs.",
      items: ["src/a.ts", "src/b.ts", "src/c.ts"],
    });

    expect(specs).toHaveLength(3);
    expect(specs[0]).toMatchObject({
      kind: "spawn",
      index: 1,
      item: "src/a.ts",
      prompt: "Review src/a.ts for bugs.",
    });
    expect(specs[1]).toMatchObject({
      kind: "spawn",
      index: 2,
      item: "src/b.ts",
      prompt: "Review src/b.ts for bugs.",
    });
    expect(specs[2]).toMatchObject({
      kind: "spawn",
      index: 3,
      item: "src/c.ts",
      prompt: "Review src/c.ts for bugs.",
    });
  });

  it("allows a single item without resume ids", () => {
    const specs = createAgentSwarmSpecs({
      prompt_template: "Process {{item}}",
      items: ["only-one"],
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]!.kind).toBe("spawn");
    expect(specs[0]!.item).toBe("only-one");
  });

  it("throws when 0 items and no resume ids", () => {
    expect(() =>
      createAgentSwarmSpecs({
        prompt_template: "Process {{item}}",
        items: [],
      }),
    ).toThrow(/at least 1 item/);
  });

  it("allows 1 item when resume_agent_ids is provided", () => {
    const specs = createAgentSwarmSpecs({
      prompt_template: "Process {{item}}",
      items: ["only-one"],
      resume_agent_ids: { "agent-1": "continue" },
    });

    expect(specs).toHaveLength(2); // 1 resume + 1 spawn
    expect(specs[0]!.kind).toBe("resume");
    expect(specs[1]!.kind).toBe("spawn");
  });

  it("throws when prompt_template is missing for items", () => {
    expect(() =>
      createAgentSwarmSpecs({
        items: ["a", "b"],
      }),
    ).toThrow(/prompt_template is required/);
  });

  it("throws when prompt_template does not contain {{item}}", () => {
    expect(() =>
      createAgentSwarmSpecs({
        prompt_template: "No placeholder here",
        items: ["a", "b"],
      }),
    ).toThrow(/must include the {{item}} placeholder/);
  });

  it("throws when prompt_template contains {{item}} more than once (#165)", () => {
    expect(() =>
      createAgentSwarmSpecs({
        prompt_template: "Fix {{item}} in {{item}}",
        items: ["a", "b"],
      }),
    ).toThrow(/exactly once/);
  });

  it("throws on duplicate prompts", () => {
    expect(() =>
      createAgentSwarmSpecs({
        prompt_template: "Process {{item}}",
        items: ["same", "same"],
      }),
    ).toThrow(/Duplicate subagent prompts/);
  });

  it("throws when total exceeds max", () => {
    const items = Array.from({ length: 129 }, (_, i) => `item-${i}`);
    expect(() =>
      createAgentSwarmSpecs({
        prompt_template: "Process {{item}}",
        items,
      }),
    ).toThrow(/at most 128/);
  });

  it("resume entries come before spawn entries", () => {
    const specs = createAgentSwarmSpecs({
      prompt_template: "Process {{item}}",
      items: ["new-a", "new-b"],
      resume_agent_ids: {
        "old-1": "continue old-1",
        "old-2": "continue old-2",
      },
    });

    expect(specs).toHaveLength(4);
    expect(specs[0]!.kind).toBe("resume");
    expect(specs[1]!.kind).toBe("resume");
    expect(specs[2]!.kind).toBe("spawn");
    expect(specs[3]!.kind).toBe("spawn");
  });

  it("applies 1-based indexing across resume and spawn", () => {
    const specs = createAgentSwarmSpecs({
      prompt_template: "Process {{item}}",
      items: ["a"],
      resume_agent_ids: { r1: "go" },
    });

    expect(specs[0]!.index).toBe(1); // resume
    expect(specs[1]!.index).toBe(2); // spawn
  });

  it("rejects path traversal in resume_agent_ids keys", () => {
    expect(() =>
      createAgentSwarmSpecs({
        resume_agent_ids: { "../../evil": "continue" },
      }),
    ).toThrow(/unsafe characters|Invalid agentId/);
  });

  it("rejects path separators in resume_agent_ids keys", () => {
    expect(() =>
      createAgentSwarmSpecs({
        resume_agent_ids: { "agent/../../escape": "continue" },
      }),
    ).toThrow(/unsafe characters|Invalid agentId/);
  });
});
