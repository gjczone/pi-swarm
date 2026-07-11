/**
 * swarm/coordinator — Non-blocking team mode for multi-turn swarm orchestration.
 *
 * Registers SwarmTeam, SendMessage, and TaskStop tools that allow
 * the main agent to launch a swarm, remain active across turns, send
 * messages to running agents, and stop individual agents.
 *
 * Unlike the blocking Swarm tool which waits for all agents to complete
 * before returning, SwarmTeam returns immediately with a runId.
 * The team leader (main agent) stays in control and can:
 * - Send messages to agents via SendMessage
 * - Stop individual agents via TaskStop
 * - Check progress and collect results
 * - Intervene when agents complete (via events)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SubagentBatchController,
  resolveSwarmMaxConcurrency,
  resolveSwarmSmallModel,
  resolveProfileModel,
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
  getBuiltinProfiles,
} from "../shared/profiles.js";
import {
  loadFileAgents,
  matchItemToAgent,
  buildAgentListing,
  clearFileAgentsCache,
} from "../shared/agents.js";
import {
  resolveSwarmRoot,
  createManifest,
  updateManifest,
  readManifest,
  registerAgentInManifest,
} from "../state/persistence.js";
import {
  resolveMailboxPaths,
  ensureMailbox,
  sendMessage,
} from "../team/mailbox.js";
import type { MailboxPaths } from "../team/mailbox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSwarmSpecs,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
} from "./specs.js";

const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * #128: produce a 6-character base36 random suffix for runId generation.
 * Two calls in the same millisecond produce distinct IDs.
 */
function randomSuffix(length = 6): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length);
}

/** Build the SwarmTeam tool description dynamically, including available agents. */
function buildTeamDescription(): string {
  clearFileAgentsCache();
  const fileAgents = loadFileAgents(process.cwd());
  const builtinProfiles = getBuiltinProfiles();
  const agentListing = buildAgentListing(fileAgents, builtinProfiles);
  const hasFileAgents = fileAgents && fileAgents.size > 0;

  const lines: string[] = [
    "Launch a non-blocking team swarm of 1-128 subagents and stay in control across turns.",
    "",
    "You are the team leader. Unlike the blocking Swarm tool, SwarmTeam returns",
    "immediately with a runId. You remain active and can orchestrate agents while they run.",
    "",
    "After launching, you can:",
    "- Send messages to running agents with SendMessage(runId, agentName, message)",
    "- Stop individual agents with TaskStop(runId, agentName)",
    "- Check status with SwarmStatus(runId)",
    "- Agents continue running across conversation turns until they complete or are stopped.",
    "",
    "Set mailbox: true to let agents exchange messages via a shared inbox/outbox.",
    "Use mailbox for collaborative workflows where agents share findings between phases.",
    "",
    "---",
    "Agent configuration — pick ONE of these three patterns:",
    "",
    "  Pattern A — AUTO-ROUTING (recommended for mixed-item swarms):",
    "    Omit both profile and agentType. Each item is automatically routed",
    "    to the best matching file-based agent (by file extension, keywords),",
    "    falling back to 'general' for unmatched items.",
    "",
    "  Pattern B — UNIFORM PROFILE (set profile):",
    '    profile: "general" | "explore" | "plan" | "review"',
    "    All items use the same built-in or custom profile. No auto-routing.",
    "",
    "  Pattern C — UNIFORM FILE AGENT (set agentType):",
    "    agentType: <name from ~/.pi/agents/*.md or .pi/agents/*.md>",
    "    All items use the same file-defined agent. No auto-routing.",
    "",
  ];

  if (agentListing) {
    lines.push(agentListing);
  }
  if (!hasFileAgents) {
    lines.push("  Tip: Define custom agents in ~/.pi/agents/<name>.md", "");
  }

  lines.push(
    "Use this when you need to launch agents and then react to their progress",
    "or give them additional instructions while they work.",
  );

  return lines.join("\n");
}

export interface ActiveTeamRun {
  runId: string;
  handle: SwarmHandle<SwarmSpec>;
  results: Array<SubagentResult<SwarmSpec>>;
  events: Array<SubagentEvent<SwarmSpec>>;
  swarmRoot: string;
  description?: string;
  completed: boolean;
  completionPromise: Promise<Array<SubagentResult<SwarmSpec>>>;
}

