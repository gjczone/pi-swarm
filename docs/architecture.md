# pi-swarm Architecture

---

## 1. Design Philosophy

pi-swarm is a **subagent orchestration system** with two operational modes:

| Mode      | Pattern                               | Trigger                                   | Communication      |
| --------- | ------------------------------------- | ----------------------------------------- | ------------------ |
| **Swarm** | Parallel, item-template, homogeneous  | `AgentSwarm` tool or `/swarm` command     | None (independent) |
| **Team**  | Sequential, role-based, heterogeneous | `SwarmTeam` tool or `/swarm-team` command | JSONL mailbox      |

The design follows these principles:

1. **Process isolation over in-process reuse.** Each subagent runs as an independent `pi --print` child process. A crash in one agent never affects the parent or sibling agents. This is the same model used by pi's built-in subagent example and pi-crew.

2. **File-based state over in-memory only.** Every run has a manifest, task graph, and event log persisted to disk under `.pi/swarm/`. On session restart, incomplete runs are detected and can be resumed.

3. **Two-phase concurrency.** The SubagentBatch controller operates in two phases: a normal ramp-up phase and a rate-limit-sensitive phase. This is ported directly from kimi-code's SubagentBatch.

4. **Mailbox as the team primitive.** In team mode, agents do not call each other directly. They write JSON messages to a shared mailbox directory. The supervisor reads the mailbox and advances the task graph.

5. **Zero runtime dependencies.** The only external packages are `typebox` (schema validation) and `@earendil-works/pi-tui` (rendering). All orchestration, state management, and process control are custom-built.

6. **100% English.** All code, comments, JSDoc, commit messages, and documentation are written in English.

---

## 2. Layer Architecture

```
src/
├── index.ts              # Entry point: registers tools, commands, lifecycle hooks
├── shared/               # Shared infrastructure (no pi or tui imports)
│   ├── types.ts          # Pure data type definitions
│   ├── pi-invoke.ts      # pi CLI invocation resolution
│   ├── spawner.ts        # Child process management (spawn, event parsing)
│   ├── controller.ts     # SubagentBatch concurrency controller
│   └── render.ts         # XML output formatter
├── swarm/                # Swarm mode (imports from shared/)
│   ├── tool.ts           # AgentSwarm tool (pi.registerTool)
│   ├── command.ts        # /swarm slash command
│   └── mode.ts           # SwarmMode lifecycle state machine
├── team/                 # Team mode (imports from shared/)
│   ├── tool.ts           # SwarmTeam tool (pi.registerTool)
│   ├── command.ts        # /swarm-team slash command
│   ├── mailbox.ts        # JSONL inbox/outbox/delivery
│   ├── task-graph.ts     # Directed acyclic phase graph with dependencies
│   └── supervisor.ts     # Team supervisor: decomposition, assignment, synthesis
├── tui/                  # TUI components (imports from shared/ + pi-tui)
│   ├── progress.ts       # Braille progress bar panel
│   ├── swarm-markers.ts  # Swarm mode state markers
│   ├── permission-prompt.ts  # Manual-mode permission dialog
│   └── team-dashboard.ts # SwarmTeam live phase progress dashboard
└── state/                # Persistence layer (imports from shared/)
    ├── persistence.ts    # Atomic file writes, manifest/task/event I/O
    └── recovery.ts       # Crash detection, stale run cleanup, resume support
```

**Dependency direction**: `tui/` + `state/` → `swarm/` + `team/` → `shared/` → `index.ts`

- `shared/` has no pi or tui imports — pure logic and Node.js standard library
- `swarm/` and `team/` compose shared primitives and register pi tools/commands
- `tui/` implements `Component` from `@earendil-works/pi-tui`
- `state/` is a pure Node.js filesystem layer with no pi imports
- `index.ts` wires everything together via `pi.registerTool`, `pi.registerCommand`, and `pi.on`

---

## 3. Shared Infrastructure

### 3.1 Types (`shared/types.ts`)

The type system is designed around a **task envelope** that carries caller-owned payload (`data: T`) through the queuing system. This allows the same controller to handle both SwarmSpec (swarm mode) and future team task types without modification.

Key type hierarchy:

