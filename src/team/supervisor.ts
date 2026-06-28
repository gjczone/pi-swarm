/**
 * team/supervisor — team supervisor agent.
 *
 * The supervisor decomposes a high-level goal into phases, assigns
 * each phase to a role agent, monitors progress via the mailbox,
 * and synthesizes the final result.
 */

import type {
  AgentRole,
  TeamPhase,
  AgentRoleConfig,
  MailboxMessage,
  TeamProgressCallback,
  TeamProgressSnapshot,
  ModelTier,
  SubagentUsage,
} from "../shared/types.js";
import { SMALL_MODEL_ROLES } from "../shared/types.js";
import { escapeXmlAttr, escapeXmlBody } from "../shared/xml.js";
import {
  TaskGraph,
  DEFAULT_TEAM_PHASES,
  type PhaseState,
} from "./task-graph.js";
import {
  resolveMailboxPaths,
  ensureMailbox,
  sendMessage,
  readTaskInbox,
  ackTaskMessages,
  updateDeliveryState,
  countOutboxMessages,
  type MailboxPaths,
} from "./mailbox.js";

/**
 * Get the mailbox root path for a given run.
 * Exposed so tool.ts can pass it to the controller for real-time mailbox access.
 */
export function getMailboxRoot(swarmRoot: string, runId: string): string {
  return resolveMailboxPaths(swarmRoot, runId).root;
}

// ---------------------------------------------------------------------------
// Supervisor config
// ---------------------------------------------------------------------------

export interface TeamSupervisorConfig {
  /** Working directory for the team run. */
  readonly cwd: string;
  /** Swarm root for state persistence. */
  readonly swarmRoot: string;
  /** Unique run identifier. */
  readonly runId: string;
  /** High-level goal. */
  readonly goal: string;
  /** Custom phases (defaults to explore/plan/implement/review/test). */
  readonly phases?: readonly TeamPhase[];
  /** Custom role configs. */
  readonly roles?: readonly AgentRoleConfig[];
  /** Model to use for lightweight/exploration roles (e.g. explorer). */
  readonly smallModel?: string;
  /** Max concurrent agents. */
  readonly maxAgents?: number;
  /** Progress callback for TUI dashboard updates. */
  readonly onProgress?: TeamProgressCallback;
}

// ---------------------------------------------------------------------------
// Team run state
// ---------------------------------------------------------------------------

