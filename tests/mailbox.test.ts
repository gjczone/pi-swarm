/**
 * tests/mailbox.test.ts — unit tests for the team mailbox module.
 *
 * Covers:
 *   #106 — atomic JSONL writes (no partial / corrupted lines)
 *   #108 — transactional send (validate-first, no partial state on failure)
 *   #113 — recipient validation (reject unknown direct recipients)
 *   #115 — broadcast per-recipient errors are surfaced, not swallowed
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveMailboxPaths,
  ensureMailbox,
  sendMessage,
  readInbox,
  readTaskInbox,
  countOutboxMessages,
  resolveTaskMailboxPaths,
  type MailboxPaths,
} from "../src/team/mailbox.js";
import type { MailboxMessage } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(to: string, from = "agent-1"): MailboxMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    runId: "test-run",
    timestamp: new Date().toISOString(),
    from,
    to,
    type: "handoff",
    payload: { text: "hello" },
  };
}

let tmpDir: string;
let paths: MailboxPaths;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-mbx-"));
  paths = resolveMailboxPaths(tmpDir, "test-run");
  ensureMailbox(paths);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #113 — validateRecipient: reject unknown direct recipients
// ---------------------------------------------------------------------------

describe("#113 recipient validation", () => {
  it("throws when sending a direct message to a recipient with no task directory", () => {
    const msg = makeMessage("nonexistent-agent");
    expect(() => sendMessage(paths, msg)).toThrow();
  });

  it("does not create a phantom task directory for an unknown recipient", () => {
    const msg = makeMessage("phantom-agent");
    try {
      sendMessage(paths, msg);
    } catch {
      // expected
    }
    const phantomDir = path.join(paths.taskDir, "phantom-agent");
    expect(fs.existsSync(phantomDir)).toBe(false);
  });

  it("delivers to a known recipient when the task directory exists", () => {
    const taskPaths = resolveTaskMailboxPaths(paths, "agent-1");
    fs.mkdirSync(path.dirname(taskPaths.inbox), { recursive: true });

    const msg = makeMessage("agent-1");
    sendMessage(paths, msg);

    const msgs = readTaskInbox(paths, "agent-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.messageId).toBe(msg.messageId);
  });

  it("still accepts broadcast recipients without pre-existing directories", () => {
    const msg = makeMessage("broadcast");
    expect(() => sendMessage(paths, msg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #108 — transactional send: no partial state on failure
// ---------------------------------------------------------------------------

describe("#108 transactional send", () => {
  it("does not write to team outbox or inbox when a direct recipient is unknown", () => {
    const msg = makeMessage("nonexistent-agent");
    try {
      sendMessage(paths, msg);
    } catch {
      // expected
    }
    expect(countOutboxMessages(paths)).toBe(0);
    expect(readInbox(paths)).toHaveLength(0);
  });

  it("delivers consistently to outbox, inbox, and task inbox for a known recipient", () => {
    const taskPaths = resolveTaskMailboxPaths(paths, "agent-1");
    fs.mkdirSync(path.dirname(taskPaths.inbox), { recursive: true });

    const msg = makeMessage("agent-1");
    sendMessage(paths, msg);

    expect(countOutboxMessages(paths)).toBe(1);
    expect(readInbox(paths)).toHaveLength(1);
    expect(readTaskInbox(paths, "agent-1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #115 — broadcast per-recipient errors surfaced
// ---------------------------------------------------------------------------

describe("#115 broadcast error surfacing", () => {
  it("delivers to all existing task inboxes on broadcast", () => {
    for (const id of ["agent-1", "agent-2"]) {
      const tp = resolveTaskMailboxPaths(paths, id);
      fs.mkdirSync(path.dirname(tp.inbox), { recursive: true });
    }
    const msg = makeMessage("broadcast");
    sendMessage(paths, msg);

    expect(readTaskInbox(paths, "agent-1")).toHaveLength(1);
    expect(readTaskInbox(paths, "agent-2")).toHaveLength(1);
  });

  it("surfaces a per-recipient delivery failure instead of swallowing it", () => {
    // agent-1 is a valid recipient
    const tp1 = resolveTaskMailboxPaths(paths, "agent-1");
    fs.mkdirSync(path.dirname(tp1.inbox), { recursive: true });

    // agent-2: make inbox.jsonl a directory so appendFileSync fails (EISDIR)
    const tp2 = resolveTaskMailboxPaths(paths, "agent-2");
    fs.mkdirSync(path.dirname(tp2.inbox), { recursive: true });
    fs.mkdirSync(tp2.inbox);

    const msg = makeMessage("broadcast");
    expect(() => sendMessage(paths, msg)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// #106 — atomic JSONL writes: every written line is complete and parseable
// ---------------------------------------------------------------------------

describe("#106 atomic JSONL writes", () => {
  it("writes complete lines — every written message is parseable", () => {
    for (let i = 0; i < 50; i += 1) {
      sendMessage(paths, makeMessage("broadcast"));
    }
    const raw = fs.readFileSync(paths.outbox, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("does not leave partial (unterminated) lines after a write", () => {
    sendMessage(paths, makeMessage("broadcast"));
    const raw = fs.readFileSync(paths.outbox, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
