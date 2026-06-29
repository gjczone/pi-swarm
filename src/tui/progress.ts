/**
 * tui/progress — AgentSwarm live progress panel.
 *
 * Vertical panel layout with fixed-width tool-call-based braille progress
 * bars and inline activity text.  Each agent renders as a single line:
 *   001 [braille bar] read: src/lib.rs lines 42-99
 * Bar width is fixed (5 cells) so tool labels align across agents.
 *
 * Progress is driven by actual tool calls / activity events (progressTick),
 * not wall-clock time.  An agent that makes more progress fills faster.
 *
 * For 5+ agents, switches to a 2-column compact grid (3-cell bars).
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
  "\u28C0",
  "\u28C4",
  "\u28E4",
  "\u28E6",
  "\u28F6",
  "\u28F7",
  "\u28FF",
] as const;

const BRAILLE_EMPTY = "\u28C0"; // baseline empty (bottom dots), so bar track is always visible

const DEBOUNCE_MS = 75;
const POLL_MS = 800;
const MAX_VISIBLE_MEMBERS = 20;
const ID_WIDTH = 3;

// Fixed-width braille bar — all agents share the same width so labels align.
// Vertical mode: 5 cells, grid mode: 3 cells.
const FIXED_BAR_CELLS = 5;
const GRID_BAR_CELLS = 3;

// Layout: agents shown vertically when count <= this
const VERTICAL_LAYOUT_MAX = 4;

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
  currentTool?: string;
  activity?: string;
  usage?: SubagentUsage;
  progressTick?: number;
  startedAt?: number;
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
      startedAt: m.startedAt,
    })),
    totalUsage: snapshot.totalUsage,
    startedAt: snapshot.startedAt ?? Date.now(),
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class AgentSwarmProgressComponent implements Component {
  private state_: SwarmProgressState | null = null;
  private onRequestRender: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(onRequestRender?: () => void) {
    this.onRequestRender = onRequestRender;
    this.startPolling();
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
        if (
          m.phase !== "completed" &&
          m.phase !== "failed" &&
          m.phase !== "cancelled"
        ) {
          m.phase = "completed";
        }
      }
      this.state_.active = 0;
      this.state_.queued = 0;
      this.state_.completed = this.state_.total - this.state_.failed;
    }
    this.requestRender();
  }

  dispose(): void {
    this.stopTimers();
    this.onRequestRender = undefined;
  }
  invalidate(): void {
    /* no-op */
  }
  handleInput(_data: string): void {
    /* minimal: no keyboard */
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    if (!this.state_ || this.state_.members.length === 0) return [];
    const state = this.state_;

    const lines: string[] = [];

    // Header: ─ Agent Swarm ─ <title> ──────────
    lines.push(this.renderHeader(safeWidth, state));
    lines.push("");

    // Agent panels (vertical or compact grid)
    const memberLines = this.renderAgentPanels(safeWidth - 2, state);
    lines.push(...memberLines);

    lines.push("");

    // Bottom separator
    const sepWidth = safeWidth - 2;
    lines.push(truncateText(repeatStr("\u2500", sepWidth), sepWidth));

    // Status line: Working...  N/M (P%)  elapsed
    lines.push(this.renderStatusLine(safeWidth, state));

    return lines;
  }

  // -------------------------------------------------------------------
  // Header: ─ Agent Swarm ─ <desc> ──────────
  // -------------------------------------------------------------------

  private renderHeader(width: number, state: SwarmProgressState): string {
    const mode = state.mailbox ? "Swarm Team" : "Agent Swarm";
    const desc = state.title ?? "";
    const mailboxInfo =
      state.mailboxCount && state.mailboxCount > 0
        ? ` | Mailbox: ${state.mailboxCount}`
        : "";
    const prefix = `\u2500 ${mode}`;
    const content = desc ? ` \u2500 ${desc}` : "";
    const label = `${prefix}${content}${mailboxInfo}`;
    const suffixLen = Math.max(0, width - visibleLen(label) - 2);
    const suffix =
      suffixLen > 0 ? ` \u2500${repeatStr("\u2500", suffixLen)}` : "";
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
    return truncateText(
      `${label}  ${done}/${total} (${pct}%)  ${elapsed}`,
      width,
    );
  }

  // -------------------------------------------------------------------
  // Agent panel layout selection
  // -------------------------------------------------------------------

  /**
   * Render all agents.  Uses vertical panels for small counts
   * and a compact 2-column grid for larger batches.
   */
  private renderAgentPanels(
    width: number,
    state: SwarmProgressState,
  ): string[] {
    const count = Math.min(state.members.length, MAX_VISIBLE_MEMBERS);
    if (count <= 0) return [];

    if (count <= VERTICAL_LAYOUT_MAX) {
      return this.renderVerticalPanels(width, state);
    }
    return this.renderCompactGrid(width, state);
  }

  // -------------------------------------------------------------------
  // Vertical panel layout (1-4 agents)
  //
  // Each agent is a single line with live activity inline:
  //   001 [▓▓▓▓▓░░░] read: src/lib.rs lines 42-99
  //   (blank line between agents)
  // -------------------------------------------------------------------

  private renderVerticalPanels(
    width: number,
    state: SwarmProgressState,
  ): string[] {
    const count = Math.min(state.members.length, MAX_VISIBLE_MEMBERS);
    const lines: string[] = [];

    for (let i = 0; i < count; i++) {
      const member = state.members[i]!;
      lines.push(this.renderAgentLine(member, width));
      if (i < count - 1) {
        lines.push(""); // blank line separator between agents
      }
    }

    if (state.members.length > MAX_VISIBLE_MEMBERS) {
      lines.push(`  ... ${state.members.length - MAX_VISIBLE_MEMBERS} more`);
    }

    return lines;
  }

  /**
   * Render one agent as a single line with fixed-width progress bar.
   *
   * Format: `001 [braille bar] read: src/lib.rs lines 42-99`
   * Bar is always FIXED_BAR_CELLS (5) wide so tool labels align across agents.
   *
   * Progress is driven by progressTick (actual tool calls / activity events),
   * not wall-clock time.  Each tick fills one level of the braille bar.
   */
  private renderAgentLine(member: MemberStatus, width: number): string {
    const id = String(member.index).padStart(ID_WIDTH, "0");

    // Fixed bar width — ensures all agent labels align
    const barCells = FIXED_BAR_CELLS;

    // Label gets the remaining space after id + bar + fixed gaps
    const labelWidth = Math.max(4, width - ID_WIDTH - barCells - 4);
    const bar = this.renderBrailleBar(member, barCells);
    const label = this.renderCellLabel(member, labelWidth);

    return truncateText(`${id} ${bar} ${label}`, width);
  }

  // -------------------------------------------------------------------
  // Compact grid layout (5+ agents)
  //
  // 2 columns, single-line cells:
  //   001 [▓▓▓] task    002 [▓▓▓] task
  //   003 [▓▓▓] task    004 [▓▓▓] task
  // -------------------------------------------------------------------

  private renderCompactGrid(
    width: number,
    state: SwarmProgressState,
  ): string[] {
    const cols = 2;
    const count = Math.min(state.members.length, MAX_VISIBLE_MEMBERS);
    const gap = 3; // spaces between columns
    const cellWidth = Math.floor((width - gap) / cols);
    const rows = Math.ceil(count / cols);

    const lines: string[] = [];
    for (let row = 0; row < rows; row++) {
      let line = "";
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        if (idx >= count) break;

        const member = state.members[idx]!;
        const cw = col < cols - 1 ? cellWidth : width - line.length;
        const cell = this.renderGridCell(member, cw);
        line += cell;

        if (col < cols - 1) {
          // Pad to fill the remaining cell width + gap
          const padLen = Math.max(0, cellWidth - visibleLen(cell) + gap);
          line += " ".repeat(padLen);
        }
      }
      lines.push(truncateText(line, width));
    }

    if (state.members.length > MAX_VISIBLE_MEMBERS) {
      lines.push(`  ... ${state.members.length - MAX_VISIBLE_MEMBERS} more`);
    }

    return lines;
  }

  /**
   * Compact single-line grid cell.
   * Format: `001 [▓▓] label`
   */
  private renderGridCell(member: MemberStatus, width: number): string {
    const id = String(member.index).padStart(ID_WIDTH, "0");

    // Compact grid uses fewer bar cells
    const barCells = GRID_BAR_CELLS;

    const bar = this.renderBrailleBar(member, barCells);
    const labelWidth = Math.max(2, width - ID_WIDTH - barCells - 4);
    const label = this.renderCellLabel(member, labelWidth);

    return `${id} ${bar} ${label}`;
  }

  // -------------------------------------------------------------------
  // Braille progress bar
  //
  // Tool-call-based progress for working agents:
  //   - Each progressTick (tool call / activity event) fills one level.
  //   - Bar fills up as the agent works; capped at 85% so completed
  //     agents (full bar) are visually distinguishable from working ones.
  //   - Empty cells show the baseline character so the bar track is always visible.
  //
  // Completed agents: full bar
  // Failed agents: half bar
  // Queued/suspended: empty bar (baseline only)
  // -------------------------------------------------------------------

  private renderBrailleBar(member: MemberStatus, width: number): string {
    if (width <= 0) return "";
    const capacity = width * BRAILLE_LEVELS.length;

    let ticks: number;

    if (member.phase === "completed") {
      ticks = capacity;
    } else if (member.phase === "failed") {
      ticks = Math.floor(capacity / 2);
    } else if (member.phase === "working" || member.phase === "prompting") {
      // Fill based on actual tool-call progress.
      // Each tool execution or model output event increments progressTick by 1.
      // Cap at 85% so "almost done" is visually distinct from "completed".
      ticks = Math.min(member.progressTick ?? 0, Math.floor(capacity * 0.85));
    } else {
      ticks = 0;
    }

    const fullBars = Math.floor(ticks / BRAILLE_LEVELS.length);
    const partial = ticks % BRAILLE_LEVELS.length;
    const partialChar = partial > 0 ? BRAILLE_LEVELS[partial - 1]! : "";

    let bar = "";
    for (let i = 0; i < width; i++) {
      if (i < fullBars) {
        bar += BRAILLE_LEVELS[BRAILLE_LEVELS.length - 1]!; // Full cell
      } else if (i === fullBars && partialChar) {
        bar += partialChar;
      } else {
        bar += BRAILLE_EMPTY;
      }
    }
    return bar;
  }

  // -------------------------------------------------------------------
  // Cell label rendering
  // -------------------------------------------------------------------

  private renderCellLabel(member: MemberStatus, width: number): string {
    if (width <= 0) return "";

    if (member.phase === "working" || member.phase === "prompting") {
      // Show tool: activity_text (scrolling model output / shell command)
      const toolPart = member.currentTool ? `${member.currentTool}: ` : "";
      const activityText = member.activity ?? member.item ?? "";
      const text = toolPart + activityText;
      return truncateText(text, width);
    }
    if (member.phase === "completed") return truncateText("ok", width);
    if (member.phase === "failed" && member.error)
      return truncateText(member.error, Math.min(width, 20));
    if (member.phase === "queued" || member.phase === "suspended")
      return truncateText(member.item ?? "...", width);

    return "";
  }

  // -------------------------------------------------------------------
  // Render scheduling
  // -------------------------------------------------------------------

  private requestRender(): void {
    if (this.debounceTimer !== undefined) {
      return;
    }
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

  private stopTimers(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
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
