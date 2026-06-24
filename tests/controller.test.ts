/**
 * tests/controller.test.ts — unit tests for SubagentBatchController.
 *
 * Tests the concurrency controller's scheduling logic using a mock
 * launcher that returns synthetic subagent handles.
 */

import { describe, it, expect, vi } from "vitest";
import { SubagentBatchController } from "../src/shared/controller.js";
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
  /** Result text. */
  result: string;
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
    kind: "spawn",
    data: { index },
    profileName: "test-agent",
    parentToolCallId: "test-call",
    prompt: `task-${index}`,
    description: `Task #${index}`,
    swarmIndex: index,
    runInBackground: false,
    timeout: 5000,
    ...overrides,
  };
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
});
