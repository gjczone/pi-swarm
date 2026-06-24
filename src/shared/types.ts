/**
 * pi-swarm — shared type definitions.
 *
 * All swarm and team modules import from here.
 * No pi or tui imports — pure data types.
 */

// ---------------------------------------------------------------------------
// Subagent lifecycle
// ---------------------------------------------------------------------------

/** Phase of a single subagent during execution. */
export type SubagentPhase =
  | "pending"
  | "prompting"
  | "working"
  | "completed"
  | "failed"
  | "cancelled"
  | "suspended";

/** Terminal outcome of a subagent run. */
export type SubagentOutcome = "completed" | "failed" | "aborted";

/** State marker for whether a subagent was ever started. */
export type SubagentStartState = "started" | "not_started";

/**
 * A single subagent's result after execution.
 */
export interface SubagentResult<T = unknown> {
  /** The task that produced this result. */
  readonly task: QueuedSubagentTask<T>;
  /** Agent identifier assigned at spawn time. */
  readonly agentId?: string;
  /** Terminal outcome. */
  readonly status: SubagentOutcome;
  /** Whether this task was ever started. */
  readonly state?: SubagentStartState;
  /** Result text (for completed tasks). */
  readonly result?: string;
  /** Error message (for failed/aborted tasks). */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Swarm-task-spec layer (carried by QueuedSubagentTask.data)
// ---------------------------------------------------------------------------

/** A new subagent spawned from a template item. */
export interface SwarmSpawnSpec {
  readonly kind: "spawn";
  /** 1-based index in the swarm. */
  readonly index: number;
  /** The template item value. */
  readonly item: string;
  /** The concrete prompt (template with {{item}} replaced). */
  readonly prompt: string;
}

/** A resumed subagent from a previous run. */
export interface SwarmResumeSpec {
  readonly kind: "resume";
  /** 1-based index in the swarm. */
  readonly index: number;
  /** Existing agent id to resume. */
  readonly agentId: string;
  /** Original item value (if known). */
  readonly item?: string;
  /** Resume prompt. */
  readonly prompt: string;
}

/** Union of all spec kinds tracked by the swarm tool. */
export type SwarmSpec = SwarmSpawnSpec | SwarmResumeSpec;

// ---------------------------------------------------------------------------
// Team mode types
// ---------------------------------------------------------------------------

/** Predefined agent roles for team mode. */
export type AgentRole =
  | "explorer"
  | "planner"
  | "coder"
  | "reviewer"
  | "tester"
  | "fixer";

/** Configuration for a single role in a team run. */
export interface AgentRoleConfig {
  readonly role: AgentRole;
  /** Model override for this role (optional). */
  readonly model?: string;
  /** Tool allowlist (default: all). */
  readonly tools?: string[];
  /** Role-specific system prompt addition. */
  readonly systemPrompt?: string;
}

/** A team phase with role assignment. */
export interface TeamPhase {
  readonly name: string;
  readonly role: AgentRole;
  /** Phases that must complete before this one starts. */
  readonly dependsOn?: string[];
  /** Model tier override for this phase. */
  readonly modelTier?: ModelTier;
  /** Explicit model name override (takes precedence over tier). */
  readonly model?: string;
  /** Tool whitelist override for this phase. */
  readonly tools?: string[];
}

/** A mailbox message for inter-agent communication. */
export interface MailboxMessage {
  readonly messageId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly from: string;
  readonly to: string;
  readonly type: "task_assignment" | "task_result" | "handoff" | "state_sync";
  readonly payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Envelope for external launcher abstraction
// ---------------------------------------------------------------------------

/** Options passed through to every subagent run. */
export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
  readonly timeout?: number;
  readonly model?: string;
  readonly tools?: string[];
  readonly cwd?: string;
}

/** Model tier for cost-optimized routing. */
export type ModelTier = "default" | "small";

/** Roles that automatically use the small/fast model when configured. */
export const SMALL_MODEL_ROLES: ReadonlySet<string> = new Set(["explorer"]);

/** Options specific to spawning a NEW subagent. */
export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
  readonly model?: string;
  readonly tools?: string[];
  readonly cwd?: string;
}

/** Result returned by the subagent launcher. */
export interface SubagentCompletion {
  readonly result: string;
  readonly usage?: SubagentUsage;
}

/** Handle to a running subagent. */
export interface SubagentHandle {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<SubagentCompletion>;
}

/** Token usage for a subagent. */
export interface SubagentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

