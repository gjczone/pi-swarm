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
  updateDeliveryState,
  type MailboxPaths,
} from "./mailbox.js";

// ---------------------------------------------------------------------------
// Supervisor config
// ---------------------------------------------------------------------------

export interface TeamSupervisorConfig {
  /** Working directory for the team run. */
  readonly cwd: string;
  /** Crew root for state persistence. */
  readonly crewRoot: string;
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

  constructor(config: TeamSupervisorConfig) {
    this.config = config;
    this.mailboxPaths = resolveMailboxPaths(
      config.crewRoot,
      config.runId,
    );

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
        dependsOn: phase.phase.dependsOn ?? [],
      },
    };
    sendMessage(this.mailboxPaths, assignmentMessage);
    updateDeliveryState(this.mailboxPaths, assignmentMessage.messageId, "delivered");

    const prompt = this.buildPhasePrompt(phase);
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
    const messageRegex = /<mailbox_message\s+to="([^"]+)">([\s\S]*?)<\/mailbox_message>/g;
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
  completePhase(name: string, rawOutput: string): {
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
        updateDeliveryState(this.mailboxPaths, handoffMessage.messageId, "delivered");
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
    updateDeliveryState(this.mailboxPaths, resultMessage.messageId, "broadcast");

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
  }

  /**
   * Assign an agent to a phase.
   */
  assignAgent(phaseName: string, agentId: string): void {
    this.state.agentIds.set(phaseName, agentId);
    this.state.taskGraph.assignAgent(phaseName, agentId);
  }

  // -------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------

  /** Check if the entire run is complete. */
  isComplete(): boolean {
    return this.state.taskGraph.isComplete();
  }

  /** Finalize the run with an overall status. */
  finalize(): void {
    this.state.status = this.state.taskGraph.overallStatus();
    this.state.completedAt = Date.now();
  }

  /**
   * Synthesize the final team result from all completed phases.
   */
  synthesizeResult(): string {
    const lines: string[] = [
      "<agent_team_result>",
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

    lines.push("</agent_team_result>");
    return lines.join("\n");
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private buildPhasePrompt(phase: PhaseState): string {
    const goal = this.config.goal;
    const role = phase.phase.role;
    const name = phase.phase.name;

    // Gather context from completed dependency phases
    const deps = phase.phase.dependsOn ?? [];
    let contextBlock = "";
    if (deps.length > 0) {
      const depResults = deps
        .map((dep) => {
          const depState = this.state.taskGraph.getPhase(dep);
          if (!depState || !depState.result) return null;
          return `${dep} output:\n${depState.result}`;
        })
        .filter(Boolean)
        .join("\n\n");

      if (depResults) {
        contextBlock = `\n\nContext from previous phases:\n${depResults}`;
      }
    }

    // Read messages addressed to this role
    let messagesBlock = "";
    try {
      const roleMessages = readTaskInbox(this.mailboxPaths, role);
      const handoffMessages = roleMessages.filter(
        (m) => m.type === "handoff" || m.type === "task_assignment",
      );
      if (handoffMessages.length > 0) {
        const messageText = handoffMessages
          .map((m) => `Message from ${m.from}:\n${String(m.payload.content ?? m.payload.phase ?? "")}`)
          .join("\n\n");
        messagesBlock = `\n\nMessages for you:\n${messageText}`;
      }
    } catch {
      // Ignore mailbox read errors
    }

    return [
      `You are the ${role} agent in a team working on: ${goal}`,
      `Your current phase is: ${name}`,
      contextBlock,
      messagesBlock,
      ``,
      `## Communication Protocol`,
      ``,
      `You can send messages to other team members by including them in your output using this format:`,
      ``,
      `<mailbox_message to="role_name">`,
      `Your message content here.`,
      `</mailbox_message>`,
      ``,
      `You can address messages to: explorer, planner, coder, reviewer, tester, fixer, or broadcast.`,
      `Messages are delivered after your phase completes.`,
      ``,
      `Your final output (outside of mailbox_message tags) is your phase result.`,
      `Complete the ${name} phase and write your result.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildSummary(): string {
    const all = this.state.taskGraph.getAllPhases();
    const completed = all.filter(
      (p) => p.status === "completed",
    ).length;
    const failed = all.filter(
      (p) => p.status === "failed",
    ).length;
    const skipped = all.filter(
      (p) => p.status === "skipped",
    ).length;
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
