/**
 * team/tool — SwarmTeam tool registration.
 *
 * Registers the `SwarmTeam` tool that the LLM can call to orchestrate
 * a team of role-based agents that collaborate via a shared mailbox.
 *
 * Inspired by pi-crew's team orchestration and CrewAI's hierarchical model.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
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
import type { QueuedSubagentTask, SubagentResult } from "../shared/types.js";
import { mergeBranch, isGitRepository } from "../shared/worktree.js";
import {
  resolveSwarmRoot,
  createManifest,
  readManifest,
  updateManifest,
  saveTaskState,
  updateHeartbeat,
  registerAgentInManifest,
} from "../state/persistence.js";
import { TeamSupervisor } from "./supervisor.js";
import type { TeamPhase, AgentRoleConfig } from "../shared/types.js";
import {
  TeamDashboardComponent,
  snapshotToDashboardState,
} from "../tui/team-dashboard.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

const TEAM_DASHBOARD_WIDGET_KEY = "pi-swarm-team-dashboard";

const AGENT_TEAM_DESCRIPTION = [
  "Orchestrate role-based agents (explorer, planner, coder, reviewer, tester) with a shared mailbox.",
  "",
  "CRITICAL RULES:",
  "1. ONLY use when the user explicitly says 'team' or 'swarm-team'.",
  "2. For simple parallel tasks, use AgentSwarm instead.",
  "3. This tool MUST be the ONLY tool call in your response — do not batch.",
  "",
  "Default phases: explore -> plan -> implement -> review -> test.",
  "Use `phases` and `roles` to customize the workflow.",
  "Use `small_model` to route explorer/tester to a cheaper model.",
].join("\n");

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSwarmTeamTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "SwarmTeam",
    label: "Swarm Team",
    description: AGENT_TEAM_DESCRIPTION,
    parameters: Type.Object(
      {
        goal: Type.String({
          description: "High-level goal for the team.",
          examples: ["Implement JWT authentication with refresh tokens"],
        }),
        description: Type.String({
          description: "Short description for the team run.",
          examples: ["Build auth system"],
        }),
        phases: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String(),
              role: Type.String(),
              dependsOn: Type.Optional(Type.Array(Type.String())),
              modelTier: Type.Optional(
                Type.Union([Type.Literal("small"), Type.Literal("default")]),
              ),
              model: Type.Optional(Type.String()),
              tools: Type.Optional(Type.Array(Type.String())),
            }),
            {
              description:
                "Custom phase definitions. Defaults to explore/plan/implement/review/test.",
              examples: [
                [
                  { name: "explore", role: "explorer" },
                  { name: "plan", role: "planner", dependsOn: ["explore"] },
                  { name: "implement", role: "coder", dependsOn: ["plan"] },
                ],
              ],
            },
          ),
        ),
        roles: Type.Optional(
          Type.Array(
            Type.Object({
              role: Type.String(),
              model: Type.Optional(Type.String()),
              tools: Type.Optional(Type.Array(Type.String())),
              systemPrompt: Type.Optional(Type.String()),
            }),
            {
              description:
                "Custom role configurations with optional model/tools overrides.",
              examples: [
                [
                  { role: "coder", model: "deepseek/deepseek-v4-pro" },
                  { role: "explorer", tools: ["read", "bash", "grep"] },
                ],
              ],
            },
          ),
        ),
        small_model: Type.Optional(
          Type.String({
            description:
              "Lightweight/fast model for exploration roles (e.g. explorer). Other roles use the default model.",
            examples: ["deepseek/deepseek-v4-flash"],
          }),
        ),
        max_agents: Type.Optional(
          Type.Number({
            description: "Max concurrent agents. Default 4.",
            examples: [6],
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
      ctxRaw: unknown,
    ) => {
      const p = params as {
        goal: string;
        description: string;
        phases?: {
          name: string;
          role: string;
          dependsOn?: string[];
          modelTier?: "small" | "default";
          model?: string;
          tools?: string[];
        }[];
        roles?: {
          role: string;
          model?: string;
          tools?: string[];
          systemPrompt?: string;
        }[];
        small_model?: string;
        max_agents?: number;
      };

      const ctx = ctxRaw as ExtensionContext;
      const dashboard = createTeamDashboardWidget(ctx, p.description);

      // Persistent run state - declared outside try for catch access
      const swarmRoot =
        process.env.PI_SWARM_ROOT ?? resolveSwarmRoot(process.cwd());
      const runId = `team-${Date.now().toString(36)}`;
      let runCreated = false;
      let supervisor: TeamSupervisor | null = null;
      try {
        // Build phase definitions
        const phases: TeamPhase[] | undefined = p.phases?.map((ph) => ({
          name: ph.name,
          role: ph.role as TeamPhase["role"],
          dependsOn: ph.dependsOn,
          modelTier: ph.modelTier,
          model: ph.model,
          tools: ph.tools,
        }));

        // Validate phases (if provided)
        if (p.phases) {
          const phaseNames = new Set(p.phases.map((ph) => ph.name));
          const VALID_ROLES = new Set([
            "explorer",
            "planner",
            "coder",
            "reviewer",
            "tester",
            "fixer",
          ]);
          for (const ph of p.phases) {
            // Validate role
            if (!VALID_ROLES.has(ph.role)) {
              throw new Error(
                `Phase "${ph.name}" has invalid role "${ph.role}". ` +
                  `Valid roles: ${[...VALID_ROLES].join(", ")}`,
              );
            }
            // Validate dependsOn references
            if (ph.dependsOn) {
              for (const dep of ph.dependsOn) {
                if (!phaseNames.has(dep)) {
                  throw new Error(
                    `Phase "${ph.name}" depends on unknown phase "${dep}". ` +
                      `Available phases: ${[...phaseNames].join(", ")}`,
                  );
                }
              }
            }
          }
        }

        // Build role configs
        const roles: AgentRoleConfig[] | undefined = p.roles?.map((r) => ({
          role: r.role as AgentRoleConfig["role"],
          model: r.model,
          tools: r.tools,
          systemPrompt: r.systemPrompt,
        }));

        // Create supervisor
        supervisor = new TeamSupervisor({
          cwd: process.cwd(),
          swarmRoot,
          runId,
          goal: p.goal,
          phases,
          roles,
          smallModel: p.small_model,
          maxAgents: p.max_agents ?? 4,
          onProgress: (snapshot) => {
            dashboard?.component.update(snapshotToDashboardState(snapshot));
          },
        });

        // Create manifest and save initial state
        createManifest(swarmRoot, {
          runId,
          type: "team",
          status: "running",
          goal: p.goal,
          startedAt: Date.now(),
          agentIds: [],
        });
        runCreated = true;
        saveTaskState(swarmRoot, runId, supervisor.state.taskGraph.toJSON());

        // Run phases through the task graph — launch all ready phases concurrently
        // 业务说明：同时启动所有依赖已满足的阶段。独立阶段并行执行，
        // 有依赖的阶段在依赖完成后自动成为下一批。
        const allResults: SubagentResult<unknown>[] = [];
        const allBranches: string[] = [];
        const maxConcurrency = p.max_agents ?? 4;
        const repoCwd = process.cwd();
        const inGitRepo = isGitRepository(repoCwd);

        let currentPhases = supervisor.startReadyPhases();

        while (currentPhases.length > 0) {
          // Check abort signal between batches
          signal?.throwIfAborted();

          // Update heartbeat before batch
          updateHeartbeat(swarmRoot, runId);

          // Build tasks for all ready phases
          const tasks: QueuedSubagentTask<unknown>[] = currentPhases.map(
            (cp, idx) => {
              const execConfig = supervisor!.getPhaseExecutionConfig(
                cp.phase.phase.name,
              );
              const phaseName = cp.phase.phase.name;
              const mailboxPath = supervisor!.getMailboxPath();
              return {
                kind: "spawn" as const,
                data: { phase: phaseName, role: cp.role },
                profileName: cp.role,
                parentToolCallId: toolCallId,
                prompt: cp.prompt,
                description: `${p.description} — ${phaseName} (${cp.role})`,
                swarmIndex: idx + 1,
                runInBackground: false,
                signal,
                timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
                model: execConfig.model,
                tools: execConfig.tools,
                cwd: execConfig.cwd,
                useWorktree: true,
                swarmRoot,
                runId,
                mailboxPath,
                roleName: cp.role,
                onUsage: (usage) => {
                  supervisor?.updatePhaseUsage(phaseName, usage);
                },
                onMessage: (message) => {
                  supervisor?.handleRealtimeMessage(cp.role, message);
                },
              };
            },
          );

          const controller = new SubagentBatchController<unknown>(
            {
              spawn: spawnSubagent,
              resume: resumeSubagent,
              retry: retrySubagent,
            },
            tasks,
            {
              maxConcurrency: Math.min(maxConcurrency, tasks.length),
            },
          );

          let batchResults: SubagentResult<unknown>[];
          try {
            batchResults = await controller.run();
          } catch (err) {
            // Batch was aborted or failed catastrophically
            // Mark all phases in this batch as failed
            for (const cp of currentPhases) {
              supervisor.failPhase(
                cp.phase.phase.name,
                err instanceof Error ? err.message : String(err),
              );
            }
            // Save state after failure
            saveTaskState(
              swarmRoot,
              runId,
              supervisor.state.taskGraph.toJSON(),
            );
            // Abort signal: stop the entire run
            if (signal?.aborted) {
              supervisor.finalize();
              if (runCreated) {
                const m = readManifest(swarmRoot, runId);
                if (m) {
                  m.status = "failed";
                  m.completedAt = Date.now();
                  m.error = "Aborted by user";
                  updateManifest(swarmRoot, m);
                }
              }
              const partialOutput = supervisor.synthesizeResult();
              return {
                content: [{ type: "text", text: partialOutput }],
                details: undefined,
              };
            }
            // Non-abort error: try next batch
            currentPhases = supervisor.startReadyPhases();
            continue;
          }

          allResults.push(...batchResults);

          // Process each phase result
          for (let i = 0; i < currentPhases.length; i += 1) {
            const cp = currentPhases[i]!;
            const result = batchResults[i];

            if (result && result.status === "completed") {
              supervisor.assignAgent(
                cp.phase.phase.name,
                result.agentId ?? cp.phase.phase.name,
              );
              supervisor.completePhase(
                cp.phase.phase.name,
                result.result ?? "",
                result.usage,
              );
              if (result.agentId) {
                registerAgentInManifest(swarmRoot, runId, result.agentId);
              }
              if (result.worktreeBranch) {
                allBranches.push(result.worktreeBranch);
              }
            } else if (result) {
              supervisor.failPhase(
                cp.phase.phase.name,
                result.error ?? "Unknown error",
              );
              if (result.agentId) {
                registerAgentInManifest(swarmRoot, runId, result.agentId);
              }
            }
          }

          // Save state after each batch
          saveTaskState(swarmRoot, runId, supervisor.state.taskGraph.toJSON());

          // Get next batch of ready phases
          currentPhases = supervisor.startReadyPhases();
        }

        // Finalize and render
        supervisor.finalize();

        // Auto-merge worktree branches back to original branch (in Git repos)
        // 业务说明：所有阶段完成后，按顺序合并子 agent 创建的分支。
        // 冲突时停止合并，保留分支供用户手动解决。
        const mergeResults: string[] = [];
        if (inGitRepo && allBranches.length > 0) {
          for (const branch of allBranches) {
            try {
              const mergeResult = mergeBranch(repoCwd, branch);
              if (mergeResult.success) {
                mergeResults.push(`Merged: ${branch}`);
              } else {
                mergeResults.push(
                  `Merge failed for ${branch}: ${mergeResult.error}`,
                );
              }
            } catch (err) {
              mergeResults.push(
                `Merge error for ${branch}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        // Mark run as completed
        if (runCreated) {
          const manifest = readManifest(swarmRoot, runId);
          if (manifest) {
            manifest.status = "completed";
            manifest.completedAt = Date.now();
            updateManifest(swarmRoot, manifest);
          }
        }

        dashboard?.component.complete();
        let output = supervisor.synthesizeResult();
        if (mergeResults.length > 0) {
          output += `\n\n<auto_merge>\n${mergeResults.join("\n")}\n</auto_merge>`;
        }

        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Mark run as failed
        if (runCreated) {
          const manifest = readManifest(swarmRoot, runId);
          if (manifest) {
            manifest.status = "failed";
            manifest.completedAt = Date.now();
            manifest.error = message;
            updateManifest(swarmRoot, manifest);
          }
        }

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
              text: `SwarmTeam failed: ${message}`,
            },
          ],
          isError: true,
          details: undefined,
        };
      } finally {
        // Always tear down the dashboard widget so it does not linger
        dashboard?.dispose();
        clearTeamDashboardWidget(ctx);
      }
    },

    // -------------------------------------------------------------------
    // Custom TUI rendering
    // -------------------------------------------------------------------

    /**
     * Render the tool call with goal summary and phase list.
     * 业务说明：在对话记录中展示 team 调用信息 —— 目标、阶段数、角色配置。
     */
    renderCall(args, theme, _context) {
      const goal = (args.goal as string) || "";
      const phases = args.phases as
        { name: string; role: string }[] | undefined;
      const phaseCount = phases?.length ?? 5; // Default 5 phases
      const maxAgents = (args.max_agents as number) ?? 4;

      const container = new Container();
      const title = `${theme.fg("toolTitle", theme.bold("team "))}${theme.fg("accent", `${phaseCount} phase${phaseCount !== 1 ? "s" : ""}`)}${theme.fg("muted", `  max ${maxAgents} agents`)}`;
      container.addChild(new Text(title, 0, 0));

      container.addChild(new Spacer(1));
      const goalPreview = goal.length > 80 ? `${goal.slice(0, 80)}...` : goal;
      container.addChild(new Text(theme.fg("dim", goalPreview), 0, 0));

      if (phases && phases.length > 0) {
        container.addChild(new Spacer(1));
        const phaseNames = phases
          .slice(0, 8)
          .map(
            (p) => `${theme.fg("muted", p.role)}:${theme.fg("accent", p.name)}`,
          )
          .join("  ");
        const more =
          phases.length > 8
            ? `  ${theme.fg("muted", `+${phases.length - 8} more`)}`
            : "";
        container.addChild(new Text(`${phaseNames}${more}`, 0, 0));
      }
      return container;
    },

    /**
     * Render the tool result with phase completion summary.
     * 业务说明：展示团队执行结果 —— 各阶段完成/失败状态。
     */
    renderResult(result, _options, theme, context) {
      const text =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const icon = context.isError
        ? theme.fg("error", "x")
        : theme.fg("success", "V");

      // Extract summary from XML output
      const summaryMatch = /<summary>(.*?)<\/summary>/.exec(text);
      const summary = summaryMatch ? summaryMatch[1]! : "";

      // Count phase results
      const phaseMatches = text.match(
        /<phase name="(\w+)"[^>]*outcome="(\w+)"/g,
      );
      let completedCount = 0;
      let failedCount = 0;
      if (phaseMatches) {
        for (const m of phaseMatches) {
          if (m.includes('outcome="completed"')) completedCount += 1;
          else if (m.includes('outcome="failed"')) failedCount += 1;
        }
      }

      const container = new Container();
      container.addChild(
        new Text(
          `${icon} ${theme.fg("toolTitle", "team ")}${theme.fg("accent", `${completedCount} done`)}${failedCount > 0 ? theme.fg("error", `  ${failedCount} failed`) : ""}`,
          0,
          0,
        ),
      );

      if (summary) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", summary), 0, 0));
      }

      if (context.isError && text) {
        container.addChild(new Spacer(1));
        const errorPreview =
          text.length > 100 ? `${text.slice(0, 100)}...` : text;
        container.addChild(new Text(theme.fg("error", errorPreview), 0, 0));
      }
      return container;
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard widget helpers
// ---------------------------------------------------------------------------

