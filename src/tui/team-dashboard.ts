/**
 * tui/team-dashboard — SwarmTeam live phase progress dashboard.
 *
 * Renders a real-time dashboard above the input area when a SwarmTeam
 * run is in progress.  Shows phase statuses with compact braille spinner
 * for active phases, mailbox message count, token usage, and elapsed time.
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
  TeamProgressSnapshot,
  TeamPhaseStatus,
  SubagentUsage,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRAME_INTERVAL_MS = 80;
const MAX_PHASES = 20;
const ICON_COL_WIDTH = 3;

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

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface TeamDashboardState {
  title: string;
  goal: string;
  status: "running" | "completed" | "failed";
  totalPhases: number;
  completedPhases: number;
  failedPhases: number;
  currentPhase?: string;
  currentRoles?: string[];
  phases: TeamPhaseStatusWithMeta[];
  mailboxCount: number;
  totalUsage: SubagentUsage;
  startedAt: number;
}

interface TeamPhaseStatusWithMeta {
  name: string;
  role: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  error?: string;
  phaseStartedAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot conversion
// ---------------------------------------------------------------------------

export function snapshotToDashboardState(
  snapshot: TeamProgressSnapshot,
): TeamDashboardState {
  const now = Date.now();
  const runningPhases = snapshot.phases
    .filter((p) => p.status === "running")
    .map((p) => p.name);
  const runningRoles = snapshot.phases
    .filter((p) => p.status === "running")
    .map((p) => p.role);
  return {
    title: snapshot.title,
    goal: snapshot.goal,
    status: snapshot.status,
    totalPhases: snapshot.totalPhases,
    completedPhases: snapshot.completedPhases,
    failedPhases: snapshot.failedPhases,
    currentPhase:
      runningPhases.length > 0
        ? runningPhases.join(", ")
        : snapshot.currentPhase,
    currentRoles:
      runningRoles.length > 0
        ? runningRoles
        : snapshot.currentRole
          ? [snapshot.currentRole]
          : undefined,
    phases: snapshot.phases.map((p) => ({
      name: p.name,
      role: p.role,
      status: p.status,
      error: p.error,
      phaseStartedAt: p.status === "running" ? now : 0,
    })),
    mailboxCount: snapshot.mailboxCount,
    totalUsage: snapshot.totalUsage,
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
  private frameIndex = 0;

  constructor(onRequestRender?: () => void) {
    this.onRequestRender = onRequestRender;
    this.startAnimation();
  }

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
      this.state_.currentRoles = undefined;
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

    if (!this.state_ || this.state_.phases.length === 0) {
      this.cachedLines = [];
      return this.cachedLines;
    }

    const state = this.state_;
    const lines: string[] = [];
    const contentWidth = safeWidth - 4;

    // Header: just title, truncated to fit
    const header = truncateText(state.title, contentWidth);
    lines.push(`  ${header}`);

    // Overall progress bar
    const barWidth = Math.max(1, contentWidth);
    const total = state.totalPhases || 1;
    const doneRatio = (state.completedPhases + state.failedPhases) / total;
    const doneChars = Math.round(doneRatio * barWidth);
    const done = "\u2501".repeat(doneChars);
    const remaining = "\u2501".repeat(barWidth - doneChars);
    lines.push(`  ${done}${remaining}`);

    // Phase rows
    const maxPhases = Math.min(state.phases.length, MAX_PHASES);
    for (let i = 0; i < maxPhases; i += 1) {
      const phase = state.phases[i];
      if (!phase) continue;
      const row = renderPhaseRow(phase, contentWidth, this.frameIndex);
      lines.push(`  ${row}`);
    }

    // Separator
    const sep = "\u2500".repeat(contentWidth);
    lines.push(`  ${sep}`);

    // Footer with all info
    const footerLine = buildFooter(state, contentWidth);
    lines.push(`  ${footerLine}`);

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

function renderPhaseRow(
  phase: TeamPhaseStatusWithMeta,
  width: number,
  frameIndex: number,
): string {
  const icon = phaseStatusIcon(phase, frameIndex).padEnd(ICON_COL_WIDTH, " ");
  const displayName = shortenPhaseName(phase.name, phase.role);
  const nameWidth = Math.max(6, Math.min(16, Math.floor(width * 0.35)));
  const name = truncateText(displayName, nameWidth).padEnd(nameWidth, " ");

  const fixed = `${icon} ${name}`;
  const remaining = Math.max(0, width - visibleLen(fixed) - 1);

  if (phase.status === "running") {
    const roleLabel = `${phase.role}`;
    return `${fixed} ${truncateText(roleLabel, remaining)}`;
  }

  if (phase.status === "failed" && phase.error) {
    const errorPart = phase.error;
    return `${fixed} ${truncateText(errorPart, remaining)}`;
  }

  if (phase.status === "completed") {
    return `${fixed} ok`;
  }

  if (phase.status === "skipped") {
    return `${fixed} skip`;
  }

  return `${fixed} ...`;
}

function shortenPhaseName(name: string, role: string): string {
  if (name.length <= 12) return name;
  if (name.startsWith(role)) return name.slice(0, Math.max(role.length, 12));
  const parts = name.split("-");
  if (parts.length > 1) {
    return parts.slice(0, 2).join("-");
  }
  return name.slice(0, 12);
}

function phaseStatusIcon(
  phase: TeamPhaseStatusWithMeta,
  frameIndex: number,
): string {
  switch (phase.status) {
    case "completed":
      return "\u2713";
    case "running":
      return BRAILLE_SPINNER[frameIndex % BRAILLE_SPINNER.length]!;
    case "failed":
      return "\u2717";
    case "skipped":
      return "\u2298";
    case "queued":
      return "\u25CB";
  }
}

function buildFooter(state: TeamDashboardState, width: number): string {
  const usage = state.totalUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const phaseCount = `${state.completedPhases + state.failedPhases}/${state.totalPhases}`;
  const tokens = `${Math.round(usage.input)}in/${Math.round(usage.output)}out`;
  const mailbox = state.mailboxCount > 0 ? ` ${state.mailboxCount}msg` : "";
  const elapsed = formatElapsed(Date.now() - state.startedAt);

  const parts = [
    `${phaseCount} ph`,
    tokens,
    mailbox.trim(),
    elapsed,
  ].filter(Boolean);

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
  return text.slice(0, maxLen - 1) + "\u2026";
}
