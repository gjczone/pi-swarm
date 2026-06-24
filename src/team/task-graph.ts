/**
 * team/task-graph — task dependency graph with phases.
 *
 * Models a team run as a directed acyclic graph of phases, where each
 * phase has a role assignment and optional dependencies.  The supervisor
 * advances phases as agents complete their tasks.
 */

import type { AgentRole, TeamPhase } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Default phases
// ---------------------------------------------------------------------------

/** Default team workflow: explore → plan → implement → review → test. */
export const DEFAULT_TEAM_PHASES: readonly TeamPhase[] = [
  { name: "explore", role: "explorer" },
  { name: "plan", role: "planner", dependsOn: ["explore"] },
  { name: "implement", role: "coder", dependsOn: ["plan"] },
  { name: "review", role: "reviewer", dependsOn: ["implement"] },
  { name: "test", role: "tester", dependsOn: ["review"] },
];

// ---------------------------------------------------------------------------
// Phase status
// ---------------------------------------------------------------------------

export type PhaseStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface PhaseState {
  readonly phase: TeamPhase;
  status: PhaseStatus;
  agentId?: string;
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

// ---------------------------------------------------------------------------
// Task graph
// ---------------------------------------------------------------------------

export class TaskGraph {
  private readonly phases: Map<string, PhaseState>;
  private readonly order: string[];

  constructor(phases: readonly TeamPhase[]) {
    this.phases = new Map();
    this.order = [];

    for (const phase of phases) {
      const name = phase.name;
      if (this.phases.has(name)) {
        throw new Error(`Duplicate phase name: ${name}`);
      }
      this.phases.set(name, {
        phase,
        status: "queued",
      });
      this.order.push(name);
    }
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  /** Get all phases in definition order. */
  getPhaseNames(): string[] {
    return [...this.order];
  }

  /** Get the state of a phase. */
  getPhase(name: string): PhaseState | undefined {
    return this.phases.get(name);
  }

  /** Get all phase states. */
  getAllPhases(): PhaseState[] {
    return this.order.map((name) => this.phases.get(name)!);
  }

  /** Get the current phase (first non-completed, non-failed, non-skipped). */
  getCurrentPhase(): PhaseState | undefined {
    for (const name of this.order) {
      const state = this.phases.get(name)!;
      if (state.status === "queued" || state.status === "running") {
        return state;
      }
    }
    return undefined;
  }

  /** Check if all phases are terminal (completed, failed, or skipped). */
  isComplete(): boolean {
    return this.order.every((name) => {
      const state = this.phases.get(name)!;
      return (
        state.status === "completed" ||
        state.status === "failed" ||
        state.status === "skipped"
      );
    });
  }

  /** Get the overall run status. */
  overallStatus(): "running" | "completed" | "failed" {
    if (!this.isComplete()) return "running";
    const allCompleted = this.order.every((name) => {
      const state = this.phases.get(name)!;
      return state.status === "completed" || state.status === "skipped";
    });
    return allCompleted ? "completed" : "failed";
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  /**
   * Start a phase.  Fails if dependencies are not satisfied.
   * Returns the phase state or an error.
   */
  startPhase(
    name: string,
  ): { ok: true; phase: PhaseState } | { ok: false; error: string } {
    const state = this.phases.get(name);
    if (!state) {
      return { ok: false, error: `Unknown phase: ${name}` };
    }

    if (state.status !== "queued") {
      return {
        ok: false,
        error: `Phase ${name} is already ${state.status}`,
      };
    }

    // Check dependencies
    const deps = state.phase.dependsOn ?? [];
    for (const dep of deps) {
      const depState = this.phases.get(dep);
      if (!depState || depState.status !== "completed") {
        return {
          ok: false,
          error: `Dependency ${dep} is not completed (${depState?.status ?? "unknown"})`,
        };
      }
    }

    state.status = "running";
    state.startedAt = Date.now();
    return { ok: true, phase: state };
  }

  /** Mark a phase as completed with a result. */
  completePhase(name: string, result: string): void {
    const state = this.phases.get(name);
    if (!state) return;
    state.status = "completed";
    state.result = result;
    state.completedAt = Date.now();
  }

  /** Mark a phase as failed with an error. */
  failPhase(name: string, error: string): void {
    const state = this.phases.get(name);
    if (!state) return;
    state.status = "failed";
    state.error = error;
    state.completedAt = Date.now();
  }

  /** Skip a phase (e.g., when a dependency failed). */
  skipPhase(name: string): void {
    const state = this.phases.get(name);
    if (!state) return;
    state.status = "skipped";
    state.completedAt = Date.now();
  }

  /** Assign an agent ID to a phase. */
  assignAgent(name: string, agentId: string): void {
    const state = this.phases.get(name);
    if (state) {
      state.agentId = agentId;
    }
  }

  // -------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------

  /** Serialize to a plain object for persistence. */
  toJSON(): Record<string, unknown> {
    const phases: Record<string, unknown> = {};
    for (const [name, state] of this.phases) {
      phases[name] = {
        name: state.phase.name,
        role: state.phase.role,
        status: state.status,
        agentId: state.agentId,
        result: state.result,
        error: state.error,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
      };
    }
    return { phases };
  }

  /** Deserialize from a plain object. */
  static fromJSON(
    data: Record<string, unknown>,
    phaseDefs: readonly TeamPhase[],
  ): TaskGraph {
    const graph = new TaskGraph(phaseDefs);
    const phases = data.phases as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (phases) {
      for (const [name, stateData] of Object.entries(phases)) {
        const state = graph.phases.get(name);
        if (state && stateData) {
          state.status = (stateData.status as PhaseStatus) ?? "queued";
          state.agentId = stateData.agentId as string | undefined;
          state.result = stateData.result as string | undefined;
          state.error = stateData.error as string | undefined;
          state.startedAt = stateData.startedAt as number | undefined;
          state.completedAt = stateData.completedAt as number | undefined;
        }
      }
    }
    return graph;
  }
}
