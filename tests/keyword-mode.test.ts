/**
 * tests/keyword-mode.test.ts — tests for keyword-based swarm/team mode activation.
 *
 * Verifies that user input keywords correctly resolve to the appropriate
 * swarm mode (swarm vs team), with proper priority when both keywords
 * appear in the same input.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Function under test (imported from index.ts)
// ---------------------------------------------------------------------------

import { resolveKeywordMode } from "../src/index.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveKeywordMode", () => {
  it('returns "swarm" for input containing "swarm"', () => {
    expect(resolveKeywordMode("use swarm")).toBe("swarm");
  });

  it('returns "swarm" for input containing "Swarm" (case-insensitive)', () => {
    expect(resolveKeywordMode("Use Swarm")).toBe("swarm");
  });

  it('returns "team" for input containing "swarm-team"', () => {
    expect(resolveKeywordMode("use swarm-team")).toBe("team");
  });

  it('returns "team" for input containing "swarm team"', () => {
    expect(resolveKeywordMode("use swarm team")).toBe("team");
  });

  it('returns "team" when both "swarm-team" and "swarm" appear (team takes priority)', () => {
    expect(resolveKeywordMode("swarm-team and swarm")).toBe("team");
  });

  it('returns "team" when both "swarm team" and "swarm" appear (team takes priority)', () => {
    expect(resolveKeywordMode("swarm team and swarm")).toBe("team");
  });

  it("returns null when no keyword matches", () => {
    expect(resolveKeywordMode("hello world")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolveKeywordMode("")).toBeNull();
  });

  it('does not match "swarm" inside "swarm-team" for swarm mode', () => {
    // "swarm-team" contains "swarm" but "swarm-team" check should take priority
    expect(resolveKeywordMode("swarm-team only")).toBe("team");
  });

  it('matches "swarm" when "swarm-" appears without "team"', () => {
    expect(resolveKeywordMode("swarm-mode activation")).toBe("swarm");
  });
});
