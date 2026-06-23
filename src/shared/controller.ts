/**
 * controller — concurrency controller for subagent batches.
 *
 * Ported from MoonshotAI/kimi-code's SubagentBatch.
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
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants (from kimi-code)
// ---------------------------------------------------------------------------

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_RETRY_BASE_MS = 3000;
const RATE_LIMIT_RETRY_FACTOR = 2;
const RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS = 2000;
const RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const AGENT_SWARM_MAX_CONCURRENCY_ENV = "PI_SWARM_MAX_CONCURRENCY";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TaskState<T> {
  readonly index: number;
  readonly task: QueuedSubagentTask<T>;
  agentId?: string;
  retryAgentId?: string;
  retryCount: number;
  retryReadyAt: number;
  started: boolean;
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
    msg.includes("user") ||
    msg.includes("cancel") ||
    msg.includes("interrupt") ||
    msg.includes("abort")
  );
}

function userCancellationReason(): Error {
  return new Error("User cancelled");
}

/**
 * Link two AbortSignals so that either one aborting aborts the other.
 * Returns a cleanup function.
 */
function linkAbortSignal(
  source: AbortSignal,
  target: AbortController,
): () => void {
  const handler = () => {
    target.abort(source.reason);
  };

  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  source.addEventListener("abort", handler, { once: true });
  return () => source.removeEventListener("abort", handler);
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
  private readonly batchSignal: AbortSignal | undefined;
  private readonly batchAbortListener: () => void;
  private readonly maxConcurrency: number | undefined;

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
  private resolve:
    | ((results: Array<SubagentResult<T>>) => void)
    | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private finished = false;
  private started = false;
  private startedSuccessCount = 0;

  constructor(
    private readonly launcher: SubagentBatchLauncher,
    tasks: readonly QueuedSubagentTask<T>[],
    options: SubagentBatchOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency;
    this.states = tasks.map((task, index) => ({
      index,
      task,
      retryCount: 0,
      retryReadyAt: 0,
      started: false,
    }));
    this.pending = [...this.states];
    this.results = Array.from<TaskState<T> | undefined>({
      length: tasks.length,
    }).fill(undefined) as Array<SubagentResult<T> | undefined>;

    // Use the first task's signal as the batch signal
    this.batchSignal = tasks.find((t) => t.signal !== undefined)?.signal;

    this.batchAbortListener = () => {
      this.controller.abort(this.batchSignal?.reason);
      if (isUserCancellation(this.batchSignal?.reason)) {
        this.finishWithUserCancellation();
      } else {
        this.fail(
          this.batchSignal?.reason ?? new Error("Aborted"),
        );
      }
    };
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
      throw new Error(
        "SubagentBatchController.run() can only be called once.",
      );
    }
    this.started = true;

    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      if (this.states.length === 0) {
        this.finish([]);
        return;
      }

      if (this.batchSignal?.aborted) {
        this.batchAbortListener();
        return;
      }

      this.batchSignal?.addEventListener(
        "abort",
        this.batchAbortListener,
        { once: true },
      );
      this.schedule();
    });
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
      if (
        this.finished ||
        this.rateLimitMode ||
        this.pending.length === 0
      )
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

    if (this.active.size >= this.rateLimitCapacity) {
      this.scheduleRateLimitWakeup(
        this.nextRateLimitCapacityRecoveryAt(),
        now,
      );
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

    const attempt: ActiveAttempt<T> = {
      state,
      controller: new AbortController(),
      cleanup: () => {},
      ready: false,
      timedOut: false,
    };
    attempt.cleanup = this.linkAttemptSignals(attempt, state.task);
    this.active.add(attempt);

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
      suppressRateLimitFailureEvent: true,
      timeout: task.timeout,
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
        handle = await this.launcher.resume(
          task.resumeAgentId,
          runOptions,
        );
      } else {
        const spawnOptions: SpawnSubagentOptions = {
          profileName: task.profileName,
          swarmItem: task.swarmItem,
          ...runOptions,
        };
        handle = await this.launcher.spawn(spawnOptions);
      }
    } catch (error) {
      return this.failedAttemptOutcome(attempt, error);
    }

    attempt.state.agentId = handle.agentId;

    try {
      const completion: SubagentCompletion =
        await handle.completion;
      return {
        task,
        agentId: handle.agentId,
        status: "completed",
        result: completion.result,
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

    if (outcome.type === "rate_limited") {
      this.handleRateLimit(attempt, outcome);
      return;
    }

    this.results[attempt.state.index] = outcome;
    this.schedule();
  }

  private handleAttemptError(
    attempt: ActiveAttempt<T>,
    error: unknown,
  ): void {
    attempt.cleanup();
    this.active.delete(attempt);

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

    const result: SubagentResult<T> = this.failedAttemptOutcome(
      attempt,
      error,
    );
    this.results[attempt.state.index] = result;
    this.schedule();
  }

  private handleRateLimit(
    attempt: ActiveAttempt<T>,
    _outcome: AttemptOutcome<T>,
  ): void {
    const state = attempt.state;

    // If this is the only remaining task, fail fast.
    if (this.pending.length === 0 && this.active.size === 0) {
      this.results[state.index] = this.failedAttemptOutcome(
        attempt,
        new Error("Rate limit exceeded with no remaining work."),
      );
      this.schedule();
      return;
    }

    // Save agent id for retry and requeue at front
    state.retryAgentId = state.agentId ?? state.retryAgentId;
    state.retryCount += 1;

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
    this.schedule();
  }

  private failedAttemptOutcome(
    attempt: ActiveAttempt<T>,
    error: unknown,
  ): SubagentResult<T> {
    const task = attempt.state.task;
    const isAbort =
      error instanceof Error &&
      (error.message.includes("abort") ||
        error.message.includes("cancel") ||
        error.name === "AbortError");

    const status: SubagentResult<T>["status"] = isAbort
      ? "aborted"
      : "failed";

    let errorMessage: string;
    if (attempt.timedOut && task.timeout !== undefined) {
      errorMessage = "Subagent timed out.";
    } else if (isAbort) {
      errorMessage =
        "The user manually interrupted this subagent batch.";
    } else {
      errorMessage =
        error instanceof Error
          ? error.message
          : String(error);
    }

    return {
      task,
      agentId: attempt.state.agentId,
      status,
      state: attempt.state.started ? "started" : "not_started",
      error: errorMessage,
    };
  }

  // -----------------------------------------------------------------------
  // Rate-limit phase
  // -----------------------------------------------------------------------

  private enterRateLimitPhase(): void {
    this.rateLimitMode = true;
    this.clearNormalTimer();
    this.rateLimitCapacity = Math.max(
      1,
      this.countReadyActive(),
    );
    this.lastRateLimitAt = Date.now();
    this.globalRetryIntervalMs = RATE_LIMIT_RETRY_BASE_MS;
    this.nextRateLimitLaunchAt = Date.now() + RATE_LIMIT_RETRY_BASE_MS;
  }

  private shrinkRateLimitCapacity(now: number): void {
    if (
      this.lastCapacityShrinkAt !== undefined &&
      now - this.lastCapacityShrinkAt <
        RATE_LIMIT_CAPACITY_SHRINK_INTERVAL_MS
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
    if (now - lastRecovery < RATE_LIMIT_CAPACITY_RECOVERY_INTERVAL_MS)
      return;

    this.lastCapacityRecoveryAt = now;
    this.rateLimitCapacity += 1;
  }

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  private finishIfComplete(): boolean {
    const allDone = this.results.every((r) => r !== undefined);
    if (allDone) {
      this.finish(
        this.results as Array<SubagentResult<T>>,
      );
      return true;
    }
    return false;
  }

  private finish(results: Array<SubagentResult<T>>): void {
    if (this.finished) return;
    this.finished = true;
    this.clearNormalTimer();
    this.clearRateLimitTimer();
    this.batchSignal?.removeEventListener(
      "abort",
      this.batchAbortListener,
    );
    this.resolve?.(results);
  }

  private finishWithUserCancellation(): void {
    if (this.finished) return;

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

    this.finish(
      this.results as Array<SubagentResult<T>>,
    );
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.clearNormalTimer();
    this.clearRateLimitTimer();

    // Abort all active attempts
    for (const attempt of this.active) {
      attempt.cleanup();
    }
    this.active.clear();

    this.batchSignal?.removeEventListener(
      "abort",
      this.batchAbortListener,
    );
    this.reject?.(error);
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

  private scheduleRateLimitWakeup(
    wakeAt: number,
    now: number,
  ): void {
    const delay = Math.max(0, wakeAt - now);
    this.rateLimitLaunchTimer = setTimeout(() => {
      this.rateLimitLaunchTimer = undefined;
      this.schedule();
    }, delay);
  }

  private scheduleNextRateLimitWakeup(now: number): void {
    const next = Math.min(
      this.nextRateLimitLaunchAt,
      this.nextPendingReadyAt(),
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
    attempt.ready = true;
    if (
      !this.rateLimitMode &&
      this.startedSuccessCount === 0
    ) {
      this.startedSuccessCount = 1;
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
      this.controller.signal.addEventListener(
        "abort",
        abortFromBatch,
        { once: true },
      );
      task.signal?.addEventListener("abort", abortFromTask, {
        once: true,
      });
    }

    return () => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.controller.signal.removeEventListener(
        "abort",
        abortFromBatch,
      );
      task.signal?.removeEventListener("abort", abortFromTask);
    };
  }
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the optional swarm max concurrency from the environment.
 *
 * Returns `undefined` when unset.  A present value must be a positive
 * integer; invalid input throws so a misconfigured cap never silently
 * reverts to uncapped.
 */
export function resolveSwarmMaxConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  const raw = env[AGENT_SWARM_MAX_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${AGENT_SWARM_MAX_CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}