const activeRuns = new Map<string, ActiveTeamRun>();

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
    "state",
    "runs",
    runId,
    "coord",
    "inboxes",
    `${agentId}.jsonl`,
  );
}

/**
 * Resolve an agent's display name (or raw agentId) to its canonical agentId
 * for a given run.
 *
 * Business (#102): Returns undefined when no event matches the name or id.
 * Previously this returned the input string unchanged, which caused callers
 * to proceed with an invalid id and produce confusing downstream errors.
 */
export function resolveAgentId(
  run: ActiveTeamRun,
  nameOrId: string,
): string | undefined {
  // First pass: match by agentName
  for (const e of run.events) {
    if (e.agentName === nameOrId && e.agentId) return e.agentId;
  }
  // Second pass: match by agentId directly (caller may have passed the id)
  for (const e of run.events) {
    if (e.agentId === nameOrId) return e.agentId;
  }
  return undefined;
}

function getRun(runId: string): ActiveTeamRun {
  const run = activeRuns.get(runId);
  if (!run) {
    throw new Error(
      `No active coordinator run with id: ${runId}. Available runs: ${Array.from(activeRuns.keys()).join(", ") || "(none)"}`,
    );
  }
  return run;
}

/**
 * Produce a human-readable summary of a single team run.
 *
 * Business (#104): Agent count is derived from unique agentIds in the event
 * log, NOT from the raw count of agent_started events. This is because
 * retries emit an additional agent_started event for the same agentId,
 * which would inflate the total and produce a negative "still running" count.
 *
 * Business (#205): The summary now includes a "Running agents" section that
 * lists all agents that have started but not yet reached a terminal state.
 * This gives the team leader visibility into which agents are still active
 * without needing to cross-reference events manually.
 */
