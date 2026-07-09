/**
 * swarm/specs — createAgentSwarmSpecs for the AgentSwarm tool.
 *
 * #127: extracted from the test fixture in tests/swarm-tool.test.ts so the
 * production Swarm tool handler and the test suite share one source of
 * truth. Adds:
 *   - 128-subagent cap (MAX_AGENT_SWARM_SUBAGENTS) — matches AGENTS.md
 *     "Single to 128 subagents" and the test intent
 *   - Duplicate prompt detection (throws with both colliding indices)
 *   - Resume entries first, then spawn entries
 *   - 1-based indexing across resume + spawn
 *   - path-traversal rejection in resume_agent_ids keys
 */

import { validateId } from "../state/persistence.js";
import type { SwarmSpec } from "../shared/types.js";

export const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";

/** Maximum number of subagents in a single AgentSwarm call (#127). */
export const MAX_AGENT_SWARM_SUBAGENTS = 128;

export interface CreateAgentSwarmSpecsArgs {
  items?: string[];
  resume_agent_ids?: Record<string, string>;
  prompt_template?: string;
}

/**
 * Build the spawn + resume spec list from AgentSwarm tool parameters.
 *
 * Throws on:
 *   - empty items and no resume entries
 *   - missing prompt_template when items are provided
 *   - prompt_template without the {{item}} placeholder
 *   - total (items + resume) > MAX_AGENT_SWARM_SUBAGENTS
 *   - duplicate resolved prompts (cost amplification)
 *   - unsafe characters in resume_agent_ids keys (path traversal)
 */
export function createAgentSwarmSpecs(
  args: CreateAgentSwarmSpecsArgs,
): SwarmSpec[] {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(
    ([agentId, prompt]) => {
      const trimmedId = agentId.trim();
      validateId(trimmedId, "agentId");
      return {
        agentId: trimmedId,
        prompt: prompt.trim(),
      };
    },
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
    throw new Error("prompt_template is required when items are provided.");
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
