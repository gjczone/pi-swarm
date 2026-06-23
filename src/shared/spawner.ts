/**
 * spawner — launch and manage pi subagent child processes.
 *
 * Each subagent runs as an independent `pi --print` child process.
 * The parent parses JSON Lines events from stdout to track progress,
 * collect token usage, and capture the final result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { getPiInvocation, buildSubagentArgs } from "./pi-invoke.js";
import type {
  SpawnSubagentOptions,
  SubagentHandle,
  SubagentCompletion,
  SubagentUsage,
  RunSubagentOptions,
} from "./types.js";

// ---------------------------------------------------------------------------
// Spawner implementation
// ---------------------------------------------------------------------------

/**
 * Launch a new subagent child process.
 *
 * The child runs `pi --print` with the given task.  The parent reads
 * JSON Lines from stdout and accumulates usage + final result.
 *
 * On abort, sends SIGTERM (then SIGKILL after 5s grace).
 */
export async function spawnSubagent(
  opts: SpawnSubagentOptions,
): Promise<SubagentHandle> {
  opts.signal.throwIfAborted();

  const agentId = `swarm-${randomId()}`;
  const completion = runSubagentProcess(agentId, opts);

  opts.onReady?.();

  return {
    agentId,
    profileName: opts.profileName,
    resumed: false,
    completion,
  };
}

/**
 * Resume an existing subagent by re-spawning with a resume prompt.
 */
export async function resumeSubagent(
  agentId: string,
  opts: RunSubagentOptions,
): Promise<SubagentHandle> {
  opts.signal.throwIfAborted();

  const spawnOpts: SpawnSubagentOptions = {
    ...opts,
    profileName: "subagent",
  };
  const completion = runSubagentProcess(agentId, spawnOpts);

  opts.onReady?.();

  return {
    agentId,
    profileName: "subagent",
    resumed: true,
    completion,
  };
}

/**
 * Retry a failed subagent with the same agentId.
 */
export async function retrySubagent(
  agentId: string,
  opts: RunSubagentOptions,
): Promise<SubagentHandle> {
  return resumeSubagent(agentId, opts);
}

// ---------------------------------------------------------------------------
// Internal process management
// ---------------------------------------------------------------------------

interface SubagentEvent {
  type: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}

interface ParsedResult {
  text: string;
  usage: SubagentUsage;
  stopReason?: string;
  errorMessage?: string;
}

async function runSubagentProcess(
  agentId: string,
  opts: SpawnSubagentOptions,
): Promise<SubagentCompletion> {
  const args = buildSubagentArgs({
    task: opts.prompt,
    model: opts.model,
    tools: opts.tools,
    cwd: opts.cwd,
  });

  const invocation = getPiInvocation(args);
  const cwd = opts.cwd ?? process.cwd();

  const result = await new Promise<ParsedResult>((resolve, reject) => {
    const proc: ChildProcess = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const parsed = parseEventStream(proc, agentId);

    // Handle abort signal
    if (opts.signal) {
      const killProc = (reason?: unknown) => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        }
        reject(
          reason instanceof Error
            ? reason
            : new Error("Subagent aborted"),
        );
      };

      if (opts.signal.aborted) {
        killProc(opts.signal.reason);
        return;
      }
      opts.signal.addEventListener("abort", () => killProc(opts.signal.reason), {
        once: true,
      });
    }

    // Handle timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        }
        reject(new Error("Subagent timed out"));
      }, opts.timeout);
    }

    proc.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (code === 0 || code === null) {
        resolve(parsed);
      } else {
        reject(
          new Error(
            `Subagent exited with code ${code}: ${parsed.errorMessage || parsed.text || "unknown error"}`,
          ),
        );
      }
    });

    proc.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });
  });

  return {
    result: result.text || "(no output)",
    usage: result.usage,
  };
}

/**
 * Parse the JSON Lines event stream from a pi --print child process.
 * Accumulates usage stats and extracts the final text result.
 */
function parseEventStream(
  proc: ChildProcess,
  _agentId: string,
): ParsedResult {
  // Mutable accumulator (interface fields are readonly)
  const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let finalText = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;

  let buffer = "";

  const processLine = (line: string) => {
    if (!line.trim()) return;

    let event: SubagentEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines
    }

    // Accumulate usage from message_end events (assistant messages)
    if (
      event.type === "message_end" &&
      event.message?.role === "assistant"
    ) {
      const msg = event.message;
      if (msg.usage) {
        usageAcc.input += msg.usage.input || 0;
        usageAcc.output += msg.usage.output || 0;
        usageAcc.cacheRead += msg.usage.cacheRead || 0;
        usageAcc.cacheWrite += msg.usage.cacheWrite || 0;
        usageAcc.totalTokens = msg.usage.totalTokens || usageAcc.totalTokens;
      }
      if (msg.stopReason) stopReason = msg.stopReason;
      if (msg.errorMessage) errorMessage = msg.errorMessage;

      // Collect text content from the final message
      const content = msg.content;
      if (content && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            finalText += block.text;
          }
        }
      }
    }

    // Tool result events — collect output for display
    if (event.type === "tool_result_end") {
      // Tool results are captured for event logging
    }
  };

  if (proc.stdout) {
    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processLine(line);
      }
    });

    // Must subscribe to consume the stream
    proc.stdout.resume();
  }

  if (proc.stderr) {
    proc.stderr.on("data", (data: Buffer) => {
      // Stderr may contain error details
      const text = data.toString().trim();
      if (text && !errorMessage) {
        errorMessage = text;
      }
    });
    proc.stderr.resume();
  }

  // Process any remaining buffer on close
  const originalOn = proc.on.bind(proc);
  proc.on("close", () => {
    if (buffer.trim()) {
      processLine(buffer);
    }
  });

  const usage: SubagentUsage = {
    input: usageAcc.input,
    output: usageAcc.output,
    cacheRead: usageAcc.cacheRead,
    cacheWrite: usageAcc.cacheWrite,
    totalTokens: usageAcc.totalTokens,
  };
  return { text: finalText, usage, stopReason, errorMessage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
