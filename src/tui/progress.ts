/**
 * tui/progress — AgentSwarm live progress panel.
 *
 * Renders a real-time progress display above the input area when
 * an AgentSwarm batch is running. Each subagent gets a compact braille
 * spinner with status and item description.
 *
 * Features:
 * - Debounced, event-driven rendering (replaces pure setInterval polling)
 * - Keyboard interaction: j/k scroll, Enter detail, ? help, tab panel switch
 * - Panel switching: members list / event log
 * - Detail overlay for individual members
 * - Activity/tool tracking per member
 * - ETA estimation
 *
 * Ported from MoonshotAI/kimi-code's AgentSwarmProgressComponent.
 */

import type { Component } from "@earendil-works/pi-tui";
import {
  matchesKey,
  Key,
  isKeyRepeat,
} from "@earendil-works/pi-tui";
import type {
  BatchProgressSnapshot,
  BatchMemberStatus,
  SubagentUsage,
  ProgressEvent,
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

/** Maximum members shown at once in the list view. */
const VISIBLE_MEMBERS = 8;

/** Maximum events shown in the event log panel. */
const VISIBLE_EVENTS = 10;

/** Debounce window for coalescing render requests. */
const DEBOUNCE_MS = 75;

/** Fallback polling interval when state is active (has running members). */
const ACTIVE_POLL_MS = 800;

/** Fallback polling interval when idle (no running members). */
const IDLE_POLL_MS = 2000;

/** Animation interval for the braille spinner. */
const FRAME_INTERVAL_MS = 80;

// ---------------------------------------------------------------------------
// Panel identifiers
// ---------------------------------------------------------------------------

type PanelId = "members" | "events";

interface OverlayState {
  kind: "detail" | "help";
}

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
  currentTool?: string;
  activity?: string;
  usage?: SubagentUsage;
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
  estimatedRemainingMs?: number;
  eventLog?: ProgressEvent[];
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
      currentTool: m.currentTool,
      activity: m.activity,
      usage: m.usage,
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
    estimatedRemainingMs: snapshot.estimatedRemainingMs,
    eventLog: snapshot.eventLog ? [...snapshot.eventLog] : undefined,
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
  private renderedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private onRequestRender: (() => void) | undefined;

  // Render scheduler
  private animationFrame: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingInvalidate = false;
  private hasActiveMembers = false;

  // Input / UI state
  private scrollOffset = 0;
  private selectedIndex = -1;
  private activePanel: PanelId = "members";
  private overlay: OverlayState | null = null;

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
    this.hasActiveMembers = state.active > 0;

    // Reset scroll offset if it exceeds member count
    if (this.scrollOffset > Math.max(0, state.members.length - VISIBLE_MEMBERS)) {
      this.scrollOffset = Math.max(0, state.members.length - VISIBLE_MEMBERS);
    }

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
          m.phaseStartedAt = Date.now();
        }
      }
      this.state_.active = 0;
      this.state_.queued = 0;
      this.state_.completed = this.state_.total - this.state_.failed;
    }
    this.hasActiveMembers = false;
    this.requestRender();
  }

  dispose(): void {
    this.stopTimers();
    this.onRequestRender = undefined;
  }

  invalidate(): void {
    this.renderedWidth = undefined;
    this.cachedLines = undefined;
  }

  // -------------------------------------------------------------------
  // Keyboard input
  // -------------------------------------------------------------------

  handleInput(data: string): void {
    // Ignore key repeats for navigation keys to avoid scroll jank
    const isRepeat = isKeyRepeat(data);

    // Close overlay on Escape / q
    if (this.overlay) {
      if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
        this.overlay = null;
        this.requestRender();
        return;
      }
      return;
    }

    // Navigation
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      if (!isRepeat) {
        this.scrollDown(1);
      }
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      if (!isRepeat) {
        this.scrollUp(1);
      }
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollDown(VISIBLE_MEMBERS);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollUp(VISIBLE_MEMBERS);
      return;
    }
    if (matchesKey(data, "g") || matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.selectedIndex = -1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.shift("g")) || matchesKey(data, Key.end)) {
      if (this.state_) {
        const maxScroll = Math.max(0, this.state_.members.length - VISIBLE_MEMBERS);
        this.scrollOffset = maxScroll;
        this.selectedIndex = Math.max(0, this.state_.members.length - 1);
      }
      this.requestRender();
      return;
    }

    // Panel switching
    if (matchesKey(data, Key.tab) || matchesKey(data, "1")) {
      this.activePanel = "members";
      this.scrollOffset = 0;
      this.selectedIndex = -1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "2")) {
      this.activePanel = "events";
      this.scrollOffset = 0;
      this.requestRender();
      return;
    }

    // Detail overlay
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (this.activePanel === "members" && this.state_) {
        const idx = this.selectedIndex >= 0
          ? this.selectedIndex
          : this.scrollOffset;
        if (idx >= 0 && idx < this.state_.members.length) {
          this.overlay = { kind: "detail" };
          this.requestRender();
        }
      }
      return;
    }

    // Help overlay
    if (matchesKey(data, "?")) {
      this.overlay = { kind: "help" };
      this.requestRender();
      return;
    }
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    if (this.cachedLines && this.renderedWidth === safeWidth) {
      return this.cachedLines;
    }

    if (!this.state_ || this.state_.members.length === 0) {
      this.cachedLines = [];
      return this.cachedLines;
    }

    // If overlay is active, render overlay content
    if (this.overlay) {
      const lines = this.renderOverlay(safeWidth);
      this.cachedLines = lines;
      return this.cachedLines;
    }

    const state = this.state_;
    const contentWidth = safeWidth - 4;
    const lines: string[] = [];

    // Header: title + panel indicator
    const title = state.title ?? "Agent Swarm";
    const panelLabel = this.activePanel === "members" ? "[1]members" : "[2]events";
    const headerText = `${title}  ${panelLabel}`;
    lines.push(`  ${truncateText(headerText, contentWidth)}`);

    // Overall progress bar
    const barWidth = Math.max(1, contentWidth);
    const total = state.total || 1;
    const doneRatio = (state.completed + state.failed) / total;
    const doneChars = Math.round(doneRatio * barWidth);
    const done = "\u2501".repeat(doneChars);
    const remaining = "\u2501".repeat(barWidth - doneChars);
    lines.push(`  ${done}${remaining}`);

    if (this.activePanel === "members") {
      this.renderMembersPanel(lines, state, contentWidth);
    } else {
      this.renderEventsPanel(lines, state, contentWidth);
    }

    // Separator
    const sep = "\u2500".repeat(contentWidth);
    lines.push(`  ${sep}`);

    // Footer: counts + tokens + elapsed + ETA
    const footer = buildFooter(state, contentWidth);
    lines.push(`  ${footer}`);

    // Bottom border
    const bottom = `\u2514${"\u2500".repeat(contentWidth)}\u2518`;
    lines.push(bottom);

    this.cachedLines = lines;
    this.renderedWidth = safeWidth;
    return this.cachedLines;
  }

  // -------------------------------------------------------------------
  // Panel rendering
  // -------------------------------------------------------------------

  private renderMembersPanel(
    lines: string[],
    state: SwarmProgressState,
    contentWidth: number,
  ): void {
    const maxMembers = Math.min(
      state.members.length,
      this.scrollOffset + VISIBLE_MEMBERS,
    );
    const hasMore = state.members.length > VISIBLE_MEMBERS;

    // Scroll indicator (top)
    if (hasMore && this.scrollOffset > 0) {
      lines.push(`  \u2191 ${this.scrollOffset} more above`);
    }

    for (let i = this.scrollOffset; i < maxMembers; i += 1) {
      const member = state.members[i];
      if (!member) continue;
      const isSelected = i === this.selectedIndex || (this.selectedIndex < 0 && i === this.scrollOffset);
      const row = renderMemberRow(member, contentWidth, this.frameIndex, isSelected);
      lines.push(`  ${row}`);
    }

    // Scroll indicator (bottom)
    if (hasMore && maxMembers < state.members.length) {
      const remaining = state.members.length - maxMembers;
      lines.push(`  \u2193 ${remaining} more below`);
    }
  }

  private renderEventsPanel(
    lines: string[],
    state: SwarmProgressState,
    contentWidth: number,
  ): void {
    const events = state.eventLog ?? [];
    const displayEvents = events.slice(-VISIBLE_EVENTS);

    if (displayEvents.length === 0) {
      lines.push(`  ${padRight("(no events yet)", contentWidth)}`);
      return;
    }

    for (const event of displayEvents) {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const icon = eventIcon(event.type);
      const detail = truncateText(event.detail, contentWidth - 12);
      lines.push(`  ${icon} ${time} ${detail}`);
    }
  }

  // -------------------------------------------------------------------
  // Overlays
  // -------------------------------------------------------------------

  private renderOverlay(width: number): string[] {
    if (!this.overlay) return [];

    if (this.overlay.kind === "help") {
      return this.renderHelpOverlay(width);
    }

    return this.renderDetailOverlay(width);
  }

  private renderHelpOverlay(width: number): string[] {
    const safeWidth = Math.max(30, width);
    const contentWidth = safeWidth - 6;
    const lines: string[] = [];

    const bottom = `\u2514${"\u2500".repeat(safeWidth - 2)}\u2518`;

    lines.push(`  \u250C${"\u2500".repeat(safeWidth - 2)}\u2510`);
    lines.push(`  \u2502  ${padRight("Help" + " ".repeat(contentWidth - 4), safeWidth - 4)}\u2502`);
    lines.push(`  \u2502  ${padRight("", safeWidth - 4)}\u2502`);

    const helpItems = [
      ["j/k, up/down", "Scroll member list"],
      ["g / Shift+G", "Go to top / bottom"],
      ["Enter", "View member detail"],
      ["1 or Tab", "Members panel"],
      ["2", "Events panel"],
      ["?", "Toggle this help"],
      ["q / Esc", "Close overlay"],
    ];

    for (const [key, desc] of helpItems) {
      const line = `${padRight(key, 18)} ${desc}`;
      lines.push(`  \u2502  ${padRight(line, safeWidth - 4)}\u2502`);
    }

    lines.push(`  \u2502  ${padRight("", safeWidth - 4)}\u2502`);
    lines.push(`  \u2502  ${padRight("Press q or Esc to close", safeWidth - 4)}\u2502`);
    lines.push(bottom);

    return lines;
  }

  private renderDetailOverlay(width: number): string[] {
    const safeWidth = Math.max(30, width);
    const contentWidth = safeWidth - 6;
    const lines: string[] = [];

    if (!this.state_) return [];

    const idx = this.selectedIndex >= 0
      ? this.selectedIndex
      : this.scrollOffset;
    const member = this.state_.members[idx];
    if (!member) return [];

    const bottom = `\u2514${"\u2500".repeat(safeWidth - 2)}\u2518`;

    lines.push(`  \u250C${"\u2500".repeat(safeWidth - 2)}\u2510`);
    lines.push(`  \u2502  ${padRight(`Agent #${String(member.index).padStart(2, "0")}`, safeWidth - 4)}\u2502`);
    lines.push(`  \u2502  ${padRight("", safeWidth - 4)}\u2502`);

    const fields: Array<{ label: string; value: string }> = [
      { label: "Status", value: shortPhaseLabel(member.phase) },
    ];

    if (member.item) {
      fields.push({ label: "Item", value: member.item });
    }
    if (member.currentTool) {
      fields.push({ label: "Tool", value: member.currentTool });
    }
    if (member.activity) {
      fields.push({ label: "Activity", value: member.activity });
    }
    if (member.usage) {
      fields.push({
        label: "Tokens",
        value: `${Math.round(member.usage.input)}in / ${Math.round(member.usage.output)}out`,
      });
    }
    if (member.error) {
      fields.push({ label: "Error", value: member.error });
    }

    for (const field of fields) {
      const line = `${padRight(field.label + ":", 10)} ${truncateText(field.value, contentWidth - 12)}`;
      lines.push(`  \u2502  ${padRight(line, safeWidth - 4)}\u2502`);
    }

    lines.push(`  \u2502  ${padRight("", safeWidth - 4)}\u2502`);
    lines.push(`  \u2502  ${padRight("Press q or Esc to close", safeWidth - 4)}\u2502`);
    lines.push(bottom);

    return lines;
  }

  // -------------------------------------------------------------------
  // Scroll helpers
  // -------------------------------------------------------------------

  private scrollDown(n: number): void {
    if (!this.state_) return;
    const memberCount = this.state_.members.length;
    const maxOffset = Math.max(0, memberCount - 1);
    this.selectedIndex = Math.min(maxOffset, Math.max(0, this.selectedIndex < 0 ? this.scrollOffset : this.selectedIndex) + n);
    if (this.selectedIndex - this.scrollOffset >= VISIBLE_MEMBERS || this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = Math.max(0, this.selectedIndex - VISIBLE_MEMBERS + 1);
      const maxScroll = Math.max(0, memberCount - VISIBLE_MEMBERS);
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    }
    this.requestRender();
  }

  private scrollUp(n: number): void {
    if (!this.state_) return;
    this.selectedIndex = Math.max(0, (this.selectedIndex < 0 ? this.scrollOffset : this.selectedIndex) - n);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = Math.max(0, this.selectedIndex);
    }
    this.requestRender();
  }

  // -------------------------------------------------------------------
  // Render scheduling
  // -------------------------------------------------------------------

  /**
   * Request a debounced render. Multiple calls within the debounce window
   * coalesce into a single render pass. State changes also trigger immediate
   * invalidation.
   */
  private requestRender(): void {
    this.invalidate();

    if (this.debounceTimer !== undefined) {
      this.pendingInvalidate = true;
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.pendingInvalidate = false;
      this.onRequestRender?.();
      this.updatePollingInterval();
    }, DEBOUNCE_MS);

    // Also trigger an immediate render for faster response to inputs
    this.onRequestRender?.();
  }

  /**
   * Start the fallback polling timer. Falls back to polling when no
   * state changes trigger requests, ensuring the spinner animates.
   */
  private startPolling(): void {
    this.schedulePoll();
  }

  private schedulePoll(): void {
    const interval = this.hasActiveMembers ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      // Tick the spinner frame even without state changes
      if (this.state_) {
        this.invalidate();
        this.onRequestRender?.();
      }
      this.schedulePoll();
    }, interval);
  }

  /**
   * Adjust polling interval based on active member count.
   */
  private updatePollingInterval(): void {
    // Will be picked up on next poll cycle
  }

  /**
   * Start the animation tick for the braille spinner.
   */
  private startAnimation(): void {
    this.animationFrame = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % BRAILLE_SPINNER.length;
      // Only invalidate and re-render if there are active members (spinner visible)
      // or if we're in an overlay that uses animation
      if (this.hasActiveMembers || this.overlay) {
        this.invalidate();
        this.onRequestRender?.();
      }
    }, FRAME_INTERVAL_MS);
  }

  private stopTimers(): void {
    if (this.animationFrame !== undefined) {
      clearInterval(this.animationFrame);
      this.animationFrame = undefined;
    }
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
// Rendering helpers
// ---------------------------------------------------------------------------

function eventIcon(type: ProgressEvent["type"]): string {
  switch (type) {
    case "started": return "\u25B6";   // ▶
    case "completed": return "\u2713";  // ✓
    case "failed": return "\u2717";     // ✗
    case "tool_execution": return "\u2699"; // ⚙
    case "suspended": return "\u23F3";  // ⏳
    case "phase_change": return "\u2192"; // →
  }
}

function renderMemberRow(
  member: MemberStatus,
  width: number,
  frameIndex: number,
  selected: boolean,
): string {
  const prefix = selected ? ">" : " ";
  const indexLabel = `#${String(member.index).padStart(2, "0")}`;
  const icon = memberIcon(member, frameIndex);
  const statusLabel = shortPhaseLabel(member.phase);

  // Layout with optional activity column
  const fixed = `${prefix}${indexLabel} ${icon} ${statusLabel}`;
  const fixedLen = visibleLen(fixed);

  let remaining = Math.max(0, width - fixedLen - 2);

  // Show current tool if available
  let activitySuffix = "";
  if (member.currentTool && member.phase === "working") {
    const toolInfo = member.activity
      ? `${member.currentTool}: ${member.activity}`
      : member.currentTool;
    if (toolInfo.length < remaining - 2) {
      activitySuffix = ` ${truncateText(toolInfo, Math.min(30, remaining - 2))}`;
      remaining -= visibleLen(activitySuffix);
    }
  }

  const itemLabel = member.item ?? "";
  const truncatedItem = truncateText(itemLabel, Math.max(0, remaining));

  return `${fixed}  ${truncatedItem}${activitySuffix}`;
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
  const usage = state.totalUsage ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  const counts = `${state.completed + state.failed}/${state.total} ag`;
  const tokens = `${Math.round(usage.input)}in/${Math.round(usage.output)}out`;
  const elapsed = formatElapsed(Date.now() - state.startedAt);

  const parts: string[] = [counts, tokens, elapsed];
  if (state.failed > 0) parts.splice(1, 0, `${state.failed}fail`);
  if (state.active > 0) parts.splice(1, 0, `${state.active}act`);

  // ETA
  if (state.estimatedRemainingMs !== undefined && state.estimatedRemainingMs > 0) {
    parts.push(formatElapsed(state.estimatedRemainingMs));
  }

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

function padRight(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}
