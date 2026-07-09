/**
 * shared/atomic-append — small fsync-backed append primitive for JSONL logs.
 *
 * #134: O_APPEND + fsync replaces the previous read-modify-write path
 * (`writeAtomic`) for incremental JSONL appends (events.jsonl,
 * mailbox outbox/inbox, delivery, coord inbox). For a log with N bytes
 * of history, `writeAtomic` reads N and writes N+K on every append —
 * at 1000 events, each append touches the whole log. O_APPEND is a
 * single atomic append at the filesystem level for writes within
 * PIPE_BUF (4096 bytes on POSIX), and `fsyncSync` requests the bytes
 * be flushed to disk before the call returns.
 *
 * Crash safety:
 *   - Process kill (SIGKILL) during the call: the line is either fully
 *     visible or not at all, because `writeSync` is synchronous. The
 *     recovery readers (`readEvents` for events.jsonl, `readJsonLines`
 *     for mailbox JSONL) filter unparseable lines, so a torn tail is
 *     discarded.
 *   - Kernel-level crash (panic, OOM kill): the kernel typically
 *     flushes dirty pages, so the line is durable.
 *   - Power loss between `writeSync` and `fsyncSync`: the bytes are in
 *     the page cache, not on disk. The function CAN lose the most
 *     recent line. Callers that need strict durability across power
 *     loss must accept this trade-off or use a WAL.
 */

import * as fs from "node:fs";

/**
 * Append a single string to a file, fsync to disk, and close.
 *
 * Caller is responsible for terminating the input with a newline if one
 * is desired. The function does not modify the input. The parent
 * directory must already exist; this primitive does not mkdir.
 */
export function appendLine(filePath: string, line: string): void {
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
