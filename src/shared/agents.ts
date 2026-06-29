/**
 * agents — File-based agent definition loader.
 *
 * Loads reusable agent configurations from Markdown files with YAML frontmatter
 * in ~/.pi/agents/ (user-global) and .pi/agents/ (project-scoped).
 *
 * Each .md file defines one named agent:
 *
 *   ---
 *   name: rust-audit
 *   description: Rust code audit specialist
 *   allowWrite: false
 *   allowBashWrite: false
 *   model: small
 *   outputFormat: structured
 *   disallowedTools:
 *     - Swarm
 *     - SwarmCoordinator
 *   ---
 *   You are a Rust audit specialist...
 *
 * Layer: shared/ — pure Node.js, no pi or tui imports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentFileDefinition,
  AgentProfile,
  FileAgentSource,
  AgentOutputFormat,
  AgentMatchRule,
} from "./types.js";

// ---------------------------------------------------------------------------
// Cache for file agent profiles — avoids repeated filesystem I/O
// ---------------------------------------------------------------------------

const fileAgentsCache = new Map<string, Map<string, AgentProfile>>();

/**
 * Clear the file agents cache.
 * Useful in tests and when agent files are modified at runtime.
 */
export function clearFileAgentsCache(): void {
  fileAgentsCache.clear();
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (lightweight YAML subset, no external dependency)
// ---------------------------------------------------------------------------

/** Parsed frontmatter key-value pairs. */
interface FrontmatterData {
  [key: string]: unknown;
}

/**
 * Split a .md file into frontmatter and body.
 * Returns { frontmatter: string, body: string } or null if no frontmatter.
 */
function splitFrontmatter(
  raw: string,
): { frontmatter: string; body: string } | null {
  const lines = raw.split("\n");
  // First line must be exactly "---"
  if (lines.length < 2 || lines[0]!.trim() !== "---") return null;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const frontmatter = lines.slice(1, endIdx).join("\n");
  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .trim();
  return { frontmatter, body };
}

/**
 * Parse a simplified YAML string into key-value pairs.
 *
 * Supports:
 * - Plain scalar values (strings, booleans, numbers)
 * - Single-line strings (unquoted or quoted)
 * - Lists with `- ` prefix (indented under a key)
 * - Nested keys via indentation
 *
 * Does NOT support:
 * - Multi-line strings (folded, literal)
 * - Anchors, aliases, tags
 * - Complex nesting (maps within maps)
 */
function parseSimpleYaml(yaml: string): FrontmatterData {
  const result: FrontmatterData = {};
  const lines = yaml.split("\n");

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || line.startsWith("#")) continue;

    // Detect list item under current key
    const listMatch = line.match(/^(\s+)-\s+(.+)/);
    if (listMatch && currentKey) {
      const value = parseScalar(listMatch[2]!.trim());
      if (typeof value === "string") {
        if (!currentList) {
          currentList = [];
          result[currentKey] = currentList;
        }
        currentList.push(value);
      }
      continue;
    }

    // Top-level key-value pair
    const kvMatch = line.match(/^(\S[^:]*?):\s*(.*)/);
    if (kvMatch) {
      // Flush previous list context
      currentList = null;
      currentKey = kvMatch[1]!.trim();
      const rawValue = kvMatch[2]!.trim();

      if (rawValue === "") {
        // Key with no value — could be a list parent
        // Don't set anything yet; wait for list items
        currentList = null;
      } else if (rawValue.startsWith("[")) {
        // Inline list: [a, b, c]
        const inlineList = rawValue
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter((s) => s.length > 0);
        result[currentKey] = inlineList;
      } else {
        result[currentKey] = parseScalar(rawValue);
      }
    }
  }

  return result;
}

/** Parse a scalar YAML value into its typed equivalent. */
function parseScalar(raw: string): string | boolean | number {
  const trimmed = raw.trim();

  // Boolean
  if (trimmed === "true" || trimmed === "yes" || trimmed === "on") return true;
  if (trimmed === "false" || trimmed === "no" || trimmed === "off")
    return false;

  // Number
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== "") {
    // Only treat as number if it looks like a number (not a quoted string)
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return num;
  }

  // Quoted string — strip quotes
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  if (quoted) return quoted[2]!;

  return trimmed;
}

