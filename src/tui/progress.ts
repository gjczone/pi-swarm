/**
 * tui/progress — AgentSwarm live progress panel.
 *
 * Renders a real-time progress display above the input area when
 * an AgentSwarm batch is running.  Each subagent gets a braille
 * progress bar with status labels.
 *
 * Ported from MoonshotAI/kimi-code's AgentSwarmProgressComponent.
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
  BatchProgressSnapshot,
  BatchMemberStatus,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants (from kimi-code)
// ---------------------------------------------------------------------------

/** Preferred width for the item text column. */
const TEXT_CELL_PREFERRED_WIDTH = 30;

/** Gap between columns. */
const CELL_GAP = "  ";

/** Braille bar max width in characters. */
const BRAILLE_BAR_MAX_WIDTH = 8;

/** Minimum braille bar width. */
const TEXT_BRAILLE_BAR_MIN_WIDTH = 6;

/** Animation frame interval in ms. */
const FRAME_INTERVAL_MS = 80;

/** How long the completion-fill animation lasts in ms. */
const COMPLETE_FILL_MS = 360;

/** Braille characters representing fill levels 0-6 dots. */
const BRAILLE_LEVELS = [
  "\u28C0", // 0 dots (empty)
  "\u28C4", // 1 dot
  "\u28E4", // 2 dots
  "\u28E6", // 3 dots
  "\u28F6", // 4 dots
  "\u28F7", // 5 dots
  "\u28FF", // 6 dots (full)
] as const;

const BRAILLE_EMPTY = BRAILLE_LEVELS[0];
const BRAILLE_FULL = BRAILLE_LEVELS[6];

/** Status labels for each phase. */
const ORCHESTRATING_LABEL = "Orchestrating...";
const WORKING_LABEL = "Working...";
const COMPLETED_LABEL = "Completed.";
const FAILED_LABEL = "Failed.";
const ABORTED_LABEL = "Aborted.";
const QUEUED_LABEL = "Queued...";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Phase of a single member (subagent) in the progress display. */
export type MemberPhase =
  | "pending"
  | "queued"
  | "prompting"
  | "working"
  | "completed"
  | "failed"
  | "cancelled"
  | "suspended";

/** Status of a single member. */
export interface MemberStatus {
  /** 1-based index. */
  readonly index: number;
  /** Current phase. */
  phase: MemberPhase;
  /** Label for the item being processed. */
  item?: string;
  /** Result text (for completed/failed). */
  result?: string;
  /** Error message (for failed). */
  error?: string;
  /** When the member transitioned to its current phase (ms timestamp). */
  phaseStartedAt?: number;
}

/** Overall swarm status pushed from the tool execution. */
export interface SwarmProgressState {
  /** Title for the progress panel. */
  title?: string;
  /** Overall status label. */
  status?: string;
  /** Total number of subagents. */
  total: number;
  /** Completed count. */
  completed: number;
  /** Failed count. */
  failed: number;
  /** Currently active count. */
  active: number;
  /** Queued count. */
  queued: number;
  /** Per-member status. */
  members: MemberStatus[];
}

// ---------------------------------------------------------------------------
// Snapshot conversion (controller snapshot -> component state)
// ---------------------------------------------------------------------------

/**
 * Convert a BatchProgressSnapshot from the concurrency controller into
 * the SwarmProgressState expected by AgentSwarmProgressComponent.
 *
 * Maps the controller's coarse member phases onto the component's
 * richer MemberPhase set, attaching a phaseStartedAt timestamp so the
 * braille animation can run for working/suspended members.
 */
export function snapshotToProgressState(
  snapshot: BatchProgressSnapshot,
  title?: string,
): SwarmProgressState {
  const now = Date.now();
  const members: MemberStatus[] = snapshot.members.map(
    (m: BatchMemberStatus): MemberStatus => ({
      index: m.index,
      phase: mapMemberPhase(m.phase),
      item: m.item,
      error: m.error,
      phaseStartedAt: isAnimatedPhase(m.phase) ? now : undefined,
    }),
  );

  return {
    title,
    total: snapshot.total,
    completed: snapshot.completed,
    failed: snapshot.failed,
    active: snapshot.active,
    queued: snapshot.queued,
    members,
  };
}

function mapMemberPhase(
  phase: BatchMemberStatus["phase"],
): MemberPhase {
  switch (phase) {
    case "queued":
      return "queued";
    case "working":
      return "working";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "suspended":
      return "suspended";
  }
}

