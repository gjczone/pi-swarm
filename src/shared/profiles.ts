/**
 * profiles — Agent profile registry.
 *
 * Provides built-in profiles (explore, plan, general, review) and
 * user-defined custom profiles loaded from .pi/settings.json.
 *
 * Profiles define role-specific behavior: tool restrictions (by capability,
 * not hardcoded tool names), model routing, system prompts, and output format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProfile, BuiltinProfileName } from "./types.js";
import { loadFileAgents } from "./agents.js";

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

const BUILTIN_PROFILES: Record<BuiltinProfileName, AgentProfile> = {
  explore: {
    name: "explore",
    description:
      "Read-only fast search specialist. Use for codebase exploration, file finding, and architecture investigation. No file modifications.",
    allowWrite: false,
    allowBashWrite: false,
    model: "small",
    outputFormat: "structured",
    systemPrompt: [
      "You are an exploration specialist operating in READ-ONLY mode.",
      "",
      "CRITICAL RULES:",
      "- You MUST NOT create, modify, or delete any files (no edit, no write).",
      "- You MUST NOT run commands that change state (no npm install, no git commit, no builds that write files).",
      "- Allowed bash commands: read-only operations only (ls, find, grep, cat, git log, git diff, git status, head, tail, wc, sort, uniq).",
      "",
      "## REQUIRED OUTPUT FORMAT",
      "",
      "Scope: <one-sentence summary of what you explored>",
      "Result: <key findings in 2-3 concise paragraphs>",
      "Key files: <comma-separated list of critical file paths>",
      "Issues: <list of problems found, or 'none'>",
    ].join("\n"),
  },

  plan: {
    name: "plan",
    description:
      "Read-only architecture planner. Use for designing solutions, listing critical files, and creating implementation plans. No file modifications.",
    allowWrite: false,
    allowBashWrite: false,
    model: "inherit",
    outputFormat: "structured",
    systemPrompt: [
      "You are a planning and architecture specialist operating in READ-ONLY mode.",
      "",
      "CRITICAL RULES:",
      "- You MUST NOT create, modify, or delete any files (no edit, no write).",
      "- You MUST NOT run commands that change state.",
      "- Allowed bash commands: read-only operations only (ls, find, grep, cat, git log, git diff, git status).",
      "",
      "Your task is to analyze the codebase and produce a concrete implementation plan.",
      "",
      "## REQUIRED OUTPUT FORMAT",
      "",
      "Scope: <one-sentence summary of the planned change>",
      "Approach: <why this approach, alternatives considered and rejected>",
      "Key files: <comma-separated list of files that must be modified>",
      "Steps: <numbered list of implementation steps>",
      "Risks: <potential issues or edge cases>",
    ].join("\n"),
  },

  general: {
    name: "general",
    description:
      "General-purpose coder. Full read/write access. Default profile for implementation tasks.",
    allowWrite: true,
    allowBashWrite: true,
    model: "inherit",
    outputFormat: "free",
    systemPrompt: "",
  },

  review: {
    name: "review",
    description:
      "Code review specialist. Read-only, produces structured review findings with severity levels.",
    allowWrite: false,
    allowBashWrite: false,
    model: "inherit",
    outputFormat: "structured",
    systemPrompt: [
      "You are a code review specialist operating in READ-ONLY mode.",
      "",
      "CRITICAL RULES:",
      "- You MUST NOT create, modify, or delete any files (no edit, no write).",
      "- You MUST NOT run commands that change state.",
      "",
      "Review the code for bugs, security issues, logic errors, edge cases, and style problems.",
      "",
      "## REQUIRED OUTPUT FORMAT",
      "",
      "Scope: <one-sentence summary of what was reviewed>",
      "Summary: <overall assessment in 1-2 sentences>",
      "Findings:",
      "  - [P0/P1/P2/P3] <file:line>: <description> — <recommended fix>",
      "  (P0=critical/security, P1=will cause bugs, P2=should fix, P3=nitpick)",
      "Positive notes: <what was done well>",
    ].join("\n"),
  },
};

const DEFAULT_PROFILE: AgentProfile = BUILTIN_PROFILES.general;

// ---------------------------------------------------------------------------
// User-defined profiles from settings
// ---------------------------------------------------------------------------

interface PiSwarmSettings {
  maxConcurrency?: number;
  smallModel?: string;
  subagents?: Record<string, UserProfileConfig>;
}

interface UserProfileConfig {
  description?: string;
  allowWrite?: boolean;
  allowBashWrite?: boolean;
  model?: string | "inherit";
  outputFormat?: "free" | "structured";
  systemPrompt?: string;
}

function readPiSettings(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loadUserProfiles(cwd?: string): Record<string, AgentProfile> {
  const profiles: Record<string, AgentProfile> = {};
  const searchPaths = [path.join(cwd ?? process.cwd(), ".pi", "settings.json")];
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    searchPaths.push(path.join(home, ".pi", "agent", "settings.json"));
  }

  for (const settingsPath of searchPaths) {
    const settings = readPiSettings(settingsPath);
    if (!settings) continue;
    const swarm = settings["pi-swarm"] as PiSwarmSettings | undefined;
    const subagents = swarm?.subagents;
    if (!subagents || typeof subagents !== "object") continue;

    for (const [name, config] of Object.entries(subagents)) {
      if (!config || typeof config !== "object") continue;
      profiles[name] = {
        name,
        description: config.description ?? `Custom subagent: ${name}`,
        allowWrite: config.allowWrite ?? true,
        allowBashWrite: config.allowBashWrite ?? true,
        model: config.model ?? "inherit",
        outputFormat: config.outputFormat ?? "free",
        systemPrompt: config.systemPrompt ?? "",
      };
    }
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an agent profile by name.
 *
 * Lookup order:
 *   1. Project-scoped file agent (.pi/agents/<name>.md)
 *   2. User-global file agent (~/.pi/agents/<name>.md)
 *   3. User-defined profiles (from .pi/settings.json pi-swarm.subagents)
 *   4. Built-in profiles (explore, plan, general, review)
 *   5. Fallback: general profile
 */