```
SubagentBatchLauncher (interface)
  └─ spawn(options) → SubagentHandle
  └─ resume(agentId, options) → SubagentHandle
  └─ retry(agentId, options) → SubagentHandle

QueuedSubagentTask<T>
  ├─ SpawnQueuedSubagentTask<T>   (kind: "spawn")
  └─ ResumeQueuedSubagentTask<T>  (kind: "resume")

SubagentResult<T>
  ├─ task: QueuedSubagentTask<T>
  ├─ agentId?: string
  ├─ status: "completed" | "failed" | "aborted"
  ├─ state?: "started" | "not_started"
  ├─ result?: string
  └─ error?: string
```

**Design rationale**: The `Launcher` interface abstracts subagent execution behind three methods (spawn/resume/retry). This makes the controller testable — tests can inject a mock launcher that returns synthetic handles. The `SubagentBatchLauncher` interface is the single seam between the controller and the real process-spawning backend.

For team mode, additional types include:

- `AgentRole` — enumerated role strings (explorer, planner, coder, reviewer, tester, fixer)
- `TeamPhase` — named phase with role assignment, optional dependencies, model tier, model override, and tool whitelist
- `MailboxMessage` — structured JSON message with `messageId`, `from`, `to`, `type`, `payload`
- `ModelTier` — `"default"` or `"small"` for cost-optimized routing
- `SMALL_MODEL_ROLES` — set of roles that auto-route to the small model (currently `explorer`)
- `BaseQueuedSubagentTask` — includes optional `model`, `tools`, `cwd` fields for threading through the spawn chain

### 3.2 Pi CLI Invocation (`shared/pi-invoke.ts`)

Resolves the correct command and arguments to launch a child pi process.

**Problem**: pi can run in several configurations — as a global npm package (`pi`), as a local development script (`node dist/cli.js`), or as a Bun virtual filesystem script. The subagent extension must work in all cases.

**Solution**: `getPiInvocation()` inspects `process.argv[1]`:

- If it's a real filesystem path → reuse current `process.execPath` + script path
- If it's a Bun virtual path → fall back to `pi` CLI command
- If the executable name is a generic `node`/`bun` → assume `pi` is on PATH
- Otherwise (custom binary like `pi` itself) → pass args directly

`buildSubagentArgs()` constructs the standard `--print` mode arguments:

- `--print` for JSON Lines output
- `--model` if specified (otherwise pi uses its configured default)
- `--tools` for tool allowlist
- `--max-turns` for turn limit
- `--append-system-prompt` for custom system prompt files

### 3.3 Subagent Spawner (`shared/spawner.ts`)

Manages the full lifecycle of a child pi process.

**Lifecycle**:

1. Build CLI arguments via `buildSubagentArgs()`
2. Resolve invocation via `getPiInvocation()`
3. `spawn()` the child with `stdio: ["ignore", "pipe", "pipe"]`
4. Parse JSON Lines events from stdout (message_end, tool_result_end)
5. Accumulate token usage from assistant message events
6. Extract final text content from the last assistant message
7. Handle abort signal: SIGTERM → wait 5s → SIGKILL
8. Handle timeout: optional per-task deadline

**Event parsing**: The `--print` mode produces one JSON object per line. `parseEventStream()` buffers stdout data, splits on newlines, and processes complete lines. Partial lines are held in the buffer. The `message_end` event with `role: "assistant"` carries the final result text and usage statistics. Content is extracted from both `tool_result` events (tool outputs) and `message_end` events (assistant text). Both string-form and array-form `msg.content` are handled.

**Why `spawn` not `exec`**: `spawn` returns a `ChildProcess` with streaming stdout/stderr. This allows real-time progress tracking and avoids buffering the entire output in memory.

**Error handling**: Three error paths:

- Non-zero exit code → reject with exit code and error message
- Process error event (e.g., ENOENT) → reject with the error
- Abort signal → kill the process, reject with abort reason
- Timeout → kill the process, reject with timeout error

### 3.4 Concurrency Controller (`shared/controller.ts`)

The most complex module. Ported from kimi-code's SubagentBatch with full fidelity.

#### Normal Phase

```
Initial launch: 5 agents immediately
Ramp interval:  700ms per additional agent
Max concurrent: PI_SWARM_MAX_CONCURRENCY (unlimited by default)
Max total:      128 agents
```

