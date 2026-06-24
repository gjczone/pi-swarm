/**
 * tui/team-dashboard — SwarmTeam live phase progress dashboard.
 *
 * Renders a real-time dashboard above the input area when a SwarmTeam
 * run is in progress.  Shows phase statuses with braille animation for
 * the active phase, mailbox message count, and elapsed time.
 *
 * Follows the same wiring pattern as AgentSwarmProgressComponent:
 * supervisor emits snapshots -> tool converts -> pushes to widget.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { TeamProgressSnapshot, TeamPhaseStatus } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants (shared braille with progress.ts for visual consistency)
// ---------------------------------------------------------------------------

const BRAILLE_BAR_MAX_WIDTH = 8;
const FRAME_INTERVAL_MS = 80;
const MAX_PHASES = 20;

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

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

/** Dashboard state for the team progress widget. */
export interface TeamDashboardState {
  title: string;
  goal: string;
  status: "running" | "completed" | "failed";
  totalPhases: number;
  completedPhases: number;
  failedPhases: number;
  currentPhase?: string;
  currentRole?: string;
  phases: TeamPhaseStatusWithMeta[];
  mailboxCount: number;
  startedAt: number;
}

interface TeamPhaseStatusWithMeta {
  name: string;
  role: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  error?: string;
  /** Timestamp when this phase entered its current status. */
  phaseStartedAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot conversion
// ---------------------------------------------------------------------------

/**
 * Convert a TeamProgressSnapshot from the supervisor into the
 * TeamDashboardState expected by TeamDashboardComponent.
 */
export function snapshotToDashboardState(
  snapshot: TeamProgressSnapshot,
): TeamDashboardState {
  const now = Date.now();
  return {
    title: snapshot.title,
    goal: snapshot.goal,
    status: snapshot.status,
    totalPhases: snapshot.totalPhases,
    completedPhases: snapshot.completedPhases,
    failedPhases: snapshot.failedPhases,
    currentPhase: snapshot.currentPhase,
    currentRole: snapshot.currentRole,
    phases: snapshot.phases.map((p) => ({
      name: p.name,
      role: p.role,
      status: p.status,
      error: p.error,
      phaseStartedAt: p.status === "running" ? now : 0,
    })),
    mailboxCount: snapshot.mailboxCount,
    startedAt: snapshot.startedAt,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class TeamDashboardComponent implements Component {
  private state_: TeamDashboardState | null = null;
  private animationFrame: ReturnType<typeof setInterval> | undefined;
  private renderedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private onRequestRender: (() => void) | undefined;

  /**
   * @param onRequestRender  Optional callback to request a TUI re-render.
   *   When provided, called on every animation tick so the braille bars
   *   animate.  Without it the component still renders correctly but the
   *   animation won't be visible to the user.
   *
   *   业务说明：TUI 框架不会自动轮询组件；需要通过 requestRender() 主动
   *   触发重绘才能使 braille 进度条动起来。此回调由 setWidget 工厂函数
   *   在捕获 tui 引用后传入。
   */
  constructor(onRequestRender?: () => void) {
    this.onRequestRender = onRequestRender;
    this.startAnimation();
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  update(state: TeamDashboardState): void {
    this.state_ = state;
    this.invalidate();
  }

  complete(): void {
    if (this.state_) {
      this.state_.phases.forEach((p) => {
        if (p.status === "queued" || p.status === "running") {
          p.status = "completed";
        }
      });
      this.state_.status = "completed";
      this.state_.completedPhases =
        this.state_.totalPhases - this.state_.failedPhases;
      this.state_.currentPhase = undefined;
    }
    this.invalidate();
  }

  dispose(): void {
    if (this.animationFrame !== undefined) {
      clearInterval(this.animationFrame);
      this.animationFrame = undefined;
    }
    // 断开与 TUI 框架的连接，防止内存泄漏
    this.onRequestRender = undefined;
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

    if (!this.state_ || this.state_.phases.length === 0) {
      this.cachedLines = [];
      return this.cachedLines;
    }

    const state = this.state_;
    const lines: string[] = [];

    // Header
    const header = buildHeader(state, safeWidth);
    lines.push(header);

    // Overall progress bar
    const bar = buildProgressBar(state, safeWidth);
    lines.push(bar);

    // Phase rows
    const maxPhases = Math.min(state.phases.length, MAX_PHASES);
    for (let i = 0; i < maxPhases; i += 1) {
      const phase = state.phases[i];
      if (!phase) continue;
      const row = renderPhaseRow(phase, safeWidth - 4);
      lines.push(`  ${row}`);
    }

    // Separator
    const sep = "\u2500".repeat(Math.max(0, safeWidth - 4));
    lines.push(`  ${sep}`);

    // Footer
    const footerLine = buildFooter(state, safeWidth - 2);
    lines.push(`  ${footerLine}`);

    // Bottom border
    const bottom = bottomBorder(safeWidth);
    lines.push(bottom);

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
      // 通知 TUI 框架重绘，使 braille 动画可见
      this.onRequestRender?.();
    }, FRAME_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function buildHeader(state: TeamDashboardState, width: number): string {
  const titleLine = `Team: ${state.title}`;
  const status = state.status;
  const phaseInfo = state.currentPhase
    ? `Phase: ${state.completedPhases + 1}/${state.totalPhases} (${state.currentPhase})`
    : `Phases: ${state.completedPhases}/${state.totalPhases}`;
  const full = `${titleLine}  |  Status: ${status}  |  ${phaseInfo}`;
  if (full.length <= width) return full;
  // Truncate to fit width — preserve the beginning which has the most info
  return full.slice(0, width);
}

function buildProgressBar(state: TeamDashboardState, width: number): string {
  const barWidth = Math.max(1, width - 4);
  const total = state.totalPhases || 1;
  const doneRatio = (state.completedPhases + state.failedPhases) / total;
  const doneChars = Math.round(doneRatio * barWidth);
  const remainingChars = barWidth - doneChars;
  const done = "\u2501".repeat(doneChars);
  const remaining = "\u2501".repeat(remainingChars);
  return `  ${done}${remaining}`;
}

function renderPhaseRow(phase: TeamPhaseStatusWithMeta, width: number): string {
  const statusIcon = phaseStatusIcon(phase);
  const phaseName = truncateText(phase.name, 14);
  const statusLabel = phase.status;
  const roleLabel = `(${phase.role})`;

  // Layout: <icon> <phaseName> <status> <role>
  const fixed = `${statusIcon} ${phaseName} ${statusLabel} ${roleLabel}`;
  const fixedLen = visibleLen(fixed);

  // If the fixed part alone exceeds width, truncate it
  if (fixedLen >= width) {
    return fixed.slice(0, width);
  }

  if (phase.status === "failed" && phase.error) {
    const errorPart = ` — ${phase.error}`;
    const avail = Math.max(0, width - fixedLen);
    const full = `${fixed}${errorPart.slice(0, avail)}`;
    return full.slice(0, width);
  }

  return fixed;
}

function phaseStatusIcon(phase: TeamPhaseStatusWithMeta): string {
  switch (phase.status) {
    case "completed":
      return "\u2713"; // checkmark
    case "running":
      return renderBrailleBar(phase);
    case "failed":
      return "\u2717"; // x mark
    case "skipped":
      return "\u2298"; // slashed circle
    case "queued":
      return "\u25CB"; // circle
  }
}

function renderBrailleBar(phase: TeamPhaseStatusWithMeta): string {
  const elapsed = Date.now() - phase.phaseStartedAt;
  const cycleMs = 800;
  const progress = (elapsed % cycleMs) / cycleMs;

  const maxWidth = BRAILLE_BAR_MAX_WIDTH;
  const totalDots = maxWidth * 6;
  const filledDots = Math.floor(progress * totalDots);

  let result = "";
  for (let i = 0; i < maxWidth; i += 1) {
    const cellStart = i * 6;
    const dotsInCell = Math.max(0, Math.min(6, filledDots - cellStart));
    result += dotsInCell === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[dotsInCell]!;
  }
  return result;
}

function buildFooter(state: TeamDashboardState, width: number): string {
  const mailbox = `Mailbox: ${state.mailboxCount > 0 ? String(state.mailboxCount) : "0"} messages`;
  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const full = `${mailbox}  |  Elapsed: ${elapsed}`;
  if (full.length <= width) return full;
  return full.slice(0, width);
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function bottomBorder(width: number): string {
  return `\u2514${"\u2500".repeat(Math.max(0, width - 2))}\u2518`;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function visibleLen(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)) + "\u2026";
}
