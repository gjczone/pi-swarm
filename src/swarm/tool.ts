/**
 * swarm/tool — Swarm tool registration.
 *
 * Registers the `Swarm` tool that the LLM can call to launch
 * 1-20 isolated subagents in parallel from a shared prompt template.
 *
 * Architecture reference: AgentSwarm pattern.
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
  resolveSwarmSmallModel,
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
import { mergeBranch, isGitRepository } from "../shared/worktree.js";
import {
  resolveMailboxPaths,
  ensureMailbox,
  sendMessage,
} from "../team/mailbox.js";
import type { MailboxPaths } from "../team/mailbox.js";
import {
  AgentSwarmProgressComponent,
  snapshotToProgressState,
} from "../tui/progress.js";

/** Widget key used to render the live swarm progress panel. */
const PROGRESS_WIDGET_KEY = "pi-swarm-progress";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";
const MAX_ITEM_COUNT = 20;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Build the Swarm tool description dynamically, including available agents. */
function buildSwarmDescription(): string {
  clearFileAgentsCache();
  const fileAgents = loadFileAgents(process.cwd());
  const builtinProfiles = getBuiltinProfiles();
  const agentListing = buildAgentListing(fileAgents, builtinProfiles);
  const hasFileAgents = fileAgents && fileAgents.size > 0;

  const lines: string[] = [
    "Launch 1-20 subagents in parallel, with optional inter-agent mailbox.",
    "",
    "YOU (the assistant) decide whether to enable mailbox based on the task:",
    "- Simple parallel work (review files, fix independent bugs, investigate):",
    "  mailbox: false (default). Items are independent.",
    "- Collaborative workflows (agents need to share findings between phases):",
    "  mailbox: true. Agents communicate via shared inbox/outbox.",
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
  } else {
    lines.push("  Available agent types:");
    lines.push('    profile: "general" | "explore" | "plan" | "review"');
    lines.push("");
  }

  if (!hasFileAgents) {
    lines.push("  Tip: Define custom agents in ~/.pi/agents/<name>.md", "");
  }

  lines.push(
    "How to use:",
    "1. Analyze the task. Decompose it into 1-20 items.",
    "2. Pick agent pattern (see above):",
    "   - Items vary by type? Omit profile AND agentType to enable auto-routing.",
    "   - All items are the same kind of work? Set profile.",
    "   - You know the exact file agent to use? Set agentType.",
    "3. Write a prompt_template with {{item}} placeholder.",
    "4. Set mailbox: true if agents need to communicate; false (default) for independent work.",
    "5. Use 1 item for single task, 2-6 for typical parallel work.",
    "6. The tool handles concurrency, rate limits, and error recovery.",
    "7. Read the results from the tool output.",
    "",
    "Each subagent runs in a clean workspace with project rules (AGENTS.md) loaded.",
    "With mailbox, subagents get inbox/outbox and send messages during execution.",
    "Without mailbox, subagents are fully independent and do not communicate.",
    "",
    "Best for: code review, bug fixing, file editing, investigation, refactoring,",
    " multi-step research, phased implementation.",
    "",
    'Optional: set model to "small" for simple/exploratory subagent tasks.',
    'The tool auto-resolves "small" from your settings (pi-swarm.smallModel).',
    "Only use small model for straightforward execution or exploration.",
    "Do NOT use small model for review, planning, or complex analysis.",
    "Default: inherit parent session model (omit model param).",
  );

  return lines.join("\n");
}