**Algorithm**:

1. `scheduleNormalLaunch()` fires INITIAL_LAUNCH_LIMIT (5) tasks immediately
2. If work remains, sets a 700ms timer for the next launch
3. On each timer tick, launches one more task if the concurrency limit is not reached
4. Continues until all tasks are launched or the rate-limit phase is entered

**Concurrency cap**: If `PI_SWARM_MAX_CONCURRENCY` is set, the active set size is checked before each launch. The timer still fires but skips launching if at capacity. When a task completes, `schedule()` is called again and checks capacity.

#### Rate-Limit Phase

Triggered by the first provider rate-limit error (HTTP 429, "rate limit", "quota", etc.).

**Capacity model**:

- Initial capacity = max(1, count of ready normal launches)
- Each rate limit shrinks capacity by 1 (min 1), at most once per 2000ms
- If no rate limit occurs for 3 minutes, capacity recovers by 1
- This models real API rate limiters that use sliding windows

**Retry backoff**:

- First retry: 3000ms
- Second: 6000ms
- Third: 12000ms
- Subsequent: double each time, capped at 120000ms (2 minutes)

**Scheduling**:

- `scheduleRateLimitLaunch()` checks capacity, launch eligibility, and pending readiness
- At most one task launched per scheduling pass
- Wakes at the earlier of: next launch time, next pending ready time, next capacity recovery time
- If only one task remains and it's rate-limited → fail fast (don't suspend forever)

#### Abort Handling

Two abort scenarios:

- **User cancellation** (Ctrl+C): `finishWithUserCancellation()` preserves completed results, marks active tasks as aborted with state "started", marks never-started tasks as aborted with state "not_started"
- **Non-user cancellation** (programmatic): `fail()` rejects the entire batch after cleaning up active attempts

#### Why Two Phases?

The two-phase design separates the "go fast" normal mode from the "be careful" rate-limit mode. In normal mode, the ramp-up is aggressive (5 immediate + steady drip). When rate limits appear, the controller switches to a conservative mode with capacity tracking and per-task backoff. This prevents a single rate-limited task from blocking the entire batch while still respecting API limits.

### 3.5 Result Renderer (`shared/render.ts`)

Produces the structured XML output that the parent LLM reads.

**AgentSwarm format** (compatible with kimi-code):

```xml
<agent_swarm_result>
<summary>completed: 3, failed: 1</summary>
<resume_hint>Call AgentSwarm with resume_agent_ids...</resume_hint>
<subagent agent_id="abc" item="src/x.ts" outcome="completed">result</subagent>
<subagent outcome="failed">error message</subagent>
</agent_swarm_result>
```

**Design decisions**:

- `escapeXml()` for attribute values (escapes `&`, `"`, `<`, `>`)
- `escapeXmlBody()` for body text (escapes `&`, `<`, `>` — no quotes needed inside tags)
- Resume hint only shown when there are failed tasks AND known agent IDs
- Summary line uses comma-separated counts

---

## 4. Swarm Mode

### 4.1 AgentSwarm Tool (`swarm/tool.ts`)

Registered via `pi.registerTool("AgentSwarm", ...)` with a TypeBox parameter schema.

**Input parameters**:
| Parameter | Required | Description |
|-----------|----------|-------------|
| `description` | Yes | Human-readable swarm description |
| `subagent_type` | No | Profile name, defaults to "coder" |
| `prompt_template` | Conditional | Required when `items` is provided; must contain `{{item}}` |
| `items` | Conditional | At least 2 unless `resume_agent_ids` is provided |
| `resume_agent_ids` | No | Map of agentId → resume prompt |

**Validation rules** (from kimi-code):

1. At least 2 items unless resume_agent_ids is provided
2. Total (items + resume entries) ≤ 128
3. prompt_template must contain `{{item}}` when items are provided
4. No duplicate prompts across items (dedup check)

**Execution flow**:

1. Parse and validate input
2. Normalize profile name
3. Create swarm specs (SpawnSpec for new items, ResumeSpec for resume entries)
4. Convert specs to QueuedSubagentTask array
5. Create SubagentBatchController with the real spawner launcher
6. Call `controller.run()` — blocks until all tasks complete
7. Convert results to SwarmRunResult array
8. Render `<agent_swarm_result>` XML
9. Return as tool result content

