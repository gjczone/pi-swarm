/**
 * swarm/mode — SwarmMode state machine.
 *
 * Tracks whether swarm mode is active and manages the lifecycle
 * of entering/exiting swarm mode with system reminders.
 *
 * Ported from MoonshotAI/kimi-code's SwarmMode.
 */

/** How swarm mode was triggered. */
export type SwarmModeTrigger = "manual" | "task" | "tool";

/**
 * Minimal interface for the agent object that SwarmMode needs.
 * The real agent is provided by the extension context.
 */
export interface SwarmModeAgent {
  readonly context: {
    /**
     * Append a system reminder to the agent context.
     * The reminder is injected into the model's context window.
     */
    appendSystemReminder(
      text: string,
      origin: { kind: string; variant: string },
    ): void;
    /**
     * Pop a matched message from the context.
     * Returns true if a message was removed.
     */
    popMatchedMessage(predicate: (origin: unknown) => boolean): boolean;
  };
  /** Emit a status update event. */
  emitStatusUpdated(): void;
  /** Log a record to the agent's event log. */
  records: {
    logRecord(entry: { type: string; trigger?: string }): void;
  };
}

// ---------------------------------------------------------------------------
// System reminder templates (from kimi-code)
// ---------------------------------------------------------------------------

const SWARM_MODE_ENTER_REMINDER = `
Swarm mode is now active. While swarm mode is active:
- The AgentSwarm tool is auto-approved (no permission required).
- You may call AgentSwarm freely to parallelise work.
- When you finish the swarm work, call AgentSwarm with
  resume_agent_ids to continue unfinished subagents.
- Prefer splitting large tasks into many small, independent items
  so the swarm stays efficient.
`.trim();

const SWARM_MODE_EXIT_REMINDER = `
Swarm mode has been deactivated.
- The AgentSwarm tool now requires permission approval again.
- Continue working normally.
`.trim();

// ---------------------------------------------------------------------------
// SwarmMode
// ---------------------------------------------------------------------------

export class SwarmMode {
  private active: SwarmModeTrigger | null = null;

  constructor(private readonly agent: SwarmModeAgent) {}

  /** Enter swarm mode with the given trigger. No-op if already active. */
  enter(trigger: SwarmModeTrigger): void {
    if (this.active !== null) return;

    this.agent.records.logRecord({
      type: "swarm_mode.enter",
      trigger,
    });
    this.active = trigger;

    if (trigger !== "tool") {
      this.agent.context.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
        kind: "injection",
        variant: "swarm_mode",
      });
    }

    this.agent.emitStatusUpdated();
  }

  /** Restore a previously saved swarm mode trigger (e.g., on session resume). */
  restoreEnter(trigger: SwarmModeTrigger): void {
    this.active = trigger;
  }

  /** Exit swarm mode. No-op if not active. */
  exit(): void {
    if (this.active === null) return;

    this.agent.records.logRecord({ type: "swarm_mode.exit" });
    const trigger = this.active;
    this.active = null;
    this.agent.emitStatusUpdated();

    if (trigger === "tool") return;

    // Try to pop the enter reminder first
    if (
      this.agent.context.popMatchedMessage((origin: unknown) => {
        const o = origin as { kind?: string; variant?: string } | null;
        return o?.kind === "injection" && o?.variant === "swarm_mode";
      })
    ) {
      return;
    }

    // If we couldn't pop it, inject an exit reminder
    this.agent.context.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
      kind: "injection",
      variant: "swarm_mode_exit",
    });
  }

  /** Whether swarm mode is currently active. */
  get isActive(): boolean {
    return this.active !== null;
  }

  /** Whether swarm mode should auto-exit after the current operation. */
  get shouldAutoExit(): boolean {
    return this.active === "task" || this.active === "tool";
  }

  /** The current trigger, or null if not active. */
  get currentTrigger(): SwarmModeTrigger | null {
    return this.active;
  }
}