// ---------------------------------------------------------------------------
// Queued-task protocol (shared between tool and controller)
// ---------------------------------------------------------------------------

/** Base fields every queued task carries. */
export interface BaseQueuedSubagentTask<T = unknown> {
  /** Caller-owned payload (SwarmSpec, team task, etc.). */
  readonly data: T;
  /** Subagent profile name. */
  readonly profileName: string;
  /** Parent tool-call id for nesting. */
  readonly parentToolCallId: string;
  /** Parent tool-call uuid for event correlation. */
  readonly parentToolCallUuid?: string;
  /** Concrete prompt sent to the subagent. */
  readonly prompt: string;
  /** Human-readable description for logging/UI. */
  readonly description: string;
  /** 1-based position in the batch (optional). */
  readonly swarmIndex?: number;
  /** Item value the subagent works on (optional). */
  readonly swarmItem?: string;
  /** Whether the subagent runs in background. */
  readonly runInBackground: boolean;
  /** Timeout in ms (optional). */
  readonly timeout?: number;
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal;
  /** Model override (optional, uses parent model if not set). */
  readonly model?: string;
  /** Tool whitelist (optional, all tools available if not set). */
  readonly tools?: string[];
  /** Working directory override (optional, uses parent cwd if not set). */
  readonly cwd?: string;
}

/** A task that spawns a NEW subagent. */
export interface SpawnQueuedSubagentTask<
  T = unknown,
> extends BaseQueuedSubagentTask<T> {
  readonly kind: "spawn";
}

/** A task that RESUMES an existing subagent. */
export interface ResumeQueuedSubagentTask<
  T = unknown,
> extends BaseQueuedSubagentTask<T> {
  readonly kind: "resume";
  readonly resumeAgentId: string;
}

/** Union of queued task kinds. */
export type QueuedSubagentTask<T = unknown> =
  | SpawnQueuedSubagentTask<T>
  | ResumeQueuedSubagentTask<T>;

// ---------------------------------------------------------------------------
// Controller options
// ---------------------------------------------------------------------------

/** Options for the batch concurrency controller. */
export interface SubagentBatchOptions {
  /**
   * Optional cap on concurrent subagents during the normal phase.
   * `undefined` means no cap (legacy ramp behavior).
   */
  readonly maxConcurrency?: number;
  /**
   * Optional progress callback invoked when task states change.
   * Receives a snapshot of the current batch progress.
   */
  readonly onProgress?: (snapshot: BatchProgressSnapshot) => void;
}

// ---------------------------------------------------------------------------
// Team progress types (for TUI dashboard)
// ---------------------------------------------------------------------------

/** Snapshot of team run progress for TUI display. */
export interface TeamProgressSnapshot {
  readonly title: string;
  readonly goal: string;
  readonly status: "running" | "completed" | "failed";
  readonly totalPhases: number;
  readonly completedPhases: number;
  readonly failedPhases: number;
  readonly currentPhase?: string;
  readonly currentRole?: string;
  readonly phases: ReadonlyArray<TeamPhaseStatus>;
  readonly mailboxCount: number;
  readonly startedAt: number;
}

/** Per-phase status in a team progress snapshot. */
export interface TeamPhaseStatus {
  readonly name: string;
  readonly role: AgentRole;
  readonly status: "queued" | "running" | "completed" | "failed" | "skipped";
  readonly error?: string;
}

/** Callback for team progress updates. */
export type TeamProgressCallback = (snapshot: TeamProgressSnapshot) => void;

/** Snapshot of batch progress for TUI display. */
export interface BatchProgressSnapshot {
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly active: number;
  readonly queued: number;
  readonly members: ReadonlyArray<BatchMemberStatus>;
}

/** Per-member status in a progress snapshot. */
export interface BatchMemberStatus {
  readonly index: number;
  readonly phase: "queued" | "working" | "completed" | "failed" | "suspended";
  readonly item?: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Suspended event (rate-limit signalling)
// ---------------------------------------------------------------------------

/** Emitted when a subagent is suspended due to rate limiting. */
export interface SubagentSuspendedEvent {
  readonly agentId: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Launcher interface (abstracts spawn / resume / retry)
// ---------------------------------------------------------------------------

/**
 * Interface the controller uses to launch subagents.
 * Implementations can use pi --print, in-process SDK, or other backends.
 */
export interface SubagentBatchLauncher {
  spawn(options: SpawnSubagentOptions): Promise<SubagentHandle>;
  resume(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
  retry(agentId: string, options: RunSubagentOptions): Promise<SubagentHandle>;
}
