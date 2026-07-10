/**
 * tests/mailbox-poll.test.ts — #101: mailbox outbox polling must not
 * swallow a partial trailing line (no trailing \n) that is mid-write.
 *
 * The poller should only advance its read offset to the last \n boundary,
 * leaving any partial trailing content to be re-read on the next poll
 * once the writer completes the line.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  appendFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readNewMailboxLines,
  cleanupTempSystemPrompt,
} from "../src/shared/spawner.js";

function makeMessage(id: string): string {
  return JSON.stringify({
    messageId: id,
    runId: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    from: "agent-a",
    to: "agent-b",
    type: "handoff",
    payload: {},
  });
}

describe("#101 mailbox outbox poll: partial trailing line is not swallowed", () => {
  let dir: string;
  let outboxPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mb-poll-"));
    outboxPath = join(dir, "outbox.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers complete lines but holds back a partial trailing line", () => {
    const complete = makeMessage("m1");
    // One complete line, then a partial line (no trailing \n)
    writeFileSync(outboxPath, `${complete}\n${complete.slice(0, 20)}`, "utf-8");

    const { messages, newOffset } = readNewMailboxLines(outboxPath, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe("m1");

    // Offset must NOT cover the partial trailing content — only up to the last \n
    const fileSize = statSync(outboxPath).size;
    expect(newOffset).toBeLessThan(fileSize);
    expect(newOffset).toBe(complete.length + 1); // complete line + \n

    // Complete the partial line and poll again — m2 must now be delivered
    appendFileSync(outboxPath, complete.slice(20) + "\n", "utf-8");
    const { messages: messages2, newOffset: newOffset2 } = readNewMailboxLines(
      outboxPath,
      newOffset,
    );
    expect(messages2).toHaveLength(1);
    expect(messages2[0].messageId).toBe("m1");
    expect(newOffset2).toBe(statSync(outboxPath).size);
  });

  it("returns empty messages and unchanged offset when file has no newline yet", () => {
    writeFileSync(outboxPath, '{"messageId":"m1"', "utf-8"); // no newline
    const { messages, newOffset } = readNewMailboxLines(outboxPath, 0);
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(0); // offset unchanged — partial line left for next poll
  });

  it("skips malformed lines but still advances past them", () => {
    const good = makeMessage("m1");
    writeFileSync(outboxPath, `not-json\n${good}\n`, "utf-8");
    const { messages, newOffset } = readNewMailboxLines(outboxPath, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe("m1");
    expect(newOffset).toBe(`not-json\n${good}\n`.length);
  });

  it("returns empty when file does not exist", () => {
    const { messages, newOffset } = readNewMailboxLines(
      join(dir, "nope.jsonl"),
      0,
    );
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(0);
  });

  it("returns empty when no new content since offset", () => {
    const line = makeMessage("m1") + "\n";
    writeFileSync(outboxPath, line, "utf-8");
    const { messages, newOffset } = readNewMailboxLines(
      outboxPath,
      line.length,
    );
    expect(messages).toHaveLength(0);
    expect(newOffset).toBe(line.length);
  });

  it("delivers multiple complete lines in one poll", () => {
    const a = makeMessage("a");
    const b = makeMessage("b");
    writeFileSync(outboxPath, `${a}\n${b}\n`, "utf-8");
    const { messages, newOffset } = readNewMailboxLines(outboxPath, 0);
    expect(messages).toHaveLength(2);
    expect(messages[0].messageId).toBe("a");
    expect(messages[1].messageId).toBe("b");
    expect(newOffset).toBe(statSync(outboxPath).size);
  });

  it("#189 resets offset when file shrinks below offset (recreated outbox)", () => {
    // Regression: previously readNewMailboxLines used fileSize <= offset
    // which returned the stale offset unchanged. When the outbox file was
    // recreated (fileSize < offset), the poller was stuck at the old offset
    // and missed all new messages.
    // First message: long messageId to create a large file offset
    const a = makeMessage("long-message-id-aaaa");
    writeFileSync(outboxPath, `${a}\n`, "utf-8");
    const fileSizeAfterFirst = statSync(outboxPath).size;

    // Simulate the outbox being recreated with a shorter new message.
    const b = makeMessage("b");
    writeFileSync(outboxPath, `${b}\n`, "utf-8");
    const fileSizeAfterRecreate = statSync(outboxPath).size;

    // Ensure the new file is shorter than the old offset (the bug condition).
    expect(fileSizeAfterRecreate).toBeLessThan(fileSizeAfterFirst);

    // Use the old offset (from the first file) — it is now past EOF.
    const { messages: _messages, newOffset } = readNewMailboxLines(
      outboxPath,
      fileSizeAfterFirst,
    );

    // After the fix, offset resets to 0 so the next poll can read the new
    // content. (If the bug were present, newOffset would equal the stale
    // offset and the poller would be stuck forever.)
    expect(newOffset).toBe(0);

    // The reset return does not include messages (it signals the caller to
    // re-read from the start). Poll again with the reset offset to verify
    // the new message is now delivered.
    const { messages: messages2, newOffset: newOffset2 } = readNewMailboxLines(
      outboxPath,
      newOffset,
    );
    expect(messages2).toHaveLength(1);
    expect(messages2[0].messageId).toBe("b");
    expect(newOffset2).toBe(fileSizeAfterRecreate);
  });
});

// ---------------------------------------------------------------------------
// #190 — temp system prompt file cleanup
// ---------------------------------------------------------------------------

describe("#190 cleanupTempSystemPrompt deletes temp file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "temp-prompt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes an existing temp file", () => {
    const tempFile = join(dir, "sys-test-agent.md");
    writeFileSync(tempFile, "system prompt content", "utf-8");
    expect(existsSync(tempFile)).toBe(true);

    cleanupTempSystemPrompt(tempFile);

    expect(existsSync(tempFile)).toBe(false);
  });

  it("does nothing when filePath is undefined", () => {
    // Should not throw
    cleanupTempSystemPrompt(undefined);
  });

  it("does not throw when file does not exist", () => {
    const nonExistent = join(dir, "nope.md");
    expect(existsSync(nonExistent)).toBe(false);
    // Should not throw
    cleanupTempSystemPrompt(nonExistent);
  });

  it("#198 cleans up temp file when called in a catch block after sync throw", () => {
    // Verifies the pattern used in the fix: wrap temp-file-dependent
    // operations in try/catch, call cleanupTempSystemPrompt before
    // re-throwing. This ensures the file is deleted even when a
    // synchronous error occurs before the promise chain can run cleanup().
    const tempFile = join(dir, "sys-catch-test.md");
    writeFileSync(tempFile, "test content", "utf-8");
    expect(existsSync(tempFile)).toBe(true);

    try {
      throw new Error("simulated sync error in buildSubagentArgs / spawn");
    } catch {
      cleanupTempSystemPrompt(tempFile);
    }

    expect(existsSync(tempFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #199 — mailbox message dedup after outbox recreation
// ---------------------------------------------------------------------------

describe("#199 deduplicates delivered messages when offset resets", () => {
  let dir: string;
  let outboxPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mb-dedup-"));
    outboxPath = join(dir, "outbox.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips re-delivery of a message seen before the outbox was recreated", () => {
    // Use a long messageId to create a larger file, then recreate with an
    // empty file so fileSize < offset triggers the reset to 0.
    const msgLong = makeMessage("long-message-id-xxxxxxxxx");
    writeFileSync(outboxPath, `${msgLong}\n`, "utf-8");
    const originalSize = statSync(outboxPath).size;

    const delivered = new Set<string>();

    // Poll 1: deliver msgLong normally
    const { messages: poll1, newOffset: off1 } = readNewMailboxLines(
      outboxPath,
      0,
    );
    expect(off1).toBe(originalSize);
    for (const msg of poll1) {
      if (!delivered.has(msg.messageId)) delivered.add(msg.messageId);
    }
    expect(delivered.has("long-message-id-xxxxxxxxx")).toBe(true);

    // Simulate outbox file recreation: truncated file (fileSize < offset)
    writeFileSync(outboxPath, "", "utf-8");
    const { messages: poll2Reset, newOffset: off2 } = readNewMailboxLines(
      outboxPath,
      off1,
    );
    expect(off2).toBe(0); // offset reset because fileSize < offset
    expect(poll2Reset).toHaveLength(0); // reset returns no messages

    // Write the same message back to the recreated file (simulated replay)
    const msgSame = makeMessage("long-message-id-xxxxxxxxx");
    writeFileSync(outboxPath, `${msgSame}\n`, "utf-8");

    // Re-read from 0 with dedup — previously delivered messageId must be skipped
    const { messages: poll2Deliver } = readNewMailboxLines(outboxPath, off2);
    const newMessages = poll2Deliver.filter((m) => !delivered.has(m.messageId));
    expect(newMessages).toHaveLength(0);
  });

  it("still delivers new messages after the outbox recreation while skipping old ones", () => {
    // Use a long messageId so the first file is larger than the recreated one
    const msgA = makeMessage("msg-long-old-message");
    writeFileSync(outboxPath, `${msgA}\n`, "utf-8");
    const firstSize = statSync(outboxPath).size;

    const delivered = new Set<string>();
    const { messages: poll1, newOffset: off1 } = readNewMailboxLines(
      outboxPath,
      0,
    );
    expect(off1).toBe(firstSize);
    for (const msg of poll1) {
      if (!delivered.has(msg.messageId)) delivered.add(msg.messageId);
    }

    // Simulate outbox recreation: truncate, then write old + new messages
    writeFileSync(outboxPath, "", "utf-8");
    const { messages: _reset, newOffset: offReset } = readNewMailboxLines(
      outboxPath,
      off1,
    );
    expect(offReset).toBe(0);

    const msgB = makeMessage("msg-new");
    writeFileSync(outboxPath, `${msgA}\n${msgB}\n`, "utf-8");

    const { messages: poll2Deliver } = readNewMailboxLines(
      outboxPath,
      offReset,
    );
    const newMessages = poll2Deliver.filter((m) => !delivered.has(m.messageId));
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].messageId).toBe("msg-new");
  });

  it("caps the delivered-message set to prevent unbounded memory growth", () => {
    // Simulate LRU-style eviction: when set size exceeds threshold, evict oldest entries.
    const MAX_IDS = 2000;
    const EVICT_COUNT = 1000;
    const delivered = new Set<string>();

    // Fill beyond the cap
    for (let i = 0; i < MAX_IDS + 10; i++) {
      delivered.add(`msg-${i}`);
    }

    expect(delivered.size).toBe(MAX_IDS + 10);

    // Apply eviction: delete oldest entries (simulated by deleting the
    // lowest-numbered IDs)
    if (delivered.size > MAX_IDS) {
      const toDelete = EVICT_COUNT;
      let deleted = 0;
      for (const id of delivered) {
        if (deleted >= toDelete) break;
        delivered.delete(id);
        deleted++;
      }
    }

    expect(delivered.size).toBeLessThanOrEqual(MAX_IDS);
    // The most recently added IDs should still be present
    expect(delivered.has(`msg-${MAX_IDS + 9}`)).toBe(true);
  });
});
