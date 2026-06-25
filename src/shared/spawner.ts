/**
 * spawner - launch and manage pi subagent child processes.
 *
 * Each subagent runs as an independent `pi --print` child process.
 * The parent parses JSON Lines events from stdout to track progress,
 * collect token usage, and capture the final result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { getPiInvocation, buildSubagentArgs } from "./pi-invoke.js";
import type {
  SpawnSubagentOptions,
  SubagentHandle,
  SubagentCompletion,
  SubagentUsage,
  RunSubagentOptions,
} from "./types.js";

const MAX_LINE_BUFFER_SIZE = 10 * 1024 * 1024;

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

  // Resolve output log path if swarm root and run ID are provided
  let resolvedOpts = opts;
  if (opts.swarmRoot && opts.runId && !opts.outputLogPath) {
    const agentDir = join(
      opts.swarmRoot,
      "state",
      "runs",
      opts.runId,
      "agents",
      agentId,
    );
    resolvedOpts = {
      ...opts,
      outputLogPath: join(agentDir, "output.log"),
    };
  }

  const completion = runSubagentProcess(agentId, resolvedOpts);

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

  let resolvedOpts = opts;
  if (opts.swarmRoot && opts.runId && !opts.outputLogPath) {
    const agentDir = join(
      opts.swarmRoot,
      "state",
      "runs",
      opts.runId,
      "agents",
      agentId,
    );
    resolvedOpts = {
      ...opts,
      outputLogPath: join(agentDir, "output.log"),
    };
  }

  const spawnOpts: SpawnSubagentOptions = {
    ...resolvedOpts,
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

  const proc: ChildProcess = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let logStream: WriteStream | undefined;
  if (opts.outputLogPath) {
    mkdirSync(dirname(opts.outputLogPath), { recursive: true });
    logStream = createWriteStream(opts.outputLogPath, {
      flags: "a",
      encoding: "utf-8",
    });
    const header = [
      "=".repeat(72),
      `Agent: ${agentId}`,
      `Profile: ${opts.profileName}`,
      `CWD: ${cwd}`,
      `Model: ${opts.model ?? "(inherited)"}`,
      `Tools: ${opts.tools?.join(", ") ?? "(all)"}`,
      `Started: ${new Date().toISOString()}`,
      "-".repeat(72),
      "PROMPT:",
      opts.prompt,
      "-".repeat(72),
      "OUTPUT:",
      "",
    ].join("\n");
    logStream.write(header);
  }

  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let streamResolve: ((result: ParsedResult) => void) | undefined;
  let streamReject: ((err: Error) => void) | undefined;
  let settled = false;
  let done = false;
  let abortReason: Error | undefined;

  const cleanup = () => {
    settled = true;
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = undefined;
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (opts.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  };

  const closeLog = (footer: string) => {
    if (logStream) {
      logStream.write(`\n${"-".repeat(72)}\n${footer}\n`);
      logStream.end();
      logStream = undefined;
    }
  };

  const resolveOnce = (parsed: ParsedResult) => {
    if (done) return;
    done = true;
    settled = true;
    const footer = [
      `Completed: ${new Date().toISOString()}`,
      `Stop reason: ${parsed.stopReason ?? "unknown"}`,
      `Tokens: in=${parsed.usage.input}, out=${parsed.usage.output}, total=${parsed.usage.totalTokens}`,
      "",
      "RESULT:",
      parsed.text || "(no output)",
    ].join("\n");
    closeLog(footer);
    cleanup();
    streamResolve?.(parsed);
  };

  const rejectOnce = (err: Error, footerPrefix = "Failed") => {
    if (done) return;
    done = true;
    settled = true;
    const footer = [
      `${footerPrefix}: ${new Date().toISOString()}`,
      `Error: ${err.message}`,
    ].join("\n");
    closeLog(footer);
    cleanup();
    streamReject?.(err);
  };

  const scheduleSigkill = () => {
    if (sigkillTimer) clearTimeout(sigkillTimer);
    sigkillTimer = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  };

  const killProc = (reason?: unknown) => {
    if (settled || done) return;
    settled = true;
    abortReason =
      reason instanceof Error ? reason : new Error("Subagent aborted");
    if (!proc.killed) {
      proc.kill("SIGTERM");
      scheduleSigkill();
    }
  };

  const onAbort = () => killProc(opts.signal?.reason);

  if (opts.signal) {
    if (opts.signal.aborted) {
      killProc(opts.signal.reason);
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (opts.timeout && opts.timeout > 0) {
    timeoutHandle = setTimeout(() => {
      if (settled || done) return;
      settled = true;
      abortReason = new Error("Subagent timed out");
      if (!proc.killed) {
        proc.kill("SIGTERM");
        scheduleSigkill();
      }
    }, opts.timeout);
  }

  try {
    const result = await new Promise<ParsedResult>((resolve, reject) => {
      streamResolve = resolve;
      streamReject = reject;
      parseEventStream(proc, agentId, logStream).then(
        (parsed) => {
          if (done) return;
          if (settled) {
            // Abort or timeout was requested, but process exited cleanly.
            // Prefer the completed result if it has no errors.
            if (parsed && !parsed.errorMessage) {
              resolveOnce(parsed);
              return;
            }
            // Process exited with an error after abort — use saved abort reason
            rejectOnce(abortReason ?? new Error("Subagent aborted"), "Aborted");
            return;
          }
          resolveOnce(parsed);
        },
        (err) => {
          if (done) return;
          if (settled) {
            // Abort was requested and process errored — use saved abort reason if available
            rejectOnce(
              abortReason ??
                (err instanceof Error ? err : new Error(String(err))),
              "Aborted",
            );
            return;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          rejectOnce(error);
        },
      );
    });

    return {
      result: result.text || "(no output)",
      usage: result.usage,
    };
  } catch (err) {
    if (!done) {
      cleanup();
      if (logStream) {
        const footer = [
          `Aborted: ${new Date().toISOString()}`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        ].join("\n");
        closeLog(footer);
      }
    }
    throw err;
  }
}

/**
 * Parse the JSON Lines event stream from a pi --print child process.
 * Returns a Promise that resolves after process close with accumulated results.
 */
