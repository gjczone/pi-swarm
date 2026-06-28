/**
 * tests/tui-truncation.test.ts — tests that TUI components never return
 * lines exceeding the render width, preventing the "Rendered line exceeds
 * terminal width" crash (issue #20).
 *
 * kimi-code style: only AgentSwarmProgressComponent is used.
 */

import { describe, it, expect } from "vitest";
import { AgentSwarmProgressComponent } from "../src/tui/progress.js";
import type { SwarmProgressState, MemberStatus } from "../src/tui/progress.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify every line returned by render is within the given width. */
function assertAllLinesWithinWidth(
  lines: string[],
  width: number,
  componentName: string,
): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    expect(
      line.length,
      `${componentName} line ${i} (len=${line.length}) exceeds width=${width}: "${line.slice(0, 40)}..."`,
    ).toBeLessThanOrEqual(width);
  }
}

/** Build a minimal progress state with a few members in different phases. */
function makeProgressState(
  overrides: Partial<SwarmProgressState> = {},
): SwarmProgressState {
  const members: MemberStatus[] = [
    { index: 1, phase: "working", item: "src/a.ts" },
    { index: 2, phase: "completed", item: "src/b.ts", result: "OK" },
    { index: 3, phase: "queued", item: "src/c.ts" },
  ];
  return {
    title: "Agent Swarm Testing",
    total: 3,
    completed: 1,
    failed: 0,
    active: 1,
    queued: 1,
    members,
    totalUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    startedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AgentSwarmProgressComponent truncation
// ---------------------------------------------------------------------------

describe("AgentSwarmProgressComponent truncation", () => {
  it("all lines fit within render width (80 cols)", () => {
    const comp = new AgentSwarmProgressComponent();
    comp.update(makeProgressState());
    const lines = comp.render(80);
    assertAllLinesWithinWidth(lines, 80, "progress");
    comp.dispose();
  });

  it("all lines fit within narrow width (40 cols)", () => {
    const comp = new AgentSwarmProgressComponent();
    comp.update(makeProgressState());
    const lines = comp.render(40);
    assertAllLinesWithinWidth(lines, 40, "progress");
    comp.dispose();
  });

  it("all lines fit within very narrow width (20 cols)", () => {
    const comp = new AgentSwarmProgressComponent();
    comp.update(makeProgressState());
    const lines = comp.render(20);
    assertAllLinesWithinWidth(lines, 20, "progress");
    comp.dispose();
  });

  it("handles long title without overflowing", () => {
    const comp = new AgentSwarmProgressComponent();
    comp.update(
      makeProgressState({
        title:
          "Agent Swarm — Very Long Title That Would Exceed Narrow Terminal Width",
      }),
    );
    const lines = comp.render(30);
    assertAllLinesWithinWidth(lines, 30, "progress");
    comp.dispose();
  });

  it("handles many members without overflowing", () => {
    const comp = new AgentSwarmProgressComponent();
    const members: MemberStatus[] = Array.from({ length: 15 }, (_, i) => ({
      index: i + 1,
      phase: "working" as const,
      item: `very-long-item-name-${i + 1}.ts`,
    }));
    comp.update(
      makeProgressState({
        members,
        total: 15,
        active: 15,
        completed: 0,
        queued: 0,
      }),
    );
    const lines = comp.render(50);
    assertAllLinesWithinWidth(lines, 50, "progress");
    comp.dispose();
  });
});
