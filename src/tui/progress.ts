/**
 * tui/progress — AgentSwarm live progress panel.
 *
 * Renders a real-time progress display above the input area when
 * an AgentSwarm batch is running. Each subagent gets a compact braille
 * spinner with status and item description.
 *
 * Ported from MoonshotAI/kimi-code's AgentSwarmProgressComponent.
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
  BatchProgressSnapshot,
  BatchMemberStatus,
  SubagentUsage,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max item description length to display. */
const MAX_ITEM_LABEL_LEN = 40;

/** Compact braille spinner frames for running agents. */
const BRAILLE_SPINNER = [
  "\u28BF",
  "\u28FB",
  "\u28FD",
  "\u28FE",
  "\u28F7",
  "\u28EF",
  "\u28DF",
  "\u287F",
] as const;

/** Animation frame interval in ms. */
const FRAME_INTERVAL_MS = 80;

/** Braille characters representing fill levels 0-6 dots for completed bar. */
const BRAILLE_LEVELS = [
  "\u28C0",
  "\u28C4",
  "\u28E4",
  "\u28E6",
  "\u28F6",
  "\u28F7",
  "\u28FF",
] as const;

const BRAILLE_EMPTY = BRAILLE_LEVELS[0];
const BRAILLE_FULL = BRAILLE_LEVELS[6];
const COMPLETED_BAR_WIDTH = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberPhase =
  | "pending"
  | "queued"
  | "prompting"
  | "working"
  | "completed"
  | "failed"
  | "cancelled"
  | "suspended";

export interface MemberStatus {
  readonly index: number;
  phase: MemberPhase;
  item?: string;
  result?: string;
  error?: string;
  phaseStartedAt?: number;
}

export interface SwarmProgressState {
  title?: string;
  total: number;
  completed: number;
  failed: number;
  active: number;
  queued: number;
  members: MemberStatus[];
  totalUsage: SubagentUsage;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot conversion
// ---------------------------------------------------------------------------

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
    totalUsage: snapshot.totalUsage,
    startedAt: snapshot.startedAt ?? now,
  };
}

function mapMemberPhase(phase: BatchMemberStatus["phase"]): MemberPhase {
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

function isAnimatedPhase(phase: BatchMemberStatus["phase"]): boolean {
  return phase === "working" || phase === "suspended";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class AgentSwarmProgressComponent implements Component {
  private state_: SwarmProgressState | null = null;
  private animationFrame: ReturnType<typeof setInterval> | undefined;
  private renderedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private onRequestRender: (() => void) | undefined;
  private frameIndex = 0;

  constructor(onRequestRender?: () => void) {
    this.onRequestRender = onRequestRender;
    this.startAnimation();
  }

  update(state: SwarmProgressState): void {
    this.state_ = state;
    this.invalidate();
  }

  complete(): void {
    if (this.state_) {
      for (const m of this.state_.members) {
        if (
          m.phase !== "completed" &&
          m.phase !== "failed" &&
          m.phase !== "cancelled"
        ) {
          m.phase = "completed";
          m.phaseStartedAt = Date.now();
        }
      }
      this.state_.active = 0;
      this.state_.queued = 0;
      this.state_.completed = this.state_.total - this.state_.failed;
    }
    this.invalidate();
  }

  dispose(): void {
    if (this.animationFrame !== undefined) {
      clearInterval(this.animationFrame);
      this.animationFrame = undefined;
    }
    this.onRequestRender = undefined;
  }

  invalidate(): void {
    this.renderedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    if (this.cachedLines && this.renderedWidth === safeWidth) {
      return this.cachedLines;
    }

    if (!this.state_ || this.state_.members.length === 0) {
      this.cachedLines = [];
      return this.cachedLines;
    }

    const state = this.state_;
    const contentWidth = safeWidth - 4;
    const lines: string[] = [];

    // Header: title
    const title = state.title ?? "Agent Swarm";
    lines.push(`  ${truncateText(title, contentWidth)}`);

    // Overall progress bar
    const barWidth = Math.max(1, contentWidth);
    const total = state.total || 1;
    const doneRatio = (state.completed + state.failed) / total;
    const doneChars = Math.round(doneRatio * barWidth);
    const done = "\u2501".repeat(doneChars);
    const remaining = "\u2501".repeat(barWidth - doneChars);
    lines.push(`  ${done}${remaining}`);

    // Member rows
    const maxMembers = Math.min(state.members.length, 20);
    for (let i = 0; i < maxMembers; i += 1) {
      const member = state.members[i];
      if (!member) continue;
      const row = renderMemberRow(member, contentWidth, this.frameIndex);
      lines.push(`  ${row}`);
    }

    // Separator
    const sep = "\u2500".repeat(contentWidth);
    lines.push(`  ${sep}`);

    // Footer: counts + tokens + elapsed
    const footer = buildFooter(state, contentWidth);
    lines.push(`  ${footer}`);

    // Bottom border
    const bottom = `\u2514${"\u2500".repeat(contentWidth)}\u2518`;
    lines.push(bottom);

    this.cachedLines = lines;
    this.renderedWidth = safeWidth;
    return this.cachedLines;
  }

  private startAnimation(): void {
    this.animationFrame = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_SPINNER.length;
      this.invalidate();
      this.onRequestRender?.();
    }, FRAME_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderMemberRow(
  member: MemberStatus,
  width: number,
  frameIndex: number,
): string {
  const indexLabel = `#${String(member.index).padStart(2, "0")}`;
  const icon = memberIcon(member, frameIndex);
  const statusLabel = shortPhaseLabel(member.phase);
  const itemLabel = member.item ?? "";

  // Layout: #NN [icon] status  item
  const fixed = `${indexLabel} ${icon} ${statusLabel}`;
  const fixedLen = visibleLen(fixed);

  if (fixedLen >= width) {
    return truncateText(fixed, width);
  }

  const itemSpace = Math.max(0, width - fixedLen - 2);
  const truncatedItem = truncateText(itemLabel, itemSpace);

  return `${fixed}  ${truncatedItem}`;
}

function memberIcon(member: MemberStatus, frameIndex: number): string {
  switch (member.phase) {
    case "completed":
      return BRAILLE_FULL.repeat(2);
    case "failed":
    case "cancelled":
      return "\u2717 ";
    case "pending":
    case "queued":
      return "\u25CB ";
    case "prompting":
    case "working":
    case "suspended":
      return BRAILLE_SPINNER[frameIndex % BRAILLE_SPINNER.length]! + " ";
  }
}

function shortPhaseLabel(phase: MemberPhase): string {
  switch (phase) {
    case "pending":
    case "queued":
      return "wait";
    case "prompting":
      return "init";
    case "working":
      return "work";
    case "completed":
      return "done";
    case "failed":
      return "fail";
    case "cancelled":
      return "abort";
    case "suspended":
      return "retry";
  }
}

function buildFooter(state: SwarmProgressState, width: number): string {
  const usage = state.totalUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const counts = `${state.completed + state.failed}/${state.total} ag`;
  const tokens = `${Math.round(usage.input)}in/${Math.round(usage.output)}out`;
  const elapsed = formatElapsed(Date.now() - state.startedAt);

  const parts: string[] = [counts, tokens, elapsed];
  if (state.failed > 0) parts.splice(1, 0, `${state.failed}fail`);
  if (state.active > 0) parts.splice(1, 0, `${state.active}act`);

  const full = parts.join(" | ");
  if (full.length <= width) return full;
  return truncateText(full, width);
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s`;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function visibleLen(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, 1);
  return text.slice(0, Math.max(0, maxLen - 1)) + "\u2026";
}
