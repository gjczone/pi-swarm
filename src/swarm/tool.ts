/**
 * swarm/tool — AgentSwarm tool registration.
 *
 * Registers the `AgentSwarm` tool that the LLM can call to launch
 * multiple subagents from a shared prompt template.
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
  SwarmResumeSpec,
  SwarmSpec,
} from "../shared/types.js";
import {
  resolveSwarmRoot,
  createManifest,
  updateManifest,
  readManifest,
  registerAgentInManifest,
} from "../state/persistence.js";
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
const MAX_AGENT_SWARM_SUBAGENTS = 128;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const AGENT_SWARM_DESCRIPTION = `Launch multiple subagents from one prompt template, existing agent resumes, or both.

Use AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`["src/a.ts", "src/b.ts"]\`, AgentSwarm launches two new subagents with those two concrete prompts.

Use \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.

AgentSwarm also works for single subagents (1 item).  Use it for any task you want to delegate to a fresh subagent with an isolated context — from 1 to 128 items.  Launches are queued automatically.  Single-agent calls still require \`prompt_template\` with \`{{item}}\` and at least one item.

If \`AgentSwarm\` is called, that call must be the only tool call in the response.`;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentSwarmTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "AgentSwarm",
    label: "Agent Swarm",
    description: AGENT_SWARM_DESCRIPTION,
    parameters: Type.Object(
      {
        description: Type.String({
          description: "Short description for the whole swarm.",
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
              "Values used to fill the {{item}} placeholder. Each item launches one new subagent. Supports 1 to 128 items.",
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
      ctxRaw: unknown,
    ) => {
      const {
        description,
        subagent_type,
        prompt_template,
        items,
        resume_agent_ids,
      } = params as {
        description: string;
        subagent_type?: string;
        prompt_template?: string;
        items?: string[];
        resume_agent_ids?: Record<string, string>;
      };

      const ctx = ctxRaw as ExtensionContext;
      const progress = createProgressWidget(ctx);

      // Persistent run state - declared outside try for catch access
      const swarmRoot =
        process.env.PI_SWARM_ROOT ?? resolveSwarmRoot(process.cwd());
      const runId = `swarm-${Date.now().toString(36)}`;
      let runCreated = false;

      try {
        const profileName =
          normalizeOptionalString(subagent_type) ?? DEFAULT_SUBAGENT_TYPE;

        // Build specs
        const specs = createAgentSwarmSpecs({
          items,
          resume_agent_ids,
          prompt_template,
        });

        createManifest(swarmRoot, {
          runId,
          type: "swarm",
          status: "running",
          goal: description,
          startedAt: Date.now(),
          agentIds: [],
        });
        runCreated = true;

        // Convert to queued tasks
        const tasks = specs.map((spec): QueuedSubagentTask<SwarmSpec> => {
          const descriptionName =
            spec.kind === "resume" ? "resume" : profileName;
          const common = {
            data: spec,
            profileName: spec.kind === "resume" ? "subagent" : profileName,
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
            swarmRoot,
            runId,
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
        });

        // Run with controller
        const maxConcurrency = resolveSwarmMaxConcurrency(process.cwd());
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

        // Trigger completion animation before tearing down
        progress?.component.complete();

        // Render output
        const swarmResults = toSwarmRunResults(results);
        const output = renderSwarmResults(swarmResults);

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
      const subagentType = (args.subagent_type as string) || "coder";
      const itemCount = (args.items as string[] | undefined)?.length ?? 0;
      const resumeCount = Object.keys(
        (args.resume_agent_ids as Record<string, string> | undefined) ?? {},
      ).length;
      const totalCount = itemCount + resumeCount;
      const hasResume = resumeCount > 0;

      const container = new Container();
      const title = `${theme.fg("toolTitle", theme.bold("swarm "))}${theme.fg("accent", `${totalCount} agent${totalCount !== 1 ? "s" : ""}`)}${hasResume ? theme.fg("warning", ` (${resumeCount} resume)`) : ""}${theme.fg("muted", ` [${subagentType}]`)}`;
      container.addChild(new Text(title, 0, 0));

      const desc = args.description as string;
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
// Spec creation (from kimi-code)
// ---------------------------------------------------------------------------

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

  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error(
      "AgentSwarm requires at least 1 item or a resume_agent_ids entry.",
    );
  }

  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error(
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
    );
  }

  const promptTemplate = normalizeOptionalString(args.prompt_template);

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
  return resumeCount > 0 || itemCount >= 1;
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