export function resolveProfile(
  name: string | undefined,
  cwd?: string,
): AgentProfile {
  // 1. File-based agents (project-scoped first, then user-global)
  if (name) {
    const fileAgents = loadFileAgents(cwd);
    const fileAgent = fileAgents.get(name);
    if (fileAgent) return fileAgent;

    // 2. User-defined profiles from settings.json
    const userProfiles = loadUserProfiles(cwd);
    const userProfile = userProfiles[name];
    if (userProfile) return userProfile;

    // 3. Built-in profiles
    const builtinName = name as BuiltinProfileName;
    if (BUILTIN_PROFILES[builtinName]) return BUILTIN_PROFILES[builtinName];
  }
  // 4. Fallback
  return DEFAULT_PROFILE;
}

/**
 * Get all built-in profiles.
 */
export function getBuiltinProfiles(): Record<BuiltinProfileName, AgentProfile> {
  return { ...BUILTIN_PROFILES };
}

/**
 * Resolve the effective model for a profile.
 *
 * - "small" resolves to the configured smallModel from settings
 * - "inherit" returns undefined (use parent session model)
 * - explicit model ID is returned as-is
 */
export function resolveProfileModel(
  profile: AgentProfile,
  cwd?: string,
): string | undefined {
  if (!profile.model || profile.model === "inherit") return undefined;
  if (profile.model === "small") {
    return resolveSmallModel(cwd);
  }
  return profile.model;
}

