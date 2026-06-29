/**
 * spawner - launch and manage pi subagent child processes.
 *
 * Each subagent runs as an independent `pi --print` child process.
 * The parent parses JSON Lines events from stdout to track progress,
 * collect token usage, and capture the final result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  createWriteStream,
  writeFileSync,
  type WriteStream,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { getPiInvocation, buildSubagentArgs } from "./pi-invoke.js";
import { resolveAgentStateDir } from "../state/persistence.js";
import {
  createWorktree,
  cleanupWorktree,
  isGitRepository,
  type WorktreeInfo,
} from "./worktree.js";
import type {
  SpawnSubagentOptions,
  SubagentHandle,
  SubagentCompletion,
  SubagentUsage,
  RunSubagentOptions,
  MailboxMessage,
} from "./types.js";

const MAX_LINE_BUFFER_SIZE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Mailbox outbox polling helper
// ---------------------------------------------------------------------------

/**
 * Read new mailbox messages from an outbox file starting at the given byte
 * offset. Returns parsed messages and the new offset to use on the next call.
 *
 * Business (#101): Only complete lines (terminated by \n) are consumed.
 * A partial trailing line (mid-write, no \n yet) is held back — the offset
 * only advances to the last \n boundary, so the partial content is re-read
 * on the next poll once the writer completes the line. This prevents
 * messages from being silently swallowed when the file is read mid-write.
 */
export function readNewMailboxLines(
  filePath: string,
  offset: number,
): { messages: MailboxMessage[]; newOffset: number } {
  let raw: string;
  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    // File doesn't exist (yet) — nothing to read
    return { messages: [], newOffset: offset };
  }
  if (fileSize <= offset) {
    return { messages: [], newOffset: offset };
  }
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    // Read error — non-fatal, try again next poll
    return { messages: [], newOffset: offset };
  }

  const newContent = raw.slice(offset);

  // Find the last \n boundary — only consume up to it (#101)
  const lastNewlineIdx = newContent.lastIndexOf("\n");
  if (lastNewlineIdx === -1) {
    // No complete line yet — hold back everything
    return { messages: [], newOffset: offset };
  }

  const completeContent = newContent.slice(0, lastNewlineIdx + 1);
  const newOffset = offset + lastNewlineIdx + 1;

  const messages: MailboxMessage[] = [];
  for (const line of completeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as MailboxMessage;
      if (msg.messageId && msg.to && msg.from) {
        messages.push(msg);
      }
    } catch {
      // Skip malformed lines but still advance past them
    }
  }

  return { messages, newOffset };
}

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
    const agentDir = resolveAgentStateDir(opts.swarmRoot, opts.runId, agentId);
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
    const agentDir = resolveAgentStateDir(opts.swarmRoot, opts.runId, agentId);
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
    content?: string | Array<{ type: string; text?: string }>;
  };
  delta?: {
    type?: string;
    text?: string;
    stopReason?: string;
  };
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
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

interface ProcessKillState {
  exited: boolean;
  sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  scheduleSigkill(): void;
}

