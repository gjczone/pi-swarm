/**
 * swarm/coordinator — Non-blocking coordinator mode for multi-turn swarm orchestration.
 *
 * Registers SwarmCoordinator, SendMessage, and TaskStop tools that allow
 * the main agent to launch a swarm, remain active across turns, send
 * messages to running agents, and stop individual agents.
 *
 * Unlike the blocking Swarm tool which waits for all agents to complete
 * before returning, SwarmCoordinator returns immediately with a runId.
 * The coordinator (main agent) stays in control and can:
 * - Send messages to agents via SendMessage
 * - Stop individual agents via TaskStop
 * - Check progress and collect results
 * - Intervene when agents complete (via events)
 */

import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SubagentBatchController,
  resolveSwarmMaxConcurrency,
  resolveSwarmSmallModel,
} from "../shared/controller.js";
import {
  spawnSubagent,
  resumeSubagent,
  retrySubagent,
} from "../shared/spawner.js";
import type {
  QueuedSubagentTask,
  SwarmHandle,
  SubagentEvent,
  SubagentResult,
  SwarmSpawnSpec,
  SwarmSpec,
} from "../shared/types.js";
import {
  resolveProfile,
  resolveProfileTools,
  deriveAgentName,
} from "../shared/profiles.js";
import {
  resolveSwarmRoot,
  createManifest,
  updateManifest,
  readManifest,
  registerAgentInManifest,
} from "../state/persistence.js";
import * as fs from "node:fs";
import * as path from "node:path";

const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";
const MAX_ITEM_COUNT = 20;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

const COORDINATOR_DESCRIPTION = [
  "Launch a non-blocking swarm of 1-20 subagents and stay in control across turns.",
  "",
  "Unlike the blocking Swarm tool, SwarmCoordinator returns immediately with a runId.",
  "You (the main agent) remain active and can orchestrate agents while they run.",
  "",
  "After launching, you can:",
  "- Send messages to running agents with SendMessage(runId, agentName, message)",
  "- Stop individual agents with TaskStop(runId, agentName)",
  "- Agents continue running across conversation turns until they complete or are stopped.",
  "",
  "Agent profiles:",
  '- "general" (default): Full read/write access.',
  '- "explore": Read-only search. No file modifications.',
  '- "plan": Read-only planner. Produces structured plans.',
  '- "review": Read-only reviewer. Produces structured findings.',
  "",
  "Use this when you need to launch agents and then react to their progress",
  "or give them additional instructions while they work.",
].join("\n");

interface ActiveCoordinatorRun {
  runId: string;
  handle: SwarmHandle<SwarmSpec>;
  results: Array<SubagentResult<SwarmSpec>>;
  events: Array<SubagentEvent<SwarmSpec>>;
  swarmRoot: string;
  description?: string;
  completed: boolean;
  completionPromise: Promise<Array<SubagentResult<SwarmSpec>>>;
}

const activeRuns = new Map<string, ActiveCoordinatorRun>();

/**
 * Get the per-agent message inbox path for SendMessage.
 */
function getAgentInboxPath(
  swarmRoot: string,
  runId: string,
  agentId: string,
): string {
  return path.join(
    swarmRoot,
    "runs",
    runId,
    "coord",
    "inboxes",
    `${agentId}.jsonl`,
  );
}

/**
 * Resolve an agent's display name to its agentId for a given run.
 */
function resolveAgentId(
  run: ActiveCoordinatorRun,
  nameOrId: string,
): string | undefined {
  for (const e of run.events) {
    if (e.agentName === nameOrId && e.agentId) return e.agentId;
  }
  return nameOrId;
}

function getRun(runId: string): ActiveCoordinatorRun {
  const run = activeRuns.get(runId);
  if (!run) {
    throw new Error(
      `No active coordinator run with id: ${runId}. Available runs: ${Array.from(activeRuns.keys()).join(", ") || "(none)"}`,
    );
  }
  return run;
}