**Why a dedicated `createAgentSwarmSpecs` function**: Keeps the validation logic testable in isolation. The function takes raw input and produces validated spec objects. The tool execution layer then converts specs to tasks and runs them.

### 4.2 Swarm Mode State Machine (`swarm/mode.ts`)

Tracks whether swarm mode is active and manages system reminders.

**Three triggers**:
| Trigger | Source | Auto-exit? | Reminder injected? |
|---------|--------|-----------|-------------------|
| `manual` | `/swarm on` | No | Yes (enter + exit) |
| `task` | `/swarm <task>` | Yes (after turn) | Yes (enter only) |
| `tool` | LLM calls AgentSwarm | Yes (after tool returns) | No (silent) |

**System reminders**:

- **Enter** (manual/task): "Swarm mode is now active. AgentSwarm is auto-approved..."
- **Exit** (manual/task): "Swarm mode has been deactivated. AgentSwarm now requires permission..."
- **Tool trigger**: No reminder injected (transient tool call)

**Design rationale**: The "silent" tool trigger avoids polluting the conversation with swarm mode reminders when the LLM itself initiated the swarm. Manual and task triggers inject reminders because the user explicitly requested swarm mode and the LLM should know.

### 4.3 /swarm Command (`swarm/command.ts`)

Supports four forms:

- `/swarm on` — enable persistent swarm mode
- `/swarm off` — disable swarm mode
- `/swarm` — toggle
- `/swarm <task>` — one-shot: enable + send task

**Permission integration**: When in `manual` permission mode and the user tries to start a swarm, the command prompts via `ctx.ui.confirm()` to switch to `auto` mode. If the user declines, the swarm is not started. This matches kimi-code's swarm command behavior.

---

## 5. Team Mode

### 5.1 Mailbox System (`team/mailbox.ts`)

A JSONL-based messaging system for inter-agent communication.

**Directory structure**:

```
.pi/swarm/state/runs/{runId}/mailbox/
  inbox.jsonl          # Team-level incoming messages
  outbox.jsonl         # Team-level outgoing messages
  delivery.json        # Message delivery/acknowledgment state
  tasks/{taskId}/
    inbox.jsonl        # Per-task incoming messages
    outbox.jsonl       # Per-task outgoing messages
```

**Operations**:

- `sendMessage()` — appends to outbox and recipient's task inbox
- `readInbox()` — reads all unacknowledged messages from team inbox
- `readTaskInbox()` — reads messages addressed to a specific task
- `ackMessages()` — removes acknowledged messages from inbox
- `ackTaskMessages()` — removes specific messages from a per-role task inbox (used after messages are consumed in a phase prompt, preventing cross-phase leakage)
- `getDeliveryState()` / `updateDeliveryState()` — tracks which messages have been delivered

**Why JSONL not JSON**: JSONL (one JSON object per line) supports append-only writes without rewriting the entire file. This is critical for a mailbox where multiple agents may be writing concurrently. Each agent appends a line; no coordination needed.

**Why files not a message broker**: pi is a local CLI tool. Adding a dependency on Redis/RabbitMQ would violate the "zero runtime deps" principle. The filesystem is always available and provides durability for free.

### 5.2 Task Graph (`team/task-graph.ts`)

A directed acyclic graph of phases with role assignments and dependency constraints.

**Default phases** (from CrewAI research):

```
explore ──→ plan ──→ implement ──→ review ──→ test
```

Each phase has:

- `name` — unique identifier
- `role` — assigned agent role (explorer, planner, coder, reviewer, tester)
- `dependsOn` — phases that must complete before this one starts
- `status` — queued, running, completed, failed, or skipped

**State machine**:

```
queued → running → completed
                 → failed
queued → skipped (when dependency fails)
```

**Dependency propagation**: When a phase fails, all downstream phases that depend on it are automatically marked as "skipped". This prevents wasting resources on phases that can't succeed without their dependencies.

**Serialization**: `toJSON()` and `fromJSON()` support persisting and restoring the complete task graph. This is used by the persistence layer and crash recovery.

### 5.3 Team Supervisor (`team/supervisor.ts`)

