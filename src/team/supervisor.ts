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
   * Max characters of phase output to include inline; rest is truncated.
   */
  private static readonly MAX_PHASE_OUTPUT_CHARS = 12000;

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
        `name="${escapeAttr(name)}"`,
        `role="${escapeAttr(role)}"`,
        `outcome="${escapeAttr(status)}"`,
      ];
      if (agentId) attrs.push(`agent_id="${escapeAttr(agentId)}"`);
      if (duration !== undefined)
        attrs.push(`duration_ms="${String(duration)}"`);

      lines.push(`<phase ${attrs.join(" ")}>`);

      if (status === "completed") {
        if (result.trim()) {
          const truncated = this.truncateForOutput(result);
          lines.push(truncated);
        } else {
          lines.push(
            "(agent returned no text output; see per-agent output.log for full session transcript)",
          );
        }
      } else if (status === "failed" && error) {
        lines.push(`<error>${escapeBody(error)}</error>`);
      } else if (status === "skipped") {
        lines.push("(phase skipped due to failed dependency)");
      }

      lines.push(`</phase>`);
    }

    // Supervisor synthesis — a consolidated summary across all phases
    lines.push("<supervisor_synthesis>");
    lines.push(this.buildSynthesis(allPhases));
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
      sections.push(`- [${bullet}] **${p.phase.name}** (${p.phase.role})${suffix}`);
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
          .map(
            (m) =>
              `Message from ${m.from}:\n${String(m.payload.content ?? m.payload.phase ?? "")}`,
          )
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

/**
 * Escape a string for use in an XML attribute value.
 * Full XML special character escaping.
 */
function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Minimal escaping for XML element body content.
 * Only escapes & and ]]> to prevent XML parsing errors while
 * preserving markdown formatting (headers, lists, bold, etc.).
 */
function escapeBody(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("]]>", "]]&gt;");
}
