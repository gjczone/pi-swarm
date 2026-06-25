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
import { validateId, writeAtomic } from "../state/persistence.js";

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

const SAFE_RECIPIENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

function validateRecipient(recipient: string, field: string): void {
  if (recipient === "broadcast") return;
  if (
    typeof recipient !== "string" ||
    recipient.length === 0 ||
    recipient.length > 128
  ) {
    throw new Error(
      `Invalid ${field}: must be a non-empty string up to 128 characters`,
    );
  }
  if (!SAFE_RECIPIENT_PATTERN.test(recipient)) {
    throw new Error(
      `Invalid ${field}: "${recipient}" contains unsafe characters`,
    );
  }
}

function ensureWithinMailbox(resolvedPath: string, mailboxRoot: string): void {
  const normalizedRoot = path.resolve(mailboxRoot) + path.sep;
  const normalizedPath = path.resolve(resolvedPath);
  if (!normalizedPath.startsWith(normalizedRoot)) {
    throw new Error(
      `Path traversal detected: ${resolvedPath} escapes mailbox root`,
    );
  }
}

// ---------------------------------------------------------------------------
// Directory structure
// ---------------------------------------------------------------------------

/**
 * Resolve mailbox paths for a team run.
 *
 *   {swarmRoot}/state/runs/{runId}/mailbox/
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
  swarmRoot: string,
  runId: string,
): MailboxPaths {
  const root = path.join(swarmRoot, "state", "runs", runId, "mailbox");
  return {
    root,
    inbox: path.join(root, "inbox.jsonl"),
    outbox: path.join(root, "outbox.jsonl"),
    delivery: path.join(root, "delivery.json"),
    taskDir: path.join(root, "tasks"),
  };
}

export function resolveTaskMailboxPaths(
  paths: MailboxPaths,
  taskId: string,
): { inbox: string; outbox: string } {
  validateId(taskId, "taskId");
  const base = path.join(paths.taskDir, taskId);
  ensureWithinMailbox(base, paths.root);
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
  validateRecipient(message.to, "message.to");

  // Append to team outbox
  appendJsonLine(paths.outbox, message);

  // If addressed to a specific agent, also put in their task inbox
  if (message.to && message.to !== "broadcast") {
    const taskPaths = resolveTaskMailboxPaths(paths, message.to);
    fs.mkdirSync(path.dirname(taskPaths.inbox), { recursive: true });
    appendJsonLine(taskPaths.inbox, message);
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
  const taskPaths = resolveTaskMailboxPaths(paths, taskId);
  return readJsonLines(taskPaths.inbox);
}

/**
 * Acknowledge (delete) messages from the team inbox.
 */
export function ackMessages(paths: MailboxPaths, messageIds: string[]): void {
  const messages = readJsonLines(paths.inbox);
  const idSet = new Set(messageIds);
  const remaining = messages.filter((m) => !idSet.has(m.messageId));
  writeJsonLines(paths.inbox, remaining);
}

/**
 * Acknowledge (delete) messages from a task-specific inbox.
 */
export function ackTaskMessages(
  paths: MailboxPaths,
  taskId: string,
  messageIds: string[],
): void {
  const taskPaths = resolveTaskMailboxPaths(paths, taskId);
  const messages = readJsonLines(taskPaths.inbox);
  const idSet = new Set(messageIds);
  const remaining = messages.filter((m) => !idSet.has(m.messageId));
  writeJsonLines(taskPaths.inbox, remaining);
}

/**
 * Get delivery state (which messages have been delivered/read).
 */
export function getDeliveryState(paths: MailboxPaths): Record<string, string> {
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
  writeAtomic(paths.delivery, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendJsonLine(filePath: string, data: unknown): void {
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

function writeJsonLines(filePath: string, messages: MailboxMessage[]): void {
  const content = messages.map((m) => JSON.stringify(m)).join("\n");
  writeAtomic(filePath, content + (content ? "\n" : ""));
}
