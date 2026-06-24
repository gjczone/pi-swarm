/**
 * team/tool — AgentTeam tool registration.
 *
 * Registers the `AgentTeam` tool that the LLM can call to orchestrate
 * a team of role-based agents that collaborate via a shared mailbox.
 *
 * Inspired by pi-crew's team orchestration and CrewAI's hierarchical model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SubagentBatchController,
  resolveSwarmMaxConcurrency,
} from "../shared/controller.js";
import { renderSwarmResults } from "../shared/render.js";
import {
  spawnSubagent,
  resumeSubagent,
  retrySubagent,
} from "../shared/spawner.js";
import type {
  QueuedSubagentTask,
  SubagentResult,
} from "../shared/types.js";
import { resolveCrewRoot } from "../state/persistence.js";
import { TeamSupervisor } from "./supervisor.js";
import type {
  TeamPhase,
  AgentRoleConfig,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

const AGENT_TEAM_DESCRIPTION = `Launch a collaborative team of role-based agents to complete a complex multi-phase task.

AgentTeam is best for tasks that require multiple steps across different roles:
explorer (codebase understanding) → planner (design) → coder (implementation)
→ reviewer (quality check) → tester (verification).

Each agent communicates via a shared mailbox. The supervisor decomposes the goal
into phases, assigns each phase to a role agent, and synthesizes the final result.
Agents receive context from previous phases automatically.

Default phases: explore → plan → implement → review → test.
Custom phases and roles can be specified.

If AgentTeam is called, that call must be the only tool call in the response.`;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentTeamTool(
  pi: ExtensionAPI,
): void {
  pi.registerTool({
    name: "AgentTeam",
    label: "Agent Team",
    description: AGENT_TEAM_DESCRIPTION,
    parameters: Type.Object(
      {
        goal: Type.String({
          description: "High-level goal for the team.",
        }),
        description: Type.String({
          description:
            "Short description for the team run.",
        }),
        phases: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              role: Type.String(),
              dependsOn: Type.Optional(
                Type.Array(Type.String()),
              ),
            }),
            {
              description:
                "Custom phase definitions. Defaults to explore/plan/implement/review/test.",
            },
          ),
        ),
        roles: Type.Optional(
          Type.Array(
            Type.Object({
              role: Type.String(),
              model: Type.Optional(Type.String()),
              tools: Type.Optional(
                Type.Array(Type.String()),
              ),
              systemPrompt: Type.Optional(
                Type.String(),
              ),
            }),
            {
              description:
                "Custom role configurations with optional model/tools overrides.",
            },
          ),
        ),
        max_agents: Type.Optional(
          Type.Number({
            description:
              "Max concurrent agents. Default 4.",
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
      const p = params as {
        goal: string;
        description: string;
        phases?: { name: string; role: string; dependsOn?: string[] }[];
        roles?: { role: string; model?: string; tools?: string[]; systemPrompt?: string }[];
        max_agents?: number;
      };

      let supervisor: TeamSupervisor | null = null;
      try {
        const crewRoot =
          process.env.PI_SWARM_CREW_ROOT ?? resolveCrewRoot(process.cwd());
        const runId = `team-${Date.now().toString(36)}`;

        // Build phase definitions
        const phases: TeamPhase[] | undefined =
          p.phases?.map((ph) => ({
            name: ph.name,
            role: ph.role as TeamPhase["role"],
            dependsOn: ph.dependsOn,
          }));

        // Build role configs
        const roles: AgentRoleConfig[] | undefined =
          p.roles?.map((r) => ({
            role: r.role as AgentRoleConfig["role"],
            model: r.model,
            tools: r.tools,
            systemPrompt: r.systemPrompt,
          }));

        // Create supervisor
        supervisor = new TeamSupervisor({
          cwd: process.cwd(),
          crewRoot,
          runId,
          goal: p.goal,
          phases,
          roles,
          maxAgents: p.max_agents ?? 4,
        });

        // Run phases sequentially through the task graph
        const allResults: SubagentResult<unknown>[] = [];
        let currentPhase = supervisor.startNextPhase();

        while (currentPhase !== null) {
          // Check abort signal between phases
          signal?.throwIfAborted();

          const { phase, role, prompt: phasePrompt } =
            currentPhase;

          // Spawn a single agent for this phase
          const tasks: QueuedSubagentTask<unknown>[] = [
            {
              kind: "spawn",
              data: { phase: phase.phase.name, role },
              profileName: role,
              parentToolCallId: toolCallId,
              prompt: phasePrompt,
              description: `${p.description} — ${phase.phase.name} (${role})`,
              swarmIndex: 1,
              runInBackground: false,
              signal,
              timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
            },
          ];

          const controller =
            new SubagentBatchController<unknown>(
              {
                spawn: spawnSubagent,
                resume: resumeSubagent,
                retry: retrySubagent,
              },
              tasks,
              {
                maxConcurrency: 1, // Team phases run sequentially
              },
            );

          let phaseResults: SubagentResult<unknown>[];
          try {
            phaseResults = await controller.run();
          } catch (err) {
            // Phase was aborted or failed catastrophically
            supervisor.failPhase(
              phase.phase.name,
              err instanceof Error ? err.message : String(err),
            );
            // Abort signal: stop the entire run, save partial state
            if (signal?.aborted) {
              supervisor.finalize();
              const partialOutput = supervisor.synthesizeResult();
              return {
                content: [{ type: "text", text: partialOutput }],
                details: undefined,
              };
            }
            // Non-abort error: try next phase
            currentPhase = supervisor.startNextPhase();
            continue;
          }

          allResults.push(...phaseResults);

          const result = phaseResults[0];
          if (result && result.status === "completed") {
            supervisor.assignAgent(
              phase.phase.name,
              result.agentId ?? phase.phase.name,
            );
            supervisor.completePhase(
              phase.phase.name,
              result.result ?? "",
            );
          } else if (result) {
            supervisor.failPhase(
              phase.phase.name,
              result.error ?? "Unknown error",
            );
          }

          currentPhase = supervisor.startNextPhase();
        }

        // Finalize and render
        supervisor.finalize();
        const output = supervisor.synthesizeResult();

        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        // Return partial state if available
        if (supervisor) {
          try {
            const partialOutput = supervisor.synthesizeResult();
            if (partialOutput) {
              return {
                content: [
                  {
                    type: "text",
                    text: `${partialOutput}\n\nRun interrupted: ${message}`,
                  },
                ],
                isError: true,
                details: undefined,
              };
            }
          } catch {
            // Synthesis failed — fall through to generic error
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `AgentTeam failed: ${message}`,
            },
          ],
          isError: true,
          details: undefined,
        };
      }
    },
  });
}