export interface TeamRunState {
  readonly runId: string;
  readonly goal: string;
  status: "running" | "completed" | "failed";
  taskGraph: TaskGraph;
  agentIds: Map<string, string>; // phase name → agent ID
  startedAt: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export class TeamSupervisor {
  readonly config: TeamSupervisorConfig;
  readonly state: TeamRunState;
  readonly mailboxPaths: MailboxPaths;
  private readonly onProgress?: TeamProgressCallback;

  constructor(config: TeamSupervisorConfig) {
    this.config = config;
    this.onProgress = config.onProgress;
    this.mailboxPaths = resolveMailboxPaths(config.swarmRoot, config.runId);

    const phases = config.phases ?? DEFAULT_TEAM_PHASES;
    this.state = {
      runId: config.runId,
      goal: config.goal,
      status: "running",
      taskGraph: new TaskGraph([...phases]),
      agentIds: new Map(),
      startedAt: Date.now(),
    };

    ensureMailbox(this.mailboxPaths);

    // Emit initial state (all queued)
    this.emitProgress();
  }

  // -------------------------------------------------------------------
  // Phase management
  // -------------------------------------------------------------------

  /**
   * Get ALL phases that are ready to execute (dependencies satisfied,
   * not yet started or assigned).  Returns in definition order.
   *
   * 业务说明：返回所有依赖已满足、尚未开始的阶段，而非仅第一个。
   * 这使得独立阶段可以并行执行。
   */
  getAllReadyPhases(): PhaseState[] {
    const ready: PhaseState[] = [];
    for (const name of this.state.taskGraph.getPhaseNames()) {
      const phase = this.state.taskGraph.getPhase(name);
      if (!phase || phase.status !== "queued") continue;

      // Check dependencies
      const deps = phase.phase.dependsOn ?? [];
      const depsSatisfied = deps.every((dep) => {
        const depState = this.state.taskGraph.getPhase(dep);
        return depState?.status === "completed";
      });

      if (depsSatisfied) {
        ready.push(phase);
      }
    }
    return ready;
  }

  /**
   * Start ALL currently ready phases and return their execution descriptors.
   * Returns an empty array when no phases are ready.
   *
   * 业务说明：一次性启动所有就绪阶段，支持并行执行。
   * 调用者应并发启动所有返回的阶段。
   */
  startReadyPhases(): Array<{
    phase: PhaseState;
    role: AgentRole;
    prompt: string;
  }> {
    const readyPhases = this.getAllReadyPhases();
    const results: Array<{
      phase: PhaseState;
      role: AgentRole;
      prompt: string;
    }> = [];

    for (const phase of readyPhases) {
      const result = this.state.taskGraph.startPhase(phase.phase.name);
      if (!result.ok) continue;

      // Gather dependency results to include in assignment
      const deps = phase.phase.dependsOn ?? [];
      const depResults: Record<string, string> = {};
      for (const dep of deps) {
        const depState = this.state.taskGraph.getPhase(dep);
        if (depState?.result) {
          depResults[dep] = depState.result;
        }
      }

      // Send task assignment message to the role's mailbox
      const assignmentMessage: MailboxMessage = {
        messageId: this.generateMessageId(),
        runId: this.state.runId,
        timestamp: new Date().toISOString(),
        from: "supervisor",
        to: phase.phase.role,
        type: "task_assignment",
        payload: {
          phase: phase.phase.name,
          goal: this.config.goal,
          dependsOn: deps,
          dependencyResults: depResults,
        },
      };
      sendMessage(this.mailboxPaths, assignmentMessage);
      updateDeliveryState(
        this.mailboxPaths,
        assignmentMessage.messageId,
        "delivered",
      );

      const prompt = this.buildPhasePrompt(phase);
      results.push({
        phase,
        role: phase.phase.role,
        prompt,
      });
    }

    if (results.length > 0) {
      this.emitProgress();
    }
    return results;
  }

  /**
   * Parse agent output for mailbox_message blocks and separate them from the result.
   */
  parseAgentMessages(output: string): {
    result: string;
    messages: Array<{ to: string; content: string }>;
  } {
    const messages: Array<{ to: string; content: string }> = [];
    const messageRegex =
      /<mailbox_message\s+to="([^"]+)">([\s\S]*?)<\/mailbox_message>/g;
    let match;
    while ((match = messageRegex.exec(output)) !== null) {
      messages.push({
        to: match[1]!.trim(),
        content: match[2]!.trim(),
      });
    }
    const result = output.replace(messageRegex, "").trim();
    return { result, messages };
  }

  /**
   * Mark a phase as completed with its raw output.
   * Parses messages from output, delivers them, and sends task_result broadcast.
   */
  completePhase(
    name: string,
    rawOutput: string,
    usage?: SubagentUsage,
  ): {
    result: string;
    deliveredMessages: number;
  } {
    const phase = this.state.taskGraph.getPhase(name);
    if (!phase) {
      return { result: rawOutput, deliveredMessages: 0 };
    }

    const { result, messages } = this.parseAgentMessages(rawOutput);
    this.state.taskGraph.completePhase(name, result, usage);

    // Deliver parsed handoff messages
    let deliveredCount = 0;
    for (const msg of messages) {
      try {
        const handoffMessage: MailboxMessage = {
          messageId: this.generateMessageId(),
          runId: this.state.runId,
          timestamp: new Date().toISOString(),
          from: name,
          to: msg.to,
          type: "handoff",
          payload: { content: msg.content },
        };
        sendMessage(this.mailboxPaths, handoffMessage);
        updateDeliveryState(
          this.mailboxPaths,
          handoffMessage.messageId,
          "delivered",
        );
        deliveredCount++;
      } catch {
        // Skip invalid messages
      }
    }

    // Broadcast task result
    const resultMessage: MailboxMessage = {
      messageId: this.generateMessageId(),
      runId: this.state.runId,
      timestamp: new Date().toISOString(),
      from: name,
      to: "broadcast",
      type: "task_result",
      payload: { phase: name, result },
    };
    sendMessage(this.mailboxPaths, resultMessage);
    updateDeliveryState(
      this.mailboxPaths,
      resultMessage.messageId,
      "broadcast",
    );

    this.emitProgress();
    return { result, deliveredMessages: deliveredCount };
  }

  private generateMessageId(): string {
    return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Mark a phase as failed.
   */
  failPhase(name: string, error: string): void {
    this.state.taskGraph.failPhase(name, error);

    // BFS: skip all phases that depend (directly or transitively) on a failed/skipped phase
    const queue = [name];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const otherName of this.state.taskGraph.getPhaseNames()) {
        const other = this.state.taskGraph.getPhase(otherName);
        if (!other || other.status !== "queued") continue;
        const deps = other.phase.dependsOn ?? [];
        if (deps.includes(current)) {
          this.state.taskGraph.skipPhase(otherName);
          queue.push(otherName);
        }
      }
    }

    this.emitProgress();
  }

  /** Assign an agent to a phase. */
  assignAgent(phaseName: string, agentId: string): void {
    this.state.agentIds.set(phaseName, agentId);
    this.state.taskGraph.assignAgent(phaseName, agentId);
  }

  /**
   * Update token usage for a running phase (for real-time progress display).
   *
   * 业务说明：实时更新运行中阶段的 token 使用量，供 TUI 仪表盘显示。
   * 由 controller 的 onUsage 回调在每次 usage 更新时调用。
   */
  updatePhaseUsage(phaseName: string, usage: SubagentUsage): void {
    const phase = this.state.taskGraph.getPhase(phaseName);
    if (phase && phase.status === "running") {
      phase.usage = { ...usage };
      this.emitProgress();
    }
  }

  /**
   * Handle a real-time message sent by an agent during execution (not just at completion).
   * Delivers the message to the recipient's inbox immediately, enabling true live communication.
   *
   * 业务说明：处理 agent 运行期间实时发送的消息（而不是仅在完成时）。
   * 消息立即投递到接收方的 inbox 文件，正在运行的 agent 可以读取到。
   * 这实现了真正的实时 agent 间通信，无需等待阶段完成。
   */
  handleRealtimeMessage(fromRole: string, message: MailboxMessage): void {
    try {
      // Override from field to use the actual sender role
      const deliveryMessage: MailboxMessage = {
        ...message,
        from: fromRole,
      };
      sendMessage(this.mailboxPaths, deliveryMessage);
      updateDeliveryState(
        this.mailboxPaths,
        deliveryMessage.messageId,
        message.to === "broadcast" ? "broadcast" : "delivered",
      );
      // Update TUI to reflect new message count
      this.emitProgress();
    } catch {
      // Best effort real-time delivery; failures are non-fatal
    }
  }

  /**
   * Get the mailbox root path for passing to spawner/controller.
   */
  getMailboxPath(): string {
    return this.mailboxPaths.root;
  }

  /**
   * Resolve the model and tools configuration for a given phase.
   *
   * Resolution order (highest priority first):
   * 1. Phase-level explicit model override (phase.model)
   * 2. Phase-level modelTier (small => smallModel if configured)
   * 3. Role-level model override from roles config
   * 4. Auto-routing by role name: roles in SMALL_MODEL_ROLES => smallModel
   * 5. Default model (undefined, inherits parent)
   */
  getPhaseExecutionConfig(phaseName: string): {
    model?: string;
    tools?: string[];
    cwd: string;
  } {
    const phase = this.state.taskGraph.getPhase(phaseName);
    const role = phase?.phase.role;
    const roleConfig = role
      ? this.config.roles?.find((r) => r.role === role)
      : undefined;

    let model: string | undefined;
    let tools: string[] | undefined;

    // Role-level tools whitelist
    if (roleConfig?.tools) {
      tools = [...roleConfig.tools];
    }

    // Phase-level explicit model (highest priority)
    if (phase?.phase.model) {
      model = phase.phase.model;
    }
    // Phase-level modelTier override
    else if (phase?.phase.modelTier === "small" && this.config.smallModel) {
      model = this.config.smallModel;
    } else if (phase?.phase.modelTier === "default") {
      model = undefined; // explicit default
    }
    // Role-level model override
    else if (roleConfig?.model) {
      model = roleConfig.model;
    }
    // Auto-routing: explorer (and other SMALL_MODEL_ROLES) => smallModel
    else if (role && SMALL_MODEL_ROLES.has(role) && this.config.smallModel) {
      model = this.config.smallModel;
    }

    // Phase-level tools override (overrides role config)
    if (phase?.phase.tools) {
      tools = [...phase.phase.tools];
    }

    return {
      model,
      tools,
      cwd: this.config.cwd,
    };
  }

  // -------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // Progress emission
  // -------------------------------------------------------------------

  /**
   * Build and emit a TeamProgressSnapshot for the TUI dashboard.
   *
   * Reads current phase statuses from the task graph, counts mailbox
   * messages, and calls the optional onProgress callback with the
   * snapshot.
   */
  private emitProgress(): void {
    if (!this.onProgress) return;

    try {
      const allPhases = this.state.taskGraph.getAllPhases();
      const phases = allPhases.map((p) => ({
        name: p.phase.name,
        role: p.phase.role,
        status: p.status as TeamProgressSnapshot["phases"][number]["status"],
        error: p.error,
        usage: p.usage,
      }));
      const completed = phases.filter((p) => p.status === "completed").length;
      const failed = phases.filter((p) => p.status === "failed").length;

      // Find current running phase(s)
      const runningPhases = phases.filter((p) => p.status === "running");
      const runningPhase = runningPhases[0];

      let mailboxCount = 0;
      try {
        mailboxCount = countOutboxMessages(this.mailboxPaths);
      } catch {
        // Ignore mailbox read errors
      }

      const totalUsage = this.state.taskGraph.getTotalUsage();

      const snapshot: TeamProgressSnapshot = {
        title: this.config.goal,
        goal: this.config.goal,
        status: this.state.status,
        totalPhases: phases.length,
        completedPhases: completed,
        failedPhases: failed,
        currentPhase:
          runningPhases.length > 0
            ? runningPhases.map((p) => p.name).join(", ")
            : runningPhase?.name,
        currentRole:
          runningPhases.length > 0
            ? runningPhases.map((p) => p.role).join(", ")
            : runningPhase?.role,
        phases,
        mailboxCount,
        startedAt: this.state.startedAt,
        totalUsage,
      };

      this.onProgress(snapshot);
    } catch {
      // Best effort — dashboard failure must not break the run
    }
  }

  /** Check if the entire run is complete. */
  isComplete(): boolean {
    return this.state.taskGraph.isComplete();
  }

  /** Finalize the run with an overall status. */
  finalize(): void {
    this.state.status = this.state.taskGraph.overallStatus();
    this.state.completedAt = Date.now();
    this.emitProgress();
  }

  /**
   * Synthesize the final team result from all completed phases.
   * Max characters of phase output to include inline; rest is truncated.
   */
  private static readonly MAX_PHASE_OUTPUT_CHARS = 50000;

  synthesizeResult(): string {
    const allPhases = this.state.taskGraph.getAllPhases();
    const durationMs =
      (this.state.completedAt ?? Date.now()) - this.state.startedAt;

    const lines: string[] = [
      "<swarm_team_result>",
      `<summary>${this.buildSummary()}</summary>`,
      `<total_duration_ms>${durationMs}</total_duration_ms>`,
    ];

    // Per-phase results
    for (const phase of allPhases) {
      const name = phase.phase.name;
      const role = phase.phase.role;
      const status = phase.status;
      const result = phase.result ?? "";
      const error = phase.error ?? "";
      const agentId = phase.agentId ?? "";
      const duration =
        phase.startedAt && phase.completedAt
          ? phase.completedAt - phase.startedAt
          : undefined;

      const attrs = [
        `name="${escapeXmlAttr(name)}"`,
        `role="${escapeXmlAttr(role)}"`,
        `outcome="${escapeXmlAttr(status)}"`,
      ];
      if (agentId) attrs.push(`agent_id="${escapeXmlAttr(agentId)}"`);
      if (duration !== undefined)
        attrs.push(`duration_ms="${String(duration)}"`);

      lines.push(`<phase ${attrs.join(" ")}>`);

      if (status === "completed") {
        if (result.trim()) {
          const truncated = this.truncateForOutput(result);
          lines.push(escapeXmlBody(truncated));
        } else {
          lines.push(
            "(agent returned no text output; see per-agent output.log for full session transcript)",
          );
        }
      } else if (status === "failed" && error) {
        lines.push(`<error>${escapeXmlBody(error)}</error>`);
      } else if (status === "skipped") {
        lines.push("(phase skipped due to failed dependency)");
      }

      lines.push(`</phase>`);
    }

    // Supervisor synthesis — a consolidated summary across all phases
    lines.push("<supervisor_synthesis>");
    lines.push(escapeXmlBody(this.buildSynthesis(allPhases)));
    lines.push("</supervisor_synthesis>");

    lines.push("</swarm_team_result>");
    return lines.join("\n");
  }

  /**
   * Truncate a phase result to MAX_PHASE_OUTPUT_CHARS with a note.
   */
  private truncateForOutput(text: string): string {
    if (text.length <= TeamSupervisor.MAX_PHASE_OUTPUT_CHARS) {
      return text;
    }
    const truncated = text.slice(0, TeamSupervisor.MAX_PHASE_OUTPUT_CHARS);
    return (
      truncated +
      `\n\n... [output truncated: ${text.length - TeamSupervisor.MAX_PHASE_OUTPUT_CHARS} additional characters omitted. See output.log for full content.]`
    );
  }

  /**
   * Build a consolidated synthesis across all completed phases.
   *
   * Extracts the first non-empty line or heading from each phase to create
   * an executive summary, then lists all phases with their key outcomes.
   */
  private buildSynthesis(phases: readonly PhaseState[]): string {
    const sections: string[] = [];
    const completedPhases = phases.filter((p) => p.status === "completed");
    const failedPhases = phases.filter((p) => p.status === "failed");

    sections.push(`### Team Run: ${this.config.goal.slice(0, 200)}`);
    sections.push("");

    if (failedPhases.length > 0) {
      sections.push(`### Errors`);
      for (const p of failedPhases) {
        sections.push(
          `- **${p.phase.name}** (${p.phase.role}): ${p.error ?? "unknown error"}`,
        );
      }
      sections.push("");
    }

    sections.push(`### Phase Outcomes`);
    for (const p of phases) {
      const status = p.status;
      const bullet =
        status === "completed"
          ? "DONE"
          : status === "failed"
            ? "FAIL"
            : status === "skipped"
              ? "SKIP"
              : "??";
      const firstLine = this.extractFirstMeaningfulLine(p.result ?? "");
      const suffix = firstLine ? ` — ${firstLine}` : "";
      sections.push(
        `- [${bullet}] **${p.phase.name}** (${p.phase.role})${suffix}`,
      );
    }

    if (completedPhases.length > 0) {
      sections.push("");
      sections.push(`### Key Deliverables`);
      for (const p of completedPhases) {
        const excerpt = this.extractExcerpt(p.result ?? "");
        if (excerpt) {
          sections.push(`#### ${p.phase.name} (${p.phase.role})`);
          sections.push(excerpt);
          sections.push("");
        }
      }
    }

    return sections.join("\n");
  }

  /**
   * Extract the first meaningful line (not empty, not a mailbox tag).
   */
  private extractFirstMeaningfulLine(text: string): string {
    const lines = text.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("<mailbox_message")) continue;
      if (trimmed.startsWith("</mailbox_message")) continue;
      // Strip leading markdown heading markers
      const cleaned = trimmed.replace(/^#+\s*/, "");
      return cleaned.slice(0, 120);
    }
    return "";
  }

  /**
   * Extract a short excerpt (first ~400 chars of meaningful content) from a phase result.
   */
  private extractExcerpt(text: string): string {
    const lines = text.split("\n");
    const meaningful: string[] = [];
    let total = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("<mailbox_message")) continue;
      if (trimmed.startsWith("</mailbox_message")) continue;
      meaningful.push(line);
      total += line.length;
      if (total > 400) break;
    }
    return meaningful.join("\n").slice(0, 500);
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private buildPhasePrompt(phase: PhaseState): string {
    const goal = this.config.goal;
    const role = phase.phase.role;
    const name = phase.phase.name;
    const deps = phase.phase.dependsOn ?? [];

    // Gather context from completed dependency phases
    let contextBlock = "";
    if (deps.length > 0) {
      const depSections = deps
        .map((dep) => {
          const depState = this.state.taskGraph.getPhase(dep);
          if (!depState) return null;
          const status = depState.status;
          if (status === "failed") {
            return `### ${dep} (${depState.phase.role}) — FAILED\nError: ${depState.error ?? "unknown"}`;
          }
          if (status === "skipped") {
            return `### ${dep} (${depState.phase.role}) — SKIPPED`;
          }
          if (depState.result) {
            return `### ${dep} (${depState.phase.role})\n${depState.result}`;
          }
          return null;
        })
        .filter(Boolean)
        .join("\n\n");

      if (depSections) {
        contextBlock = `\n\n## Previous Phase Results\n\n${depSections}\n`;
      }
    }

    // Read messages addressed to this role
    let messagesBlock = "";
    const ackIds: string[] = [];
    try {
      const roleMessages = readTaskInbox(this.mailboxPaths, role);
      if (roleMessages.length > 0) {
        const messageParts: string[] = [];
        for (const m of roleMessages) {
          ackIds.push(m.messageId);
          if (m.type === "task_assignment") {
            const depList = Array.isArray(m.payload.dependsOn)
              ? (m.payload.dependsOn as string[]).join(", ")
              : "(none)";
            let depResultsText = "";
            const depResults = m.payload.dependencyResults as
              Record<string, string> | undefined;
            if (depResults && Object.keys(depResults).length > 0) {
              depResultsText = Object.entries(depResults)
                .map(
                  ([depName, depResult]) =>
                    `#### ${depName} result:\n${depResult}`,
                )
                .join("\n\n");
            }
            messageParts.push(
              `### Task Assignment from supervisor (${m.timestamp})\n` +
                `Phase: ${m.payload.phase ?? name}\n` +
                `Dependencies: ${depList}\n` +
                (depResultsText ? `\n${depResultsText}\n` : ""),
            );
          } else if (m.type === "handoff") {
            const content = String(m.payload.content ?? "");
            messageParts.push(
              `### Message from ${m.from} (${m.timestamp})\n${content}`,
            );
          } else if (m.type === "task_result") {
            const resultText = String(m.payload.result ?? "");
            const fromPhase = String(m.payload.phase ?? m.from);
            messageParts.push(
              `### Completed: ${fromPhase} (${m.timestamp})\n${resultText}`,
            );
          }
        }
        if (messageParts.length > 0) {
          messagesBlock = `\n## Messages\n\n${messageParts.join("\n\n")}\n`;
        }
      }
    } catch {
      // Ignore mailbox read errors
    }

    // Acknowledge messages that were included in the prompt
    if (ackIds.length > 0) {
      try {
        ackTaskMessages(this.mailboxPaths, role, ackIds);
      } catch {
        // Best effort acknowledgment
      }
    }

    // Get role-specific system prompt if configured
    const roleConfig = this.config.roles?.find((r) => r.role === role);
    const roleSystemPrompt = roleConfig?.systemPrompt;

    return [
      roleSystemPrompt
        ? roleSystemPrompt
        : `You are the ${role} agent on a software engineering team.`,
      "",
      `## Overall Goal`,
      "",
      goal,
      "",
      `## Your Current Phase: ${name}`,
      "",
      contextBlock,
      messagesBlock,
      `## Communication Protocol`,
      "",
      `You have TWO ways to communicate with other team members:`,
      "",
      `1. **In your final output** (delivered after you complete):`,
      `   Wrap messages in: <mailbox_message to="role_name">content</mailbox_message>`,
      "",
      `2. **Real-time during your work** (delivered immediately):`,
      `   Append a JSON line to your outbox file (see "Real-time Mailbox Communication" section below).`,
      `   Check your inbox file periodically for new messages from teammates.`,
      "",
      `You can address messages to: explorer, planner, coder, reviewer, tester, fixer, or broadcast (all agents).`,
      "",
      `Your final output (outside of mailbox_message tags) is your phase result.`,
      `Complete the ${name} phase and write your result.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildSummary(): string {
    const all = this.state.taskGraph.getAllPhases();
    const completed = all.filter((p) => p.status === "completed").length;
    const failed = all.filter((p) => p.status === "failed").length;
    const skipped = all.filter((p) => p.status === "skipped").length;
    const total = all.length;

    return (
      `Phases completed: ${completed}/${total}. ` +
      `Succeeded: ${completed}, Failed: ${failed}, Skipped: ${skipped}.`
    );
  }
}