function isAnimatedPhase(
  phase: BatchMemberStatus["phase"],
): boolean {
  return phase === "working" || phase === "suspended";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class AgentSwarmProgressComponent implements Component {
  private state_: SwarmProgressState | null = null;
  private animationFrame: ReturnType<typeof setInterval> | undefined;
  private startTime = Date.now();
  private renderedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor() {
    this.startAnimation();
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /** Update the progress state from the tool execution. */
  update(state: SwarmProgressState): void {
    this.state_ = state;
    this.invalidate();
  }

  /** Mark the swarm as completed (triggers completion animation). */
  complete(): void {
    if (this.state_) {
      // Mark all non-terminal members as completed
      for (const m of this.state_.members) {
        if (m.phase !== "completed" && m.phase !== "failed" && m.phase !== "cancelled") {
          m.phase = "completed";
          m.phaseStartedAt = Date.now();
        }
      }
      this.state_.active = 0;
      this.state_.queued = 0;
      this.state_.completed = this.state_.total - this.state_.failed;
      this.state_.status = COMPLETED_LABEL;
    }
    this.invalidate();
  }

  /** Stop the animation loop. */
  dispose(): void {
    if (this.animationFrame !== undefined) {
      clearInterval(this.animationFrame);
      this.animationFrame = undefined;
    }
  }

  // -------------------------------------------------------------------
  // Component interface
  // -------------------------------------------------------------------

  invalidate(): void {
    this.renderedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(10, width);
    if (this.cachedLines && this.renderedWidth === safeWidth) {
      return this.cachedLines;
    }

    if (!this.state_ || this.state_.members.length === 0) {
      this.cachedLines = [];
      return this.cachedLines;
    }

    const state = this.state_;
    const lines: string[] = [];

    // Title bar
    const title = state.title ?? "Agent Swarm";
    lines.push(borderTop(title, safeWidth));

    // Overall status
    const statusLabel = state.status ?? resolveOverallStatus(state);
    const statusBar = buildStatusBar(state, safeWidth);
    lines.push(`  ${statusLabel}`);
    lines.push(`  ${statusBar}`);

    // Member rows
    const maxMembers = Math.min(state.members.length, 20); // Cap for performance
    for (let i = 0; i < maxMembers; i += 1) {
      const member = state.members[i];
      if (!member) continue;
      const row = renderMemberRow(member, safeWidth - 4);
      lines.push(`  ${row}`);
    }

    // Summary
    const summary = buildSummary(state);
    lines.push(`  ${summary}`);

    // Bottom border
    lines.push(borderBottom(safeWidth));

    this.cachedLines = lines;
    this.renderedWidth = safeWidth;
    return this.cachedLines;
  }

  // -------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------

  private startAnimation(): void {
    this.animationFrame = setInterval(() => {
      this.invalidate();
    }, FRAME_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function borderTop(title: string, width: number): string {
  const inner = ` ${title} `;
  const dashes = Math.max(0, width - inner.length - 2);
  return `\u250C${inner}\u2500${"\u2500".repeat(Math.max(0, dashes))}\u2510`;
}

function borderBottom(width: number): string {
  return `\u2514${"\u2500".repeat(Math.max(0, width - 2))}\u2518`;
}

function resolveOverallStatus(state: SwarmProgressState): string {
  if (state.queued === 0 && state.active === 0) {
    if (state.failed > 0) return FAILED_LABEL;
    return COMPLETED_LABEL;
  }
  if (state.active > 0) return WORKING_LABEL;
  return ORCHESTRATING_LABEL;
}

function buildStatusBar(state: SwarmProgressState, width: number): string {
  const barWidth = Math.max(1, width - 4);
  const total = state.total || 1;
  const doneRatio = (state.completed + state.failed) / total;
  const doneChars = Math.round(doneRatio * barWidth);
  const remainingChars = barWidth - doneChars;

  const done = "\u2501".repeat(doneChars);
  const remaining = "\u2501".repeat(remainingChars);
  return done + remaining;
}

function renderMemberRow(member: MemberStatus, width: number): string {
  const indexLabel = `#${String(member.index)}`;
  const brailleBar = renderBrailleBar(member, BRAILLE_BAR_MAX_WIDTH);
  const statusLabel = memberPhaseLabel(member.phase);
  const itemLabel = (member.item ?? "").slice(0, TEXT_CELL_PREFERRED_WIDTH);

  // Layout: #N [braille] Status  item
  const fixed = `${indexLabel} ${brailleBar} ${statusLabel}`;
  const fixedLen = visibleLen(fixed);
  const itemSpace = Math.max(0, width - fixedLen - 2);
  const truncatedItem = truncateText(itemLabel, itemSpace);

  return `${fixed}  ${truncatedItem}`;
}

function renderBrailleBar(member: MemberStatus, maxWidth: number): string {
  const phase = member.phase;
  const elapsed = member.phaseStartedAt
    ? Date.now() - member.phaseStartedAt
    : 0;

  switch (phase) {
    case "completed":
      return BRAILLE_FULL.repeat(maxWidth);
    case "failed":
    case "cancelled":
    case "pending":
    case "queued":
      return BRAILLE_EMPTY.repeat(maxWidth);
    case "prompting":
    case "working":
    case "suspended":
      return animatedBrailleBar(maxWidth, elapsed);
  }
}

function animatedBrailleBar(maxWidth: number, elapsedMs: number): string {
  const cycleMs = 800; // One full animation cycle
  const progress = (elapsedMs % cycleMs) / cycleMs; // 0..1

  // Fill from left to right
  const totalDots = maxWidth * 6; // 6 dots per braille char
  const filledDots = Math.floor(progress * totalDots);

  let result = "";
  for (let i = 0; i < maxWidth; i += 1) {
    const cellStart = i * 6;
    const dotsInCell = Math.max(0, Math.min(6, filledDots - cellStart));
    result += dotsInCell === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[dotsInCell]!;
  }
  return result;
}

function memberPhaseLabel(phase: MemberPhase): string {
  switch (phase) {
    case "pending":
    case "queued":
      return QUEUED_LABEL;
    case "prompting":
      return "Prompting...";
    case "working":
      return WORKING_LABEL;
    case "completed":
      return COMPLETED_LABEL;
    case "failed":
      return FAILED_LABEL;
    case "cancelled":
      return ABORTED_LABEL;
    case "suspended":
      return "Rate limited...";
  }
}

function buildSummary(state: SwarmProgressState): string {
  const parts: string[] = [];
  if (state.completed > 0) parts.push(`completed: ${state.completed}`);
  if (state.failed > 0) parts.push(`failed: ${state.failed}`);
  if (state.active > 0) parts.push(`active: ${state.active}`);
  if (state.queued > 0) parts.push(`queued: ${state.queued}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Text utilities (no external dependency — avoids import issues)
// ---------------------------------------------------------------------------

function visibleLen(text: string): number {
  // Simple implementation: count characters, stripping ANSI escapes
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)) + "\u2026";
}
