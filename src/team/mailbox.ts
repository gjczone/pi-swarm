/**
 * team/mailbox — JSONL-based mailbox for inter-agent communication.
 *
 * Each team run has a shared mailbox directory under .pi/swarm/mailbox/
 * where agents write messages (outbox) and read messages (inbox).
 *
 * Inspired by pi-crew's mailbox system.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MailboxMessage } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Directory structure
// ---------------------------------------------------------------------------

/**
 * Resolve mailbox paths for a team run.
 *
 *   {crewRoot}/state/runs/{runId}/mailbox/
 *     inbox.jsonl       — team-level inbox
 *     outbox.jsonl      — team-level outbox
 *     delivery.json     — delivery state
 *     tasks/{taskId}/
 *       inbox.jsonl     — per-task inbox
 *       outbox.jsonl    — per-task outbox
 */
export interface MailboxPaths {
  readonly root: string;
  readonly inbox: string;
  readonly outbox: string;
  readonly delivery: string;
  readonly taskDir: string;
}

export function resolveMailboxPaths(
  crewRoot: string,
  runId: string,
): MailboxPaths {
  const root = path.join(
    crewRoot,
    "state",
    "runs",
    runId,
    "mailbox",
  );
  return {
    root,
    inbox: path.join(root, "inbox.jsonl"),
    outbox: path.join(root, "outbox.jsonl"),
    delivery: path.join(root, "delivery.json"),
    taskDir: path.join(root, "tasks"),
  };
}

export function resolveTaskMailboxPaths(
  crewRoot: string,
  runId: string,
  taskId: string,
): { inbox: string; outbox: string } {
  const base = path.join(
    crewRoot,
    "state",
    "runs",
    runId,
    "mailbox",
    "tasks",
    taskId,
  );
  return {
    inbox: path.join(base, "inbox.jsonl"),
    outbox: path.join(base, "outbox.jsonl"),
  };
}

// ---------------------------------------------------------------------------
// Mailbox operations
// ---------------------------------------------------------------------------

/**
 * Ensure the mailbox directory structure exists.
 */
export function ensureMailbox(paths: MailboxPaths): void {
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.taskDir, { recursive: true });
  // Create files if they don't exist
  for (const file of [paths.inbox, paths.outbox, paths.delivery]) {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, "", "utf-8");
    }
  }
}

/**
 * Send a message to the team outbox and the recipient's per-task inbox.
 */
export function sendMessage(
  paths: MailboxPaths,
  message: MailboxMessage,
): void {
  ensureMailbox(paths);

  // Append to team outbox
  appendJsonLine(paths.outbox, message);

  // If addressed to a specific agent, also put in their task inbox
  if (message.to && message.to !== "broadcast") {
    const taskPaths = resolveTaskMailboxPaths(
      paths.root.replace(/\/state\/runs\/[^/]+\/mailbox$/, ""), // extract crewRoot
      extractRunId(paths.root),
      message.to,
    );
    // Actually, we need proper path derivation. Let's use a simpler approach:
    // The task inbox is under the taskDir.
    const taskInbox = path.join(paths.taskDir, message.to, "inbox.jsonl");
    fs.mkdirSync(path.dirname(taskInbox), { recursive: true });
    appendJsonLine(taskInbox, message);
  }
}

/**
 * Read unacknowledged messages from the team inbox.
 */
export function readInbox(paths: MailboxPaths): MailboxMessage[] {
  return readJsonLines(paths.inbox);
}

/**
 * Read messages from a task-specific inbox.
 */
export function readTaskInbox(
  paths: MailboxPaths,
  taskId: string,
): MailboxMessage[] {
  const taskPaths = resolveTaskMailboxPaths(
    extractCrewRoot(paths.root),
    extractRunId(paths.root),
    taskId,
  );
  return readJsonLines(taskPaths.inbox);
}

/**
 * Acknowledge (delete) messages from the team inbox.
 */
export function ackMessages(
  paths: MailboxPaths,
  messageIds: string[],
): void {
  const messages = readJsonLines(paths.inbox);
  const idSet = new Set(messageIds);
  const remaining = messages.filter((m) => !idSet.has(m.messageId));
  writeJsonLines(paths.inbox, remaining);
}

/**
 * Get delivery state (which messages have been delivered/read).
 */
export function getDeliveryState(
  paths: MailboxPaths,
): Record<string, string> {
  try {
    const raw = fs.readFileSync(paths.delivery, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Update delivery state for a message.
 */
export function updateDeliveryState(
  paths: MailboxPaths,
  messageId: string,
  status: string,
): void {
  const state = getDeliveryState(paths);
  state[messageId] = status;
  fs.writeFileSync(
    paths.delivery,
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendJsonLine(
  filePath: string,
  data: unknown,
): void {
  const line = JSON.stringify(data) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

function readJsonLines(filePath: string): MailboxMessage[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return [];
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as MailboxMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is MailboxMessage => m !== null);
  } catch {
    return [];
  }
}

function writeJsonLines(
  filePath: string,
  messages: MailboxMessage[],
): void {
  const content = messages
    .map((m) => JSON.stringify(m))
    .join("\n");
  fs.writeFileSync(filePath, content + (content ? "\n" : ""), "utf-8");
}

function extractRunId(mailboxRoot: string): string {
  // mailboxRoot = .../state/runs/{runId}/mailbox
  const parts = mailboxRoot.split(path.sep);
  const mailboxIdx = parts.lastIndexOf("mailbox");
  if (mailboxIdx >= 2 && parts[mailboxIdx - 2] === "runs") {
    return parts[mailboxIdx - 1]!;
  }
  return "unknown";
}

function extractCrewRoot(mailboxRoot: string): string {
  // mailboxRoot = {crewRoot}/state/runs/{runId}/mailbox
  const parts = mailboxRoot.split(path.sep);
  const stateIdx = parts.lastIndexOf("state");
  if (stateIdx >= 0) {
    return parts.slice(0, stateIdx).join(path.sep);
  }
  return mailboxRoot;
}
