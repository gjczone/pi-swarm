/**
 * tests/agents.test.ts — unit tests for file-based agent loading and profile integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseFrontmatterForTest,
  parseAgentFileForTest,
  loadFileAgents,
  listFileAgents,
  clearFileAgentsCache,
} from "../src/shared/agents.js";
import { resolveProfile, resolveProfileTools } from "../src/shared/profiles.js";
import type { AgentProfile } from "../src/shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory for testing. */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-agents-test-"));
}

/** Write an agent file and return the full path. */
function writeAgentFile(
  dir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const fmLines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}:`);
      for (const item of v) {
        fmLines.push(`  - ${item}`);
      }
    } else if (typeof v === "boolean") {
      fmLines.push(`${k}: ${v}`);
    } else if (typeof v === "number") {
      fmLines.push(`${k}: ${v}`);
    } else {
      fmLines.push(`${k}: ${v}`);
    }
  }
  fmLines.push("---");
  const content = [...fmLines, "", body].join("\n");
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// Save original HOME
const ORIGINAL_HOME = process.env.HOME;

// ---------------------------------------------------------------------------
// Tests: frontmatter parsing
// ---------------------------------------------------------------------------

describe("parseFrontmatterForTest", () => {
  it("parses a simple markdown file with frontmatter", () => {
    const raw = [
      "---",
      "name: rust-audit",
      "description: Rust code audit specialist",
      "allowWrite: false",
      "model: small",
      "---",
      "",
      "You are a Rust audit specialist.",
    ].join("\n");

    const fm = parseFrontmatterForTest(raw);
    expect(fm).not.toBeNull();
    expect(fm!["name"]).toBe("rust-audit");
    expect(fm!["description"]).toBe("Rust code audit specialist");
    expect(fm!["allowWrite"]).toBe(false);
    expect(fm!["model"]).toBe("small");
  });

  it("returns null when no frontmatter", () => {
    const raw = "Just some text\n\nNo frontmatter here.";
    expect(parseFrontmatterForTest(raw)).toBeNull();
  });

  it("parses list values", () => {
    const raw = [
      "---",
      "name: test-agent",
      "description: test",
      "tools:",
      "  - read",
      "  - bash",
      "disallowedTools:",
      "  - Swarm",
      "---",
      "body",
    ].join("\n");

    const fm = parseFrontmatterForTest(raw);
    expect(fm).not.toBeNull();
    expect(fm!["tools"]).toEqual(["read", "bash"]);
    expect(fm!["disallowedTools"]).toEqual(["Swarm"]);
  });

  it("parses inline list format", () => {
    const raw = [
      "---",
      "name: test-agent",
      "description: test",
      "tools: [read, bash, edit]",
      "---",
      "body",
    ].join("\n");

    const fm = parseFrontmatterForTest(raw);
    expect(fm).not.toBeNull();
    expect(fm!["tools"]).toEqual(["read", "bash", "edit"]);
  });

  it("parses boolean values", () => {
    const raw = [
      "---",
      "name: test",
      "description: test",
      "allowWrite: false",
      "allowBashWrite: true",
      "---",
      "body",
    ].join("\n");

    const fm = parseFrontmatterForTest(raw);
    expect(fm).not.toBeNull();
    expect(fm!["allowWrite"]).toBe(false);
    expect(fm!["allowBashWrite"]).toBe(true);
  });

  it("strips quotes from string values", () => {
    const raw = [
      "---",
      'name: "my-agent"',
      "description: 'A test agent'",
      "---",
      "body",
    ].join("\n");

    const fm = parseFrontmatterForTest(raw);
    expect(fm).not.toBeNull();
    expect(fm!["name"]).toBe("my-agent");
    expect(fm!["description"]).toBe("A test agent");
  });

  it("ignores comments in frontmatter", () => {
    const raw = [
      "---",
      "name: test",
      "description: test agent",
      "# this is a comment",
      "model: small",
      "---",
      "body",
    ].join("\n");

    const fm = parseFrontmatterForTest(raw);
    expect(fm).not.toBeNull();
    expect(fm!["name"]).toBe("test");
    expect(fm!["model"]).toBe("small");
  });
});

// ---------------------------------------------------------------------------
// Tests: Agent file parsing
// ---------------------------------------------------------------------------

describe("parseAgentFileForTest", () => {
  let tmpAgentDir: string;

  beforeEach(() => {
    tmpAgentDir = tmpDir();
  });

  afterEach(() => {
    // Cleanup tmp dir after each test
    try {
      fs.rmSync(tmpAgentDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("parses a valid agent file", () => {
    const filePath = writeAgentFile(
      tmpAgentDir,
      "rust-audit.md",
      {
        name: "rust-audit",
        description: "Rust code audit specialist",
        allowWrite: false,
        allowBashWrite: false,
        model: "small",
        outputFormat: "structured",
        tools: ["read", "bash"],
        disallowedTools: ["Swarm"],
      },
      "You are a Rust audit specialist.\n\nFocus on safety.",
    );

    const def = parseAgentFileForTest(
      filePath,
      fs.readFileSync(filePath, "utf-8"),
      "user",
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("rust-audit");
    expect(def!.description).toBe("Rust code audit specialist");
    expect(def!.allowWrite).toBe(false);
    expect(def!.allowBashWrite).toBe(false);
    expect(def!.model).toBe("small");
    expect(def!.outputFormat).toBe("structured");
    expect(def!.tools).toEqual(["read", "bash"]);
    expect(def!.disallowedTools).toEqual(["Swarm"]);
    expect(def!.prompt).toBe(
      "You are a Rust audit specialist.\n\nFocus on safety.",
    );
    expect(def!.source).toBe("user");
    expect(def!.filePath).toBe(filePath);
  });

  it("derives name from filename when frontmatter name is missing", () => {
    const filePath = writeAgentFile(
      tmpAgentDir,
      "my-agent.md",
      {
        description: "Test agent",
        model: "small",
      },
      "Body content",
    );

    const def = parseAgentFileForTest(
      filePath,
      fs.readFileSync(filePath, "utf-8"),
      "user",
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("my-agent");
    expect(def!.description).toBe("Test agent");
  });

  it("returns null for missing description", () => {
    const filePath = writeAgentFile(
      tmpAgentDir,
      "no-desc.md",
      {
        name: "no-desc",
      },
      "body",
    );

    const def = parseAgentFileForTest(
      filePath,
      fs.readFileSync(filePath, "utf-8"),
      "user",
    );
    expect(def).toBeNull();
  });

  it("returns null for files without frontmatter", () => {
    const filePath = path.join(tmpAgentDir, "plain.md");
    fs.writeFileSync(filePath, "Just plain text", "utf-8");

    const def = parseAgentFileForTest(
      filePath,
      fs.readFileSync(filePath, "utf-8"),
      "user",
    );
    expect(def).toBeNull();
  });

  it("defaults capability flags to true when not specified", () => {
    const filePath = writeAgentFile(
      tmpAgentDir,
      "defaults.md",
      {
        name: "defaults-test",
        description: "Testing defaults",
      },
      "Body content here",
    );

    const def = parseAgentFileForTest(
      filePath,
      fs.readFileSync(filePath, "utf-8"),
      "user",
    );
    expect(def).not.toBeNull();
    expect(def!.allowWrite).toBe(true);
    expect(def!.allowBashWrite).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: File agent loading
// ---------------------------------------------------------------------------

describe("loadFileAgents and listFileAgents", () => {
  const tmpProjectDir = tmpDir();
  let userAgentsDir: string;
  let projectAgentsDir: string;

  beforeEach(() => {
    clearFileAgentsCache();
    // Create fake HOME with .pi/agents/ dir
    const fakeHome = path.join(tmpProjectDir, "fake-home");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    userAgentsDir = path.join(fakeHome, ".pi", "agents");
    projectAgentsDir = path.join(tmpProjectDir, ".pi", "agents");
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try {
      fs.rmSync(tmpProjectDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("loads agents from user directory only", () => {
    writeAgentFile(
      userAgentsDir,
      "user-agent.md",
      { name: "user-agent", description: "User agent" },
      "User agent body",
    );

    const agents = loadFileAgents(tmpProjectDir);
    expect(agents.size).toBe(1);
    expect(agents.has("user-agent")).toBe(true);
    expect(agents.get("user-agent")!.description).toBe("User agent");
  });

  it("loads agents from project directory only", () => {
    writeAgentFile(
      projectAgentsDir,
      "proj-agent.md",
      { name: "proj-agent", description: "Project agent" },
      "Project agent body",
    );

    const agents = loadFileAgents(tmpProjectDir);
    expect(agents.size).toBe(1);
    expect(agents.has("proj-agent")).toBe(true);
  });

  it("project agents override user agents with same name", () => {
    writeAgentFile(
      userAgentsDir,
      "shared.md",
      { name: "shared", description: "User version" },
      "User body",
    );
    writeAgentFile(
      projectAgentsDir,
      "shared.md",
      { name: "shared", description: "Project version" },
      "Project body",
    );

    const agents = loadFileAgents(tmpProjectDir);
    expect(agents.size).toBe(1);
    expect(agents.get("shared")!.description).toBe("Project version");
    expect(agents.get("shared")!.systemPrompt).toBe("Project body");
  });

  it("returns empty map when no agent files exist", () => {
    const agents = loadFileAgents(tmpProjectDir);
    expect(agents.size).toBe(0);
  });

  it("listFileAgents returns correct sources and handles overrides", () => {
    writeAgentFile(
      userAgentsDir,
      "user-only.md",
      { name: "user-only", description: "Only user" },
      "body",
    );
    writeAgentFile(
      userAgentsDir,
      "shared.md",
      { name: "shared", description: "User version" },
      "body",
    );
    writeAgentFile(
      projectAgentsDir,
      "shared.md",
      { name: "shared", description: "Project version" },
      "body",
    );
    writeAgentFile(
      projectAgentsDir,
      "proj-only.md",
      { name: "proj-only", description: "Only project" },
      "body",
    );

    const list = listFileAgents(tmpProjectDir);
    // user-only, shared (project), proj-only = 3 entries
    expect(list.length).toBe(3);

    const userOnly = list.find((a) => a.name === "user-only");
    expect(userOnly).toBeDefined();
    expect(userOnly!.source).toBe("user");

    const shared = list.find((a) => a.name === "shared");
    expect(shared).toBeDefined();
    expect(shared!.source).toBe("project"); // project overrides

    const projOnly = list.find((a) => a.name === "proj-only");
    expect(projOnly).toBeDefined();
    expect(projOnly!.source).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// Tests: Profile integration
// ---------------------------------------------------------------------------

describe("resolveProfile with file agents", () => {
  const tmpProjectDir = tmpDir();
  let userAgentsDir: string;

  beforeEach(() => {
    clearFileAgentsCache();
    const fakeHome = path.join(tmpProjectDir, "fake-home");
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    userAgentsDir = path.join(fakeHome, ".pi", "agents");
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    try {
      fs.rmSync(tmpProjectDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("resolves a file-based agent by name", () => {
    writeAgentFile(
      userAgentsDir,
      "custom-coder.md",
      {
        name: "custom-coder",
        description: "Custom coding agent",
        allowWrite: true,
        model: "small",
        tools: ["read", "bash", "edit", "write"],
      },
      "You are a custom coder.",
    );

    const profile = resolveProfile("custom-coder", tmpProjectDir);
    expect(profile.name).toBe("custom-coder");
    expect(profile.allowWrite).toBe(true);
    expect(profile.systemPrompt).toBe("You are a custom coder.");
  });

  it("falls through to built-in when file agent does not exist", () => {
    const profile = resolveProfile("explore", tmpProjectDir);
    expect(profile.name).toBe("explore");
    expect(profile.allowWrite).toBe(false);
  });

  it("file agent takes priority over built-in with same name", () => {
    // Create a file agent named "review" that overrides the built-in
    writeAgentFile(
      userAgentsDir,
      "review.md",
      {
        name: "review",
        description: "Custom review agent with write access",
        allowWrite: true,
      },
      "Custom review prompt",
    );

    const profile = resolveProfile("review", tmpProjectDir);
    expect(profile.name).toBe("review");
    expect(profile.allowWrite).toBe(true);
    expect(profile.systemPrompt).toBe("Custom review prompt");
  });

  it("returns default profile when name is undefined", () => {
    const profile = resolveProfile(undefined, tmpProjectDir);
    expect(profile.name).toBe("general");
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveProfileTools with disallowedTools
// ---------------------------------------------------------------------------

describe("resolveProfileTools with allowlist/denylist", () => {
  it("returns undefined for full-access profile with no restrictions", () => {
    const profile: AgentProfile = {
      name: "general",
      description: "Full access",
      allowWrite: true,
      allowBashWrite: true,
      model: "inherit",
      outputFormat: "free",
      systemPrompt: "",
    };
    expect(resolveProfileTools(profile)).toBeUndefined();
  });

  it("filters by capability when allowWrite is false", () => {
    const profile: AgentProfile = {
      name: "explore",
      description: "Read-only",
      allowWrite: false,
      allowBashWrite: false,
      model: "small",
      outputFormat: "structured",
      systemPrompt: "",
    };
    const tools = resolveProfileTools(profile);
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  it("uses explicit tools allowlist when set", () => {
    const profile: AgentProfile = {
      name: "custom",
      description: "Custom",
      allowWrite: true,
      allowBashWrite: true,
      model: "inherit",
      outputFormat: "free",
      systemPrompt: "",
      tools: ["read", "bash"],
    };
    const tools = resolveProfileTools(profile);
    expect(tools).toEqual(["read", "bash"]);
  });

  it("applies disallowedTools denylist to capability-derived set", () => {
    const profile: AgentProfile = {
      name: "safe",
      description: "Safe agent",
      allowWrite: true,
      allowBashWrite: true,
      model: "inherit",
      outputFormat: "free",
      systemPrompt: "",
      disallowedTools: ["Swarm", "SwarmCoordinator"],
    };
    const tools = resolveProfileTools(profile);
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).toContain("edit");
    expect(tools).toContain("write");
    expect(tools).not.toContain("Swarm");
    expect(tools).not.toContain("SwarmCoordinator");
  });

  it("combines explicit tools allowlist with capability filter", () => {
    const profile: AgentProfile = {
      name: "custom",
      description: "Custom",
      allowWrite: false, // should remove edit, write even from explicit list
      allowBashWrite: true,
      model: "inherit",
      outputFormat: "free",
      systemPrompt: "",
      tools: ["read", "bash", "edit", "write"],
    };
    const tools = resolveProfileTools(profile);
    expect(tools).toContain("read");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
  });

  it("combines explicit tools with disallowedTools", () => {
    const profile: AgentProfile = {
      name: "custom",
      description: "Custom",
      allowWrite: true,
      allowBashWrite: true,
      model: "inherit",
      outputFormat: "free",
      systemPrompt: "",
      tools: ["read", "bash", "edit"],
      disallowedTools: ["edit"],
    };
    const tools = resolveProfileTools(profile);
    expect(tools).toEqual(["read", "bash"]);
  });

  it("returns empty array when all tools are filtered out", () => {
    const profile: AgentProfile = {
      name: "empty",
      description: "Empty",
      allowWrite: false,
      allowBashWrite: false,
      model: "inherit",
      outputFormat: "free",
      systemPrompt: "",
      disallowedTools: ["read", "bash"],
    };
    const tools = resolveProfileTools(profile);
    expect(tools).toEqual([]);
  });
});