Orchestrates the team run by managing the task graph and spawning agents.

**Responsibilities**:

1. Decompose the goal into phases (using default or custom phase definitions)
2. Determine which phase is ready to execute (dependencies satisfied)
3. Resolve model/tools/cwd for each phase via `getPhaseExecutionConfig()` using priority: phase-level model > phase-level modelTier > role-level config > auto-route (explorer → small) > default
4. Build a phase-specific prompt that includes context from completed dependency phases and mailbox messages
5. Spawn a role agent for the current phase with resolved model/tools/cwd
6. Collect results and advance the task graph
7. Acknowledge (delete) consumed mailbox messages to prevent cross-phase leakage
8. Synthesize the final `<swarm_team_result>` XML output with per-phase content, timing, and supervisor synthesis

**Phase prompt construction**: Each agent receives:

- Role-specific system prompt (from role config, or generic default)
- Team goal context
- Results from completed dependency phases (injected as context, with status badges)
- Mailbox messages addressed to the role (task_assignment, handoff, task_result)
- Phase-specific instruction with communication protocol

This is analogous to CrewAI's task context chaining — each task receives the output of its predecessor tasks as input context.

**Result synthesis**: The final XML includes:

- `<summary>` with phase counts
- `<total_duration_ms>` for overall wall-clock time
- Per-phase `<phase>` elements with `agent_id`, `duration_ms`, `outcome` attributes and full markdown output (truncated at 12,000 chars)
- `<supervisor_synthesis>` with consolidated outcomes, errors, and key deliverables excerpts
- Failed phases get `<error>` sub-elements; skipped phases get explanatory messages
- Empty results show a note pointing to `output.log` for full transcripts

### 5.4 SwarmTeam Tool (`team/tool.ts`)

Registered via `pi.registerTool("SwarmTeam", ...)`.

**Input parameters**:
| Parameter | Required | Description |
|-----------|----------|-------------|
| `goal` | Yes | High-level team goal |
| `description` | Yes | Human-readable run description |
| `phases` | No | Custom phase definitions; defaults to explore/plan/implement/review/test |
| `roles` | No | Custom role configs with model/tools/systemPrompt overrides |
| `small_model` | No | Lightweight model for exploration roles (e.g. deepseek/deepseek-v4-flash) |
| `max_agents` | No | Max concurrent agents (default 4) |
| `resume_agent_ids` | No | Map for resuming failed phase agents |

**Execution flow**:

1. Create a TeamSupervisor with the run configuration (including `smallModel`)
2. Loop: get next ready phase → resolve model/tools/cwd via `getPhaseExecutionConfig()` → spawn agent with resolved config → wait for completion → advance graph
3. On phase completion: assign agent ID, save result, update heartbeat
4. On phase failure: mark as failed, skip downstream phases
5. After all phases: finalize run, synthesize enhanced XML output with per-phase content and supervisor synthesis

**Why sequential not parallel for team phases**: Team phases have explicit dependencies (plan must finish before coding starts). Each phase agent needs the output of previous phases as context. Running phases in parallel would violate these dependencies. Future work could support parallel sub-phases within a single phase.

### 5.5 /swarm-team Command (`team/command.ts`)

Sends the goal as a user message. The LLM can then decide whether to call SwarmTeam directly or handle the goal differently. This is a lightweight command — the heavy lifting is in the tool.

---

## 6. TUI Components

### 6.1 Progress Panel (`tui/progress.ts`)

The most visually complex component. Renders a live progress panel above the input area during swarm execution.

**Visual layout**:

```
┌─ Agent Swarm ──────────────────────────────────────┐
│  Working...                                          │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  #1 ⣿⣿⣿⣿⣿⣶⣀  Working...  src/auth/login.ts    │
│  #2 ✓ Completed.                 src/auth/types.ts  │
│  #3 ✗ Failed: syntax error       src/auth/middle.ts │
│  #4 ⣀⣀⣀⣀⣀⣀⣀  Queued...     src/auth/utils.ts  │
│  completed: 1, failed: 1, active: 1, queued: 1      │
└─────────────────────────────────────────────────────┘
```

