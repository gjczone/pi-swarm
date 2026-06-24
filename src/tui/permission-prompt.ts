/**
 * tui/permission-prompt — swarm start permission dialog for manual mode.
 *
 * When the user is in manual permission mode and tries to start a
 * swarm, this component asks whether to switch to auto/yolo or cancel.
 *
 * Ported from MoonshotAI/kimi-code's SwarmStartPermissionPromptComponent.
 */

import type { Component } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwarmPermissionChoice = "auto" | "yolo" | "cancel";

export interface SwarmPermissionPromptOptions {
  /** Called when the user makes a selection. */
  onSelect: (choice: SwarmPermissionChoice) => void;
  /** Called when the user cancels (Escape). */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class SwarmPermissionPromptComponent implements Component {
  private selectedIndex = 0;
  private readonly choices: readonly SwarmPermissionChoice[] = [
    "auto",
    "yolo",
    "cancel",
  ];

  constructor(private readonly opts: SwarmPermissionPromptOptions) {}

  handleInput(data: string): void {
    if (data === "\x1b[A" || data === "k") {
      // Up arrow or 'k'
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
    } else if (data === "\x1b[B" || data === "j") {
      // Down arrow or 'j'
      this.selectedIndex = Math.min(
        this.choices.length - 1,
        this.selectedIndex + 1,
      );
      this.invalidate();
    } else if (data === "\r" || data === "\n") {
      // Enter
      const choice = this.choices[this.selectedIndex];
      if (choice) {
        this.opts.onSelect(choice);
      }
    } else if (data === "\x1b") {
      // Escape
      this.opts.onCancel();
    }
  }

  invalidate(): void {
    // No cached state to clear — render is pure.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(10, width);
    const lines: string[] = [];

    lines.push(borderTop(safeWidth));
    lines.push(padLine("Manual mode can block swarm work.", safeWidth));
    lines.push(padLine("", safeWidth));
    lines.push(padLine("Choose a permission mode for this swarm:", safeWidth));
    lines.push(padLine("", safeWidth));

    for (let i = 0; i < this.choices.length; i += 1) {
      const choice = this.choices[i]!;
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? " > " : "   ";
      const label = choiceLabel(choice);
      lines.push(padLine(`${prefix}${label}`, safeWidth));
    }

    lines.push(padLine("", safeWidth));
    lines.push(
      padLine(
        "Use arrow keys to select, Enter to confirm, Esc to cancel.",
        safeWidth,
      ),
    );
    lines.push(borderBottom(safeWidth));

    return lines;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function choiceLabel(choice: SwarmPermissionChoice): string {
  switch (choice) {
    case "auto":
      return "Auto mode — tools auto-approved, including AgentSwarm";
    case "yolo":
      return "YOLO mode — all tools auto-approved, no confirmations";
    case "cancel":
      return "Cancel — do not start the swarm";
  }
}

function borderTop(width: number): string {
  return `\u250C${"\u2500".repeat(Math.max(0, width - 2))}\u2510`;
}

function borderBottom(width: number): string {
  return `\u2514${"\u2500".repeat(Math.max(0, width - 2))}\u2518`;
}

function padLine(text: string, width: number): string {
  const inner = `\u2502 ${text}`;
  const padding = Math.max(0, width - inner.length - 1);
  return `${inner}${" ".repeat(padding)}\u2502`;
}