// ---------------------------------------------------------------------------
// Agent file scanning and parsing
// ---------------------------------------------------------------------------

/** Resolve the user-level agents directory (~/.pi/agents/). */
function resolveUserAgentsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".pi", "agents");
}

/** Resolve the project-level agents directory (.pi/agents/). */
function resolveProjectAgentsDir(cwd?: string): string {
  return path.join(cwd ?? process.cwd(), ".pi", "agents");
}

/**
 * Scan a directory for .md files and parse each as an agent definition.
 * Returns a map of agent name → AgentFileDefinition.
 */
function scanDirectory(
  dir: string,
  source: FileAgentSource,
): Map<string, AgentFileDefinition> {
  const agents = new Map<string, AgentFileDefinition>();

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Directory doesn't exist or can't be read — not an error
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      // Skip unreadable files
      continue;
    }

    const parsed = parseAgentFile(filePath, raw, source);
    if (parsed) {
      agents.set(parsed.name, parsed);
    }
  }

  return agents;
}

/**
 * Parse a single .md file into an AgentFileDefinition.
 * Returns null if parsing fails.
 */
function parseAgentFile(
  filePath: string,
  raw: string,
  source: FileAgentSource,
): AgentFileDefinition | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;

  const fm = parseSimpleYaml(split.frontmatter);
  const body = split.body;

  // Derive name: frontmatter 'name' field, or filename without .md
  const nameFromFile = path.basename(filePath, ".md");
  const name =
    typeof fm["name"] === "string" && fm["name"].trim().length > 0
      ? fm["name"].trim()
      : nameFromFile;

  const description =
    typeof fm["description"] === "string" ? fm["description"].trim() : "";

  if (!name || !description) return null;

  // Model (optional)
  let model: string | undefined;
  if (typeof fm["model"] === "string" && fm["model"].trim().length > 0) {
    model = fm["model"].trim();
    if (model.toLowerCase() === "inherit") model = undefined;
  }

  // Output format
  const outputFormatRaw = fm["outputFormat"];
  const outputFormat: AgentOutputFormat | undefined =
    outputFormatRaw === "structured" ? "structured" : undefined;

  // Tool allowlist
  const tools = parseStringArray(fm["tools"]);

  // Tool denylist
  const disallowedTools = parseStringArray(fm["disallowedTools"]);

  // Capability flags
  const allowWrite =
    typeof fm["allowWrite"] === "boolean" ? fm["allowWrite"] : true;
  const allowBashWrite =
    typeof fm["allowBashWrite"] === "boolean" ? fm["allowBashWrite"] : true;

  // Match rules for automatic routing
  const matchPatterns = parseStringArray(fm["matchPatterns"]);
  const matchKeywords = parseStringArray(fm["matchKeywords"]);
  const match: AgentMatchRule | undefined =
    matchPatterns.length > 0 || matchKeywords.length > 0
      ? {
          patterns: matchPatterns.length > 0 ? matchPatterns : undefined,
          keywords: matchKeywords.length > 0 ? matchKeywords : undefined,
        }
      : undefined;

  return {
    name,
    description,
    allowWrite,
    allowBashWrite,
    model,
    outputFormat,
    match,
    tools: tools.length > 0 ? tools : undefined,
    disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
    prompt: body,
    source,
    filePath,
  };
}

/** Parse a frontmatter value into a string array. */
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all file-based agent definitions.
 *
 * Resolution order: project agents (.pi/agents/) override user agents (~/.pi/agents/).
 * Returns a map of agent name → AgentProfile, ready for resolveProfile() integration.
 *
 * Results are cached per working directory. Call clearFileAgentsCache() to invalidate.
 */
export function loadFileAgents(cwd?: string): Map<string, AgentProfile> {
  const cacheKey = cwd ?? process.cwd();
  const cached = fileAgentsCache.get(cacheKey);
  if (cached) return cached;

  const profiles = new Map<string, AgentProfile>();

  // Load user agents first (lower priority)
  const userDir = resolveUserAgentsDir();
  const userAgents = scanDirectory(userDir, "user");
  for (const [name, def] of userAgents) {
    profiles.set(name, convertToProfile(def));
  }

  // Load project agents (higher priority — overrides user agents with same name)
  const projectDir = resolveProjectAgentsDir(cwd);
  const projectAgents = scanDirectory(projectDir, "project");
  for (const [name, def] of projectAgents) {
    profiles.set(name, convertToProfile(def));
  }

  fileAgentsCache.set(cacheKey, profiles);
  return profiles;
}

