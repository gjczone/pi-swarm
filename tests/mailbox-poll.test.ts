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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewMailboxLines } from "../src/shared/spawner.js";

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
});
