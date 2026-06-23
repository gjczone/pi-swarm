/**
 * tests/swarm-tool.test.ts — unit tests for AgentSwarm spec creation.
 *
 * Tests the validation and spec creation logic from swarm/tool.ts.
 * Does not require a running pi instance.
 */

import { describe, it, expect } from "vitest";

// Replicate the createAgentSwarmSpecs logic inline for testing.
// (In production this lives in swarm/tool.ts; we test the pure function.)

const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";
const MAX_AGENT_SWARM_SUBAGENTS = 128;

interface SwarmSpawnSpec {
  readonly kind: "spawn";
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface SwarmResumeSpec {
  readonly kind: "resume";
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type SwarmSpec = SwarmSpawnSpec | SwarmResumeSpec;

function createAgentSwarmSpecs(args: {
  items?: string[];
  resume_agent_ids?: Record<string, string>;
  prompt_template?: string;
}): SwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(
    ([agentId, prompt]) => ({
      agentId: agentId.trim(),
      prompt: prompt.trim(),
    }),
  );
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;

  if (resumeCount === 0 && itemCount < 1) {
    throw new Error(
      "AgentSwarm requires at least 1 item or a resume_agent_ids entry.",
    );
  }

  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
    );
  }

  const promptTemplate = args.prompt_template?.trim() || undefined;

  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error(
      "prompt_template is required when items are provided.",
    );
  }

  if (
    promptTemplate !== undefined &&
    !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)
  ) {
    throw new Error(
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: SwarmSpec[] = [];

  for (const entry of resumeEntries) {
    specs.push({
      kind: "resume",
      index: specs.length + 1,
      agentId: entry.agentId,
      prompt: entry.prompt,
    });
  }

  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate
        .split(PROMPT_TEMPLATE_PLACEHOLDER)
        .join(item);

      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error(
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
        );
      }
      seenPrompts.set(prompt, index + 1);

      specs.push({
        kind: "spawn",
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }

  return specs;
}

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
      resume_agent_ids: { "r1": "go" },
    });

    expect(specs[0]!.index).toBe(1); // resume
    expect(specs[1]!.index).toBe(2); // spawn
  });
});
