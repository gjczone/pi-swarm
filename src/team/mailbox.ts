/**
 * team/mailbox — JSONL-based mailbox for inter-agent communication.
 *
 * Each team run has a shared mailbox directory under .pi/swarm/mailbox/
 * where agents write messages (outbox) and read messages (inbox).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MailboxMessage } from "../shared/types.js";
import { validateId } from "../state/persistence.js";
import { appendLine } from "../shared/atomic-append.js";

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

const SAFE_RECIPIENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * #137: per-line log cap for corrupted JSONL entries. A file with many
 * bad lines must not produce N log entries on every read (the inbox
 * poller runs at ~1.25 Hz, so a million-line file would emit 1.25M
 * lines per second). The first MAX_PER_LINE_LOGS occurrences are
 * logged with full context; the remaining count is summarized.
 */
const MAX_PER_LINE_LOGS = 5;

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
 *
 * Transactional guarantees (#108, #113):
 *   - For direct messages, the recipient's task directory must already exist.
 *     If it does not, sendMessage throws BEFORE writing to outbox or inbox,
 *     leaving no partial state behind.
 *   - No phantom task directories are created for unknown recipients.
 *
 * Broadcast error surfacing (#115):
 *   - Per-recipient delivery failures during broadcast are surfaced to the
 *     caller instead of being silently swallowed. If any recipient's inbox
 *     cannot be written, sendMessage throws so the caller can retry or report.
 */
export function sendMessage(
  paths: MailboxPaths,
  message: MailboxMessage,
): void {
  ensureMailbox(paths);
  validateRecipient(message.to, "message.to");

  if (message.to === "broadcast") {
    // Broadcast: deliver to all known task inboxes under the tasks directory.
    // Discovers recipients dynamically so it works for both team mode
    // (explorer, planner, ...) and swarm mode (agent-1, agent-2, ...).
    // Per-recipient errors are surfaced, not swallowed (#115).
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(paths.taskDir, { withFileTypes: true });
    } catch (err) {
      // #135: ensureMailbox already created taskDir, so this catch is
      // defensive — it covers ENOENT (race / external rm) and I/O faults
      // like EACCES/ENOTDIR. Log the operation, the dir, the error, and
      // the chosen remediation (treat as "no recipients" — the same
      // semantic the previous empty catch had). A real I/O fault during
      // broadcast is a degraded-but-non-fatal condition; we still record
      // it so the operator can investigate.
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const isMissing = code === "ENOENT";
      const context = isMissing
        ? "no tasks dir (treating as zero recipients)"
        : `tasks dir unreadable (treating as zero recipients): ${code || "I/O error"}`;
      console.error(
        `[pi-swarm] sendMessage: failed to readdir ${paths.taskDir}: ${(err as Error).message}. ${context}.`,
      );
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      if (!SAFE_RECIPIENT_PATTERN.test(taskId)) continue;
      const taskPaths = resolveTaskMailboxPaths(paths, taskId);
      fs.mkdirSync(path.dirname(taskPaths.inbox), { recursive: true });
      appendJsonLine(taskPaths.inbox, message);
    }

    // #122: All per-recipient deliveries succeeded. Now record the broadcast
    // in the team outbox + team inbox so the sender's view is consistent
    // with what was actually delivered. If any per-recipient append had
    // thrown, we never reach this point and the sender's outbox stays
    // empty (the caller retries the whole broadcast).
    appendJsonLine(paths.inbox, message);
    appendJsonLine(paths.outbox, message);
  } else {
    // Direct message: validate recipient exists BEFORE writing anything (#108, #113).
    // This ensures no partial state (outbox/inbox writes) is left behind on failure.
    const recipientDir = path.join(paths.taskDir, message.to);
    if (!fs.existsSync(recipientDir)) {
      throw new Error(
        `Unknown recipient: "${message.to}" has no task directory`,
      );
    }
    const taskPaths = resolveTaskMailboxPaths(paths, message.to);
    // Deliver to recipient first, then record in sender's outbox last.
    // This mirrors broadcast ordering (above): if a crash occurs
    // mid-sequence, the sender's outbox stays empty and the caller
    // retries. Previously wrote outbox first, which meant a crash after
    // outbox but before task inbox left the message recorded but
    // undelivered. (#179)
    appendJsonLine(taskPaths.inbox, message);
    appendJsonLine(paths.inbox, message);
    appendJsonLine(paths.outbox, message);
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

/**
 * Read messages from a task-specific inbox.
 */
export function readTaskInbox(
  paths: MailboxPaths,
  taskId: string,
): MailboxMessage[] {
  const taskPaths = resolveTaskMailboxPaths(paths, taskId);
  const messages = readJsonLines(taskPaths.inbox);
  const ackedIds = readAckIds(taskPaths.inbox + ".acks");
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
  } catch (err) {
    // #135: missing outbox is the common case (first run, fresh mailbox),
    // but a corrupt or unreadable file is a real fault. Log the path and
    // the error so the operator can tell which.
    console.error(
      `[pi-swarm] countOutboxMessages: failed to read outbox ${paths.outbox}: ${(err as Error).message}. Returning 0.`,
    );
    return 0;
  }
}

/**
 * Get delivery state (which messages have been delivered/read).
 */
export function getDeliveryState(paths: MailboxPaths): Record<string, string> {
  try {
    const raw = fs.readFileSync(paths.delivery, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    // #135: this catch covers BOTH readFileSync (missing/unreadable) and
    // JSON.parse (corrupt content) failures. Log both possibilities under
    // a single "read or parse" message so the operator knows what failed.
    console.error(
      `[pi-swarm] getDeliveryState: failed to read or parse delivery ${paths.delivery}: ${(err as Error).message}. Returning empty state.`,
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Append a JSON line to a JSONL file.
 *
 * #106 + #134: O_APPEND + fsync via `appendLine` replaces the previous
 * read-modify-write path. Each line is durable on disk before the call
 * returns, so a SIGKILL mid-write cannot lose the message. The O_APPEND
 * primitive is atomic at the filesystem level for small writes, which
 * is what mailbox messages are.
 */
function appendJsonLine(filePath: string, data: unknown): void {
  appendLine(filePath, JSON.stringify(data) + "\n");
}

/**
 * Read acknowledged message IDs from an ack file (JSONL with {messageId: string} entries).
 */
function readAckIds(ackPath: string): Set<string> {
  try {
    const raw = fs.readFileSync(ackPath, "utf-8");
    if (!raw.trim()) return new Set();
    const ids = new Set<string>();
    let corruptedCount = 0;
    for (const line of raw.trim().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { messageId?: string };
        if (parsed.messageId) ids.add(parsed.messageId);
      } catch (err) {
        // #137: count corruption and log per-line only for the first
        // few occurrences to bound log volume on heavily corrupt files.
        // The summary log after the loop records the total.
        corruptedCount += 1;
        if (corruptedCount <= MAX_PER_LINE_LOGS) {
          console.error(
            `[pi-swarm] readAckIds: corrupted JSONL line in ${ackPath}: ${(err as Error).message}. Line: ${trimmed.slice(0, 200)}.`,
          );
        }
      }
    }
    if (corruptedCount > MAX_PER_LINE_LOGS) {
      console.error(
        `[pi-swarm] readAckIds: skipped ${corruptedCount} corrupted line(s) in ${ackPath} (logged first ${MAX_PER_LINE_LOGS})`,
      );
    }
    return ids;
  } catch (err) {
    // #137: missing acks file is the common case (no messages ever
    // acked, or compacted down to empty by compactAcks). Suppress the
    // log for ENOENT to match the #135 sendMessage pattern; only treat
    // other errors (EACCES, EIO, etc.) as a real fault.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code !== "ENOENT") {
      console.error(
        `[pi-swarm] readAckIds: failed to read acks file ${ackPath}: ${(err as Error).message}. Returning empty set.`,
      );
    }
    return new Set();
  }
}

/**
 * Compact an ack file if the number of lines exceeds 10x the unique ID count
 * (indicating significant duplication from repeated acknowledgment cycles).
 *
 * #148: dead since #135/#137 removed `ackMessages` and `ackTaskMessages`
 * (its only callers). Kept for now in case a future ack-aware tool wants
 * the same logic; remove in a follow-up if no caller appears.
 */
// function compactAcks(ackPath: string): void {
//   try {
//     const raw = fs.readFileSync(ackPath, "utf-8");
//     if (!raw.trim()) return;
//     const lines = raw
//       .trim()
//       .split("\n")
//       .filter((l) => l.trim());
//     if (lines.length < 100) return; // Don't compact small files
//     const uniqueIds = readAckIds(ackPath);
//     if (uniqueIds.size === 0) return;
//     // Compact if ratio exceeds 10x
//     if (lines.length > uniqueIds.size * 10) {
//       const content = Array.from(uniqueIds)
//         .map((id) => JSON.stringify({ messageId: id }))
//         .join("\n");
//       writeAtomic(ackPath, content + "\n");
//     }
//   } catch (err) {
//     // Compaction failure is non-fatal but visible (#130)
//     console.error(
//       `[pi-swarm] compactAcks: failed to compact ${ackPath}: ${(err as Error).message}`,
//     );
//   }
// }

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
        } catch (err) {
          corruptedCount += 1;
          // #137: per-line log only for the first MAX_PER_LINE_LOGS
          // occurrences to bound log volume; the summary below records
          // the total. The full parse error is included for diagnosis.
          if (corruptedCount <= MAX_PER_LINE_LOGS) {
            console.error(
              `[pi-swarm] readJsonLines: corrupted JSONL line in ${filePath}: ${(err as Error).message}. Line: ${line.slice(0, 200)}.`,
            );
          }
          return null;
        }
      })
      .filter((m): m is MailboxMessage => m !== null);
    if (corruptedCount > 0) {
      console.error(
        `[pi-swarm] readJsonLines: skipped ${corruptedCount} corrupted line(s) in ${filePath}${corruptedCount > MAX_PER_LINE_LOGS ? ` (logged first ${MAX_PER_LINE_LOGS})` : ""}`,
      );
    }
    return messages;
  } catch (err) {
    // #137: missing or unreadable JSONL file. Missing is the common
    // case (no messages ever written) but a real I/O fault must be
    // visible. Log unconditionally here because JSONL files (inbox,
    // outbox) ARE created by ensureMailbox, so a missing file is
    // genuinely anomalous — unlike the ack file (#137 outer catch).
    console.error(
      `[pi-swarm] readJsonLines: failed to read JSONL file ${filePath}: ${(err as Error).message}. Returning empty array.`,
    );
    return [];
  }
}
