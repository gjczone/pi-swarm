/**
 * tests/keyword-mode.test.ts — tests for keyword-based swarm mode activation.
 */

import { describe, it, expect } from "vitest";
import { resolveKeywordMode } from "../src/index.js";

describe("resolveKeywordMode", () => {
  it('returns "swarm" for input containing "swarm"', () => {
    expect(resolveKeywordMode("use swarm")).toBe("swarm");
  });

  it('returns "swarm" for input containing "Swarm" (case-insensitive)', () => {
    expect(resolveKeywordMode("Use Swarm")).toBe("swarm");
  });

  it("returns null when no keyword matches", () => {
    expect(resolveKeywordMode("hello world")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolveKeywordMode("")).toBeNull();
  });

  it('returns "team" for input containing "swarm-team"', () => {
    expect(resolveKeywordMode("swarm-team task")).toBe("team");
  });

  it('returns "team" for input containing "swarm team"', () => {
    expect(resolveKeywordMode("swarm team task")).toBe("team");
  });

  it('returns "team" when both "swarm-team" and "swarm" appear', () => {
    expect(resolveKeywordMode("swarm-team and swarm")).toBe("team");
  });
});
