/**
 * swarm/tool — AgentSwarm tool registration.
 *
 * Registers the `AgentSwarm` tool that the LLM can call to launch
 * multiple subagents from a shared prompt template.
 *
 * Ported from MoonshotAI/kimi-code's AgentSwarmTool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SubagentBatchController,
  resolveSwarmMaxConcurrency,
} from "../shared/controller.js";
import { renderSwarmResults, toSwarmRunResults } from "../shared/render.js";
import {
  spawnSubagent,
  resumeSubagent,
  retrySubagent,
} from "../shared/spawner.js";
import type {
  QueuedSubagentTask,
  SwarmSpawnSpec,
  SwarmResumeSpec,
  SwarmSpec,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SUBAGENT_TYPE = "coder";
const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";
const MAX_AGENT_SWARM_SUBAGENTS = 128;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const AGENT_SWARM_DESCRIPTION = `Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`["src/a.ts", "src/b.ts"]\`, AgentSwarm launches two new subagents with those two concrete prompts.

Use \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.

Use enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.

If \`AgentSwarm\` is called, that call must be the only tool call in the response.`;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentSwarmTool(
  pi: ExtensionAPI,
): void {
  pi.registerTool({
    name: "AgentSwarm",
    label: "Agent Swarm",
    description: AGENT_SWARM_DESCRIPTION,
    parameters: Type.Object(
      {
        description: Type.String({
          description:
            "Short description for the whole swarm.",
        }),
        subagent_type: Type.Optional(
          Type.String({
            description:
              "Subagent type used for every spawned subagent. Defaults to coder when omitted.",
          }),
        ),
        prompt_template: Type.Optional(
          Type.String({
            description: `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
          }),
        ),
        items: Type.Optional(
          Type.Array(Type.String(), {
            maxItems: MAX_AGENT_SWARM_SUBAGENTS,
            description:
              "Values used to fill the {{item}} placeholder. Each item launches one new subagent.",
          }),
        ),
        resume_agent_ids: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Map of existing subagent agent_id to the prompt used to resume that subagent. Resumed subagents launch before new item-based subagents.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      const { description, subagent_type, prompt_template, items, resume_agent_ids } =
        params as {
          description: string;
          subagent_type?: string;
          prompt_template?: string;
          items?: string[];
          resume_agent_ids?: Record<string, string>;
        };

      try {
        const profileName =
          normalizeOptionalString(subagent_type) ??
          DEFAULT_SUBAGENT_TYPE;

        // Build specs
        const specs = createAgentSwarmSpecs({
          items,
          resume_agent_ids,
          prompt_template,
        });

        // Convert to queued tasks
        const tasks = specs.map(
          (spec): QueuedSubagentTask<SwarmSpec> => {
            const descriptionName =
              spec.kind === "resume" ? "resume" : profileName;
            const common = {
              data: spec,
              profileName:
                spec.kind === "resume" ? "subagent" : profileName,
              parentToolCallId: toolCallId,
              prompt: spec.prompt,
              description: childDescription(
                description,
                spec.index,
                descriptionName,
              ),
              swarmIndex: spec.index,
              runInBackground: false,
              swarmItem: spec.item,
              signal,
              timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
            };

            if (spec.kind === "resume") {
              return {
                ...common,
                kind: "resume",
                resumeAgentId: spec.agentId,
              } as QueuedSubagentTask<SwarmSpec>;
            }

            return {
              ...common,
              kind: "spawn",
            } as QueuedSubagentTask<SwarmSpec>;
          },
        );

        // Run with controller
        const maxConcurrency = resolveSwarmMaxConcurrency();
        const controller = new SubagentBatchController<SwarmSpec>(
          { spawn: spawnSubagent, resume: resumeSubagent, retry: retrySubagent },
          tasks,
          { maxConcurrency },
        );
        const results = await controller.run();

        // Render output
        const swarmResults = toSwarmRunResults(results);
        const output = renderSwarmResults(swarmResults);

        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `AgentSwarm failed: ${message}` }],
          isError: true,
          details: undefined,
        };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Spec creation (from kimi-code)
// ---------------------------------------------------------------------------

function createAgentSwarmSpecs(args: {
  items?: string[];
  resume_agent_ids?: Record<string, string>;
  prompt_template?: string;
}): SwarmSpec[] {
  const resumeEntries = Object.entries(
    args.resume_agent_ids ?? {},
  ).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;

  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error(
      "AgentSwarm requires at least 2 items unless resume_agent_ids is provided.",
    );
  }

  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
    );
  }

  const promptTemplate = normalizeOptionalString(args.prompt_template);

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

  // Resume entries first
  for (const entry of resumeEntries) {
    specs.push({
      kind: "resume",
      index: specs.length + 1,
      agentId: entry.agentId,
      prompt: entry.prompt,
    } satisfies SwarmResumeSpec);
  }

  // Item-based spawns
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
      } satisfies SwarmSpawnSpec);
    });
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasMinimumAgentSwarmInputs(
  itemCount: number,
  resumeCount: number,
): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(
  swarmDescription: string,
  index: number,
  profileName: string,
): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