/**
 * Load a single file-based agent by name.
 * Checks project dir first, then user dir.
 */
export function loadFileAgent(
  name: string,
  cwd?: string,
): AgentProfile | undefined {
  // Check project dir first
  const projectDir = resolveProjectAgentsDir(cwd);
  const projectAgents = scanDirectory(projectDir, "project");
  const projectAgent = projectAgents.get(name);
  if (projectAgent) return convertToProfile(projectAgent);

  // Check user dir
  const userDir = resolveUserAgentsDir();
  const userAgents = scanDirectory(userDir, "user");
  const userAgent = userAgents.get(name);
  if (userAgent) return convertToProfile(userAgent);

  return undefined;
}

/**
 * Convert an AgentFileDefinition to an AgentProfile.
 *
 * The systemPrompt is the Markdown body content.
 * tools/disallowedTools are passed through for resolveProfileTools() to handle.
 */
function convertToProfile(def: AgentFileDefinition): AgentProfile {
  return {
    name: def.name,
    description: def.description,
    allowWrite: def.allowWrite ?? true,
    allowBashWrite: def.allowBashWrite ?? true,
    model: def.model ?? "inherit",
    outputFormat: def.outputFormat ?? "free",
    systemPrompt: def.prompt,
    tools: def.tools,
    disallowedTools: def.disallowedTools,
    match: def.match,
  };
}

/**
 * List all available file-based agent names with descriptions.
 * Useful for the /agents command.
 */
export function listFileAgents(
  cwd?: string,
): Array<{ name: string; description: string; source: FileAgentSource }> {
  const agents: Array<{
    name: string;
    description: string;
    source: FileAgentSource;
  }> = [];

  const userDir = resolveUserAgentsDir();
  for (const [, def] of scanDirectory(userDir, "user")) {
    // Don't add if project will override
    agents.push({
      name: def.name,
      description: def.description,
      source: "user",
    });
  }

  const projectDir = resolveProjectAgentsDir(cwd);
  // Remove user entries that will be overridden
  const projectNames = new Set<string>();
  for (const [name, def] of scanDirectory(projectDir, "project")) {
    projectNames.add(name);
    agents.push({
      name: def.name,
      description: def.description,
      source: "project",
    });
  }

  // Filter out user entries that are shadowed by project entries
  return agents.filter(
    (a) => a.source === "project" || !projectNames.has(a.name),
  );
}

// ---------------------------------------------------------------------------
// Item-to-agent routing
// ---------------------------------------------------------------------------

/**
 * Match a Swarm item to the most suitable file-based agent.
 *
 * Matching phases (ordered by specificity):
 *   1. Pattern match — across ALL agents, pick the one with the longest
 *      (most specific) matching pattern. Longer pattern = higher specificity,
 *      so `*.test.ts` beats `*.ts`.
 *   2. Keyword match — if no pattern matched, first keyword match wins.
 *
 * Returns the matched AgentProfile, or undefined if no match found.
 */
export function matchItemToAgent(
  item: string,
  agents: Map<string, AgentProfile> | undefined,
): AgentProfile | undefined {
  if (!agents || agents.size === 0) return undefined;

  const itemLower = item.toLowerCase();

  // Phase 1: pattern matching — find the most specific matching pattern
  let bestProfile: AgentProfile | undefined;
  let bestPatternLen = -1;

  for (const [, profile] of agents) {
    const match = profile.match;
    if (!match || !match.patterns) continue;

    for (const pattern of match.patterns) {
      if (pattern.length > bestPatternLen && matchGlobPattern(item, pattern)) {
        bestProfile = profile;
        bestPatternLen = pattern.length;
      }
    }
  }

  if (bestProfile) return bestProfile;

  // Phase 2: keyword matching (case-insensitive substring) — first match wins
  for (const [, profile] of agents) {
    const match = profile.match;
    if (!match || !match.keywords) continue;

    for (const kw of match.keywords) {
      if (itemLower.includes(kw.toLowerCase())) {
        return profile;
      }
    }
  }

  return undefined;
}