function parseEventStream(
  proc: ChildProcess,
  agentId: string,
  logStream?: WriteStream,
): Promise<ParsedResult> {
  return new Promise<ParsedResult>((resolve, reject) => {
    const usageAcc = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
    let finalText = "";
    let stopReason: string | undefined;
    let errorMessage = "";
    let buffer = "";
    let unparseableCount = 0;
    let settled = false;

    const settle = (result: ParsedResult | null, err?: Error) => {
      if (settled) return;
      settled = true;
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      proc.stdout?.on("error", () => {});
      proc.stderr?.on("error", () => {});
      proc.on("error", () => {});
      if (err) {
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    const buildResult = (): ParsedResult => ({
      text: finalText,
      usage: {
        input: usageAcc.input,
        output: usageAcc.output,
        cacheRead: usageAcc.cacheRead,
        cacheWrite: usageAcc.cacheWrite,
        totalTokens: usageAcc.totalTokens,
      },
      stopReason,
      errorMessage: errorMessage || undefined,
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;

      let event: SubagentEvent;
      try {
        event = JSON.parse(line);
      } catch {
        unparseableCount++;
        if (unparseableCount === 1 || unparseableCount % 100 === 0) {
          console.error(
            `[pi-swarm] Agent ${agentId}: ${unparseableCount} unparseable output line(s)`,
          );
        }
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const msg = event.message;
        if (msg.usage) {
          usageAcc.input += msg.usage.input || 0;
          usageAcc.output += msg.usage.output || 0;
          usageAcc.cacheRead += msg.usage.cacheRead || 0;
          usageAcc.cacheWrite += msg.usage.cacheWrite || 0;
          usageAcc.totalTokens += msg.usage.totalTokens || 0;
        }
        if (msg.stopReason) stopReason = msg.stopReason;
        if (msg.errorMessage) {
          if (errorMessage) errorMessage += "\n";
          errorMessage += msg.errorMessage;
        }

        const content = msg.content;
        let messageText = "";
        if (typeof content === "string" && content) {
          messageText = content;
        } else if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              messageText += block.text;
            }
          }
        }
        if (messageText) {
          if (finalText) finalText += "\n";
          finalText += messageText;
        }
      }
    };

    const processBuffer = () => {
      if (!buffer.trim()) return;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        processLine(line);
      }
    };

    if (proc.stdout) {
      proc.stdout.on("data", (data: Buffer) => {
        if (settled) return;
        const text = data.toString();
        buffer += text;
        if (logStream) logStream.write(text);

        if (buffer.length > MAX_LINE_BUFFER_SIZE) {
          settle(
            null,
            new Error(
              `Subagent output exceeded buffer limit (${MAX_LINE_BUFFER_SIZE / 1024 / 1024}MB)`,
            ),
          );
          if (!proc.killed) {
            proc.kill("SIGTERM");
            setTimeout(() => {
              if (!proc.killed) proc.kill("SIGKILL");
            }, 5000);
          }
          return;
        }

        processBuffer();
      });

      proc.stdout.on("error", (err) => {
        console.error(
          `[pi-swarm] stdout error for agent ${agentId}:`,
          err.message,
        );
        if (!settled) {
          settle(null, new Error(`Subagent stdout error: ${err.message}`));
        }
      });

      proc.stdout.resume();
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data: Buffer) => {
        if (settled) return;
        const text = data.toString();
        if (logStream) {
          logStream.write(`[stderr] ${text}`);
        }
        if (text.trim()) {
          if (errorMessage) errorMessage += "\n";
          errorMessage += text.trim();
        }
      });

      proc.stderr.on("error", (err) => {
        console.error(
          `[pi-swarm] stderr error for agent ${agentId}:`,
          err.message,
        );
      });

      proc.stderr.resume();
    }

    proc.on("close", (code, signal) => {
      if (settled) return;
      processBuffer();

      if (code === 0 && signal === null) {
        settle(buildResult());
      } else {
        const errMsg = signal
          ? `Subagent killed by signal ${signal}`
          : `Subagent exited with code ${code}`;
        const fullMsg = errorMessage ? `${errMsg}: ${errorMessage}` : errMsg;
        settle(null, new Error(fullMsg));
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settle(null, err);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
