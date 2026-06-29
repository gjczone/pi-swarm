/**
 * team/mailbox — JSONL-based mailbox for inter-agent communication.
 *
 * Each team run has a shared mailbox directory under .pi/swarm/mailbox/
 * where agents write messages (outbox) and read messages (inbox).
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
  readonly inboxAcks: string;
}

export function resolveMailboxPaths(
  swarmRoot: string,
  runId: string,
): MailboxPaths {
  const root = path.join(swarmRoot, "state", "runs", runId, "mailbox");
  const inbox = path.join(root, "inbox.jsonl");
  return {
    root,
    inbox,
    outbox: path.join(root, "outbox.jsonl"),
    delivery: path.join(root, "delivery.json"),
    taskDir: path.join(root, "tasks"),
    inboxAcks: inbox + ".acks",
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
 * For broadcast messages, also deliver to all known role inboxes.
 */
export function sendMessage(
  paths: MailboxPaths,
  message: MailboxMessage,
): void {
  ensureMailbox(paths);
  validateRecipient(message.to, "message.to");

  // Append to team outbox
  appendJsonLine(paths.outbox, message);
  // Also append to team inbox for general reading
  appendJsonLine(paths.inbox, message);

  if (message.to === "broadcast") {
    // Broadcast: deliver to all known task inboxes under the tasks directory.
    // Discovers recipients dynamically so it works for both team mode
    // (explorer, planner, ...) and swarm mode (agent-1, agent-2, ...).
    try {
      const entries = fs.readdirSync(paths.taskDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        if (!SAFE_RECIPIENT_PATTERN.test(taskId)) continue;
        try {
          const taskPaths = resolveTaskMailboxPaths(paths, taskId);
          fs.mkdirSync(path.dirname(taskPaths.inbox), { recursive: true });
          appendJsonLine(taskPaths.inbox, message);
        } catch {
          // Best effort delivery per task
        }
      }
    } catch {
      // tasks directory might not exist yet — best effort
    }
  } else {
    // Direct message: deliver to specific role inbox
    const taskPaths = resolveTaskMailboxPaths(paths, message.to);
    fs.mkdirSync(path.dirname(taskPaths.inbox), { recursive: true });
    appendJsonLine(taskPaths.inbox, message);
  }
}

/**
 * Read unacknowledged messages from the team inbox.
 */
export function readInbox(paths: MailboxPaths): MailboxMessage[] {
  const messages = readJsonLines(paths.inbox);
  const ackedIds = readAckIds(paths.inboxAcks);
  if (ackedIds.size === 0) return messages;
  return messages.filter((m) => !ackedIds.has(m.messageId));
}

function taskAckPath(taskInbox: string): string {
  return taskInbox + ".acks";
}

/**
 * Read messages from a task-specific inbox.
 */
export function readTaskInbox(
  paths: MailboxPaths,
  taskId: string,
): MailboxMessage[] {
  const taskPaths = resolveTaskMailboxPaths(paths, taskId);
  const messages = readJsonLines(taskPaths.inbox);
  const ackedIds = readAckIds(taskAckPath(taskPaths.inbox));
  if (ackedIds.size === 0) return messages;
  return messages.filter((m) => !ackedIds.has(m.messageId));
}

/**
 * Count total messages in the team outbox.
 */
export function countOutboxMessages(paths: MailboxPaths): number {
  try {
    const raw = fs.readFileSync(paths.outbox, "utf-8");
    if (!raw.trim()) return 0;
    return raw
      .trim()
      .split("\n")
      .filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Acknowledge (delete) messages from the team inbox.
 *
 * Uses an append-only ack file to avoid the TOCTOU race between
 * reading and rewriting inbox.jsonl. Acknowledged message IDs are
 * appended to inboxAcks.jsonl and filtered at read time.
 */
export function ackMessages(paths: MailboxPaths, messageIds: string[]): void {
  for (const id of messageIds) {
    appendJsonLine(paths.inboxAcks, { messageId: id });
  }
  compactAcks(paths.inboxAcks);
}

/**
 * Acknowledge (delete) messages from a task-specific inbox.
 *
 * Uses the same append-only ack approach as ackMessages.
 */
export function ackTaskMessages(
  paths: MailboxPaths,
  taskId: string,
  messageIds: string[],
): void {
  const taskPaths = resolveTaskMailboxPaths(paths, taskId);
  const ackPath = taskAckPath(taskPaths.inbox);
  for (const id of messageIds) {
    appendJsonLine(ackPath, { messageId: id });
  }
  compactAcks(ackPath);
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

/**
 * Read acknowledged message IDs from an ack file (JSONL with {messageId: string} entries).
 */
function readAckIds(ackPath: string): Set<string> {
  try {
    const raw = fs.readFileSync(ackPath, "utf-8");
    if (!raw.trim()) return new Set();
    const ids = new Set<string>();
    for (const line of raw.trim().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { messageId?: string };
        if (parsed.messageId) ids.add(parsed.messageId);
      } catch {
        // Skip corrupted ack lines
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Compact an ack file if the number of lines exceeds 10x the unique ID count
 * (indicating significant duplication from repeated acknowledgment cycles).
 */
function compactAcks(ackPath: string): void {
  try {
    const raw = fs.readFileSync(ackPath, "utf-8");
    if (!raw.trim()) return;
    const lines = raw
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    if (lines.length < 100) return; // Don't compact small files
    const uniqueIds = readAckIds(ackPath);
    if (uniqueIds.size === 0) return;
    // Compact if ratio exceeds 10x
    if (lines.length > uniqueIds.size * 10) {
      const content = Array.from(uniqueIds)
        .map((id) => JSON.stringify({ messageId: id }))
        .join("\n");
      writeAtomic(ackPath, content + "\n");
    }
  } catch {
    // Best effort compaction
  }
}

function readJsonLines(filePath: string): MailboxMessage[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return [];
    const lines = raw
      .trim()
      .split("\n")
      .filter((line) => line.trim());
    let corruptedCount = 0;
    const messages = lines
      .map((line) => {
        try {
          return JSON.parse(line) as MailboxMessage;
        } catch {
          corruptedCount++;
          console.error(
            `[pi-swarm] Corrupted JSONL line in ${filePath}:`,
            line.slice(0, 200),
          );
          return null;
        }
      })
      .filter((m): m is MailboxMessage => m !== null);
    if (corruptedCount > 0) {
      console.error(
        `[pi-swarm] Skipped ${corruptedCount} corrupted line(s) in ${filePath}`,
      );
    }
    return messages;
  } catch {
    return [];
  }
}
