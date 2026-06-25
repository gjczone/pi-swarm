# Data & State Rules

## State Storage

State is stored under `.pi/swarm/state/`. The extension auto-creates `.pi/` if it doesn't exist.

### Directory Structure

```
.pi/swarm/state/runs/{runId}/
  manifest.json          # Run metadata, agent IDs, timestamps
  tasks.json             # Task graph, per-phase status
  events.jsonl           # Append-only event log
  agents/{agentId}/
    status.json          # Per-agent status snapshot
    output.log           # Full agent session output (header, raw stdout, footer)
  mailbox/               # Team inter-agent messages
    inbox.jsonl
    outbox.jsonl
    delivery.json
```

## Atomic Writes

`state/persistence.ts` exports `writeAtomic` (temp-file + rename) for crash-safe writes. All JSON/JSONL state mutations (mailbox, delivery, manifest) MUST use it to prevent partial writes on crash.

```typescript
// CORRECT: atomic write
import { writeAtomic } from "./persistence.js";
writeAtomic(filePath, JSON.stringify(data));

// WRONG: direct write (can truncate on crash)
import { writeFileSync } from "node:fs";
writeFileSync(filePath, JSON.stringify(data));
```

## Crash Recovery

`state/recovery.ts` detects stale runs (30min no heartbeat) on session start and marks them abandoned.

## Cleanup

- Completed runs are auto-deleted after 7 days
- Stale runs (30min no heartbeat) are marked abandoned on session start

## Per-Agent Output Log

Each sub-agent writes its full session output to `output.log` under the agent state directory. Includes headers, raw stdout, and footers for debugging.

## Mailbox System (Team Mode)

Agents communicate by reading/writing JSONL files in a shared mailbox directory:

- `inbox.jsonl` -- Messages addressed to this agent/team
- `outbox.jsonl` -- Messages sent by this agent/team
- `delivery.json` -- Delivery state tracking

Each message is a JSON object with `message_id`, `from`, `to`, `type`, `payload`. Messages are acknowledged (deleted) after consumption to prevent cross-phase leakage.

## No Database

This project uses pure file-based persistence. There is no database, no ORM, no SQL. All state is JSON or JSONL files on disk.