async function runSubagentProcess(
  agentId: string,
  opts: SpawnSubagentOptions,
): Promise<SubagentCompletion> {
  const repoCwd = opts.cwd ?? process.cwd();
  let worktree: WorktreeInfo | undefined;
  let cwd = repoCwd;

  // worktree 默认启用：Git 仓库自动创建 worktree 隔离，非 Git 仓库回退到 cwd
  // 仅当显式设置 useWorktree: false 时禁用
  // 传递 mailboxPath 以符号链接 mailbox 到 worktree 中，支持实时消息传递
  if (opts.useWorktree !== false && isGitRepository(repoCwd)) {
    try {
      worktree = createWorktree(repoCwd, agentId, opts.mailboxPath);
      if (worktree) {
        cwd = worktree.path;
      }
    } catch (err) {
      console.error(
        `[pi-swarm] WARNING: Worktree creation failed: ${err instanceof Error ? err.message : String(err)}. Running without isolation.`,
      );
    }
  }

  // Resolve paths for inbox/outbox polling when mailbox is enabled
  const roleName = opts.agentName ?? opts.roleName ?? agentId;
  let pollInboxPath: string | undefined;
  let pollOutboxPath: string | undefined;
  if (opts.mailboxPath) {
    const taskMailboxDir = join(opts.mailboxPath, "tasks", roleName);
    mkdirSync(taskMailboxDir, { recursive: true });
    pollInboxPath = join(taskMailboxDir, "inbox.jsonl");
    pollOutboxPath = join(taskMailboxDir, "outbox.jsonl");
    // Ensure outbox file exists for the agent to write to
    if (!existsSync(pollOutboxPath)) {
      writeFileSync(pollOutboxPath, "", "utf-8");
    }
    // Ensure inbox file exists
    if (!existsSync(pollInboxPath)) {
      writeFileSync(pollInboxPath, "", "utf-8");
    }
  }

  // Set up coordinator message inbox if path provided
  let coordInboxPath: string | undefined;
  if (opts.messageInboxPath) {
    coordInboxPath = opts.messageInboxPath;
    mkdirSync(dirname(coordInboxPath), { recursive: true });
    if (!existsSync(coordInboxPath)) {
      writeFileSync(coordInboxPath, "", "utf-8");
    }
  }

  // Inject mailbox communication instructions into prompt if mailbox is available
  let finalPrompt = opts.prompt;
  if (opts.mailboxPath && pollInboxPath && pollOutboxPath) {
    // Use path relative to cwd when possible for cleaner instructions
    const inboxRel = worktree
      ? join(".pi", "swarm", "mailbox-link", "tasks", roleName, "inbox.jsonl")
      : pollInboxPath;
    const outboxRel = worktree
      ? join(".pi", "swarm", "mailbox-link", "tasks", roleName, "outbox.jsonl")
      : pollOutboxPath;
    const mailboxAddendum = [
      "",
      "---",
      "",
      "## Real-time Mailbox Communication",
      "",
      "You have access to a live mailbox for sending and receiving messages during your work:",
      "",
      `- Your inbox (read for new messages): ${inboxRel}`,
      `- Your outbox (write to send messages): ${outboxRel}`,
      "",
      "How to use:",
      "1. Read your inbox for new messages: use the read tool to check your inbox file periodically.",
      "2. To send a message, append a single JSON line to your outbox file with format:",
      `   {"messageId":"msg-{random}","runId":"${opts.runId ?? ""}","timestamp":"{ISO8601}","from":"${roleName}","to":"{recipient}","type":"handoff","payload":{"content":"your message"}}`,
      `3. Valid recipients: other agent names (e.g. agent-1, agent-2, ...) or "broadcast" to send to all.`,
      "   To discover available agents, list the mailbox tasks directory (parent of your inbox path).",
      "4. Messages you write to your outbox are delivered immediately to the recipient's inbox.",
      "5. You do NOT need to wait for your phase to complete to send messages.",
      "6. Read your inbox: use the read tool or bash cat to read your inbox file.",
      "",
    ].join("\n");
    finalPrompt = finalPrompt + mailboxAddendum;
  }

  // Inject coordinator message inbox instructions if available
  if (coordInboxPath) {
    const inboxRel = relative(cwd, coordInboxPath);
    const coordAddendum = [
      "",
      "---",
      "",
      "## Coordinator Messages",
      "",
      "You can receive messages from the coordinator during your execution.",
      `Check your message inbox periodically: ${inboxRel}`,
      'To read messages, use the read tool on this file. New messages are appended as JSON lines: {"messageId":"...","from":"coordinator","content":"...","timestamp":"..."}',
      "When you receive a message, acknowledge it and adjust your work accordingly.",
      "",
    ].join("\n");
    finalPrompt = finalPrompt + coordAddendum;
  }

  // Auto-detect root AGENTS.md for subagent project rules
  const agentsPath = join(cwd, "AGENTS.md");
  const baseSystemPrompt = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf-8")
    : undefined;

  // Build combined system prompt from base (AGENTS.md) + profile additions
  const systemPromptParts: string[] = [];
  if (baseSystemPrompt) systemPromptParts.push(baseSystemPrompt);
  if (opts.additionalSystemPrompt) {
    systemPromptParts.push(opts.additionalSystemPrompt);
  }

  let effectiveSystemPrompt: string | undefined;
  if (systemPromptParts.length > 0) {
    const tempDir = opts.swarmRoot
      ? join(opts.swarmRoot, "temp")
      : join(process.cwd(), ".pi", "swarm", "temp");
    mkdirSync(tempDir, { recursive: true });
    const tempFile = join(tempDir, `sys-${agentId}.md`);
    writeFileSync(tempFile, systemPromptParts.join("\n\n"), "utf-8");
    effectiveSystemPrompt = tempFile;
  }

  const args = buildSubagentArgs({
    task: finalPrompt,
    model: opts.model,
    tools: opts.tools,
    cwd,
    systemPromptFile: effectiveSystemPrompt,
  });

  const invocation = getPiInvocation(args);

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
    logStream.on("error", (err) => {
      console.error(
        `[pi-swarm] Log stream error for agent ${agentId}:`,
        err.message,
      );
    });
    const worktreeInfo = worktree
      ? `Worktree: ${worktree.path}\nBranch: ${worktree.branch}`
      : "Worktree: disabled";
    const header = [
      "=".repeat(72),
      `Agent: ${agentId}`,
      `Profile: ${opts.profileName}`,
      `Role: ${roleName}`,
      `CWD: ${cwd}`,
      worktreeInfo,
      `Mailbox: ${opts.mailboxPath ?? "disabled"}`,
      `Model: ${opts.model ?? "(inherited)"}`,
      `Tools: ${opts.tools?.join(", ") ?? "(all)"}`,
      `Started: ${new Date().toISOString()}`,
      "-".repeat(72),
      "PROMPT:",
      finalPrompt,
      "-".repeat(72),
      "OUTPUT:",
      "",
    ].join("\n");
    logStream.write(header);
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let mailboxPollHandle: ReturnType<typeof setInterval> | undefined;
  let mailboxReadOffset = 0;
  let streamResolve: ((result: ParsedResult) => void) | undefined;
  let streamReject: ((err: Error) => void) | undefined;
  let settled = false;
  let done = false;
  let abortReason: Error | undefined;

  const killState: ProcessKillState = {
    exited: false,
    sigkillTimer: undefined,
    scheduleSigkill() {
      if (this.sigkillTimer) clearTimeout(this.sigkillTimer);
      this.sigkillTimer = setTimeout(() => {
        this.sigkillTimer = undefined;
        if (!this.exited) proc.kill("SIGKILL");
      }, 5000);
    },
  };

  proc.on("close", () => {
    killState.exited = true;
    if (killState.sigkillTimer) {
      clearTimeout(killState.sigkillTimer);
      killState.sigkillTimer = undefined;
    }
  });

  // Mailbox outbox polling: watch for new messages written by the agent and deliver them
  if (pollOutboxPath && opts.onMessage) {
    // Initialize offset to current file size to only read new content
    try {
      mailboxReadOffset = existsSync(pollOutboxPath)
        ? statSync(pollOutboxPath).size
        : 0;
    } catch {
      mailboxReadOffset = 0;
    }

    mailboxPollHandle = setInterval(() => {
      if (settled || done) return;
      try {
        const { messages, newOffset } = readNewMailboxLines(
          pollOutboxPath,
          mailboxReadOffset,
        );
        mailboxReadOffset = newOffset;
        for (const msg of messages) {
          opts.onMessage?.(msg);
        }
      } catch {
        // Poll errors are non-fatal
      }
    }, 800); // Poll at ~1.25Hz for near-real-time delivery without excessive IO
  }

  const cleanup = () => {
    settled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (mailboxPollHandle) {
      clearInterval(mailboxPollHandle);
      mailboxPollHandle = undefined;
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

  const killProc = (reason?: unknown) => {
    if (settled || done) return;
    settled = true;
    abortReason =
      reason instanceof Error ? reason : new Error("Subagent aborted");
    if (!killState.exited) {
      proc.kill("SIGTERM");
      killState.scheduleSigkill();
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
      if (!killState.exited) {
        proc.kill("SIGTERM");
        killState.scheduleSigkill();
      }
    }, opts.timeout);
  }

  try {
    const result = await new Promise<ParsedResult>((resolve, reject) => {
      streamResolve = resolve;
      streamReject = reject;
      parseEventStream(
        proc,
        agentId,
        logStream,
        killState,
        opts.onUsage,
        opts.onActivity,
      ).then(
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

    let finalResult = result.text || "(no output)";
    let worktreeBranch: string | undefined;
    if (worktree) {
      const cleanupResult = cleanupWorktree(
        repoCwd,
        worktree,
        opts.description,
      );
      if (cleanupResult.hasChanges && cleanupResult.branch) {
        worktreeBranch = cleanupResult.branch;
        finalResult += `\n\n---\nChanges committed to branch \`${cleanupResult.branch}\`.`;
      } else if (cleanupResult.hasChanges && cleanupResult.commitSha) {
        finalResult += `\n\n---\nChanges committed at commit \`${cleanupResult.commitSha}\` but branch creation failed.`;
      } else if (cleanupResult.hasChanges && cleanupResult.error) {
        finalResult += `\n\n---\nChanges detected but commit failed: ${cleanupResult.error}`;
      }
    }

    return {
      result: finalResult,
      usage: result.usage,
      worktreeBranch,
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
    if (worktree) {
      try {
        cleanupWorktree(repoCwd, worktree, opts.description);
      } catch {
        // best effort cleanup on error
      }
    }
    throw err;
  }
}

/**
 * Parse the JSON Lines event stream from a pi --print child process.
 * Returns a Promise that resolves after process close with accumulated results.
 *
 * 业务说明：解析 pi --print 的 JSON Lines 事件流，累积 token 使用量和最终结果。
 * 支持实时通过 onUsage 回调推送使用量更新，让 TUI 能实时显示 token 计数。
 * 同时捕获 content_block_delta 增量文本和工具调用输出，避免结果丢失。
 */
function parseEventStream(
  proc: ChildProcess,
  agentId: string,
  logStream: WriteStream | undefined,
  killState: ProcessKillState,
  onUsage?: (usage: SubagentUsage) => void,
  onActivity?: (tool: string, activity: string) => void,
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
    let lastUsageEmit = 0;
    let lastActivityEmit = 0;
    let lastModelText = "";

    const emitUsage = () => {
      if (!onUsage) return;
      const now = Date.now();
      if (now - lastUsageEmit < 200) return; // Throttle to 5Hz
      lastUsageEmit = now;
      try {
        onUsage({ ...usageAcc });
      } catch {
        // Callback errors must not break parsing
      }
    };

    const emitActivity = (tool: string, activity: string) => {
      if (!onActivity) return;
      const now = Date.now();
      if (now - lastActivityEmit < 150) return; // Throttle to ~6Hz
      lastActivityEmit = now;
      try {
        onActivity(tool, activity);
      } catch {
        // Callback errors must not break parsing
      }
    };

    const settle = (result: ParsedResult | null, err?: Error) => {
      if (settled) return;
      settled = true;
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      proc.stdout?.on("error", () => {});
      proc.stderr?.on("error", () => {});
      proc.on("error", () => {});
      proc.on("close", () => {
        killState.exited = true;
        if (killState.sigkillTimer) {
          clearTimeout(killState.sigkillTimer);
          killState.sigkillTimer = undefined;
        }
      });
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
      const trimmed = line.trim();
      if (!trimmed) return;

      if (!trimmed.startsWith("{")) {
        if (logStream) {
          logStream.write(`[diagnostic] ${line}\n`);
        }
        return;
      }

      let event: SubagentEvent;
      try {
        event = JSON.parse(trimmed);
      } catch {
        unparseableCount++;
        if (logStream) {
          const preview =
            trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
          logStream.write(`[unparseable] ${preview}\n`);
        }
        if (unparseableCount >= 10 && unparseableCount % 10 === 0) {
          console.error(
            `[pi-swarm] Agent ${agentId}: ${unparseableCount} unparseable JSON line(s) logged to output.log`,
          );
        }
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        const msg = event.message;
        if (msg.usage) {
          usageAcc.input += Math.round(msg.usage.input || 0);
          usageAcc.output += Math.round(msg.usage.output || 0);
          usageAcc.cacheRead += Math.round(msg.usage.cacheRead || 0);
          usageAcc.cacheWrite += Math.round(msg.usage.cacheWrite || 0);
          usageAcc.totalTokens += Math.round(
            msg.usage.totalTokens ||
              (msg.usage.input || 0) + (msg.usage.output || 0),
          );
          emitUsage();
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
      } else if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        const deltaText = event.delta.text;
        if (deltaText) {
          finalText += deltaText;
          // Track latest text for scrolling output display
          lastModelText = (lastModelText + deltaText).slice(-200);
          emitActivity("model", lastModelText);
        }
      } else if (event.type === "message_delta") {
        if (event.usage) {
          usageAcc.input += Math.round(event.usage.input || 0);
          usageAcc.output += Math.round(event.usage.output || 0);
          usageAcc.cacheRead += Math.round(event.usage.cacheRead || 0);
          usageAcc.cacheWrite += Math.round(event.usage.cacheWrite || 0);
          usageAcc.totalTokens += Math.round(
            event.usage.totalTokens ||
              (event.usage.input || 0) + (event.usage.output || 0),
          );
          emitUsage();
        }
        if (event.delta?.stopReason) {
          stopReason = event.delta.stopReason;
        }
      } else if (
        event.type === "tool_result" &&
        typeof event.output === "string"
      ) {
        const toolOutput = event.output;
        if (toolOutput && toolOutput.trim()) {
          if (finalText) finalText += "\n";
          finalText += toolOutput;
        }
        // Forward tool activity to TUI
        const toolName = event.toolName ?? "tool";
        const summary = toolOutput.trim().slice(0, 60);
        emitActivity(toolName, summary);
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
          if (!killState.exited) {
            proc.kill("SIGTERM");
            killState.scheduleSigkill();
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