**Braille animation**: The progress bar uses Unicode braille characters (U+28C0–U+28FF) to render a continuous fill animation. Each braille character can represent 0-6 dots. The animation cycles through the fill levels at 80ms intervals, creating a smooth progress effect.

**Parameters** (from kimi-code):

- `TEXT_CELL_PREFERRED_WIDTH = 30` — item name column width
- `BRAILLE_BAR_MAX_WIDTH = 8` — progress bar width in characters
- `FRAME_INTERVAL_MS = 80` — animation frame interval
- `COMPLETE_FILL_MS = 360` — completion fill animation duration

**Phase-to-bar mapping**:
| Phase | Bar display |
|-------|------------|
| completed | Full bar |
| failed/cancelled | Empty bar |
| pending/queued | Empty bar (static) |
| prompting/working/suspended | Animated fill |

**Design rationale for custom braille rendering**: pi-tui does not provide a built-in braille progress bar component. The implementation handles the dot-level rendering directly to achieve the same visual effect as kimi-code's AgentSwarmProgressComponent.

### 6.2 Swarm Markers (`tui/swarm-markers.ts`)

Simple single-line markers inserted into the conversation transcript.

```
Swarm activated    (active state)
Swarm deactivated  (inactive state)
Swarm ended        (ended state — one-shot task completed)
```

**Rendering**: Each marker is a single line with the label text. The `invalidate()` method resets the cached render so theme changes are reflected.

### 6.3 Permission Prompt (`tui/permission-prompt.ts`)

A dialog component for manual permission mode. When the user in manual mode tries to start a swarm, this dialog offers:

```
┌──────────────────────────────────────────────┐
│ Manual mode can block swarm work.            │
│                                              │
│ Choose a permission mode for this swarm:     │
│                                              │
│  > Auto mode — tools auto-approved           │
│    YOLO mode — all tools auto-approved       │
│    Cancel — do not start the swarm           │
│                                              │
│ Use arrow keys to select, Enter to confirm.  │
└──────────────────────────────────────────────┘
```

**Input handling**: Up/Down arrows or j/k to navigate, Enter to select, Escape to cancel. This matches kimi-code's SwarmStartPermissionPromptComponent.

### 6.4 Team Dashboard (`tui/team-dashboard.ts`)

Live phase progress dashboard for SwarmTeam mode. Renders a multi-row panel showing each phase's status, assigned role, and elapsed time during team execution.

**Visual layout**:

```
┌─ Swarm Team ─────────────────────────────────────────────┐
│  Goal: Implement login with tests                         │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│  explore    ──→ plan    ──→ implement ──→ review ──→ test │
│    done         done        running        queued  queued │
│   (coder)      (planner)    (coder)                                │
│   2.3s         1.8s         12.5s                                  │
└──────────────────────────────────────────────────────────┘
```

**Parameters**:

- Uses `TeamProgressSnapshot` from `shared/types.ts` for phase status data
- `TeamPhaseStatus` enum: queued, running, completed, failed, skipped
- `TeamProgressCallback` type: `(snapshot: TeamProgressSnapshot) => void`

**Phase display**: Each phase shows its status with a role label and elapsed time. Phases are connected by arrows showing the flow direction. Running phases display a spinner or elapsed timer. Completed phases show their duration. Failed phases are highlighted. Skipped phases are grayed out.

**Integration**: The team supervisor calls the progress callback after each phase state change. The callback updates the dashboard component via TUI invalidation, providing real-time visual feedback during team runs.

### 6.5 Widget Wiring Pattern

Both the Progress Panel and Team Dashboard are installed as extension widgets via `ctx.ui.setWidget(key, factory, options)`.  A critical implementation detail:

The `setWidget` factory receives `(tui: TUI, theme: Theme)` from the framework.  The `tui` reference MUST be captured and exposed to the component so that `setInterval`-based animation timers can call `tui.requestRender()` after `invalidate()`.  Without this call the TUI framework has no trigger to redraw the widget, and braille bars / spinners appear frozen.

```
setWidget(key, (tui, _theme) => {
  capturedTui = tui;
  return component;  // component calls capturedTui.requestRender() on each animation tick
}, { placement: "aboveEditor" });
```

This pattern was ported from pi-crew's `requestRenderTarget(tui)` callback.

---

## 7. State & Persistence

