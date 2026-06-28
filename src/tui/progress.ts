/**
 * tui/progress — AgentSwarm live progress panel (minimal).
 *
 * Grid layout with braille progress bars and scrolling model output.
 * - Multiple agents: grid cells with ID + braille bar + model text
 * - Single agent: compact status line with spinner + text
 * - No token/in/out display — replaced by scrolling model output
 *
 * Architecture reference: AgentSwarm pattern.
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

const BRAILLE_LEVELS = [
  "\u28C0", "\u28C4", "\u28E4", "\u28E6",
  "\u28F6", "\u28F7", "\u28FF",
] as const;

const BRAILLE_EMPTY = "\u2800"; // truly empty braille cell (no dots)
const BRAILLE_SPINNER = [
  "\u28BF", "\u28FB", "\u28FD", "\u28FE",
  "\u28F7", "\u28EF", "\u28DF", "\u287F",
] as const;

const FRAME_INTERVAL_MS = 80;
const DEBOUNCE_MS = 75;
const POLL_MS = 800;
const MAX_VISIBLE_MEMBERS = 20;
const CELL_GAP = "  ";
const BRAILLE_BAR_MIN_WIDTH = 2;
const BRAILLE_BAR_MAX_WIDTH = 5;
const ID_WIDTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberPhase =
  | "pending" | "queued" | "prompting" | "working"
  | "completed" | "failed" | "cancelled" | "suspended";

export interface MemberStatus {
  readonly index: number;
  phase: MemberPhase;
  item?: string;
  result?: string;
  error?: string;
  currentTool?: string;
  activity?: string;
  usage?: SubagentUsage;
  progressTick?: number;
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
  mailbox?: boolean;
  mailboxCount?: number;
}

// ---------------------------------------------------------------------------
// Snapshot conversion
// ---------------------------------------------------------------------------

export function snapshotToProgressState(
  snapshot: BatchProgressSnapshot,
  title?: string,
): SwarmProgressState {
  return {
    title,
    total: snapshot.total,
    completed: snapshot.completed,
    failed: snapshot.failed,
    active: snapshot.active,
    queued: snapshot.queued,
    members: snapshot.members.map((m: BatchMemberStatus): MemberStatus => ({
      index: m.index,
      phase: mapMemberPhase(m.phase),
      item: m.item,
      error: m.error,
      currentTool: m.currentTool,
      activity: m.activity,
      usage: m.usage,
      progressTick: m.progressTick,
    })),
    totalUsage: snapshot.totalUsage,
    startedAt: snapshot.startedAt ?? Date.now(),
  };
}

function mapMemberPhase(phase: BatchMemberStatus["phase"]): MemberPhase {
  switch (phase) {
    case "queued": return "queued";
    case "working": return "working";
    case "completed": return "completed";
    case "failed": return "failed";
    case "suspended": return "suspended";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class AgentSwarmProgressComponent implements Component {
  private state_: SwarmProgressState | null = null;
  private onRequestRender: (() => void) | undefined;
  private animationFrame: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(onRequestRender?: () => void) {
    this.onRequestRender = onRequestRender;
    this.startPolling();
    this.startAnimation();
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  update(state: SwarmProgressState): void {
    this.state_ = state;
    this.requestRender();
  }

  complete(): void {
    if (this.state_) {
      for (const m of this.state_.members) {
        if (m.phase !== "completed" && m.phase !== "failed" && m.phase !== "cancelled") {
          m.phase = "completed";
        }
      }
      this.state_.active = 0;
      this.state_.queued = 0;
      this.state_.completed = this.state_.total - this.state_.failed;
    }
    this.requestRender();
  }

  dispose(): void { this.stopTimers(); this.onRequestRender = undefined; }
  invalidate(): void { /* no-op */ }
  handleInput(_data: string): void { /* minimal: no keyboard */ }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    if (!this.state_ || this.state_.members.length === 0) return [];
    const state = this.state_;

    const lines: string[] = [];

    // Layout: header → grid → status line
    lines.push(this.renderHeader(safeWidth, state));
    lines.push("");

    if (state.members.length === 1) {
      // Single agent: compact line, no grid
      const row = this.renderSingleAgent(state.members[0]!, safeWidth - 2);
      lines.push(row);
    } else {
      // Multiple agents: grid layout
      const gridLines = this.renderGrid(safeWidth - 2, state);
      lines.push(...gridLines);
    }

    lines.push("");
    // Bottom separator
    const sepWidth = safeWidth - 2;
    lines.push(truncateText(repeatStr("─", sepWidth), sepWidth));
    lines.push(this.renderStatusLine(safeWidth, state));

    return lines;
  }

  // -------------------------------------------------------------------
  // Kimi-code style header: ─ Agent Swarm ─ description ──────
  // -------------------------------------------------------------------

  private renderHeader(width: number, state: SwarmProgressState): string {
    const mode = state.mailbox ? "Swarm Team" : "Agent Swarm";
    const desc = state.title ?? "";
    const mailboxInfo = state.mailboxCount && state.mailboxCount > 0 ? ` │ Mailbox: ${state.mailboxCount}` : "";
    // ─ Agent Swarm ─ <desc> ──────  or  ─ Swarm Team ─ <desc> ─ Mailbox: 3
    const prefix = `─ ${mode}`;
    const content = desc ? ` ─ ${desc}` : "";
    const label = `${prefix}${content}${mailboxInfo}`;
    const suffixLen = Math.max(0, width - visibleLen(label) - 2);
    const suffix = suffixLen > 0 ? ` ─${repeatStr("─", suffixLen)}` : "";
    return truncateText(`${label}${suffix}`, width);
  }

  // -------------------------------------------------------------------
  // Status line
  // -------------------------------------------------------------------

  private renderStatusLine(width: number, state: SwarmProgressState): string {
    const done = state.completed + state.failed;
    const total = state.total;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const elapsed = formatElapsed(Date.now() - state.startedAt);
    const label = state.active > 0 ? "Working..." : "Completed";
    return truncateText(`${label}  ${done}/${total} (${pct}%)  ${elapsed}`, width);
  }

  // -------------------------------------------------------------------
  // Single agent mode
  // -------------------------------------------------------------------

  private renderSingleAgent(member: MemberStatus, width: number): string {
    const spinner = member.phase === "working" || member.phase === "prompting"
      ? BRAILLE_SPINNER[this.frameIndex % BRAILLE_SPINNER.length]
      : member.phase === "completed" ? "\u2713"
        : member.phase === "failed" ? "\u2717" : "\u25CB";

    const item = member.item ?? `#${String(member.index).padStart(2, "0")}`;
    const itemTrunc = truncateText(item, Math.max(4, Math.floor(width * 0.4)));

    let suffix = "";
    const remaining = Math.max(0, width - visibleLen(`${spinner} ${itemTrunc}`) - 2);
    if (member.phase === "working" && member.activity && remaining > 4) {
      suffix = ` ${truncateText(member.activity, Math.min(remaining - 1, width - 10))}`;
    } else if (member.phase === "completed") {
      suffix = " ok";
    } else if (member.phase === "failed" && member.error && remaining > 4) {
      suffix = ` ${truncateText(member.error, Math.min(remaining - 1, 30))}`;
    }

    // No braille bar for single agent — just spinner + item + scrolling text
    return truncateText(`${spinner} ${itemTrunc}${suffix}`, width);
  }

  // -------------------------------------------------------------------
  // Grid layout (multiple agents)
  // -------------------------------------------------------------------

  private renderGrid(width: number, state: SwarmProgressState): string[] {
    const count = Math.min(state.members.length, MAX_VISIBLE_MEMBERS);
    if (count <= 0) return [];

    // Calculate grid dimensions
    const gapWidth = visibleLen(CELL_GAP);
    const minLabelWidth = 8;
    const estCellWidth = ID_WIDTH + BRAILLE_BAR_MIN_WIDTH + minLabelWidth;
    const columns = Math.max(1, Math.min(count, Math.floor((width + gapWidth) / (estCellWidth + gapWidth))));
    const rows = Math.ceil(count / columns);
    const actualCellWidth = Math.floor((width - gapWidth * (columns - 1)) / columns);
    // Bar gets what's left after ID + minimum label; cap to keep label readable
    const barCells = Math.max(
      BRAILLE_BAR_MIN_WIDTH,
      Math.min(BRAILLE_BAR_MAX_WIDTH, actualCellWidth - ID_WIDTH - minLabelWidth),
    );
    const leftPad = Math.floor((width - (actualCellWidth * columns + gapWidth * (columns - 1))) / 2);

    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = " ".repeat(Math.max(0, leftPad));
      for (let col = 0; col < columns; col++) {
        const idx = row * columns + col;
        const member = state.members[idx];
        if (!member) continue;
        const cell = this.renderCell(member, actualCellWidth, barCells);
        line += cell;
        if (col < columns - 1) line += CELL_GAP;
      }
      lines.push(truncateText(line, width));
    }

    // Extra info line for truncated members
    if (state.members.length > MAX_VISIBLE_MEMBERS) {
      lines.push(`  ... ${state.members.length - MAX_VISIBLE_MEMBERS} more`);
    }

    return lines;
  }

  private renderCell(member: MemberStatus, cellWidth: number, barCells: number): string {
    const id = String(member.index).padStart(ID_WIDTH, "0");
    const bar = this.renderBrailleBar(member, barCells);
    const label = this.renderCellLabel(member, Math.max(1, cellWidth - ID_WIDTH - barCells - 3));
    return `${id} ${bar}${label ? " " + label : ""}`;
  }

  private renderBrailleBar(member: MemberStatus, width: number): string {
    if (width <= 0) return "";
    const capacity = width * BRAILLE_LEVELS.length;
    const ticks = member.phase === "completed"
      ? capacity
      : member.phase === "working"
        ? Math.min(capacity, (member.progressTick ?? 0) + this.frameIndex % 3)
        : 0;

    const fullBars = Math.floor(ticks / BRAILLE_LEVELS.length);
    const partial = ticks % BRAILLE_LEVELS.length;
    const partialChar = partial > 0 ? BRAILLE_LEVELS[partial - 1]! : "";

    let bar = "";
    for (let i = 0; i < width; i++) {
      if (i < fullBars) {
        bar += BRAILLE_LEVELS[BRAILLE_LEVELS.length - 1]!; // Full █
      } else if (i === fullBars && partialChar) {
        bar += partialChar;
      } else {
        bar += BRAILLE_EMPTY;
      }
    }
    return bar;
  }

  private renderCellLabel(member: MemberStatus, width: number): string {
    if (width <= 0) return "";

    // Show latest activity (model output or tool call) for running agents
    if (member.phase === "working" || member.phase === "prompting") {
      const text = member.activity ?? member.item ?? "";
      return truncateText(text, width);
    }
    if (member.phase === "completed") return truncateText("ok", width);
    if (member.phase === "failed" && member.error) return truncateText(member.error, Math.min(width, 20));
    if (member.phase === "queued") return truncateText(member.item ?? "...", width);

    return "";
  }

  // -------------------------------------------------------------------
  // Render scheduling
  // -------------------------------------------------------------------

  private requestRender(): void {
    if (this.debounceTimer !== undefined) { return; }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
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
      const hasActive = this.state_?.active ?? 0 > 0;
      if (hasActive) this.onRequestRender?.();
    }, FRAME_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.animationFrame !== undefined) { clearInterval(this.animationFrame); this.animationFrame = undefined; }
    if (this.debounceTimer !== undefined) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    if (this.pollTimer !== undefined) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
  }
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

function repeatStr(ch: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += ch;
  return out;
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

function visibleLen(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return text.slice(0, 1);
  return text.slice(0, maxLen - 1) + "\u2026";
}
