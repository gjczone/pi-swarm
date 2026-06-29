/**
 * tui/swarm-markers — swarm mode state markers rendered in the
 * conversation transcript.
 *
 * Displays a coloured marker line when swarm mode is activated,
 * deactivated, or ended.
 *
 * Architecture reference: AgentSwarm pattern.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwarmModeMarkerState = "active" | "inactive" | "ended";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class SwarmModeMarkerComponent implements Component {
  private renderedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(private readonly state: SwarmModeMarkerState) {}

  invalidate(): void {
    this.renderedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [""];

    if (this.cachedLines && this.renderedWidth === safeWidth) {
      return this.cachedLines;
    }

    const marker = swarmMarkerLabel(this.state);
    const line = truncateToWidth(marker, safeWidth);

    this.cachedLines = ["", line];
    this.renderedWidth = safeWidth;
    return this.cachedLines;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function swarmMarkerLabel(state: SwarmModeMarkerState): string {
  switch (state) {
    case "active":
      return "Swarm activated";
    case "inactive":
      return "Swarm deactivated";
    case "ended":
      return "Swarm ended";
  }
}
