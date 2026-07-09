/**
 * tests/atomic-append.test.ts — unit tests for #134 atomic append.
 *
 * Covers:
 *   #134 — `appendLine` uses O_APPEND + fsync so each line is durable
 *   before the call returns. Eliminates the read-modify-write cost of
 *   the previous `writeAtomic` path for JSONL appends.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { appendLine } from "../src/shared/atomic-append.js";

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-aa-"));
  filePath = path.join(tmpDir, "log.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendLine (#134)", () => {
  it("creates a new file when the path does not exist", () => {
    appendLine(filePath, "hello\n");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello\n");
  });

  it("appends to an existing file without truncating", () => {
    fs.writeFileSync(filePath, "first\n");
    appendLine(filePath, "second\n");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("first\nsecond\n");
  });

  it("survives 100 sequential appends with no torn or missing lines", () => {
    const total = 100;
    for (let i = 0; i < total; i += 1) {
      appendLine(filePath, `${i}\n`);
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(total);
    lines.forEach((line, i) => expect(line).toBe(String(i)));
  });

  it("a fresh file descriptor can read the just-appended bytes", () => {
    // Sanity check: after `appendLine` returns, opening a brand-new
    // read-only FD on the same path returns the appended bytes. This
    // verifies the FD was closed and the OS page cache reflects the
    // write. Note: it does NOT simulate a power loss, so it does not
    // prove fsync durably hit the platter — that requires OS-level
    // crash injection and is out of scope for a unit test.
    appendLine(filePath, "durable\n");
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, 64, 0);
      expect(buf.subarray(0, bytesRead).toString("utf-8")).toBe("durable\n");
    } finally {
      fs.closeSync(fd);
    }
  });
});
