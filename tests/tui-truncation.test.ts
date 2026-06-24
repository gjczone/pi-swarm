/**
 * tests/tui-truncation.test.ts — tests that TUI components never return
 * lines exceeding the render width, preventing the "Rendered line exceeds
 * terminal width" crash (issue #20).
 */

import { describe, it, expect } from "vitest";
import { AgentSwarmProgressComponent } from "../src/tui/progress.js";
import type { SwarmProgressState, MemberStatus } from "../src/tui/progress.js";
import { SwarmPermissionPromptComponent } from "../src/tui/permission-prompt.js";
import { TeamDashboardComponent } from "../src/tui/team-dashboard.js";
import type { TeamDashboardState } from "../src/tui/team-dashboard.js";

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
    title: "Agent Swarm — Testing",
    total: 3,
    completed: 1,
    failed: 0,
    active: 1,
    queued: 1,
    members,
    ...overrides,
  };
}

/** Build a minimal team dashboard state with a few phases. */
function makeDashboardState(
  overrides: Partial<TeamDashboardState> = {},
): TeamDashboardState {
  return {
    title: "Test Team",
    goal: "Verify TUI truncation",
    status: "running",
    totalPhases: 3,
    completedPhases: 1,
    failedPhases: 0,
    currentPhase: "implement",
    currentRole: "implementer",
    phases: [
      {
        name: "explore",
        role: "explorer",
        status: "completed",
        phaseStartedAt: Date.now(),
      },
      {
        name: "implement",
        role: "implementer",
        status: "running",
        phaseStartedAt: Date.now(),
      },
      {
        name: "review",
        role: "reviewer",
        status: "queued",
        phaseStartedAt: Date.now(),
      },
    ],
    mailboxCount: 0,
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

// ---------------------------------------------------------------------------
// SwarmPermissionPromptComponent truncation
// ---------------------------------------------------------------------------

describe("SwarmPermissionPromptComponent truncation", () => {
  const noop = () => {};

  it("all lines fit within render width (80 cols)", () => {
    const comp = new SwarmPermissionPromptComponent({
      onSelect: noop,
      onCancel: noop,
    });
    const lines = comp.render(80);
    assertAllLinesWithinWidth(lines, 80, "permission-prompt");
  });

  it("all lines fit within narrow width (40 cols)", () => {
    const comp = new SwarmPermissionPromptComponent({
      onSelect: noop,
      onCancel: noop,
    });
    const lines = comp.render(40);
    assertAllLinesWithinWidth(lines, 40, "permission-prompt");
  });

  it("all lines fit within very narrow width (20 cols)", () => {
    const comp = new SwarmPermissionPromptComponent({
      onSelect: noop,
      onCancel: noop,
    });
    const lines = comp.render(20);
    assertAllLinesWithinWidth(lines, 20, "permission-prompt");
  });
});

// ---------------------------------------------------------------------------
// TeamDashboardComponent truncation
// ---------------------------------------------------------------------------

describe("TeamDashboardComponent truncation", () => {
  it("all lines fit within render width (80 cols)", () => {
    const comp = new TeamDashboardComponent();
    comp.update(makeDashboardState());
    const lines = comp.render(80);
    assertAllLinesWithinWidth(lines, 80, "team-dashboard");
    comp.dispose();
  });

  it("all lines fit within narrow width (40 cols)", () => {
    const comp = new TeamDashboardComponent();
    comp.update(makeDashboardState());
    const lines = comp.render(40);
    assertAllLinesWithinWidth(lines, 40, "team-dashboard");
    comp.dispose();
  });

  it("all lines fit within very narrow width (20 cols)", () => {
    const comp = new TeamDashboardComponent();
    comp.update(makeDashboardState());
    const lines = comp.render(20);
    assertAllLinesWithinWidth(lines, 20, "team-dashboard");
    comp.dispose();
  });

  it("handles long goal text without overflowing", () => {
    const comp = new TeamDashboardComponent();
    comp.update(
      makeDashboardState({
        title: "Very Long Team Name That Exceeds Narrow Terminal Widths",
        goal: "This is a very long goal description that will definitely overflow on a narrow terminal window",
      }),
    );
    const lines = comp.render(30);
    assertAllLinesWithinWidth(lines, 30, "team-dashboard");
    comp.dispose();
  });

  it("handles many phases without overflowing", () => {
    const comp = new TeamDashboardComponent();
    const phases = Array.from({ length: 10 }, (_, i) => ({
      name: `very-long-phase-name-${i + 1}`,
      role: `phase-role-${i + 1}`,
      status: i === 0 ? ("completed" as const) : ("queued" as const),
      phaseStartedAt: Date.now(),
    }));
    comp.update(
      makeDashboardState({
        totalPhases: 10,
        completedPhases: 1,
        phases,
        currentPhase: undefined,
        currentRole: undefined,
      }),
    );
    const lines = comp.render(40);
    assertAllLinesWithinWidth(lines, 40, "team-dashboard");
    comp.dispose();
  });
});
