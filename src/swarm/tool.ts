/**
 * swarm/tool — Swarm tool registration.
 *
 * Registers the `Swarm` tool that the LLM can call to launch
 * 1-20 isolated subagents in parallel from a shared prompt template.
 *
 * Ported from MoonshotAI/kimi-code's AgentSwarmTool.
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
import { renderSwarmResults, toSwarmRunResults } from "../shared/render.js";
import {
  spawnSubagent,
  resumeSubagent,
  retrySubagent,
} from "../shared/spawner.js";
import type {
  QueuedSubagentTask,
  SwarmSpawnSpec,
  SwarmSpec,
} from "../shared/types.js";
import {
  resolveSwarmRoot,
  createManifest,
  updateManifest,
  readManifest,
  registerAgentInManifest,
} from "../state/persistence.js";
import { mergeBranch, isGitRepository } from "../shared/worktree.js";
import {
  resolveMailboxPaths,
  ensureMailbox,
} from "../team/mailbox.js";
import {
  AgentSwarmProgressComponent,
  snapshotToProgressState,
} from "../tui/progress.js";

/** Widget key used to render the live swarm progress panel. */
const PROGRESS_WIDGET_KEY = "pi-swarm-progress";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SUBAGENT_TYPE = "coder";
const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";
const MAX_ITEM_COUNT = 20;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const AGENT_SWARM_DESCRIPTION = [
  "Launch 1-20 isolated subagents in parallel from a shared prompt template.",
  "",
  "Use this tool when a task benefits from isolated subagents. Each subagent",
  "runs in its own clean workspace with project rules (AGENTS.md) loaded.",
  "Subagents do NOT communicate with each other.",
  "",
  "When to use:",
  "- Code review: 1 subagent per file. Even a single file benefits from an",
  "  isolated review pass.",
  "- Bug investigation: 1 subagent to investigate in isolation.",
  "- Parallel edits: multiple files, each handled by its own subagent.",
  "- Complex tasks: the subagent gets a clean context focused on just its item.",
  "",
  "How to use:",
  "1. Decompose the task into 1-20 independent items.",
  "2. Write a prompt_template with {{item}} placeholder.",
  "3. Include context from the user's task and the specific item.",
  "4. Use 1 item when a single subagent is enough for isolation.",
  "5. Use 2-6 items for typical parallel work.",
  "6. The tool handles concurrency, rate limits, and error recovery.",
  "7. Read the results from the tool output.",
  "",
  "Best for: code review, bug fixing, file editing, investigation, refactoring.",
  "",
  "Mailbox mode (mailbox: true):",
  "- Enables inter-agent communication via shared mailbox.",
  "- Each subagent gets an inbox/outbox. Agents can send messages to each other.",
  "- The main agent orchestrates: decompose tasks, assign via mailbox, collect results.",
  "- Use for collaborative workflows where agents need to share findings.",
  "- Without mailbox, agents are fully independent and do not communicate.",
].join("\n");

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentSwarmTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Swarm",
    label: "Swarm",
    description: AGENT_SWARM_DESCRIPTION,
    parameters: Type.Object(
      {
        description: Type.Optional(
          Type.String({
            description: "Short description for the whole swarm (optional).",
            examples: ["Review source files for bugs"],
          }),
        ),
        prompt_template: Type.String({
          description: `Prompt template with ${PROMPT_TEMPLATE_PLACEHOLDER} exactly once. Each item replaces the placeholder.`,
          examples: [
            "You are a code reviewer. Review {{item}} for bugs and security issues.",
            "Fix the following issue in {{item}}",
          ],
        }),
        items: Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 20,
          description:
            "Items (1-20) to parallelize across. Each item replaces {{item}} in the template.",
          examples: [["src/auth.ts", "src/api.ts", "src/db.ts"]],
        }),
        mailbox: Type.Optional(
          Type.Boolean({
            description:
              "Enable inter-agent mailbox. When true, subagents can exchange messages via shared mailbox. Use for collaborative workflows where agents need to share findings. Default: false (agents are independent, no communication).",
            examples: [true],
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
      const { description, prompt_template, items, mailbox } = params as {
        description?: string;
        prompt_template: string;
        items: string[];
        mailbox?: boolean;
      };

      const ctx = ctxRaw as ExtensionContext;
      const progress = createProgressWidget(ctx);

      // Persistent run state - declared outside try for catch access
      const swarmRoot =
        process.env.PI_SWARM_ROOT ?? resolveSwarmRoot(process.cwd());
      const runId = `swarm-${Date.now().toString(36)}`;
      let runCreated = false;

      try {
        const profileName = DEFAULT_SUBAGENT_TYPE;

        // Build specs
        const specs = items.map((item: string, index: number) => ({
          kind: "spawn" as const,
          index: index + 1,
          item: item.trim(),
          prompt: prompt_template.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item.trim()),
        } satisfies SwarmSpawnSpec));

        // Set up mailbox when enabled
        let mailboxPath: string | undefined;
        if (mailbox) {
          const paths = resolveMailboxPaths(swarmRoot, runId);
          ensureMailbox(paths);
          mailboxPath = paths.root;
        }

        createManifest(swarmRoot, {
          runId,
          type: "swarm",
          status: "running",
          goal: description ?? "Swarm",
          startedAt: Date.now(),
          agentIds: [],
        });
        runCreated = true;

        // Convert to queued tasks
        const tasks = specs.map((spec, idx): QueuedSubagentTask<SwarmSpec> => ({
          kind: "spawn",
          data: spec,
          profileName: profileName,
          parentToolCallId: toolCallId,
          prompt: spec.prompt,
          description: `${description ?? "Swarm"} #${spec.index} (${profileName})`,
          swarmIndex: spec.index,
          runInBackground: false,
          swarmItem: spec.item,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
          swarmRoot,
          runId,
          useWorktree: true,
          mailboxPath,
          roleName: `agent-${idx + 1}`,
        }));

        // Run with controller
        const maxConcurrency = resolveSwarmMaxConcurrency(process.cwd());
        const repoCwd = process.cwd();
        const inGitRepo = isGitRepository(repoCwd);
        const controller = new SubagentBatchController<SwarmSpec>(
          {
            spawn: spawnSubagent,
            resume: resumeSubagent,
            retry: retrySubagent,
          },
          tasks,
          {
            maxConcurrency,
            onProgress: (snapshot) => {
              progress?.component.update(
                snapshotToProgressState(snapshot, description),
              );
            },
          },
        );
        const results = await controller.run();

        // Collect worktree branches for auto-merge
        const allBranches: string[] = [];
        for (const r of results) {
          if (r.worktreeBranch) {
            allBranches.push(r.worktreeBranch);
          }
        }

        // Register all agents in manifest and mark run completed
        for (const r of results) {
          if (r.agentId) {
            registerAgentInManifest(swarmRoot, runId, r.agentId);
          }
        }
        const manifest = readManifest(swarmRoot, runId);
        if (manifest) {
          manifest.status = "completed";
          manifest.completedAt = Date.now();
          updateManifest(swarmRoot, manifest);
        }

        // Auto-merge worktree branches back to original branch (in Git repos)
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

        // Trigger completion animation before tearing down
        progress?.component.complete();

        // Render output
        const swarmResults = toSwarmRunResults(results);
        let output = renderSwarmResults(swarmResults);
        if (mergeResults.length > 0) {
          output += `\n\n<auto_merge>\n${mergeResults.join("\n")}\n</auto_merge>`;
        }

        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (runCreated) {
          const manifest = readManifest(swarmRoot, runId);
          if (manifest) {
            manifest.status = "failed";
            manifest.completedAt = Date.now();
            manifest.error = message;
            updateManifest(swarmRoot, manifest);
          }
        }
        return {
          content: [{ type: "text", text: `AgentSwarm failed: ${message}` }],
          isError: true,
          details: undefined,
        };
      } finally {
        // Always tear down the progress widget so it does not linger
        progress?.dispose();
        clearProgressWidget(ctx);
      }
    },

    // -------------------------------------------------------------------
    // Custom TUI rendering
    // -------------------------------------------------------------------

    /**
     * Render the tool call in the conversation transcript with arg summary.
     * 业务说明：在对话记录中展示 swarm 调用信息 —— 包含类型、数量、
     * prompt 模板预览。
     */
    renderCall(args, theme, _context) {
      const itemCount = (args.items as string[] | undefined)?.length ?? 0;

      const container = new Container();
      const title = `${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${itemCount} agent${itemCount !== 1 ? "s" : ""}`)}`;
      container.addChild(new Text(title, 0, 0));

      const desc = args.description as string | undefined;
      if (desc) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              desc.length > 80 ? `${desc.slice(0, 80)}...` : desc,
            ),
            0,
            0,
          ),
        );
      }

      const templatePreview = args.prompt_template as string | undefined;
      if (templatePreview) {
        container.addChild(new Spacer(1));
        const preview =
          templatePreview.length > 60
            ? `${templatePreview.slice(0, 60)}...`
            : templatePreview;
        container.addChild(new Text(theme.fg("muted", `${preview}`), 0, 0));
      }
      return container;
    },

    /**
     * Render the tool result in the conversation transcript.
     * 业务说明：根据执行结果展示成功/失败图标和概要统计。
     */
    renderResult(result, _options, theme, context) {
      const text =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const icon = context.isError
        ? theme.fg("error", "x")
        : theme.fg("success", "V");

      // Extract summary stats from the XML output
      const summaryMatch = /<summary>(.*?)<\/summary>/.exec(text);
      const summaryText = summaryMatch ? summaryMatch[1]! : "";
      const completedMatch = /completed: (\d+)/.exec(summaryText);
      const failedMatch = /failed: (\d+)/.exec(summaryText);
      const completed = completedMatch ? completedMatch[1]! : "0";
      const failed = failedMatch ? failedMatch[1]! : "0";

      const container = new Container();
      container.addChild(
        new Text(
          `${icon} ${theme.fg("toolTitle", "swarm ")}${theme.fg("accent", `done: ${completed}`)}${failed !== "0" ? theme.fg("error", `  failed: ${failed}`) : ""}`,
          0,
          0,
        ),
      );

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
// Live progress widget
// ---------------------------------------------------------------------------

/** Handle returned by createProgressWidget for teardown. */
interface ProgressHandle {
  readonly component: AgentSwarmProgressComponent;
  dispose(): void;
}

/**
 * Install a live progress widget above the editor when running in TUI mode.
 *
 * Returns undefined in non-TUI modes (print/rpc/json) where setWidget is a
 * no-op, so the controller's onProgress callback stays a cheap no-op too.
 *
 * 业务说明：在 TUI 模式下注册一个实时进度面板，展示每个子 Agent 的
 * 运行状态（队列/运行中/完成/失败/限流挂起）。非 TUI 模式下返回
 * undefined，避免无意义的 UI 调用。
 *
 * 关键修复：setWidget 的工厂函数接收 (tui, theme) 参数，我们捕获 tui
 * 引用并传给组件，使组件在动画定时器触发时能调用 tui.requestRender()
 * 通知 TUI 框架重绘，否则 braille 进度条不会动。
 */
function createProgressWidget(
  ctx: ExtensionContext,
): ProgressHandle | undefined {
  // 仅在 TUI 模式下展示进度面板；其他模式（print/rpc/json）无可用 UI
  if (ctx.mode !== "tui") return undefined;
  const setWidget = ctx.ui?.setWidget;
  if (typeof setWidget !== "function") return undefined;

  // 捕获 tui 引用，供组件动画 tick 时调用 requestRender()
  let capturedTui: { requestRender(force?: boolean): void } | undefined;

  const component = new AgentSwarmProgressComponent(() => {
    capturedTui?.requestRender();
  });
  try {
    // 工厂函数接收 tui 和 theme，捕获 tui 供动画驱动使用
    setWidget(
      PROGRESS_WIDGET_KEY,
      (tui, _theme) => {
        capturedTui = tui;
        return component;
      },
      {
        placement: "aboveEditor",
      },
    );
  } catch {
    // setWidget 失败不应阻断 swarm 执行
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

/**
 * Remove the progress widget after the swarm run completes or fails.
 */
function clearProgressWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const setWidget = ctx.ui?.setWidget;
  if (typeof setWidget !== "function") return;
  try {
    setWidget(PROGRESS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
  } catch {
    // Best effort — widget teardown failure is non-fatal
  }
}
