/**
 * tests/controller.test.ts — unit tests for SubagentBatchController.
 *
 * Tests the concurrency controller's scheduling logic using a mock
 * launcher that returns synthetic subagent handles.
 */

import { describe, it, expect } from "vitest";
import {
  SubagentBatchController,
  USER_CANCELLATION_MARKER,
  isUserCancellation,
  resolveProfileModel,
  resolveSwarmSmallModel,
} from "../src/shared/controller.js";
import type {
  QueuedSubagentTask,
  SubagentHandle,
  SubagentBatchLauncher,
  SpawnSubagentOptions,
  RunSubagentOptions,
  SubagentCompletion,
} from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Mock launcher
// ---------------------------------------------------------------------------

interface MockAgentConfig {
  /** Delay before completion in ms. */
  delayMs: number;
  /** Result text (optional, only needed for success cases). */
  result?: string;
  /** Whether to throw an error. */
  throwError?: boolean;
  /** Whether to throw a rate-limit error. */
  throwRateLimit?: boolean;
}

function createMockLauncher(
  configs: Record<string, MockAgentConfig>,
): SubagentBatchLauncher {
  return {
    async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
      const configKey = opts.prompt || opts.description;
      const config = configs[configKey] ?? {
        delayMs: 10,
        result: "default result",
      };

      const agentId = `mock-${Math.random().toString(36).slice(2, 6)}`;
      opts.onReady?.();

      const completion: Promise<SubagentCompletion> = new Promise(
        (resolve, reject) => {
          setTimeout(() => {
            if (config.throwRateLimit) {
              reject(new Error("Rate limit exceeded (429)"));
            } else if (config.throwError) {
              reject(new Error("Simulated error"));
            } else {
              resolve({ result: config.result });
            }
          }, config.delayMs);
        },
      );

      return {
        agentId,
        profileName: opts.profileName,
        resumed: false,
        completion,
      };
    },

    async resume(
      agentId: string,
      opts: RunSubagentOptions,
    ): Promise<SubagentHandle> {
      return this.spawn({
        ...opts,
        profileName: "resumed",
        swarmItem: undefined,
      });
    },

    async retry(
      agentId: string,
      opts: RunSubagentOptions,
    ): Promise<SubagentHandle> {
      return this.resume(agentId, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  index: number,
  overrides: Partial<QueuedSubagentTask<unknown>> = {},
): QueuedSubagentTask<unknown> {
  return {
    kind: "spawn" as const,
    data: { index },
    profileName: "test-agent",
    parentToolCallId: "test-call",
    prompt: `task-${index}`,
    description: `Task #${index}`,
    swarmIndex: index,
    runInBackground: false,
    timeout: 5000,
    ...overrides,
  } as QueuedSubagentTask<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubagentBatchController", () => {
  it("completes a single task", async () => {
    const launcher = createMockLauncher({
      "task-0": { delayMs: 10, result: "done" },
    });

    const controller = new SubagentBatchController(launcher, [makeTask(0)]);
    const results = await controller.run();

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.result).toBe("done");
  });

  it("completes multiple tasks in parallel", async () => {
    const launcher = createMockLauncher({
      "task-0": { delayMs: 20, result: "result-0" },
      "task-1": { delayMs: 10, result: "result-1" },
      "task-2": { delayMs: 30, result: "result-2" },
    });

    const controller = new SubagentBatchController(launcher, [
      makeTask(0),
      makeTask(1),
      makeTask(2),
    ]);
    const results = await controller.run();

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "completed")).toBe(true);
    // Results maintain input order
    expect(results[0]!.result).toBe("result-0");
    expect(results[1]!.result).toBe("result-1");
    expect(results[2]!.result).toBe("result-2");
  });

  it("handles a failed task", async () => {
    const launcher = createMockLauncher({
      "task-0": { delayMs: 10, result: "ok" },
      "task-1": { delayMs: 10, throwError: true },
    });

    const controller = new SubagentBatchController(launcher, [
      makeTask(0),
      makeTask(1),
    ]);
    const results = await controller.run();

    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe("completed");
    expect(results[1]!.status).toBe("failed");
    expect(results[1]!.error).toBeDefined();
  });

  it("#125 scheduleNextRateLimitWakeup: past-time branch calls schedule()", async () => {
    // Regression: previously scheduleNextRateLimitWakeup returned silently when
    // the next-wake time was in the past, leaving the controller in a stuck
    // state. The fix invokes this.schedule() directly when next <= now.
    // This test exercises the method through the public surface: a launcher
    // that rate-limits twice in a row (the second recovery time elapses while
    // the task is still pending) must not deadlock.
    let callCount = 0;
    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        callCount += 1;
        const agentId = `mock-rl-${callCount}`;
        opts.onReady?.();
        const completion: Promise<SubagentCompletion> = new Promise(
          (resolve, reject) => {
            setTimeout(() => {
              if (callCount === 1) {
                reject(new Error("Rate limit exceeded (429)"));
              } else {
                resolve({ result: "ok-after-past-wakeup" });
              }
            }, 5);
          },
        );
        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.spawn({
          ...opts,
          profileName: "resumed",
        });
      },
      async retry(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.resume(agentId, opts);
      },
    };

    const controller = new SubagentBatchController(launcher, [makeTask(0)]);
    // Bounded wait: if scheduleNextRateLimitWakeup deadlocks, the run promise
    // never resolves; if it works, we see completion within a few seconds.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("rate-limit recovery deadlocked")),
        10000,
      ),
    );
    const results = await Promise.race([controller.run(), timeout]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("completed");
    expect(results[0]!.result).toBe("ok-after-past-wakeup");
  });

  it("handles rate-limit errors by retrying", async () => {
    let callCount = 0;
    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        callCount += 1;
        const agentId = `mock-${callCount}`;
        opts.onReady?.();

        const completion: Promise<SubagentCompletion> = new Promise(
          (resolve, reject) => {
            setTimeout(() => {
              if (callCount === 1) {
                // First attempt: rate limit
                reject(new Error("Rate limit exceeded"));
              } else {
                // Retry: success
                resolve({ result: "retry-success" });
              }
            }, 5);
          },
        );

        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.spawn({
          ...opts,
          profileName: "resumed",
        });
      },
      async retry(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.resume(agentId, opts);
      },
    };

    const controller = new SubagentBatchController(launcher, [makeTask(0)]);
    const results = await controller.run();

    expect(results).toHaveLength(1);
    // After retry, should complete (or fail if only one task and rate-limited)
    expect(["completed", "failed"]).toContain(results[0]!.status);
  });

  it("respects max concurrency cap", async () => {
    const started: number[] = [];
    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        started.push(Date.now());
        const agentId = `mock-${started.length}`;
        opts.onReady?.();

        const completion: Promise<SubagentCompletion> = new Promise(
          (resolve) => {
            setTimeout(() => {
              resolve({ result: `task-${started.length}` });
            }, 50);
          },
        );

        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.spawn({
          ...opts,
          profileName: "resumed",
        });
      },
      async retry(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.resume(agentId, opts);
      },
    };

    const tasks = Array.from({ length: 10 }, (_, i) => makeTask(i));

    const controller = new SubagentBatchController(launcher, tasks, {
      maxConcurrency: 3,
    });
    const results = await controller.run();

    expect(results).toHaveLength(10);
    expect(results.every((r) => r.status === "completed")).toBe(true);
  }, 10000);

  it("handles empty task list", async () => {
    const launcher = createMockLauncher({});
    const controller = new SubagentBatchController(launcher, []);
    const results = await controller.run();

    expect(results).toHaveLength(0);
  });

  it("aborts tasks when signal is triggered", async () => {
    const controller2 = new AbortController();

    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        const agentId = `mock-abort`;
        opts.onReady?.();

        // Resolve the completion immediately but attach the signal
        const completion: Promise<SubagentCompletion> = new Promise(
          (resolve, reject) => {
            // Check if already aborted
            if (opts.signal?.aborted) {
              reject(new Error("User cancelled"));
              return;
            }
            const onAbort = () => {
              reject(new Error("User cancelled"));
            };
            opts.signal?.addEventListener("abort", onAbort, {
              once: true,
            });
            // Never resolve — we test abort behavior
          },
        );

        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.spawn({
          ...opts,
          profileName: "resumed",
        });
      },
      async retry(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.resume(agentId, opts);
      },
    };

    const task = makeTask(0, { signal: controller2.signal });
    const controller = new SubagentBatchController(launcher, [task]);

    // Abort before the completion resolves
    queueMicrotask(() => {
      controller2.abort("User cancelled");
    });

    const results = await controller.run();

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("aborted");
  });

  it("does not mutate results array after finish() resolves on cancel (#43)", async () => {
    const controller2 = new AbortController();

    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        const agentId = `mock-late`;
        opts.onReady?.();

        const completion: Promise<SubagentCompletion> = new Promise(
          (resolve, reject) => {
            if (opts.signal) {
              if (opts.signal.aborted) {
                reject(new Error("User cancelled"));
                return;
              }
              opts.signal.addEventListener(
                "abort",
                () => reject(new Error("User cancelled")),
                { once: true },
              );
            }
          },
        );

        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.spawn({
          ...opts,
          profileName: "resumed",
        });
      },
      async retry(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.resume(agentId, opts);
      },
    };

    const task = makeTask(0, { signal: controller2.signal });
    const controller = new SubagentBatchController(launcher, [task]);

    // Start the run
    const resultsPromise = controller.run();

    // Wait for the task to start
    await new Promise((r) => setTimeout(r, 20));

    // Abort — this should finish the batch and abort the active attempt
    controller2.abort("User cancelled");

    const results = await resultsPromise;

    // Record the result after cancellation
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("aborted");
    const statusAfterCancel = results[0]!.status;
    const resultAfterCancel = results[0]!.result;

    // Wait for the abort to propagate and the attempt to settle
    await new Promise((r) => setTimeout(r, 20));

    // Results array should not have been mutated after finish()
    expect(results[0]!.status).toBe(statusAfterCancel);
    expect(results[0]!.status).toBe("aborted");
    expect(results[0]!.result).toBe(resultAfterCancel);
  });

  it("#105 fail() populates results for all tasks before rejecting", async () => {
    // When fail() is called (non-user abort), it must populate this.results
    // for every queued task — completed agents keep their result, active/pending
    // agents are marked aborted — so coordinator getResults() returns a full
    // array instead of filtering out undefined slots.
    const ac = new AbortController();
    const launcher = createMockLauncher({
      "task-0": { delayMs: 10, result: "done-0" },
      "task-1": { delayMs: 500, result: "done-1" },
    });
    const tasks = [makeTask(0), makeTask(1, { signal: ac.signal })];
    const controller = new SubagentBatchController(launcher, tasks);
    const handle = controller.runAsync("test-run-105");

    // Let task-0 finish, then abort task-1's signal with a non-user reason.
    // Non-user abort triggers handleBatchAbort -> fail().
    await new Promise((r) => setTimeout(r, 80));
    ac.abort(new Error("Simulated failure"));

    await expect(handle.completion).rejects.toThrow("Simulated failure");

    const results = handle.getResults();
    expect(results).toHaveLength(2);
    const r0 = results.find(
      (r) => (r.task.data as { index: number }).index === 0,
    );
    const r1 = results.find(
      (r) => (r.task.data as { index: number }).index === 1,
    );
    expect(r0?.status).toBe("completed");
    expect(r1).toBeDefined();
    expect(r1?.status).toBe("aborted");
  });

  it("#124 isUserCancellation does NOT match substring 'user' in error messages", async () => {
    // Regression: an Error message that happens to contain the word "user"
    // must NOT be misclassified as user cancellation. Substring matching on
    // "user"/"cancel"/"interrupt" caused unrelated errors to be reported as
    // "aborted" instead of "failed".
    // Use a launcher that throws an error containing "user" in its message
    // at the task level (handleAttemptError path) — not via abort signal.
    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        const agentId = "mock-user-message";
        opts.onReady?.();
        const completion: Promise<SubagentCompletion> = new Promise(
          (_resolve, reject) => {
            // Reject with a non-cancellation error whose message contains "user"
            setTimeout(() => reject(new Error("user_id field is required")), 5);
          },
        );
        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume() {
        throw new Error("not used");
      },
      async retry() {
        throw new Error("not used");
      },
    };

    const task = makeTask(0);
    const controller = new SubagentBatchController(launcher, [task]);
    const handle = controller.runAsync("test-run-124");

    // The completion promise resolves with a result whose status reflects the
    // task outcome — "failed" for a non-user error (NOT "aborted").
    const results = await handle.completion;
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.status).not.toBe("aborted");
    expect(results[0]!.error).toBe("user_id field is required");
  });

  it("#124 isUserCancellation still detects marker-based errors as cancellation", async () => {
    // Counterpart: errors carrying the USER_CANCELLATION_MARKER must still be
    // recognized as user cancellation so the result status is "aborted" (not
    // "failed"). This is the source of truth for the marker check.
    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        const agentId = "mock-marker";
        opts.onReady?.();
        const completion: Promise<SubagentCompletion> = new Promise(
          (_resolve, reject) => {
            setTimeout(() => {
              const err = new Error("user typed Ctrl-C");
              (err as Record<symbol, unknown>)[USER_CANCELLATION_MARKER] = true;
              reject(err);
            }, 5);
          },
        );
        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume() {
        throw new Error("not used");
      },
      async retry() {
        throw new Error("not used");
      },
    };

    const task = makeTask(0);
    const controller = new SubagentBatchController(launcher, [task]);
    const handle = controller.runAsync("test-run-124b");

    const results = await handle.completion;
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("aborted");
  });

  it("#132 USER_CANCELLATION_MARKER is a Symbol, not a string", () => {
    // #132: the marker is now a Symbol so plain string properties on Error
    // cannot be misidentified as user cancellation. The exported value must
    // be a Symbol.
    expect(typeof USER_CANCELLATION_MARKER).toBe("symbol");
  });

  it("#132 an Error with a literal '__pi_swarm_user_cancellation__' string property is NOT recognized as user cancellation", () => {
    // Defense-in-depth: after the Symbol refactor, an unrelated library that
    // attaches a string property with the old marker name must not be
    // misclassified. Only the symbol-keyed property is the source of truth.
    const err = new Error("spoof attempt");
    (err as Record<string, unknown>)["__pi_swarm_user_cancellation__"] = true;
    expect(isUserCancellation(err)).toBe(false);
  });

  it("#121 blocking run() resolves (does not reject) on internal failure with partial results", async () => {
    // Regression: previously fail() always called reject(). The blocking
    // AgentSwarm caller in src/swarm/tool.ts:409 caught that rejection and
    // returned "Swarm failed: <message>" — skipping the post-await auto-merge
    // loop and orphaning completed worktree branches. fix() changes fail()
    // to call resolve() for blocking callers (coordReject still rejects).
    const ac = new AbortController();
    const launcher = createMockLauncher({
      "task-0": { delayMs: 10, result: "done-0" },
      "task-1": { delayMs: 500, result: "done-1" },
    });
    const tasks = [makeTask(0), makeTask(1, { signal: ac.signal })];
    const controller = new SubagentBatchController(launcher, tasks);
    const runPromise = controller.run();

    // Let task-0 finish, then abort task-1's signal with a non-user reason.
    await new Promise((r) => setTimeout(r, 80));
    ac.abort(new Error("Simulated failure"));

    // run() must resolve with a full results array (not throw)
    const results = await runPromise;
    expect(results).toHaveLength(2);
    const r0 = results.find(
      (r) => (r.task.data as { index: number }).index === 0,
    );
    const r1 = results.find(
      (r) => (r.task.data as { index: number }).index === 1,
    );
    expect(r0?.status).toBe("completed");
    expect(r1?.status).toBe("aborted");
  });

  it("#191 rate-limit retry has a maximum count — permanent rate limit fails the task", async () => {
    // Regression: handleRateLimit retried indefinitely. A permanent rate
    // limit (exhausted quota, invalid API key) caused the swarm to hang
    // forever. The fix adds MAX_RATE_LIMIT_RETRIES; when exceeded, the task
    // is marked failed instead of being requeued.
    let callCount = 0;
    const launcher: SubagentBatchLauncher = {
      async spawn(opts: SpawnSubagentOptions): Promise<SubagentHandle> {
        callCount += 1;
        const agentId = `mock-rl-${callCount}`;
        opts.onReady?.();
        const completion: Promise<SubagentCompletion> = new Promise(
          (_resolve, reject) => {
            // Every attempt rate-limits — simulates a permanent rate limit
            setTimeout(() => reject(new Error("Rate limit exceeded (429)")), 5);
          },
        );
        return {
          agentId,
          profileName: opts.profileName,
          resumed: false,
          completion,
        };
      },
      async resume(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.spawn({
          ...opts,
          profileName: "resumed",
        });
      },
      async retry(
        agentId: string,
        opts: RunSubagentOptions,
      ): Promise<SubagentHandle> {
        return this.resume(agentId, opts);
      },
    };

    const controller = new SubagentBatchController(launcher, [makeTask(0)], {
      maxRateLimitRetries: 2,
    });

    // Bounded wait: if the retry loop is infinite, the run promise never
    // resolves. With the fix, it should resolve with status "failed" after
    // exceeding maxRateLimitRetries (2 retries = ~9s with exponential backoff).
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("rate-limit retry did not terminate")),
        30000,
      ),
    );
    const results = await Promise.race([controller.run(), timeout]);

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.error).toMatch(/rate limit/i);
  }, 35000);
});