function runToSummary(run: ActiveCoordinatorRun): string {
  const results = run.handle.getResults();
  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const aborted = results.filter((r) => r.status === "aborted").length;
  const total = run.events.filter(
    (e) => e.eventType === "agent_started",
  ).length;
  const stillRunning = total - completed - failed - aborted;
  const lines = [
    `Run: ${run.runId}`,
    `Status: ${run.completed ? "completed" : "running"}`,
    `Agents: ${total} total, ${completed} completed, ${failed} failed, ${stillRunning} running`,
  ];
  if (run.description) lines.push(`Description: ${run.description}`);

  if (completed > 0) {
    lines.push("");
    lines.push("Completed agents:");
    for (const r of results) {
      if (r.status === "completed") {
        const name = r.agentId ?? "(unknown)";
        const preview = r.result
          ? r.result.length > 100
            ? r.result.slice(0, 100) + "..."
            : r.result
          : "(no output)";
        lines.push(`  - ${name}: ${preview}`);
      }
    }
  }
  if (failed > 0) {
    lines.push("");
    lines.push("Failed agents:");
    for (const r of results) {
      if (r.status === "failed") {
        lines.push(
          `  - ${r.agentId ?? "(unknown)"}: ${r.error ?? "unknown error"}`,
        );
      }
    }
  }

  return lines.join("\n");
}

