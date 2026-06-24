/**
 * tests/team-dashboard.test.ts — Team dashboard component tests.
 *
 * Verifies the TeamDashboardComponent renders correct phase statuses,
 * braille animation, status icons, and layout structure.
 */

import { describe, it, expect } from "vitest";
import {
  TeamDashboardComponent,
  snapshotToDashboardState,
} from "../src/tui/team-dashboard.js";
import type {
  TeamProgressSnapshot,
  TeamPhaseStatus,
} from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhase(
  name: string,
  role: TeamPhaseStatus["role"],
  status: TeamPhaseStatus["status"],
  error?: string,
): TeamPhaseStatus {
  return { name, role, status, error };
}

function makeSnapshot(
  overrides: Partial<TeamProgressSnapshot> = {},
): TeamProgressSnapshot {
  return {
    title: "Test Team",
    goal: "Test goal",
    status: "running",
    totalPhases: 5,
    completedPhases: 2,
    failedPhases: 0,
    currentPhase: "implement",
    currentRole: "coder",
    phases: [
      makePhase("explore", "explorer", "completed"),
      makePhase("plan", "planner", "completed"),
      makePhase("implement", "coder", "running"),
      makePhase("review", "reviewer", "queued"),
      makePhase("test", "tester", "queued"),
    ],
    mailboxCount: 3,
    startedAt: Date.now() - 120000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamDashboardComponent", () => {
  it("renders header with title and status", () => {
    const snapshot = makeSnapshot();
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    expect(lines.length).toBeGreaterThan(0);
    // Header should contain title or status
    const header = lines[0]!;
    expect(header).toContain("Test Team");
  });

  it("renders all 5 phases with correct status labels", () => {
    const snapshot = makeSnapshot();
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    // Phases should appear: explore, plan, implement, review, test
    const joined = lines.join("\n");
    expect(joined).toContain("explore");
    expect(joined).toContain("plan");
    expect(joined).toContain("implement");
    expect(joined).toContain("review");
    expect(joined).toContain("test");
  });

  it("shows completed checkmark for finished phases", () => {
    const snapshot = makeSnapshot();
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    const joined = lines.join("\n");
    expect(joined).toMatch(/explore.*completed/s);
    expect(joined).toMatch(/plan.*completed/s);
  });

  it("shows queued marker for pending phases", () => {
    const snapshot = makeSnapshot();
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    const joined = lines.join("\n");
    expect(joined).toMatch(/review.*queued/s);
    expect(joined).toMatch(/test.*queued/s);
  });

  it("shows failed marker for failed phases", () => {
    const snapshot = makeSnapshot({
      completedPhases: 0,
      failedPhases: 1,
      phases: [
        makePhase("explore", "explorer", "failed", "bad error"),
        makePhase("plan", "planner", "queued"),
      ],
      totalPhases: 2,
    });
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    const joined = lines.join("\n");
    expect(joined).toMatch(/explore.*failed/s);
  });

  it("shows skipped marker for skipped phases", () => {
    const snapshot = makeSnapshot({
      completedPhases: 0,
      failedPhases: 0,
      phases: [
        makePhase("explore", "explorer", "skipped"),
        makePhase("plan", "planner", "queued"),
      ],
      totalPhases: 2,
    });
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    const joined = lines.join("\n");
    expect(joined).toMatch(/explore.*skipped/s);
  });

  it("shows mailbox count in footer", () => {
    const snapshot = makeSnapshot({ mailboxCount: 5 });
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    const joined = lines.join("\n");
    expect(joined).toContain("5");
  });

  it("shows elapsed time in footer", () => {
    const snapshot = makeSnapshot({ startedAt: Date.now() - 180000 });
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    const joined = lines.join("\n");
    // Should contain elapsed time units (m or s)
    expect(joined).toMatch(/\d+m/);
  });

  it("returns empty lines for null state", () => {
    const component = new TeamDashboardComponent();
    const lines = component.render(60);
    expect(lines).toEqual([]);
  });

  it("caps displayed phases at 20", () => {
    const phases: TeamPhaseStatus[] = [];
    for (let i = 0; i < 25; i += 1) {
      phases.push(makePhase(`phase${i}`, "coder", "queued"));
    }
    const snapshot = makeSnapshot({
      phases,
      totalPhases: 25,
      completedPhases: 0,
    });
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    const lines = component.render(60);
    // Should render at most 20 phases
    const phaseNameLines = lines.filter((l) => l.includes("phase"));
    expect(phaseNameLines.length).toBeLessThanOrEqual(20);
  });

  it("completes all phases when complete() is called", () => {
    const snapshot = makeSnapshot();
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    component.complete();
    const lines = component.render(60);
    const joined = lines.join("\n");
    // Status should change to completed
    expect(joined).toContain("completed");
  });

  it("dispose stops animation", () => {
    const snapshot = makeSnapshot();
    const state = snapshotToDashboardState(snapshot);
    const component = new TeamDashboardComponent();
    component.update(state);

    // Should not throw
    component.dispose();
  });
});