### 7.1 Persistence Layer (`state/persistence.ts`)

Provides durable file-based state for all runs.

**State directory**:

```
.pi/swarm/state/runs/{runId}/
  manifest.json          # Run metadata (type, status, agent IDs, timestamps)
  tasks.json             # Task graph state (per-phase status, results)
  events.jsonl           # Append-only event log
  agents/{agentId}/
    status.json          # Per-agent status snapshot
    output.log           # Full agent session output (header, raw stdout, footer)
```

**Atomic writes**: All file writes use a temp-file + rename pattern:

1. Write content to `file.tmp.{random}`
2. `fs.renameSync()` to replace the target
3. On POSIX, `rename` is atomic (the target is replaced or not — no partial writes)
4. On failure, clean up the temp file

**Why atomic writes**: Crash safety. If the process crashes mid-write, the original file is intact (the temp file is orphaned but harmless). Without atomic writes, a crash during `writeFileSync` could leave a truncated manifest, making the run unrecoverable.

**Swarm root resolution**:

- If `.pi/` exists → use `.pi/swarm/` (reuse existing pi directory)
- Otherwise → use `.crew/` (clean separation for non-pi projects)

### 7.2 Crash Recovery (`state/recovery.ts`)

Runs on `session_start` to detect and handle stale runs.

**Recovery logic**:

1. List all run directories under `state/runs/`
2. For each run, read the manifest
3. Orphaned directories (no manifest) → clean up
4. "running" runs older than 30 minutes → mark as "abandoned"
5. "completed"/"failed" runs older than 7 days → delete
6. "abandoned" runs older than 7 days → delete
7. Return lists of resumable and abandoned runs

**Staleness threshold (30 minutes)**: If a run has been "running" for 30+ minutes without a heartbeat update, the parent pi process is assumed dead. The run is marked abandoned rather than deleted so the user can inspect what happened.

**Why 7-day retention**: Completed runs may be referenced by the user for inspection. 7 days provides a reasonable window before automatic cleanup.

---

## 8. Data Flow

### 8.1 Swarm Execution Flow

```
User: /swarm Review src/*.ts for bugs
  │
  ▼
/swarm command handler
  │  enables swarm mode (task trigger)
  │  sends user prompt
  ▼
LLM receives prompt with system reminders
  │  decides to call AgentSwarm
  ▼
AgentSwarm.execute()
  │
  ├─ createAgentSwarmSpecs()   ← validate inputs, build specs
  │
  ├─ specs → QueuedSubagentTask[]
  │
  ├─ new SubagentBatchController(launcher, tasks)
  │     │
  │     ├─ scheduleNormalLaunch()   ← 5 immediate, +1/700ms
  │     ├─ startAttempt()           ← spawn pi --print
  │     │     └─ parseEventStream() ← read JSON Lines
  │     ├─ handleAttemptOutcome()   ← completed / rate-limited / failed
  │     └─ [if rate-limited] → scheduleRateLimitLaunch()
  │
  ├─ controller.run() → SubagentResult[]
  │
  ├─ toSwarmRunResults() → SwarmRunResult[]
  │
  └─ renderSwarmResults() → <agent_swarm_result> XML
       │
       ▼
     Returned to LLM as tool result
```

### 8.2 Team Execution Flow

```
User: /swarm-team Implement login with tests
  │
  ▼
/swarm-team command handler
  │  sends user prompt
  ▼
LLM receives prompt → decides to call SwarmTeam
  │
  ▼
SwarmTeam.execute()
  │
  ├─ new TeamSupervisor(config)
  │     ├─ resolves phases (default or custom)
  │     ├─ creates TaskGraph
  │     └─ ensures mailbox exists
  │
  ├─ Loop:
  │   ├─ supervisor.startNextPhase()
  │   │     ├─ checks dependencies
  │   │     └─ builds phase prompt with dependency context + mailbox messages
  │   │
  │   ├─ supervisor.getPhaseExecutionConfig(phaseName)
  │   │     └─ resolves model/tools/cwd via priority chain
  │   │
  │   ├─ spawn agent for phase (via controller)
  │   │     ├─ agent runs with resolved model, tools, cwd
  │   │     └─ agent writes to mailbox if needed
  │   │
  │   ├─ on complete: supervisor.completePhase() + ackTaskMessages()
  │   ├─ on fail: supervisor.failPhase() + skip downstream
  │   └─ continue until no more ready phases
  │
  ├─ supervisor.finalize()
  ├─ supervisor.synthesizeResult() → enhanced XML with per-phase output, timing, synthesis
  └─ return <swarm_team_result> XML
```