export function registerAgentSwarmTool(pi: ExtensionAPI): void {
  const description = buildSwarmDescription();
  pi.registerTool({
    name: "Swarm",
    label: "Swarm",
    description,
    parameters: Type.Object(
      {
        description: Type.Optional(
          Type.String({
            description: "Short description for the whole swarm (optional).",
            examples: ["Review source files for bugs"],
          }),
        ),
        profile: Type.Optional(
          Type.String({
            description:
              'Built-in profile: "general", "explore", "plan", "review". ' +
              "Custom: from .pi/settings.json pi-swarm.subagents. " +
              "Mutually exclusive with agentType. " +
              "When set, ALL items share this profile (disables auto-routing). " +
              "Omit BOTH profile and agentType to enable auto-routing (each item matched individually).",
            examples: ["general", "explore", "review"],
          }),
        ),
        agentType: Type.Optional(
          Type.String({
            description:
              "File-based agent name from ~/.pi/agents/<name>.md or .pi/agents/<name>.md. " +
              "Mutually exclusive with profile. " +
              "When set, ALL items use this agent (disables auto-routing). " +
              "Omit BOTH profile and agentType to enable auto-routing (each item matched individually). " +
              "File agents bundle system prompt, tool permissions, model, and optional match patterns/keywords.",
            examples: ["rust-audit", "vue-dev", "data-science"],
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
          maxItems: MAX_ITEM_COUNT,
          description:
            "Items (1-20) to parallelize across. Each item replaces {{item}} in the template.",
          examples: [["src/auth.ts", "src/api.ts", "src/db.ts"]],
        }),
        model: Type.Optional(
          Type.String({
            description:
              'Model for subagents. Pass "small" to auto-resolve from settings pi-swarm.smallModel. Pass an explicit model ID to override. Omit to inherit parent session model. Do NOT use small model for review, planning, or complex analysis.',
            examples: ["deepseek/deepseek-v4-flash"],
          }),
        ),
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
      const {
        description,
        prompt_template,
        items,
        model,
        mailbox,
        profile,
        agentType,
      } = params as {
        description?: string;
        prompt_template: string;
        items: string[];
        model?: string;
        mailbox?: boolean;
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

      // Resolve model: "small" keyword → lookup settings; explicit model ID → use as-is; undefined → inherit parent
      const resolvedModel =
        model === "small" ? resolveSwarmSmallModel() : model;

      // Resolve agent profile:
      // - When profile OR agentType is specified → all items share one profile
      // - When neither is specified → auto-route each item to the best matching agent
      const useAutoRoute = !profile && !agentType;
      const profileSource = agentType ?? profile;
      const agentProfile = useAutoRoute
        ? resolveProfile(undefined, process.cwd()) // default general, overridden per-item
        : resolveProfile(profileSource, process.cwd());
      const profileName = agentProfile.name;
      const profileModel =
        agentProfile.model === "inherit" ? undefined : agentProfile.model;
      const effectiveModel = profileModel ?? resolvedModel;

      // Pre-load file agents for auto-routing (shared across all items)
      const fileAgents = useAutoRoute
        ? loadFileAgents(process.cwd())
        : undefined;

      const ctx = ctxRaw as ExtensionContext;
      const progress = createProgressWidget(ctx);

      // Persistent run state - declared outside try for catch access
      const swarmRoot =
        process.env.PI_SWARM_ROOT ?? resolveSwarmRoot(process.cwd());
      const runId = `swarm-${Date.now().toString(36)}`;
      let runCreated = false;

      try {
        // Validate prompt_template contains exactly one placeholder
        const placeholderCount =
          prompt_template.split(PROMPT_TEMPLATE_PLACEHOLDER).length - 1;
        if (placeholderCount !== 1) {
          throw new Error(
            `prompt_template must contain {{item}} exactly once, found ${placeholderCount} occurrence(s). ` +
              `Each item replaces the placeholder to generate per-agent prompts.`,
          );
        }

        // Build specs
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

        // Set up mailbox when enabled
        let mailboxPath: string | undefined;
        let mailboxPaths: MailboxPaths | undefined;
        if (mailbox) {
          mailboxPaths = resolveMailboxPaths(swarmRoot, runId);
          ensureMailbox(mailboxPaths);
          mailboxPath = mailboxPaths.root;
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

        // Resolve tool restrictions from profile
        const profileTools = resolveProfileTools(agentProfile);

        // Convert to queued tasks
        const resolvedPaths = mailboxPaths;
        const tasks = specs.map((spec, idx): QueuedSubagentTask<SwarmSpec> => {
          const agentName = deriveAgentName(profileName, spec.item, idx + 1);

          // Auto-route per item when no explicit profile/agentType
          let itemProfile = agentProfile;
          let itemProfileTools = profileTools;
          let itemModel = effectiveModel;
          let itemAdditionalPrompt = agentProfile.systemPrompt;

          if (useAutoRoute && fileAgents) {
            const matched = matchItemToAgent(spec.item, fileAgents);
            if (matched) {
              itemProfile = matched;
              itemProfileTools = resolveProfileTools(matched);
              // Resolve model: if matched agent has explicit model, use it; else inherit
              const matchedModel =
                matched.model === "inherit" ? undefined : matched.model;
              itemModel = matchedModel ?? effectiveModel;
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
            description: `${description ?? "Swarm"} #${spec.index} (${agentName})`,
            swarmIndex: spec.index,
            runInBackground: false,
            swarmItem: spec.item,
            signal,
            timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
            swarmRoot,
            runId,
            useWorktree: true,
            model: itemModel,
            tools: itemProfileTools,
            additionalSystemPrompt: itemAdditionalPrompt,
            mailboxPath,
            roleName: agentName,
            onMessage: resolvedPaths
              ? (msg) => sendMessage(resolvedPaths, msg)
              : undefined,
          };
        });

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
              const state = snapshotToProgressState(snapshot, description);
              state.mailbox = mailbox;
              progress?.component.update(state);
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
          content: [{ type: "text", text: `Swarm failed: ${message}` }],
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