export function registerCoordinatorTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "SwarmCoordinator",
    label: "SwarmCoordinator",
    description: COORDINATOR_DESCRIPTION,
    parameters: Type.Object(
      {
        description: Type.Optional(
          Type.String({
            description: "Short description for the swarm.",
          }),
        ),
        profile: Type.Optional(
          Type.String({
            description:
              'Agent profile: "general" (default), "explore", "plan", "review", or custom.',
          }),
        ),
        prompt_template: Type.String({
          description: `Prompt template with ${PROMPT_TEMPLATE_PLACEHOLDER} exactly once.`,
        }),
        items: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: MAX_ITEM_COUNT,
          description: "Items (1-20) to parallelize across.",
        }),
        model: Type.Optional(
          Type.String({
            description:
              'Model: "small" for lightweight tasks, or explicit model ID. Omit to inherit.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) => {
      const { description, prompt_template, items, model, profile } =
        params as {
          description?: string;
          prompt_template: string;
          items: string[];
          model?: string;
          profile?: string;
        };

      const resolvedModel =
        model === "small" ? resolveSwarmSmallModel() : model;

      const agentProfile = resolveProfile(profile, process.cwd());
      const profileName = agentProfile.name;
      const profileModel =
        agentProfile.model === "inherit" ? undefined : agentProfile.model;
      const effectiveModel = profileModel ?? resolvedModel;
      const profileTools = resolveProfileTools(agentProfile);

      const swarmRoot =
        process.env.PI_SWARM_ROOT ?? resolveSwarmRoot(process.cwd());
      const runId = `coord-${Date.now().toString(36)}`;

      const placeholderCount =
        prompt_template.split(PROMPT_TEMPLATE_PLACEHOLDER).length - 1;
      if (placeholderCount !== 1) {
        throw new Error(
          `prompt_template must contain {{item}} exactly once, found ${placeholderCount} occurrence(s).`,
        );
      }

      const specs = items.map(
        (item: string, index: number) =>
          ({
            kind: "spawn" as const,
            index: index + 1,
            item: item.trim(),
            prompt: prompt_template
              .split(PROMPT_TEMPLATE_PLACEHOLDER)
              .join(item.trim()),
          }) satisfies SwarmSpawnSpec,
      );

      const coordDir = path.join(swarmRoot, "runs", runId, "coord");
      const inboxesDir = path.join(coordDir, "inboxes");
      fs.mkdirSync(inboxesDir, { recursive: true });

      createManifest(swarmRoot, {
        runId,
        type: "coordinator",
        status: "running",
        goal: description ?? "Coordinator Swarm",
        startedAt: Date.now(),
        agentIds: [],
      });

      const tasks = specs.map((spec, idx): QueuedSubagentTask<SwarmSpec> => {
        const agentName = deriveAgentName(profileName, spec.item, idx + 1);
        const agentId = `${runId}-${idx + 1}`;
        const messageInboxPath = getAgentInboxPath(swarmRoot, runId, agentId);
        return {
          kind: "spawn",
          data: spec,
          profileName,
          agentName,
          parentToolCallId: toolCallId,
          prompt: spec.prompt,
          description: `${description ?? "Coordinator"} #${spec.index} (${agentName})`,
          swarmIndex: spec.index,
          runInBackground: true,
          swarmItem: spec.item,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
          swarmRoot,
          runId,
          useWorktree: true,
          model: effectiveModel,
          tools: profileTools,
          additionalSystemPrompt: agentProfile.systemPrompt,
          roleName: agentName,
          messageInboxPath,
        };
      });

      const maxConcurrency = resolveSwarmMaxConcurrency(process.cwd());
      const events: Array<SubagentEvent<SwarmSpec>> = [];
      const controller = new SubagentBatchController<SwarmSpec>(
        {
          spawn: spawnSubagent,
          resume: resumeSubagent,
          retry: retrySubagent,
        },
        tasks,
        { maxConcurrency },
      );

      const handle = controller.runAsync(runId, {
        onEvent: (event) => {
          events.push(event);
          if (event.agentId) {
            registerAgentInManifest(swarmRoot, runId, event.agentId);
          }
        },
      });

      const run: ActiveCoordinatorRun = {
        runId,
        handle,
        results: [],
        events,
        swarmRoot,
        description,
        completed: false,
        completionPromise: handle.completion.then(
          (results) => {
            run.completed = true;
            run.results = results;
            const manifest = readManifest(swarmRoot, runId);
            if (manifest) {
              manifest.status = "completed";
              manifest.completedAt = Date.now();
              updateManifest(swarmRoot, manifest);
            }
            return results;
          },
          (err) => {
            run.completed = true;
            const manifest = readManifest(swarmRoot, runId);
            if (manifest) {
              manifest.status = "failed";
              manifest.completedAt = Date.now();
              manifest.error = err instanceof Error ? err.message : String(err);
              updateManifest(swarmRoot, manifest);
            }
            throw err;
          },
        ),
      };

      activeRuns.set(runId, run);

      return {
        content: [
          {
            type: "text",
            text:
              `Coordinator swarm launched: ${runId}\n` +
              `Agents: ${specs.length}\n` +
              `Profile: ${profileName}\n\n` +
              `Agents are now running in the background. You can:\n` +
              `- Continue working while agents execute\n` +
              `- Use SendMessage(${runId}, <agentName>, <message>) to send instructions\n` +
              `- Use TaskStop(${runId}, <agentName>) to stop an agent\n` +
              `- Agent results will be available as they complete.\n\n` +
              `Agents: ${specs.map((s, i) => `${i + 1}. ${deriveAgentName(profileName, s.item, i + 1)}`).join("\n")}`,
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "SendMessage",
    label: "SendMessage",
    description:
      "Send a message to a running agent in a coordinator swarm. The agent will receive it in their inbox and can read it during their execution.",
    parameters: Type.Object(
      {
        runId: Type.String({
          description: "The run ID returned by SwarmCoordinator.",
        }),
        agentName: Type.String({
          description:
            "Agent name or agent ID to send the message to. Use 'broadcast' to send to all agents.",
        }),
        message: Type.String({
          description: "The message content to send.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      const { runId, agentName, message } = params as {
        runId: string;
        agentName: string;
        message: string;
      };

      const run = getRun(runId);

      if (agentName === "broadcast") {
        for (const e of run.events.filter(
          (e) => e.eventType === "agent_started",
        )) {
          if (e.agentId) {
            run.handle.sendMessage(e.agentId, message);
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Message broadcast to all agents in run ${runId}.`,
            },
          ],
          details: undefined,
        };
      }

      const agentId = resolveAgentId(run, agentName);
      if (!agentId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent "${agentName}" not found in run ${runId}.`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      run.handle.sendMessage(agentId, message);

      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to agent ${agentName} (${agentId}).`,
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: "Stop a running agent in a coordinator swarm.",
    parameters: Type.Object(
      {
        runId: Type.String({
          description: "The run ID returned by SwarmCoordinator.",
        }),
        agentName: Type.String({
          description: "Agent name or ID to stop.",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      const { runId, agentName } = params as {
        runId: string;
        agentName: string;
      };

      const run = getRun(runId);
      const agentId = resolveAgentId(run, agentName);

      if (!agentId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent "${agentName}" not found in run ${runId}.`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      run.handle.stopAgent(agentId);

      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${agentName} (${agentId}) stopped.`,
          },
        ],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "SwarmStatus",
    label: "SwarmStatus",
    description: "Check the status and results of a coordinator swarm run.",
    parameters: Type.Object(
      {
        runId: Type.Optional(
          Type.String({
            description:
              "Run ID to check. If omitted, shows the most recent run.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, _params) => {
      if (activeRuns.size === 0) {
        return {
          content: [
            { type: "text" as const, text: "No active coordinator runs." },
          ],
          details: undefined,
        };
      }

      const allRuns = Array.from(activeRuns.values());
      const summaries = allRuns.map(runToSummary).join("\n\n");
      return {
        content: [{ type: "text" as const, text: summaries }],
        details: undefined,
      };
    },
  });
}
