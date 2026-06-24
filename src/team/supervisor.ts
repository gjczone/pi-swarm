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
} from "../shared/types.js";
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
  type MailboxPaths,
} from "./mailbox.js";

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
   * Get the next phase that is ready to execute (dependencies satisfied,
   * not yet started or assigned).
   */
  getNextReadyPhase(): PhaseState | undefined {
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
        return phase;
      }
    }
    return undefined;
  }

  /**
   * Start the next ready phase and return the role + prompt for the agent.
   */
  startNextPhase(): {
    phase: PhaseState;
    role: AgentRole;
    prompt: string;
  } | null {
    const phase = this.getNextReadyPhase();
    if (!phase) return null;

    const result = this.state.taskGraph.startPhase(phase.phase.name);
    if (!result.ok) return null;

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
    this.emitProgress();
    return {
      phase,
      role: phase.phase.role,
      prompt,
    };
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
  ): {
    result: string;
    deliveredMessages: number;
  } {
    const phase = this.state.taskGraph.getPhase(name);
    if (!phase) {
      return { result: rawOutput, deliveredMessages: 0 };
    }

    const { result, messages } = this.parseAgentMessages(rawOutput);
    this.state.taskGraph.completePhase(name, result);

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
   * Get the effective model and tools for a given role.
   * Returns undefined for model/tools when no role-specific config exists.
   */
  getRoleConfig(role: AgentRole): { model?: string; tools?: string[] } {
    const roleConfig = this.config.roles?.find((r) => r.role === role);
    return {
      model: roleConfig?.model,
      tools: roleConfig?.tools,
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
      }));
      const completed = phases.filter((p) => p.status === "completed").length;
      const failed = phases.filter((p) => p.status === "failed").length;

      // Find current running phase
      const runningPhase = phases.find((p) => p.status === "running");

      // Best-effort mailbox count
      let mailboxCount = 0;
      try {
        const inbox = readTaskInbox(this.mailboxPaths, "supervisor");
        mailboxCount = inbox.length;
      } catch {
        // Ignore mailbox read errors
      }

      const snapshot: TeamProgressSnapshot = {
        title: this.config.goal,
        goal: this.config.goal,
        status: this.state.status,
        totalPhases: phases.length,
        completedPhases: completed,
        failedPhases: failed,
        currentPhase: runningPhase?.name,
        currentRole: runningPhase?.role,
        phases,
        mailboxCount,
        startedAt: this.state.startedAt,
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
   */
  synthesizeResult(): string {
    const lines: string[] = [
      "<swarm_team_result>",
      `<summary>${this.buildSummary()}</summary>`,
    ];

    for (const phase of this.state.taskGraph.getAllPhases()) {
      const name = phase.phase.name;
      const role = phase.phase.role;
      const status = phase.status;
      const result = phase.result ?? "";
      const error = phase.error ?? "";

      lines.push(
        `<phase name="${escapeXml(name)}" role="${escapeXml(role)}" outcome="${escapeXml(status)}">`,
      );

      if (status === "completed" && result) {
        lines.push(escapeXml(result));
      } else if (status === "failed" && error) {
        lines.push(`<error>${escapeXml(error)}</error>`);
      }

      lines.push(`</phase>`);
    }

    lines.push("</swarm_team_result>");
    return lines.join("\n");
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
              | Record<string, string>
              | undefined;
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
      `You can send messages to other team members by including them in your output using this format:`,
      "",
      `<mailbox_message to="role_name">`,
      `Your message content here. Be specific about what you found and what they need to know.`,
      `</mailbox_message>`,
      "",
      `You can address messages to: explorer, planner, coder, reviewer, tester, fixer, or broadcast.`,
      `Messages are delivered after your phase completes.`,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