interface DashboardHandle {
  readonly component: TeamDashboardComponent;
  dispose(): void;
}

function createTeamDashboardWidget(
  ctx: ExtensionContext,
  _description: string,
): DashboardHandle | undefined {
  if (ctx.mode !== "tui") return undefined;
  const setWidget = ctx.ui?.setWidget;
  if (typeof setWidget !== "function") return undefined;

  // 捕获 tui 引用，供组件动画 tick 时调用 requestRender()
  let capturedTui: { requestRender(force?: boolean): void } | undefined;

  const component = new TeamDashboardComponent(() => {
    capturedTui?.requestRender();
  });
  try {
    // 工厂函数接收 tui 和 theme，捕获 tui 供动画驱动使用
    setWidget(
      TEAM_DASHBOARD_WIDGET_KEY,
      (tui, _theme) => {
        capturedTui = tui;
        return component;
      },
      {
        placement: "aboveEditor",
      },
    );
  } catch {
    component.dispose();
    return undefined;
  }

  return {
    component,
    dispose(): void {
      component.dispose();
    },
  };
}

function clearTeamDashboardWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const setWidget = ctx.ui?.setWidget;
  if (typeof setWidget !== "function") return;
  try {
    setWidget(TEAM_DASHBOARD_WIDGET_KEY, undefined, {
      placement: "aboveEditor",
    });
  } catch {
    // Best effort
  }
}
