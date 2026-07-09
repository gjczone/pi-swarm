import { describe, it, expect } from "vitest";
import { buildSubagentArgs } from "../src/shared/pi-invoke.js";

describe("buildSubagentArgs tool filtering (#153)", () => {
  it("strips forbidden swarm tools from an explicit tool list", () => {
    const args = buildSubagentArgs({
      task: "do work",
      tools: ["Read", "Swarm", "SwarmCoordinator", "SendMessage", "Write"],
    });
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThan(-1);
    const toolList = args[idx + 1]!;
    expect(toolList).toContain("Read");
    expect(toolList).toContain("Write");
    expect(toolList).not.toContain("Swarm");
    expect(toolList).not.toContain("SwarmCoordinator");
    expect(toolList).not.toContain("SendMessage");
  });

  it("does not pass --tools when the filtered list is empty", () => {
    const args = buildSubagentArgs({
      task: "do work",
      tools: ["Swarm", "TaskStop"],
    });
    expect(args).not.toContain("--tools");
  });

  it("passes --tools when tools provided and none are forbidden", () => {
    const args = buildSubagentArgs({
      task: "do work",
      tools: ["Read", "Write", "Bash"],
    });
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Read,Write,Bash");
  });
});