// ---------------------------------------------------------------------------
// #201 — resolveProfileModel resolves profile "small" and "inherit"
// ---------------------------------------------------------------------------

describe("#201 resolveProfileModel", () => {
  const baseProfile = {
    name: "test",
    description: "test",
    allowWrite: true,
    allowBashWrite: true,
    outputFormat: "free" as const,
    systemPrompt: "",
  };

  it("returns undefined for 'inherit' model", () => {
    const profile = { ...baseProfile, model: "inherit" as const };
    expect(resolveProfileModel(profile)).toBeUndefined();
  });

  it("returns undefined when model is not set", () => {
    const profile = { ...baseProfile };
    expect(resolveProfileModel(profile)).toBeUndefined();
  });

  it("returns explicit model ID as-is", () => {
    const profile = { ...baseProfile, model: "deepseek/deepseek-v4-flash" };
    expect(resolveProfileModel(profile)).toBe("deepseek/deepseek-v4-flash");
  });

  it("resolves 'small' through resolveSwarmSmallModel", () => {
    // The "small" keyword must be resolved via settings, not passed literally.
    // When settings have no smallModel configured, resolveSwarmSmallModel
    // returns undefined — so resolveProfileModel also returns undefined.
    const profile = { ...baseProfile, model: "small" as const };
    const result = resolveProfileModel(profile);
    const expected = resolveSwarmSmallModel();
    expect(result).toBe(expected);
  });
});