---

## 9. Key Design Decisions & Rationale

| Decision                                              | Rationale                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Out-of-process subagents** (`spawn` not in-process) | Crash isolation. A subagent that runs in-process can corrupt the parent's state. Process isolation is the same model used by pi-crew and pi's built-in subagent example                             |
| **Two-phase concurrency**                             | Rate limits are inevitable at scale. The normal phase maximizes throughput; the rate-limit phase prevents cascading failures. This is proven in kimi-code's production use                          |
| **XML output format**                                 | Compatible with kimi-code's output format. The parent LLM already knows how to parse `<agent_swarm_result>`. Using the same format ensures the LLM's training data includes examples of this format |
| **Mailbox as JSONL files**                            | Simplicity, durability, auditability. Every message is a file that can be inspected with `cat` or `jq`. No message broker to install                                                                |
| **Sequential team phases**                            | Team phases have semantic dependencies (plan before code). Parallel execution within a phase is possible (future work) but inter-phase parallelism would violate the dependency graph               |
| **Default 5-phase team workflow**                     | Based on research of CrewAI's hierarchical model and common software development workflows. The explore → plan → implement → review → test pipeline mirrors real engineering processes              |
| **Atomic writes for state**                           | Crash safety. A partial write on crash should never corrupt the existing state                                                                                                                      |
| **30-minute staleness threshold**                     | Long enough for a legitimate run, short enough to detect actual crashes. Pi's default subagent timeout is also 30 minutes                                                                           |
| **100% English codebase**                             | Language rule for all repository artifacts. Only user-facing reports (like this one) use Chinese                                                                                                    |

---

## 10. Comparison with Reference Projects

| Aspect             | kimi-code                        | pi-crew                                    | pi-swarm                                                |
| ------------------ | -------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Subagent execution | In-process session API           | Out-of-process spawn                       | Out-of-process spawn                                    |
| Concurrency model  | Two-phase SubagentBatch          | Task queue with configurable cap           | Two-phase SubagentBatch (ported from kimi-code)         |
| Swarm mode         | AgentSwarm tool + /swarm         | N/A (team only)                            | AgentSwarm + SwarmTeam dual mode                        |
| Team mode          | N/A                              | Task graph + supervisor + mailbox          | Task graph + supervisor + mailbox (inspired by pi-crew) |
| State persistence  | In-memory                        | Full state machine (JSONL + atomic writes) | Manifest + tasks + events (atomic writes)               |
| TUI                | Braille progress + swarm markers | Dashboard + widget + powerbar              | Braille progress + markers + permission dialog          |
| Mailbox            | N/A                              | JSONL inbox/outbox/delivery                | JSONL inbox/outbox/delivery                             |
| Crash recovery     | N/A                              | Heartbeat + deadletter                     | Staleness detection + auto-abandon                      |
| Runtime deps       | Many (internal packages)         | Zero (for orchestration)                   | Zero (for orchestration)                                |

**pi-swarm's unique position**: Combines kimi-code's proven concurrency model with pi-crew's mailbox-driven team collaboration, while maintaining zero runtime dependencies and 100% process isolation.

---

## 11. Future Work

1. **Parallel team sub-phases**: Within a single team phase, spawn multiple agents working on different files simultaneously, then aggregate results
2. **Heartbeat-based liveness**: Replace the 30-minute staleness threshold with active heartbeat updates from running agents
3. **Worktree isolation**: Each team phase agent could run in a git worktree for filesystem isolation (like pi-crew's worktree manager)
4. **Agent capability inventory**: Auto-detect what tools/skills each role agent has available
5. **Model fallback chain**: If the primary model for a role is rate-limited, fall back to a cheaper model
6. **Run export/import**: Bundle a complete run (state + artifacts + events) for cross-machine sharing or debugging
7. **Dashboard TUI**: A `/swarm-status` command showing all active and recent runs
