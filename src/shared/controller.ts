/**
 * controller — concurrency controller for subagent batches.
 *
 * Architecture reference: AgentSwarm pattern.
 *
 * Two-phase scheduling:
 *   Normal phase: ramp-up (5 initial, +1 every 700ms).
 *   Rate-limit phase: capacity tracking with exponential backoff retries.
 *
 * Environment variables:
 *   PI_SWARM_MAX_CONCURRENCY — cap on concurrent subagents (optional).
 */

import type {
  QueuedSubagentTask,
  SubagentResult,
  SubagentBatchOptions,
  SubagentBatchLauncher,
  SpawnSubagentOptions,
  RunSubagentOptions,
  SubagentHandle,
  SubagentCompletion,
  BatchProgressSnapshot,
  BatchMemberStatus,
  SubagentUsage,
  MailboxMessage,
  ProgressEvent,
  SubagentEvent,
  SwarmHandle,
  CoordinatorOptions,
} from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const AGENT_SWARM_MAX_CONCURRENCY_ENV = "PI_SWARM_MAX_CONCURRENCY";
const DEFAULT_MAX_CONCURRENCY = 5;
const RATE_LIMIT_SUSPENDED_REASON = "Rate limit reached — agent suspended";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TaskState<T> {
  readonly index: number;
  readonly task: QueuedSubagentTask<T>;
  agentId?: string;
  agentController?: AbortController;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
  usage: SubagentUsage;
  currentTool?: string;
  activity?: string;
  progressTick: number;
  startedAt?: number;
  completedAt?: number;
}

interface ActiveAttempt<T> {
  readonly state: TaskState<T>;
  readonly controller: AbortController;
  cleanup: () => void;
  ready: boolean;
  timedOut: boolean;
}

interface AttemptOutcome<T> extends SubagentResult<T> {
  type?: "rate_limited";
}

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an abort reason indicates user cancellation
 * (as opposed to a programmatic abort).
 */
function isUserCancellation(reason?: unknown): boolean {
  if (reason === undefined) return false;
  const msg =
    reason instanceof Error
      ? reason.message.toLowerCase()
      : String(reason).toLowerCase();
  return (
    msg.includes("user") || msg.includes("cancel") || msg.includes("interrupt")
  );
}

function userCancellationReason(): Error {
  return new Error("User cancelled");
}

/**
 * Detect whether an error indicates a provider rate limit.
 */
function isProviderRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("ratelimit") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  );
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class SubagentBatchController<T> {
  private readonly states: Array<TaskState<T>>;
  private readonly pending: Array<TaskState<T>>;
  private readonly results: Array<SubagentResult<T> | undefined>;
  private readonly active = new Set<ActiveAttempt<T>>();
  private readonly controller = new AbortController();
  private readonly batchSignals: AbortSignal[];
  private readonly maxConcurrency: number | undefined;
  private batchAborted = false;

  // Normal phase state
  private normalLaunchCount = 0;
  private normalLaunchTimer: ReturnType<typeof setTimeout> | undefined;

  // Rate-limit phase state
  private rateLimitLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  private rateLimitMode = false;
  private rateLimitCapacity = 1;
  private lastRateLimitAt: number | undefined;
  private lastCapacityShrinkAt: number | undefined;
  private lastCapacityRecoveryAt: number | undefined;
  private globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
  private nextRateLimitLaunchAt = 0;

  // Promise control
  private resolve: ((results: Array<SubagentResult<T>>) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private finished = false;
  private started = false;
  private startedAt = 0;
  private startedSuccessCount = 0;
  private readonly onProgress?: (snapshot: BatchProgressSnapshot) => void;

  // Event log
  private eventLog: ProgressEvent[] = [];
  private nextEventId = 1;

  // ETA tracking: track completion timestamps for average calculation
  private completionTimesMs: number[] = [];

  // Coordinator mode state
  private coordRunId?: string;
  private coordOnEvent?: (event: SubagentEvent<T>) => void;
  private readonly coordAgentControllers = new Map<string, AbortController>();
  private coordResolve?: (results: Array<SubagentResult<T>>) => void;
  private coordReject?: (error: unknown) => void;
  private coordStarted = false;

  constructor(
    private readonly launcher: SubagentBatchLauncher,
    tasks: readonly QueuedSubagentTask<T>[],
    options: SubagentBatchOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency;
    this.onProgress = options.onProgress;
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      progressTick: 0,
    }));
    this.pending = [...this.states];
    this.results = Array.from<TaskState<T> | undefined>({
      length: tasks.length,
    }).fill(undefined) as Array<SubagentResult<T> | undefined>;

    // Collect all unique task signals for batch abort
    const signalSet = new Set<AbortSignal>();
    for (const task of tasks) {
      if (task.signal) {
        signalSet.add(task.signal);
      }
    }
    this.batchSignals = Array.from(signalSet);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run the batch.  Returns a promise that resolves when all tasks
   * have a terminal result, or rejects on non-user cancellation.
   */
  run(): Promise<Array<SubagentResult<T>>> {
    if (this.started) {
      throw new Error("SubagentBatchController.run() can only be called once.");
    }
    this.started = true;
    this.startedAt = Date.now();

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.startInternal();
    });
  }

  /**
   * Run the batch in non-blocking coordinator mode.
   * Returns a SwarmHandle immediately that allows:
   * - Getting results so far via getResults()
   * - Stopping individual agents via stopAgent()
   * - Aborting the entire swarm via abort()
   * - Waiting for all agents via completion promise
   *
   * Per-agent events are delivered via onEvent callback.
   */
  runAsync(runId: string, coordOpts?: CoordinatorOptions<T>): SwarmHandle<T> {
    if (this.started) {
      throw new Error(
        "SubagentBatchController.runAsync() can only be called once.",
      );
    }
    this.started = true;
    this.coordStarted = true;
    this.startedAt = Date.now();
    this.coordRunId = runId;
    this.coordOnEvent = coordOpts?.onEvent;

    const completion = new Promise<Array<SubagentResult<T>>>(
      (resolve, reject) => {
        this.coordResolve = resolve;
        this.coordReject = reject;
      },
    );

    this.startInternal();

    return {
      runId,
      getResults: (): Array<SubagentResult<T>> => this.getCompletedResults(),
      sendMessage: (agentId: string, message: string): void =>
        this.sendMessageToAgent(agentId, message),
      stopAgent: (agentId: string): void => this.stopAgentById(agentId),
      abort: (): void =>
        this.controller.abort(new Error("Coordinator aborted swarm")),
      completion,
    };
  }

  private startInternal(): void {
    if (this.states.length === 0) {
      this.finish([]);
      return;
    }

    for (const signal of this.batchSignals) {
      if (signal.aborted) {
        this.handleBatchAbort(signal);
        return;
      }
    }

    for (const signal of this.batchSignals) {
      signal.addEventListener("abort", () => this.handleBatchAbort(signal), {
        once: true,
      });
    }
    this.emitProgress();
    this.schedule();
  }

  private handleBatchAbort(signal: AbortSignal): void {
    if (this.batchAborted) return;
    this.batchAborted = true;

    const reason = isUserCancellation(signal.reason)
      ? userCancellationReason()
      : signal.reason;
    this.controller.abort(reason);
    if (isUserCancellation(signal.reason)) {
      this.finishWithUserCancellation();
    } else {
      this.fail(signal.reason ?? new Error("Aborted"));
    }
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------

  private schedule(): void {
    if (this.finished) return;
    if (this.finishIfComplete()) return;
    if (this.controller.signal.aborted) return;

    if (this.rateLimitMode) {
      this.scheduleRateLimitLaunch();
    } else {
      this.scheduleNormalLaunch();
    }
  }

  private scheduleNormalLaunch(): void {
    // Launch up to INITIAL_LAUNCH_LIMIT immediately
    while (
      this.normalLaunchCount < INITIAL_LAUNCH_LIMIT &&
      this.pending.length > 0 &&
      !this.rateLimitMode &&
      !this.isAtConcurrencyLimit()
    ) {
      const state = this.pending.shift();
      if (state) {
        this.startAttempt(state);
        this.normalLaunchCount += 1;
      }
    }

    // Schedule next ramp launch if work remains
    if (
      this.pending.length === 0 ||
      this.rateLimitMode ||
      this.normalLaunchTimer !== undefined ||
      this.isAtConcurrencyLimit()
    ) {
      return;
    }

    this.normalLaunchTimer = setTimeout(() => {
      this.normalLaunchTimer = undefined;
      if (this.finished || this.rateLimitMode || this.pending.length === 0)
        return;
      if (this.isAtConcurrencyLimit()) return;

      const state = this.pending.shift();
      if (state) {
        this.startAttempt(state);
        this.normalLaunchCount += 1;
      }
      this.schedule();
    }, INITIAL_LAUNCH_INTERVAL_MS);
  }

  private isAtConcurrencyLimit(): boolean {
    return (
      this.maxConcurrency !== undefined &&
      this.active.size >= this.maxConcurrency
    );
  }

  private scheduleRateLimitLaunch(): void {
    this.clearRateLimitTimer();
    if (this.pending.length === 0) return;

    const now = Date.now();
    this.recoverRateLimitCapacity(now);

    if (
      this.active.size >= this.rateLimitCapacity ||
      (this.maxConcurrency !== undefined &&
        this.active.size >= this.maxConcurrency)
    ) {
      this.scheduleRateLimitWakeup(this.nextRateLimitCapacityRecoveryAt(), now);
      return;
    }

    const nextAllowedAt = Math.max(
      this.nextRateLimitLaunchAt,
      this.nextPendingReadyAt(),
    );
    const nextWakeupAt = Math.min(
      nextAllowedAt,
      this.nextRateLimitCapacityRecoveryAt(),
    );

    if (nextWakeupAt > now) {
      this.scheduleRateLimitWakeup(nextWakeupAt, now);
      return;
    }

    const pendingIndex = this.pending.findIndex(
      (state) => state.retryReadyAt <= now,
    );
    if (pendingIndex === -1) return;

    const [state] = this.pending.splice(pendingIndex, 1);
    if (state) {
      this.startAttempt(state);
      this.nextRateLimitLaunchAt = now + this.globalRetryIntervalMs;
      this.scheduleNextRateLimitWakeup(now);
    }
  }

  // -----------------------------------------------------------------------
  // Attempt lifecycle
  // -----------------------------------------------------------------------

  private startAttempt(state: TaskState<T>): void {
    if (this.finished || this.controller.signal.aborted) return;

    const attemptController = new AbortController();
    const attempt: ActiveAttempt<T> = {
      state,
      controller: attemptController,
      cleanup: () => {},
      ready: false,
      timedOut: false,
    };
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.add(attempt);
    attempt.state.started = true;
    attempt.state.startedAt = Date.now();
    attempt.state.agentController = attemptController;
    // Add event to log
    this.addEvent({
      id: this.nextEventId++,
      agentId: undefined,
      timestamp: Date.now(),
      type: "started",
      detail: state.task.swarmItem
        ? `Started: ${state.task.swarmItem.slice(0, 60)}`
        : `Started task ${state.index + 1}`,
    });
    // Trim event log to last 50 entries
    if (this.eventLog.length > 50) {
      this.eventLog = this.eventLog.slice(-50);
    }
    // A task transitioned from queued to working
    this.emitProgress();

    this.runAttempt(attempt).then(
      (outcome) => {
        this.handleAttemptOutcome(attempt, outcome);
      },
      (error) => {
        this.handleAttemptError(attempt, error);
      },
    );
  }

  private async runAttempt(
    attempt: ActiveAttempt<T>,
  ): Promise<AttemptOutcome<T>> {
    const task = attempt.state.task;
    const runOptions: RunSubagentOptions = {
      parentToolCallId: task.parentToolCallId,
      parentToolCallUuid: task.parentToolCallUuid,
      prompt: task.prompt,
      description: task.description,
      swarmIndex: task.swarmIndex,
      runInBackground: task.runInBackground,
      signal: attempt.controller.signal,
      onReady: () => {
        this.markAttemptReady(attempt);
      },
      onUsage: (usage) => {
        attempt.state.usage = { ...usage };
        this.emitProgress();
        // Forward to task-level callback (used by team mode to update supervisor phase usage)
        task.onUsage?.(usage);
      },
      onActivity: (tool, activity) => {
        attempt.state.currentTool = tool;
        attempt.state.activity = activity;
        attempt.state.progressTick += 1;
        this.emitProgress();
        // Forward to task-level callback (used by team mode to update phase activity)
        task.onActivity?.(tool, activity);
      },
      onMessage: task.onMessage,
      suppressRateLimitFailureEvent: true,
      timeout: task.timeout,
      swarmRoot: task.swarmRoot,
      runId: task.runId,
      outputLogPath: task.outputLogPath,
      model: task.model,
      tools: task.tools,
      cwd: task.cwd,
      useWorktree: task.useWorktree,
      mailboxPath: task.mailboxPath,
      roleName: task.roleName,
      additionalSystemPrompt: task.additionalSystemPrompt,
      agentName: task.agentName,
      messageInboxPath: task.messageInboxPath,
    };

    let handle: SubagentHandle;
    try {
      attempt.controller.signal.throwIfAborted();

      if (attempt.state.retryAgentId !== undefined) {
        handle = await this.launcher.retry(
          attempt.state.retryAgentId,
          runOptions,
        );
      } else if (task.kind === "resume") {
        handle = await this.launcher.resume(task.resumeAgentId, runOptions);
      } else {
        const spawnOptions: SpawnSubagentOptions = {
          profileName: task.profileName,
          swarmItem: task.swarmItem,
          model: task.model,
          tools: task.tools,
          cwd: task.cwd,
          useWorktree: task.useWorktree,
          mailboxPath: task.mailboxPath,
          roleName: task.roleName,
          additionalSystemPrompt: task.additionalSystemPrompt,
          agentName: task.agentName,
          messageInboxPath: task.messageInboxPath,
          onMessage: task.onMessage,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions);
      }
    } catch (error) {
      return this.failedAttemptOutcome(attempt, error);
    }

    attempt.state.agentId = handle.agentId;

    // Track controller for coordinator stopAgent
    if (this.coordStarted) {
      this.coordAgentControllers.set(handle.agentId, attempt.controller);
      if (this.coordOnEvent) {
        this.coordOnEvent({
          runId: this.coordRunId ?? "",
          agentId: handle.agentId,
          agentName: task.agentName,
          eventType: "agent_started",
          timestamp: Date.now(),
        });
      }
    }

    try {
      const completion: SubagentCompletion = await handle.completion;
      if (completion.usage) {
        attempt.state.usage = { ...completion.usage };
      }
      const completedAt = Date.now();
      attempt.state.completedAt = completedAt;
      if (attempt.state.startedAt) {
        this.completionTimesMs.push(completedAt - attempt.state.startedAt);
      }
      // Add event to log
      this.addEvent({
        id: this.nextEventId++,
        agentId: handle.agentId,
        timestamp: completedAt,
        type: "completed",
        detail: attempt.state.task.swarmItem
          ? `Agent completed: ${attempt.state.task.swarmItem.slice(0, 60)}`
          : `Agent completed`,
      });
      return {
        task,
        agentId: handle.agentId,
        status: "completed",
        result: completion.result,
        usage: attempt.state.usage,
        worktreeBranch: completion.worktreeBranch,
      };
    } catch (error) {
      if (isProviderRateLimitError(error)) {
        return {
          type: "rate_limited",
          task,
          agentId: handle.agentId,
          status: "failed",
          error: String(error),
        } as AttemptOutcome<T>;
      }
      return this.failedAttemptOutcome(attempt, error);
    }
  }

  // -----------------------------------------------------------------------
  // Outcome handling
  // -----------------------------------------------------------------------

  private handleAttemptOutcome(
    attempt: ActiveAttempt<T>,
    outcome: AttemptOutcome<T>,
  ): void {
    attempt.cleanup();
    this.active.delete(attempt);

    if (this.finished) return;

    if (outcome.type === "rate_limited") {
      this.handleRateLimit(attempt, outcome);
      return;
    }

    this.results[attempt.state.index] = outcome;

    const agentId = outcome.agentId;
    if (this.coordOnEvent && agentId) {
      const result = outcome as SubagentResult<T>;
      this.coordOnEvent({
        runId: this.coordRunId ?? "",
        agentId,
        agentName: attempt.state.task.agentName,
        eventType: "agent_completed",
        timestamp: Date.now(),
        result,
      });
    }

    // A task reached a terminal state (completed/failed/aborted)
    this.emitProgress();
    this.schedule();
  }

  private handleAttemptError(attempt: ActiveAttempt<T>, error: unknown): void {
    attempt.cleanup();
    this.active.delete(attempt);

    if (this.finished) return;

    if (isProviderRateLimitError(error)) {
      this.handleRateLimit(attempt, {
        type: "rate_limited",
        task: attempt.state.task,
        agentId: attempt.state.agentId,
        status: "failed",
        error: String(error),
      } as AttemptOutcome<T>);
      return;
    }

    const result: SubagentResult<T> = this.failedAttemptOutcome(attempt, error);
    this.results[attempt.state.index] = result;

    const resAgentId = result.agentId;
    if (this.coordOnEvent && resAgentId) {
      this.coordOnEvent({
        runId: this.coordRunId ?? "",
        agentId: resAgentId,
        agentName: attempt.state.task.agentName,
        eventType: "agent_completed",
        timestamp: Date.now(),
        result,
      });
    }

    // A task reached a terminal state (completed/failed/aborted)
    this.emitProgress();
    this.schedule();
  }

  private handleRateLimit(
    attempt: ActiveAttempt<T>,
    _outcome: AttemptOutcome<T>,
  ): void {
    const state = attempt.state;

    // Save agent id for retry and requeue at front
    state.retryAgentId = state.agentId ?? state.retryAgentId;
    state.retryCount += 1;

    // Notify external listeners that this agent was suspended
    if (state.agentId) {
      this.launcher.suspended?.({
        agentId: state.agentId,
        reason: RATE_LIMIT_SUSPENDED_REASON,
      });
    }

    // Exponential backoff
    const delay =
      RATE_LIMIT_RETRY_BASE_MS *
      Math.pow(RATE_LIMIT_RETRY_FACTOR, state.retryCount - 1);
    state.retryReadyAt = Date.now() + delay;

    this.pending.unshift(state);

    // Enter rate-limit phase
    if (!this.rateLimitMode) {
      this.enterRateLimitPhase();
    }

    this.shrinkRateLimitCapacity(Date.now());
    // A task was suspended and requeued due to rate limiting
    this.emitProgress();
    this.schedule();
  }

  private failedAttemptOutcome(
    attempt: ActiveAttempt<T>,
    error: unknown,
  ): SubagentResult<T> {
    const task = attempt.state.task;
    const isAbort = isUserCancellation(error);

    const status: SubagentResult<T>["status"] = isAbort ? "aborted" : "failed";

    let errorMessage: string;
    if (attempt.timedOut && task.timeout !== undefined) {
      errorMessage = "Subagent timed out.";
    } else if (isAbort) {
      errorMessage = "The user manually interrupted this subagent batch.";
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    return {
      task,
      agentId: attempt.state.agentId,
      status,
      state: attempt.state.started ? "started" : "not_started",
      error: errorMessage,
      usage: { ...attempt.state.usage },
    };
  }

  // -----------------------------------------------------------------------
  // Rate-limit phase
  // -----------------------------------------------------------------------

  private enterRateLimitPhase(): void {
    this.rateLimitMode = true;
    this.clearNormalTimer();
    // Use startedSuccessCount (count of agents that fully booted during
    // the normal phase) so capacity reflects true past throughput rather
    // than only currently-active attempts (which may already be finishing).
    this.rateLimitCapacity = Math.max(
      1,
      this.maxConcurrency !== undefined
        ? Math.min(this.maxConcurrency, this.startedSuccessCount)
        : this.startedSuccessCount,
    );
    this.lastRateLimitAt = Date.now();
    this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
    this.nextRateLimitLaunchAt = Date.now() + RATE_LIMIT_RETRY_BASE_MS;
  }

  private shrinkRateLimitCapacity(now: number): void {
    if (
      this.lastCapacityShrinkAt !== undefined &&
      now - this.lastCapacityShrinkAt < RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
    ) {
      return;
    }
    this.lastCapacityShrinkAt = now;
    this.rateLimitCapacity = Math.max(1, this.rateLimitCapacity - 1);
    this.globalRetryIntervalMs = Math.min(
      this.globalRetryIntervalMs * RATE_LIMIT_RETRY_FACTOR,
      120_000, // Cap at 2 minutes
    );
  }

  private recoverRateLimitCapacity(now: number): void {
    if (this.lastRateLimitAt === undefined) return;

    const quietPeriod = now - this.lastRateLimitAt;
    if (quietPeriod < RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS) return;

    const lastRecovery = this.lastCapacityRecoveryAt ?? 0;
    if (now - lastRecovery < RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS) return;

    this.lastCapacityRecoveryAt = now;
    this.rateLimitCapacity += 1;
    if (
      this.maxConcurrency !== undefined &&
      this.rateLimitCapacity > this.maxConcurrency
    ) {
      this.rateLimitCapacity = this.maxConcurrency;
    }
  }

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  private finishIfComplete(): boolean {
    const allDone = this.results.every((r) => r !== undefined);
    if (allDone) {
      this.finish(this.results as Array<SubagentResult<T>>);
      return true;
    }
    return false;
  }

  private emitProgress(): void {
    if (!this.onProgress) return;

    let completed = 0;
    let failed = 0;
    let active = 0;
    const totalUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
    const members: BatchMemberStatus[] = [];

    const activeIndices = new Set(
      Array.from(this.active, (a) => a.state.index),
    );

    for (const state of this.states) {
      const result = this.results[state.index];
      const isActiveState = activeIndices.has(state.index);

      let phase: BatchMemberStatus["phase"] = "queued";
      let error: string | undefined;

      // Accumulate usage from live state or completed result
      const memberUsage = result?.usage ?? state.usage;
      if (memberUsage) {
        totalUsage.input += memberUsage.input;
        totalUsage.output += memberUsage.output;
        totalUsage.cacheRead += memberUsage.cacheRead;
        totalUsage.cacheWrite += memberUsage.cacheWrite;
        totalUsage.totalTokens += memberUsage.totalTokens;
      }

      if (result) {
        if (result.status === "completed") {
          phase = "completed";
          completed++;
        } else {
          phase = "failed";
          failed++;
          error = result.error;
        }
      } else if (isActiveState) {
        phase = "working";
        active++;
      } else if (state.retryCount > 0 && state.retryReadyAt > Date.now()) {
        phase = "suspended";
      }

      members.push({
        index: state.task.swarmIndex ?? state.index + 1,
        phase,
        name: state.task.agentName,
        item: state.task.swarmItem,
        error,
        usage: memberUsage,
        currentTool: state.currentTool,
        activity: state.activity,
        progressTick: state.progressTick,
        startedAt: state.startedAt,
      });
    }

    const queued = this.states.length - completed - failed - active;

    // Calculate ETA based on average completion time
    let estimatedRemainingMs: number | undefined;
    const totalFinished = completed + failed;
    const totalRemaining = queued + active;
    if (totalFinished > 0 && totalRemaining > 0) {
      const avgTimeMs =
        this.completionTimesMs.length > 0
          ? this.completionTimesMs.reduce((a, b) => a + b, 0) /
            this.completionTimesMs.length
          : 0;
      if (avgTimeMs > 0) {
        estimatedRemainingMs = avgTimeMs * totalRemaining;
      }
    }

    this.onProgress({
      total: this.states.length,
      completed,
      failed,
      active,
      queued,
      members,
      totalUsage,
      startedAt: this.startedAt,
      estimatedRemainingMs,
      eventLog: [...this.eventLog],
    });
  }

  /** Add an event to the event log, keeping it bounded. */
  private addEvent(event: ProgressEvent): void {
    this.eventLog.push(event);
    // Keep max 100 events
    if (this.eventLog.length > 100) {
      this.eventLog = this.eventLog.slice(-100);
    }
  }

  private finish(results: Array<SubagentResult<T>>): void {
    if (this.finished) return;
    this.finished = true;
    this.clearNormalTimer();
    this.clearRateLimitTimer();
    // Emit final snapshot so the TUI reflects the terminal state
    this.emitProgress();
    this.resolve?.(results);
    this.coordResolve?.(results);
  }

  private finishWithUserCancellation(): void {
    if (this.finished) return;

    // Abort all active attempts first (mirrors fail())
    for (const attempt of this.active) {
      attempt.controller.abort(userCancellationReason());
      attempt.cleanup();
    }
    this.active.clear();

    // Preserve existing results
    for (let i = 0; i < this.states.length; i += 1) {
      if (this.results[i] !== undefined) continue;

      const state = this.states[i]!;
      if (state.started || state.agentId !== undefined) {
        this.results[i] = {
          task: state.task,
          agentId: state.agentId,
          status: "aborted",
          state: "started",
          error: "Cancelled by user.",
        };
      } else {
        this.results[i] = {
          task: state.task,
          status: "aborted",
          state: "not_started",
          error: "Cancelled by user.",
        };
      }
    }

    this.finish(this.results as Array<SubagentResult<T>>);
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.clearNormalTimer();
    this.clearRateLimitTimer();

    // Abort all active attempts
    for (const attempt of this.active) {
      attempt.controller.abort(error);
      attempt.cleanup();
    }
    this.active.clear();

    // Emit final snapshot so the TUI reflects the failed state
    this.emitProgress();
    this.reject?.(error);
    this.coordReject?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  private clearNormalTimer(): void {
    if (this.normalLaunchTimer !== undefined) {
      clearTimeout(this.normalLaunchTimer);
      this.normalLaunchTimer = undefined;
    }
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitLaunchTimer !== undefined) {
      clearTimeout(this.rateLimitLaunchTimer);
      this.rateLimitLaunchTimer = undefined;
    }
  }

  private scheduleRateLimitWakeup(wakeAt: number, now: number): void {
    const delay = Math.max(0, wakeAt - now);
    this.rateLimitLaunchTimer = setTimeout(() => {
      this.rateLimitLaunchTimer = undefined;
      this.schedule();
    }, delay);
  }

  private scheduleNextRateLimitWakeup(now: number): void {
    const nextAllowedAt = Math.max(
      this.nextRateLimitLaunchAt,
      this.nextPendingReadyAt(),
    );
    const next = Math.min(
      nextAllowedAt,
      this.nextRateLimitCapacityRecoveryAt(),
    );
    if (next > now) {
      this.scheduleRateLimitWakeup(next, now);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private markAttemptReady(attempt: ActiveAttempt<T>): void {
    if (attempt.ready) return;
    attempt.ready = true;
    this.startedSuccessCount += 1;

    // If we are in rate-limit mode, reset the global retry interval
    // so the next launch uses the base delay rather than an accumulated
    // exponential backoff, and re-arm the scheduler immediately.
    if (this.rateLimitMode) {
      this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
      this.nextRateLimitLaunchAt = Date.now() + this.globalRetryIntervalMs;
      // Clear any pending rate-limit timer so schedule() re-computes
      // the next wakeup from the new (shorter) interval.
      this.clearRateLimitTimer();
      this.schedule();
    }
  }

  private countReadyActive(): number {
    let count = 0;
    for (const a of this.active) {
      if (a.ready) count += 1;
    }
    return count;
  }

  private nextPendingReadyAt(): number {
    let earliest = Infinity;
    for (const state of this.pending) {
      if (state.retryReadyAt < earliest) {
        earliest = state.retryReadyAt;
      }
    }
    return earliest === Infinity ? 0 : earliest;
  }

  private nextRateLimitCapacityRecoveryAt(): number {
    if (this.lastRateLimitAt === undefined) return Infinity;
    const nextRecovery =
      (this.lastCapacityRecoveryAt ?? this.lastRateLimitAt) +
      RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS;
    return nextRecovery;
  }

  private linkAttemptSignals(
    attempt: ActiveAttempt<T>,
    task: QueuedSubagentTask<T>,
  ): () => void {
    const abortFromBatch = () => {
      attempt.controller.abort(this.controller.signal.reason);
    };
    const abortFromTask = () => {
      attempt.controller.abort(task.signal?.reason);
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (task.timeout !== undefined && task.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        attempt.timedOut = true;
        attempt.controller.abort(new Error("Aborted"));
      }, task.timeout);
    }

    if (this.controller.signal.aborted) {
      abortFromBatch();
    } else if (task.signal?.aborted) {
      abortFromTask();
    } else {
      this.controller.signal.addEventListener("abort", abortFromBatch, {
        once: true,
      });
      task.signal?.addEventListener("abort", abortFromTask, {
        once: true,
      });
    }

    return () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.controller.signal.removeEventListener("abort", abortFromBatch);
      task.signal?.removeEventListener("abort", abortFromTask);
    };
  }

  // -----------------------------------------------------------------------
  // Coordinator helpers
  // -----------------------------------------------------------------------

  private getCompletedResults(): Array<SubagentResult<T>> {
    return this.results.filter((r): r is SubagentResult<T> => r !== undefined);
  }

  private stopAgentById(agentId: string): void {
    const ctrl = this.coordAgentControllers.get(agentId);
    if (ctrl) {
      ctrl.abort(new Error("Agent stopped by coordinator"));
      this.coordAgentControllers.delete(agentId);
    }
  }

  private sendMessageToAgent(agentId: string, message: string): void {
    const state = this.states.find(
      (s) => s.agentId === agentId || s.retryAgentId === agentId,
    );
    const inboxPath = state?.task.messageInboxPath;
    if (!inboxPath) return;

    const line =
      JSON.stringify({
        messageId: `coord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: "coordinator",
        content: message,
        timestamp: new Date().toISOString(),
      }) + "\n";

    fs.appendFileSync(inboxPath, line, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the optional swarm max concurrency from pi settings.json
 * or the environment variable.
 *
 * Priority:
 *   1. `.pi/settings.json` → `pi-swarm.maxConcurrency` (project-local)
 *   2. `~/.pi/agent/settings.json` → `pi-swarm.maxConcurrency` (global)
 *   3. `PI_SWARM_MAX_CONCURRENCY` env var
 *
 * Falls back to DEFAULT_MAX_CONCURRENCY (5) when unset.  A present
 * value must be a positive integer; invalid input throws so a
 * misconfigured cap never silently reverts to uncapped.
 */
export function resolveSwarmMaxConcurrency(cwd?: string): number {
  // 1. Project-local settings
  const projectSettings = readPiSettings(
    path.join(cwd ?? process.cwd(), ".pi", "settings.json"),
  );
  const projectValue = getSettingsMaxConcurrency(projectSettings);
  if (projectValue !== undefined) {
    return validateConcurrency(projectValue, ".pi/settings.json");
  }

  // 2. Global settings
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const globalSettings = readPiSettings(
    path.join(home, ".pi", "agent", "settings.json"),
  );
  const globalValue = getSettingsMaxConcurrency(globalSettings);
  if (globalValue !== undefined) {
    return validateConcurrency(globalValue, "~/.pi/agent/settings.json");
  }

  // 3. Environment variable
  const raw = process.env[AGENT_SWARM_MAX_CONCURRENCY_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    return validateConcurrency(Number(raw), AGENT_SWARM_MAX_CONCURRENCY_ENV);
  }

  // 4. Default (always reached — value guaranteed)
  return DEFAULT_MAX_CONCURRENCY;
}

function validateConcurrency(value: unknown, source: string): number {
  if (value === undefined || value === null) return DEFAULT_MAX_CONCURRENCY;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(
      `pi-swarm.maxConcurrency in ${source} must be a positive integer, got ${JSON.stringify(value)}.`,
    );
  }
  return num;
}

function readPiSettings(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getSettingsMaxConcurrency(
  settings: Record<string, unknown> | null,
): unknown {
  if (!settings) return undefined;
  const swarm = settings["pi-swarm"] as Record<string, unknown> | undefined;
  return swarm?.maxConcurrency;
}

/**
 * Resolve the optional small model from pi settings.
 * Used as the default model for simple subagent tasks.
 *
 * Priority:
 *   1. `.pi/settings.json` → `pi-swarm.smallModel`
 *   2. `~/.pi/agent/settings.json` → `pi-swarm.smallModel`
 */
export function resolveSwarmSmallModel(cwd?: string): string | undefined {
  const projectSettings = readPiSettings(
    path.join(cwd ?? process.cwd(), ".pi", "settings.json"),
  );
  const projectValue = getSettingsSmallModel(projectSettings);
  if (projectValue !== undefined) return projectValue;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const globalSettings = readPiSettings(
    path.join(home, ".pi", "agent", "settings.json"),
  );
  return getSettingsSmallModel(globalSettings);
}

function getSettingsSmallModel(
  settings: Record<string, unknown> | null,
): string | undefined {
  if (!settings) return undefined;
  const swarm = settings["pi-swarm"] as Record<string, unknown> | undefined;
  const val = swarm?.smallModel;
  return typeof val === "string" && val.trim().length > 0
    ? val.trim()
    : undefined;
}