/**
 * Derive tool restrictions for a profile.
 * Returns a list of allowed tools, or undefined for "all tools".
 *
 * Resolution order:
 *   1. If profile.tools (explicit allowlist) is set → use that list exactly
 *      (capability flags still filter native tools from it)
 *   2. If profile.disallowedTools is set → start from capability-derived base,
 *      then subtract disallowed items
 *   3. If neither → use capability flags only
 *
 * Capability flags:
 * - allowWrite=false: remove edit, write from resolved set
 * - allowBashWrite=false: keep bash but caller should add read-only prompt
 *
 * Since community tools vary by installation, capability flags are the
 * recommended portable mechanism. Explicit tool lists are for power users.
 */
export function resolveProfileTools(
  profile: AgentProfile,
): string[] | undefined {
  // Step 1: Determine the base tool set
  let tools: string[];

  if (profile.tools && profile.tools.length > 0) {
    // Use explicit allowlist as starting point
    tools = [...profile.tools];
  } else {
    // Derive from capability flags
    tools = ["read", "bash"];
    if (profile.allowWrite) {
      tools.push("edit", "write");
    }
  }

  // Step 2: Apply capability flags (always enforced)
  if (!profile.allowWrite) {
    tools = tools.filter((t) => t !== "edit" && t !== "write");
  }

  // Step 3: Apply denylist
  if (profile.disallowedTools && profile.disallowedTools.length > 0) {
    const deny = new Set(profile.disallowedTools);
    tools = tools.filter((t) => !deny.has(t));
  }

  // Return undefined if all 4 native tools are available with no allowlist/denylist
  // (optimization for spawner — no --tools flag = all tools available)
  if (
    !profile.tools &&
    !profile.disallowedTools &&
    tools.length === 4 &&
    tools.includes("read") &&
    tools.includes("bash") &&
    tools.includes("edit") &&
    tools.includes("write")
  ) {
    return undefined;
  }
  return tools.length === 0 ? [] : tools;
}

/**
 * Get bash restriction guidance for profiles that disallow write commands.
 */
export function getBashRestrictionPrompt(profile: AgentProfile): string {
  if (profile.allowBashWrite) return "";
  return [
    "",
    "BASH COMMAND RESTRICTION:",
    "You may ONLY run read-only bash commands: ls, find, grep, cat, head, tail, wc, sort, uniq, git log, git diff, git status, file, stat.",
    "Do NOT run: npm install, npm build, git commit, git checkout, mkdir, rm, cp, mv, or any command that creates/modifies/deletes files.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Agent name derivation
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable agent name.
 *
 * Priority:
 *   1. Explicit profile name
 *   2. First meaningful segment of item text (e.g. "repo-inspect: ..." -> "repo-inspect")
 *   3. Fallback: agent-{index}
 */
export function deriveAgentName(
  profileName: string | undefined,
  item: string | undefined,
  index: number,
): string {
  if (profileName && profileName !== "coder" && profileName !== "subagent") {
    return profileName;
  }
  if (item) {
    const trimmed = item.trim();
    const colonIdx = trimmed.indexOf(":");
    const dashIdx = trimmed.indexOf(" - ");
    let segment: string;
    if (colonIdx > 0 && colonIdx < 30) {
      segment = trimmed.slice(0, colonIdx);
    } else if (dashIdx > 0 && dashIdx < 30) {
      segment = trimmed.slice(0, dashIdx);
    } else {
      segment = trimmed.split(/\s+/)[0] ?? "";
    }
    segment = segment.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
    if (segment.length >= 2 && segment.length <= 30) {
      return segment;
    }
  }
  return `agent-${index}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSmallModel(cwd?: string): string | undefined {
  const searchPaths = [path.join(cwd ?? process.cwd(), ".pi", "settings.json")];
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    searchPaths.push(path.join(home, ".pi", "agent", "settings.json"));
  }
  for (const settingsPath of searchPaths) {
    const settings = readPiSettings(settingsPath);
    if (!settings) continue;
    const swarm = settings["pi-swarm"] as PiSwarmSettings | undefined;
    const val = swarm?.smallModel;
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}
