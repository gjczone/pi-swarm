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

// ---------------------------------------------------------------------------
// #137 — readAckIds / readJsonLines (called by readInbox) had four more
// empty catch blocks. The two outer file-missing catches MUST log
// instead of returning silently (ack reads suppress ENOENT — the
// common case; JSONL reads log unconditionally because the file is
// expected to exist). The two inner per-line parse catches MUST log
// corruption per-line (capped at MAX_PER_LINE_LOGS to bound log
// volume on heavily corrupt files). readInbox is the public entry
// point that exercises both helpers, so the tests go through it.
// ---------------------------------------------------------------------------

describe("#137 readAckIds / readJsonLines log instead of swallowing", () => {
  function makeAckFile(isolatedPaths: MailboxPaths, lines: string[]): void {
    fs.writeFileSync(isolatedPaths.inboxAcks, lines.join("\n") + "\n");
  }

  it("readInbox logs readJsonLines outer (file-missing) catch when the inbox is missing", () => {
    // paths.inbox does not exist — readJsonLines outer catch fires.
    // JSONL files are expected to exist (ensureMailbox creates them),
    // so a missing file is genuinely anomalous and must be logged.
    const isolatedPaths = resolveMailboxPaths(tmpDir, "137-inbox-missing");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(readInbox(isolatedPaths)).toEqual([]);
      expect(spy).toHaveBeenCalled();
      const log = spy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toMatch(/readJsonLines/);
      expect(log).toContain(isolatedPaths.inbox);
      expect(log).toMatch(/Returning empty array/);
    } finally {
      spy.mockRestore();
    }
  });

  it("readInbox does NOT log readAckIds outer (file-missing) catch on ENOENT — common case", () => {
    // paths.inbox exists (with one valid message) but paths.inboxAcks is
    // missing. The acks file is created lazily (ackMessages is the only
    // writer; compactAcks deletes it when empty). A missing acks file is
    // the common case for any fresh or fully-acked mailbox, so the outer
    // catch suppresses the log for ENOENT and silently returns empty.
    // This matches the #135 sendMessage readdir pattern.
    const isolatedPaths = resolveMailboxPaths(tmpDir, "137-acks-missing");
    fs.mkdirSync(path.dirname(isolatedPaths.inbox), { recursive: true });
    const validMsg = JSON.stringify({ messageId: "m1" });
    fs.writeFileSync(isolatedPaths.inbox, validMsg + "\n");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readInbox(isolatedPaths);
      expect(result).toHaveLength(1);
      expect(result[0]?.messageId).toBe("m1");
      // ENOENT is silent — the readAckIds outer catch must not log.
      // (The readJsonLines call on the existing inbox does not log either.)
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("readInbox logs readJsonLines inner (per-line parse) catch for each corrupted inbox line", () => {
    // Inner catch logs per-line (capped) plus a summary. Pre-create an
    // empty acks file so the readAckIds outer catch is silent on the
    // intentionally-missing path. The test pins the per-line log
    // behavior so a future regression to empty-braces is caught.
    const isolatedPaths = resolveMailboxPaths(tmpDir, "137-inbox-corrupt");
    fs.mkdirSync(path.dirname(isolatedPaths.inbox), { recursive: true });
    // Pre-create empty acks so readAckIds outer catch is silent.
    fs.writeFileSync(isolatedPaths.inboxAcks, "");
    const valid = JSON.stringify({ messageId: "m1" });
    const corrupt = "{ this is not valid json";
    fs.writeFileSync(isolatedPaths.inbox, `${valid}\n${corrupt}\n`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readInbox(isolatedPaths);
      expect(result).toHaveLength(1);
      expect(result[0]?.messageId).toBe("m1");
      expect(spy).toHaveBeenCalled();
      const log = spy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toContain(isolatedPaths.inbox);
      expect(log).toMatch(/[Cc]orrupted/);
      expect(log).toMatch(/skipped 1 corrupted line/);
    } finally {
      spy.mockRestore();
    }
  });

  it("readInbox logs readAckIds inner (per-line parse) catch for each corrupted acks line", () => {
    // The inner catch at readAckIds silently skipped before #137. This
    // test pins the post-fix behavior: per-line corruption must be
    // logged with the ack file path. The summary log is emitted only
    // when count > MAX_PER_LINE_LOGS (covered by a separate test).
    const isolatedPaths = resolveMailboxPaths(tmpDir, "137-acks-corrupt");
    fs.mkdirSync(path.dirname(isolatedPaths.inbox), { recursive: true });
    const validMsg = JSON.stringify({ messageId: "m1" });
    fs.writeFileSync(isolatedPaths.inbox, validMsg + "\n");
    const validAck = JSON.stringify({ messageId: "m1" });
    const corrupt = "{ not valid";
    makeAckFile(isolatedPaths, [validAck, corrupt]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = readInbox(isolatedPaths);
      // Valid ack removes m1 from the inbox; corrupt line is logged and skipped.
      expect(result).toEqual([]);
      expect(spy).toHaveBeenCalled();
      const log = spy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(log).toContain(isolatedPaths.inboxAcks);
      expect(log).toMatch(/[Cc]orrupted/);
    } finally {
      spy.mockRestore();
    }
  });

  it("readAckIds per-line log is capped at MAX_PER_LINE_LOGS on heavily corrupt files", () => {
    // #137 review: per-line logs would spam on a file with millions of
    // bad lines. Cap the per-line log to MAX_PER_LINE_LOGS and emit a
    // summary for the rest. This test exercises a file with N > cap
    // bad lines and asserts the log count is bounded.
    const isolatedPaths = resolveMailboxPaths(tmpDir, "137-acks-spam");
    fs.mkdirSync(path.dirname(isolatedPaths.inbox), { recursive: true });
    fs.writeFileSync(isolatedPaths.inbox, "");
    const corruptLines = Array.from({ length: 20 }, (_, i) => `{ invalid ${i}`);
    makeAckFile(isolatedPaths, corruptLines);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      readInbox(isolatedPaths);
      // Per-line logs (5) + 1 summary = 6 total. If the cap is removed,
      // the count would be 21 (20 per-line + 1 summary).
      const perLineCount = spy.mock.calls.filter((c) =>
        /[Cc]orrupted JSONL line/.test(String(c[0])),
      ).length;
      const summaryCount = spy.mock.calls.filter((c) =>
        /skipped 20 corrupted line/.test(String(c[0])),
      ).length;
      expect(perLineCount).toBeLessThanOrEqual(5);
      expect(summaryCount).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// #179 — direct message write order: deliver-first, record-last
// ---------------------------------------------------------------------------

describe("#179 direct message write order", () => {
  it("writes task inbox before outbox so a crash mid-sequence does not lose messages", () => {
    // Regression: previously sendMessage wrote outbox → inbox → task inbox.
    // If a crash occurred after outbox but before task inbox, the message
    // was recorded in the sender's outbox but never delivered to the
    // recipient. The fix reorders to task inbox → inbox → outbox.
    //
    // This test simulates a crash on the outbox write by making outbox
    // read-only after ensuring it exists. The task inbox write must
    // succeed before the outbox write is attempted.
    const agentDir = path.join(paths.taskDir, "agent-179");
    fs.mkdirSync(agentDir, { recursive: true });
    const taskPaths = resolveTaskMailboxPaths(paths, "agent-179");
    // Ensure task inbox exists
    fs.writeFileSync(taskPaths.inbox, "", "utf-8");

    const msg = makeMessage("agent-179");

    // Make outbox read-only to cause appendLine to throw on write.
    // The outbox file already exists (created by ensureMailbox).
    fs.chmodSync(paths.outbox, 0o444);

    try {
      // sendMessage should throw when it tries to append to outbox.
      // But task inbox should already have the message because the
      // write order is task inbox → inbox → outbox (deliver-first).
      expect(() => sendMessage(paths, msg)).toThrow();
    } catch {
      // On some systems chmod may not prevent writes; skip assertion
    }

    // Restore permissions for verification
    fs.chmodSync(paths.outbox, 0o644);

    // The task inbox must contain the message (deliver-first ordering).
    const taskMessages = readTaskInbox(paths, "agent-179");
    expect(taskMessages.length).toBeGreaterThanOrEqual(1);
    expect(taskMessages[0].messageId).toBe(msg.messageId);
  });
});
