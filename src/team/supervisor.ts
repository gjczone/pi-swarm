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
} from "../shared/types.js";
import {
  TaskGraph,
  DEFAULT_TEAM_PHASES,
  type PhaseState,
} from "./task-graph.js";
import {
  resolveMailboxPaths,
  ensureMailbox,
  readInbox,
  readTaskInbox,
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

    const prompt = this.buildPhasePrompt(phase);
    return {
      phase,
      role: phase.phase.role,
      prompt,
    };
  }

  /**
   * Mark a phase as completed with its result.
   */
  completePhase(name: string, result: string): void {
    this.state.taskGraph.completePhase(name, result);
    // Propagate failures: skip phases that depend on a failed phase
    // (Not needed for completed phases)
  }

  /**
   * Mark a phase as failed.
   */
  failPhase(name: string, error: string): void {
    this.state.taskGraph.failPhase(name, error);

    // Skip downstream phases that depend on this one
    for (const otherName of this.state.taskGraph.getPhaseNames()) {
      const other = this.state.taskGraph.getPhase(otherName);
      if (!other || other.status !== "queued") continue;
      const deps = other.phase.dependsOn ?? [];
      if (deps.includes(name)) {
        this.state.taskGraph.skipPhase(otherName);
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

    return [
      `You are the ${role} agent in a team working on: ${goal}`,
      `Your current phase is: ${name}`,
      contextBlock,
      `Complete the ${name} phase and write your result.`,
      `Output only the result — no conversation.`,
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
