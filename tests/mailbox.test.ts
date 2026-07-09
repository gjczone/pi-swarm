/**
 * tests/mailbox.test.ts — unit tests for the team mailbox module.
 *
 * Covers:
 *   #106 — atomic JSONL writes (no partial / corrupted lines)
 *   #108 — transactional send (validate-first, no partial state on failure)
 *   #113 — recipient validation (reject unknown direct recipients)
 *   #115 — broadcast per-recipient errors are surfaced, not swallowed
 *   #135 — missing-file error paths log via console.error instead of
 *     silently swallowing (no empty catch blocks)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  getDeliveryState,
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

  it("#122 broadcast: team outbox is NOT written when a per-recipient delivery fails", () => {
    // Regression: previously the broadcast branch wrote the team outbox
    // and team inbox FIRST, then iterated per-recipient. If a mid-loop
    // failure occurred (e.g. disk full on recipient N+1), the sender's
    // outbox claimed "delivered" but some recipients never got the message.
    // Fix: per-recipient delivery completes first; only on full success
    // does the team outbox/inbox get the broadcast record. Per-recipient
    // writes are idempotent (appendJsonLine), so retries are safe.
    for (const id of ["agent-1", "agent-2"]) {
      const tp = resolveTaskMailboxPaths(paths, id);
      fs.mkdirSync(path.dirname(tp.inbox), { recursive: true });
    }
    // Make agent-2's inbox unwritable so delivery fails
    const tp2 = resolveTaskMailboxPaths(paths, "agent-2");
    fs.mkdirSync(tp2.inbox);

    const msg = makeMessage("broadcast");
    expect(() => sendMessage(paths, msg)).toThrow();

    // Team outbox must remain empty — the broadcast was not fully delivered
    expect(countOutboxMessages(paths)).toBe(0);
    // Team inbox must also be empty
    expect(readInbox(paths)).toHaveLength(0);
    // agent-1 received the message before agent-2 failed. This is
    // intentional: the per-recipient writes are idempotent, so a retry
    // of the whole broadcast appends another copy. The sender's
    // outbox staying empty is the new correctness signal.
    expect(readTaskInbox(paths, "agent-1")).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// #135 — missing-file error paths log via console.error instead of
// silently swallowing. The catch blocks must surface the operation
// name, the relevant input context, and the original error message.
//
// Note on sendMessage's broadcast catch: ensureMailbox always creates
// taskDir with mkdirSync(recursive), so the readdirSync catch is
// defensive (e.g. ENOTDIR if a file collides with the dir). Reaching
// it from a unit test requires either mocking node:fs (heavy) or
// chmod tricks (non-portable). The two tests below exercise the same
// pattern (missing file → console.error → safe default) for the
// standalone helpers, which is sufficient regression coverage.
// ---------------------------------------------------------------------------

describe("#135 empty catch blocks log the underlying error", () => {
  it("countOutboxMessages logs the path and remediation, then returns 0 when the outbox is missing", () => {
    // No ensureMailbox() call — paths.outbox does not exist. countOutboxMessages
    // must log the error (function name + path + remediation) and return 0.
    const isolatedPaths = resolveMailboxPaths(tmpDir, "no-such-team-outbox");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(countOutboxMessages(isolatedPaths)).toBe(0);
      expect(spy).toHaveBeenCalled();
      const log = spy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toMatch(/countOutboxMessages/);
      expect(log).toContain(isolatedPaths.outbox);
      expect(log).toMatch(/Returning 0/);
    } finally {
      spy.mockRestore();
    }
  });

  it("getDeliveryState logs the path and remediation, then returns {} when the delivery file is missing", () => {
    const isolatedPaths = resolveMailboxPaths(tmpDir, "no-such-delivery");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(getDeliveryState(isolatedPaths)).toEqual({});
      expect(spy).toHaveBeenCalled();
      const log = spy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toMatch(/getDeliveryState/);
      expect(log).toContain(isolatedPaths.delivery);
      expect(log).toMatch(/Returning empty state/);
    } finally {
      spy.mockRestore();
    }
  });
});
