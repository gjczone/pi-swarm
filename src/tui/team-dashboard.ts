/**
 * tui/team-dashboard — SwarmTeam live progress display (kimi-code style).
 *
 * Minimal, flat list of phases with braille spinners and scrolling activity.
 * No box borders, no panels, no keyboard navigation.
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
  TeamProgressSnapshot,
  TeamPhaseStatus,
  SubagentUsage,
} from "../shared/types.js";

const FRAME_INTERVAL_MS = 80;
const DEBOUNCE_MS = 75;
const POLL_MS = 800;
const MAX_VISIBLE_PHASES = 12;

const BRAILLE_SPINNER = [
  "\u28BF", "\u28FB", "\u28FD", "\u28FE",
  "\u28F7", "\u28EF", "\u28DF", "\u287F",
] as const;

export interface TeamDashboardState {
  title: string;
  goal: string;
  status: "running" | "completed" | "failed";
  totalPhases: number;
  completedPhases: number;
  failedPhases: number;
  phases: PhaseDisplayStatus[];
  mailboxCount: number;
  totalUsage: SubagentUsage;
  startedAt: number;
}

interface PhaseDisplayStatus {
  name: string;
  role: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  error?: string;
  currentTool?: string;
  activity?: string;
}

export function snapshotToDashboardState(
  snapshot: TeamProgressSnapshot,
  _mailboxPath?: string,
): TeamDashboardState {
  return {
    title: snapshot.title,
    goal: snapshot.goal,
    status: snapshot.status,
    totalPhases: snapshot.totalPhases,
    completedPhases: snapshot.completedPhases,
    failedPhases: snapshot.failedPhases,
    phases: snapshot.phases.map((p) => ({
      name: p.name,
      role: p.role,
      status: p.status,
      error: p.error,
      currentTool: p.currentTool,
      activity: p.activity,
    })),
    mailboxCount: snapshot.mailboxCount,
    totalUsage: snapshot.totalUsage,
    startedAt: snapshot.startedAt,
  };
}

export class TeamDashboardComponent implements Component {
  private state_: TeamDashboardState | null = null;
  private onRequestRender: (() => void) | undefined;
  private animationFrame: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingInvalidate = false;

  constructor(onRequestRender?: () => void) {
    this.onRequestRender = onRequestRender;
    this.startPolling();
    this.startAnimation();
  }

  update(state: TeamDashboardState): void {
    this.state_ = state;
    this.requestRender();
  }

  complete(): void {
    if (this.state_) {
      this.state_.phases.forEach((p) => {
        if (p.status === "queued" || p.status === "running") p.status = "completed";
      });
      this.state_.status = "completed";
      this.state_.completedPhases = this.state_.totalPhases - this.state_.failedPhases;
    }
    this.requestRender();
  }

  dispose(): void { this.stopTimers(); this.onRequestRender = undefined; }
  invalidate(): void { /* no-op */ }
  handleInput(_data: string): void { /* kimi-code style: no keyboard interaction */ }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    if (!this.state_ || this.state_.phases.length === 0) return [];
    const state = this.state_;
    const cw = safeWidth - 2;
    const lines: string[] = [];

    // Header
    const done = state.completedPhases + state.failedPhases;
    const total = state.totalPhases;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const suffix = `  ${done}/${total} (${pct}%)  ${elapsed}`;
    const maxTitleLen = Math.max(4, cw - visibleLen(suffix));
    const headerText = truncateText(state.title, maxTitleLen);
    lines.push(truncateText(`${headerText}${suffix}`, cw));

    // Phase rows
    const maxP = Math.min(state.phases.length, MAX_VISIBLE_PHASES);
    for (let i = 0; i < maxP; i++) {
      const p = state.phases[i];
      if (!p) continue;
      lines.push(renderPhaseRow(p, cw, this.frameIndex));
    }
    if (state.phases.length > MAX_VISIBLE_PHASES) {
      lines.push(`  ... ${state.phases.length - MAX_VISIBLE_PHASES} more`);
    }

    // Footer: mailbox count only
    if (state.mailboxCount > 0) {
      lines.push(truncateText(`Mailbox msg: ${state.mailboxCount}`, cw));
    }
    return lines;
  }

  private requestRender(): void {
    if (this.debounceTimer !== undefined) { this.pendingInvalidate = true; return; }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.pendingInvalidate = false;
      this.onRequestRender?.();
    }, DEBOUNCE_MS);
    this.onRequestRender?.();
  }

  private startPolling(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.state_) this.onRequestRender?.();
      this.startPolling();
    }, POLL_MS);
  }

  private startAnimation(): void {
    this.animationFrame = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_SPINNER.length;
      if (this.state_?.phases.some((p) => p.status === "running")) this.onRequestRender?.();
    }, FRAME_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.animationFrame !== undefined) { clearInterval(this.animationFrame); this.animationFrame = undefined; }
    if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.pollTimer !== undefined) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
  }
}

function renderPhaseRow(phase: PhaseDisplayStatus, width: number, frameIndex: number): string {
  const icon = phaseStatusIcon(phase, frameIndex);
  const name = truncateText(phase.name, Math.max(6, Math.floor(width * 0.3)));
  const fixed = `${icon} ${name}`;
  const remaining = Math.max(0, width - visibleLen(fixed) - 2);

  if (phase.status === "running") {
    const info = phase.currentTool
      ? phase.activity ? `${phase.currentTool}: ${phase.activity}` : phase.currentTool
      : phase.activity ?? phase.role;
    return `${fixed} ${truncateText(info, remaining)}`;
  }
  if (phase.status === "completed") return `${fixed} ok`;
  if (phase.status === "failed" && phase.error) return `${fixed} ${truncateText(phase.error, Math.min(remaining, 30))}`;
  if (phase.status === "skipped") return `${fixed} skip`;
  return `${fixed} ...`;
}

function phaseStatusIcon(phase: PhaseDisplayStatus, frameIndex: number): string {
  switch (phase.status) {
    case "completed": return "\u2713";
    case "running": return BRAILLE_SPINNER[frameIndex % BRAILLE_SPINNER.length]!;
    case "failed": return "\u2717";
    case "skipped": return "\u2298";
    case "queued": return "\u25CB";
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

function visibleLen(text: string): number { return text.replace(/\x1b\[[0-9;]*m/g, "").length; }
function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, 1);
  return text.slice(0, maxLen - 1) + "\u2026";
}
