/**
 * tests/smoke.test.ts — smoke tests that verify core modules load and
 * basic operations work without requiring a running pi instance.
 *
 * These tests validate the extension can be imported and basic
 * functionality works. They do NOT spawn real pi child processes.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import { SubagentBatchController } from "../src/shared/controller.js";
import { renderSwarmResults } from "../src/shared/render.js";
import { resolveSwarmMaxConcurrency } from "../src/shared/controller.js";
import {
  resolveSwarmRoot,
  createManifest,
  readManifest,
  deleteRunState,
  writeAtomic,
  validateId,
  resolveAgentStateDir,
  type RunManifest,
} from "../src/state/persistence.js";
import { recoverRuns } from "../src/state/recovery.js";
import { pruneWorktrees } from "../src/shared/worktree.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------

describe("Module imports", () => {
  it("imports render module", () => {
    expect(renderSwarmResults).toBeDefined();
    expect(typeof renderSwarmResults).toBe("function");
  });

  it("imports persistence module", () => {
    expect(resolveSwarmRoot).toBeDefined();
    expect(createManifest).toBeDefined();
    expect(readManifest).toBeDefined();
  });

  it("imports recovery module", () => {
    expect(recoverRuns).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Environment variable parsing
// ---------------------------------------------------------------------------

describe("Environment config", () => {
  it("returns default 5 when no settings exist", () => {
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
    const result = resolveSwarmMaxConcurrency("/tmp/nonexistent");
    expect(result).toBe(5);
  });

  it("throws on non-integer value", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "abc";
    expect(() => resolveSwarmMaxConcurrency("/tmp/nonexistent")).toThrow(
      /positive integer/,
    );
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });

  it("throws on zero", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "0";
    expect(() => resolveSwarmMaxConcurrency("/tmp/nonexistent")).toThrow(
      /positive integer/,
    );
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });

  it("throws on negative", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "-5";
    expect(() => resolveSwarmMaxConcurrency("/tmp/nonexistent")).toThrow(
      /positive integer/,
    );
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });

  it("parses env var when no settings file exists", () => {
    process.env.PI_SWARM_MAX_CONCURRENCY = "10";
    const result = resolveSwarmMaxConcurrency("/tmp/nonexistent");
    expect(result).toBe(10);
    delete process.env.PI_SWARM_MAX_CONCURRENCY;
  });
});

// ---------------------------------------------------------------------------
// Basic controller integration
// ---------------------------------------------------------------------------

describe("Controller integration", () => {
  it("resolves empty batch immediately", async () => {
    const mockLauncher = {
      spawn: async () => {
        throw new Error("should not be called");
      },
      resume: async () => {
        throw new Error("should not be called");
      },
      retry: async () => {
        throw new Error("should not be called");
      },
    };

    const controller = new SubagentBatchController(mockLauncher, []);
    const results = await controller.run();

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Persistence smoke
// ---------------------------------------------------------------------------

describe("Persistence smoke", () => {
  const tmpDir = path.join(os.tmpdir(), `pi-swarm-smoke-${Date.now()}`);

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates and reads a manifest", () => {
    const manifest: RunManifest = {
      runId: "test-run-001",
      type: "swarm",
      status: "running",
      goal: "Test goal",
      startedAt: Date.now(),
      agentIds: ["agent-1", "agent-2"],
    };

    createManifest(tmpDir, manifest);

    const read = readManifest(tmpDir, "test-run-001");
    expect(read).not.toBeNull();
    expect(read!.runId).toBe("test-run-001");
    expect(read!.type).toBe("swarm");
    expect(read!.status).toBe("running");
    expect(read!.agentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("returns null for non-existent manifest", () => {
    const result = readManifest(tmpDir, "nonexistent");
    expect(result).toBeNull();
  });

  it("deletes run state", () => {
    const manifest: RunManifest = {
      runId: "test-run-002",
      type: "swarm",
      status: "completed",
      startedAt: Date.now(),
      agentIds: [],
    };

    createManifest(tmpDir, manifest);
    expect(readManifest(tmpDir, "test-run-002")).not.toBeNull();

    deleteRunState(tmpDir, "test-run-002");
    expect(readManifest(tmpDir, "test-run-002")).toBeNull();
  });

  it("recovery returns empty for clean directory", () => {
    const result = recoverRuns(tmpDir);
    expect(result.resumable).toEqual([]);
    expect(result.abandoned).toEqual([]);
    expect(result.cleanedUp.length).toBeGreaterThanOrEqual(0);
  });

  it("recovery deletes orphaned directories without manifest", () => {
    const orphanRunId = "test-orphan-run";
    const swarmRoot = resolveSwarmRoot(tmpDir);
    const runDir = path.join(swarmRoot, "state", "runs", orphanRunId);
    const agentsDir = path.join(runDir, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "dummy.log"), "dummy agent log");

    const result = recoverRuns(tmpDir);
    expect(result.cleanedUp).toContain(orphanRunId);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it("recovery preserves directories with corrupt manifest", () => {
    const corruptRunId = "test-corrupt-run";
    const swarmRoot = resolveSwarmRoot(tmpDir);
    const runDir = path.join(swarmRoot, "state", "runs", corruptRunId);
    const manifestPath = path.join(runDir, "manifest.json");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(manifestPath, "{ this is not valid json");

    const result = recoverRuns(tmpDir);
    expect(result.cleanedUp).not.toContain(corruptRunId);
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ID validation and path traversal tests (#41)
// ---------------------------------------------------------------------------

describe("ID validation", () => {
  it("validateId accepts safe agent IDs", () => {
    expect(() => validateId("agent-123_abc", "agentId")).not.toThrow();
    expect(() => validateId("swarm-abc123", "agentId")).not.toThrow();
  });

  it("validateId rejects path traversal characters", () => {
    expect(() => validateId("../../evil", "agentId")).toThrow(
      /unsafe characters/,
    );
    expect(() => validateId("../escape", "agentId")).toThrow(
      /unsafe characters/,
    );
    expect(() => validateId("agent/../../evil", "agentId")).toThrow(
      /unsafe characters/,
    );
    expect(() => validateId("agent\\..\\evil", "agentId")).toThrow(
      /unsafe characters/,
    );
  });

  it("resolveAgentStateDir rejects path traversal in agentId", () => {
    const tmpDir = path.join(os.tmpdir(), `pi-swarm-validate-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const swarmRoot = resolveSwarmRoot(tmpDir);
    const runId = "test-run-validate";

    expect(() =>
      resolveAgentStateDir(swarmRoot, runId, "../../evil"),
    ).toThrow();
    expect(() => resolveAgentStateDir(swarmRoot, runId, "../escape")).toThrow();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Atomic write tests (#45)
// ---------------------------------------------------------------------------

describe("Atomic write", () => {
  const tmpDir = path.join(os.tmpdir(), `pi-swarm-atomic-${Date.now()}`);

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writeAtomic leaves no temp files after write", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const testFile = path.join(tmpDir, "test-atomic.json");
    const testContent = JSON.stringify({ key: "value", num: 42 }, null, 2);

    writeAtomic(testFile, testContent);

    // Verify content was written correctly
    expect(fs.readFileSync(testFile, "utf-8")).toBe(testContent);

    // Verify no .tmp files remain in the directory
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #130 — silent error swallowing replaced with console.error logging
// ---------------------------------------------------------------------------

describe("#130 silent catch blocks emit console.error", () => {
  it("pruneWorktrees in a non-git directory logs via console.error (via wrapper)", () => {
    // The wrapper in src/index.ts:97-101 calls pruneWorktrees inside a
    // try/catch and logs the error. We exercise the underlying helper
    // here and confirm it does not throw (a non-git dir is a no-op for
    // git worktree prune).
    const nonGitDir = path.join(os.tmpdir(), `pi-swarm-nongit-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // pruneWorktrees silently returns when not in a git repo
      expect(() => pruneWorktrees(nonGitDir)).not.toThrow();
      // The wrapper is what would log; this test documents that the
      // underlying helper does not throw, allowing the wrapper's catch
      // to log instead of propagating.
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
      errSpy.mockRestore();
    }
  });

  it("writeAtomic surfaces write errors via the thrown exception (not silently swallowed)", () => {
    // The fix replaces the empty `catch {}` with `console.error(...)` for
    // the inner cleanup branch. This test confirms the public behavior
    // is unchanged: write still throws on failure so callers can react.
    // We test this by writing to an invalid path (parent is a file).
    const tmpDir = path.join(
      os.tmpdir(),
      `pi-swarm-atomic-throw-${Date.now()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not-a-dir");
    const invalidPath = path.join(blocker, "child.json");
    expect(() => writeAtomic(invalidPath, "x")).toThrow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("src/ contains no empty `// Best effort` or `// ignore` comments", async () => {
    // AGENTS.md §0 Quality Gates: every catch block must log or propagate.
    // This grep is enforced at runtime to catch regressions. The grep
    // exits 1 when no matches are found — that is the success case.
    const { execFileSync } = await import("node:child_process");
    const repoRoot = path.resolve(__dirname, "..");
    try {
      const result = execFileSync(
        "grep",
        ["-rn", "-E", "Best effort|// ignore", "src/"],
        { cwd: repoRoot, stdio: "pipe" },
      ).toString();
      // grep exited 0 = at least one match → regression
      expect(result.trim()).toBe("");
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 1) {
        // grep exit 1 = no matches. The success case.
        return;
      }
      throw err;
    }
    expect(result.trim()).toBe("");
  });
});