/**
 * Minimal glob pattern matcher.
 *
 * Supports:
 *   - `*.ext` — matches any path ending with `.ext`
 *   - `path/*.ext` — matches paths under `path/` with `.ext`
 *   - `*` — matches everything
 *
 * Does NOT support `**`, `{a,b}`, `?`, or bracket expressions.
 */
function matchGlobPattern(item: string, pattern: string): boolean {
  if (pattern === "*") return true;

  // Simple wildcard: split on * and check prefix/suffix
  const parts = pattern.split("*");
  if (parts.length === 1) {
    // No wildcard — exact suffix match
    return item.endsWith(pattern);
  }

  if (parts.length === 2) {
    // One wildcard: prefix*suffix
    const [prefix, suffix] = parts;
    const prefixOk = !prefix || item.startsWith(prefix);
    const suffixOk = !suffix || item.endsWith(suffix);
    if (prefixOk && suffixOk) {
      // Ensure the wildcard matches at least something between prefix and suffix
      if (prefix && suffix) {
        return item.length >= prefix.length + suffix.length;
      }
      return true;
    }
    return false;
  }

  // Multiple wildcards — fall back to simple suffix check for now
  const lastPart = parts[parts.length - 1];
  return lastPart ? item.endsWith(lastPart) : false;
}

// ---------------------------------------------------------------------------
// Agent listing (for LLM-facing tool descriptions)
// ---------------------------------------------------------------------------

/**
 * Match summary for display in agent listing.
 */
function formatMatchSummary(match: AgentMatchRule | undefined): string {
  if (!match) return "";
  const parts: string[] = [];
  if (match.patterns && match.patterns.length > 0) {
    parts.push("pattern: " + match.patterns.slice(0, 3).join(", "));
    if (match.patterns.length > 3) parts[parts.length - 1] += "...";
  }
  if (match.keywords && match.keywords.length > 0) {
    parts.push("kw: " + match.keywords.slice(0, 3).join(", "));
    if (match.keywords.length > 3) parts[parts.length - 1] += "...";
  }
  return parts.length > 0 ? " [" + parts.join("; ") + "]" : "";
}

/**
 * Build a formatted listing of all available agents for inclusion in
 * the Swarm tool description, similar to CCB's AgentTool.prompt().
 *
 * Groups agents into:
 *   1. Built-in profiles (accessible via `profile` parameter)
 *   2. File-based agents (accessible via `agentType` parameter)
 *
 * Each entry shows agentType/name, description, and match rules.
 */
export function buildAgentListing(
  fileAgents: Map<string, AgentProfile> | undefined,
  builtinProfiles?: Record<string, AgentProfile>,
): string {
  const lines: string[] = [];

  // Built-in profiles
  if (builtinProfiles) {
    const entries = Object.entries(builtinProfiles);
    if (entries.length > 0) {
      lines.push("  Built-in profiles (use via profile param):");
      for (const [, p] of entries) {
        const toolHint = p.allowWrite
          ? "read, edit, bash, write"
          : "read, bash";
        lines.push(
          `    ${p.name.padEnd(12)} ${p.description} [tools: ${toolHint}]`,
        );
      }
      lines.push("");
    }
  }

  // File-based agents
  if (fileAgents && fileAgents.size > 0) {
    lines.push("  File-based agents (use via agentType param):");
    for (const [, p] of fileAgents) {
      const matchStr = formatMatchSummary(p.match);
      lines.push(`    ${p.name.padEnd(18)} ${p.description}${matchStr}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

/** Exported for testing — parse frontmatter from raw text. */
export function parseFrontmatterForTest(raw: string): FrontmatterData | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  return parseSimpleYaml(split.frontmatter);
}

/** Exported for testing — parse a full .md file into an AgentFileDefinition. */
export function parseAgentFileForTest(
  filePath: string,
  raw: string,
  source: FileAgentSource,
): AgentFileDefinition | null {
  return parseAgentFile(filePath, raw, source);
}