export function runToSummary(run: ActiveTeamRun): string {
  const results = run.handle.getResults();
  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const aborted = results.filter((r) => r.status === "aborted").length;
  const uniqueAgentIds = new Set(
    run.events.filter((e) => e.agentId).map((e) => e.agentId as string),
  );
  const total = uniqueAgentIds.size;
  const stillRunning = total - completed - failed - aborted;

  // #205: Build a map of agentId -> agentName from events so running agents
  // can be listed by name (not just by ID).
  const agentNames = new Map<string, string>();
  for (const e of run.events) {
    if (e.agentId && e.agentName) {
      agentNames.set(e.agentId, e.agentName);
    }
  }

  const completedAgentIds = new Set(
    results.map((r) => r.agentId).filter((id): id is string => !!id),
  );
  const runningAgentIds = Array.from(uniqueAgentIds).filter(
    (id) => !completedAgentIds.has(id),
  );

  const lines = [
    `Run: ${run.runId}`,
    `Status: ${run.completed ? "completed" : "running"}`,
    `Agents: ${total} total, ${completed} completed, ${failed} failed, ${stillRunning} running`,
  ];
  if (run.description) lines.push(`Description: ${run.description}`);

  // #205: Show running agents first so the team leader can see what is
  // still in progress before reading completed/failed results.
  if (runningAgentIds.length > 0) {
    lines.push("");
    lines.push("Running agents:");
    for (const id of runningAgentIds) {
      const name = agentNames.get(id) ?? id;
      lines.push(`  - ${name} (${id})`);
    }
  }

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

/**
 * Summarize one or more team runs. When runId is provided, only that
 * run is summarized; otherwise all runs are included.
 *
 * Business (#103): Previously the SwarmStatus handler ignored the runId
 * parameter and always returned all runs. This helper centralizes the
 * filtering logic and makes it testable.
 */
export function summarizeRuns(runs: ActiveTeamRun[], runId?: string): string {
  if (runId) {
    const run = runs.find((r) => r.runId === runId);
    if (!run) {
      return `Run "${runId}" not found. Available runs: ${runs.map((r) => r.runId).join(", ") || "(none)"}`;
    }
    return runToSummary(run);
  }
  if (runs.length === 0) {
    return "No active team runs.";
  }
  return runs.map(runToSummary).join("\n\n");
}

export function registerTeamTools(pi: ExtensionAPI): void {
  const description = buildTeamDescription();
  pi.registerTool({
    name: "SwarmTeam",
    label: "SwarmTeam",
    description,
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
              'Agent profile: "general", "explore", "plan", "review", or custom. Mutually exclusive with agentType.',
          }),
        ),
        agentType: Type.Optional(
          Type.String({
            description:
              "File-based agent name from ~/.pi/agents/<name>.md or .pi/agents/<name>.md. " +
              "Mutually exclusive with profile.",
          }),
        ),
        prompt_template: Type.String({
          description: `Prompt template with ${PROMPT_TEMPLATE_PLACEHOLDER} exactly once.`,
        }),
        items: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: MAX_AGENT_SWARM_SUBAGENTS,
          description: `Items (1-${String(MAX_AGENT_SWARM_SUBAGENTS)}) to parallelize across.`,
        }),
        model: Type.Optional(
          Type.String({
            description:
              'Model: "small" for lightweight tasks, or explicit model ID. Omit to inherit.',
          }),
        ),
        mailbox: Type.Optional(
          Type.Boolean({
            description:
              "Enable inter-agent mailbox. When true, subagents can exchange messages via shared mailbox. Use for collaborative workflows where agents share findings. Default: false.",
            examples: [true],
          }),
        ),
        timeout: Type.Optional(
          Type.Integer({
            description:
              "Per-agent timeout in milliseconds. Default: 1800000 (30 minutes). 0 disables timeout.",
            minimum: 0,
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
      const {
        description,
        prompt_template,
        items,
        model,
        mailbox,
        timeout,
        profile,
        agentType,
      } = params as {
        description?: string;
        prompt_template: string;
        items: string[];
        model?: string;
        mailbox?: boolean;
        timeout?: number;
        profile?: string;
        agentType?: string;
      };

      // Validate: profile and agentType are mutually exclusive
      if (profile && agentType) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: profile and agentType are mutually exclusive. Use one or the other, not both.",
            },
          ],
          isError: true,
          details: undefined,
        };
      }

      const resolvedModel =
        model === "small" ? resolveSwarmSmallModel() : model;

      const useAutoRoute = !profile && !agentType;
      const profileSource = agentType ?? profile;
      const agentProfile = useAutoRoute
        ? resolveProfile(undefined, process.cwd())
        : resolveProfile(profileSource, process.cwd());
      const profileName = agentProfile.name;
      // #201: resolve profile "small" through settings, and let the user's
      // explicit model parameter take precedence over the profile model.
      const profileModel = resolveProfileModel(agentProfile);
      const effectiveModel = resolvedModel ?? profileModel;
      const profileTools = resolveProfileTools(agentProfile);

      // Pre-load file agents for auto-routing
      const fileAgents = useAutoRoute
        ? loadFileAgents(process.cwd())
        : undefined;

      const swarmRoot =
        process.env.PI_SWARM_ROOT ?? resolveSwarmRoot(process.cwd());
      // #128: append a 6-char random suffix so two team calls in
      // the same millisecond do not collide in activeRuns / manifest lookups.
      const runId = `team-${Date.now().toString(36)}-${randomSuffix()}`;

      const placeholderCount =
        prompt_template.split(PROMPT_TEMPLATE_PLACEHOLDER).length - 1;
      if (placeholderCount !== 1) {
        throw new Error(
          `prompt_template must contain {{item}} exactly once, found ${placeholderCount} occurrence(s).`,
        );
      }

      const specs = createAgentSwarmSpecs({
        items: items.map((i) => i.trim()),
        prompt_template,
      });

      const coordDir = path.join(swarmRoot, "state", "runs", runId, "coord");
      const inboxesDir = path.join(coordDir, "inboxes");
      fs.mkdirSync(inboxesDir, { recursive: true });

      // #206: Set up shared mailbox when enabled so agents can exchange
      // messages via inbox/outbox during collaborative workflows.
      let mailboxPath: string | undefined;
      let mailboxPaths: MailboxPaths | undefined;
      if (mailbox) {
        mailboxPaths = resolveMailboxPaths(swarmRoot, runId);
        ensureMailbox(mailboxPaths);
        mailboxPath = mailboxPaths.root;
      }

      createManifest(swarmRoot, {
        runId,
        type: "team",
        status: "running",
        goal: description ?? "Team Swarm",
        startedAt: Date.now(),
        agentIds: [],
      });

      // #204: Use user-specified timeout or fall back to the default.
      const resolvedTimeout =
        timeout !== undefined && timeout > 0
          ? timeout
          : DEFAULT_SUBAGENT_TIMEOUT_MS;

      const resolvedPaths = mailboxPaths;
      const tasks = specs.map((spec, idx): QueuedSubagentTask<SwarmSpec> => {
        const spawnSpec = spec as SwarmSpawnSpec;
        const agentName = deriveAgentName(profileName, spawnSpec.item, idx + 1);
        const agentId = `${runId}-${idx + 1}`;
        const messageInboxPath = getAgentInboxPath(swarmRoot, runId, agentId);

        // Auto-route per item when no explicit profile/agentType
        let itemProfile = agentProfile;
        let itemProfileTools = profileTools;
        let itemModel = effectiveModel;
        let itemAdditionalPrompt = agentProfile.systemPrompt;

        if (useAutoRoute && fileAgents) {
          const matched = matchItemToAgent(spawnSpec.item, fileAgents);
          if (matched) {
            itemProfile = matched;
            itemProfileTools = resolveProfileTools(matched);
            // #201/#202: resolve matched agent "small" through settings,
            // and let the user's explicit model parameter take precedence.
            const matchedModel = resolveProfileModel(matched);
            itemModel = resolvedModel ?? matchedModel ?? effectiveModel;
            itemAdditionalPrompt = matched.systemPrompt;
          }
        }

        return {
          kind: "spawn",
          data: spec,
          profileName: itemProfile.name,
          agentName,
          parentToolCallId: toolCallId,
          prompt: spec.prompt,
          description: `${description ?? "Team"} #${spec.index} (${agentName})`,
          swarmIndex: spec.index,
          runInBackground: true,
          swarmItem: spawnSpec.item,
          signal,
          timeout: resolvedTimeout,
          swarmRoot,
          runId,
          useWorktree: true,
          model: itemModel,
          tools: itemProfileTools,
          additionalSystemPrompt: itemAdditionalPrompt,
          roleName: agentName,
          messageInboxPath,
          mailboxPath,
          onMessage: resolvedPaths
            ? (msg) => sendMessage(resolvedPaths, msg)
            : undefined,
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

      const run: ActiveTeamRun = {
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

      // #160: Remove the run entry when it reaches a terminal state
      // (completes or fails) to prevent the activeRuns Map from leaking memory.
      run.completionPromise.finally(() => {
        activeRuns.delete(runId);
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Team swarm launched: ${runId}\n` +
              `Agents: ${specs.length}\n` +
              `Profile: ${profileName}\n` +
              `Mailbox: ${mailbox ? "enabled" : "disabled"}\n\n` +
              `Agents are now running in the background. You can:\n` +
              `- Continue working while agents execute\n` +
              `- Use SendMessage(${runId}, <agentName>, <message>) to send instructions\n` +
              `- Use TaskStop(${runId}, <agentName>) to stop an agent\n` +
              `- Use SwarmStatus(${runId}) to check progress\n` +
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
      "Send a message to a running agent in a team swarm. The agent will receive it in their inbox and can read it during their execution.",
    parameters: Type.Object(
      {
        runId: Type.String({
          description: "The run ID returned by SwarmTeam.",
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
    description: "Stop a running agent in a team swarm.",
    parameters: Type.Object(
      {
        runId: Type.String({
          description: "The run ID returned by SwarmTeam.",
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
    description: "Check the status and results of a team swarm run.",
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
    execute: async (_toolCallId, params) => {
      const { runId } = params as { runId?: string };
      const allRuns = Array.from(activeRuns.values());
      const summaries = summarizeRuns(allRuns, runId);
      return {
        content: [{ type: "text" as const, text: summaries }],
        details: undefined,
      };
    },
  });
}
