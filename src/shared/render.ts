/**
 * render — format AgentSwarm and SwarmTeam output.
 *
 * Produces the structured XML output that the parent LLM reads.
 * Format: XML-wrapped per-agent results.
 */

import type {
  SwarmSpawnSpec,
  SwarmResumeSpec,
  SubagentResult,
} from "./types.js";
import { escapeXmlAttr, escapeXmlBody } from "./xml.js";

// ---------------------------------------------------------------------------
// AgentSwarm XML output
// ---------------------------------------------------------------------------

interface SwarmRunResult {
  readonly spec: SwarmSpawnSpec | SwarmResumeSpec;
  readonly agentId?: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly state?: "started" | "not_started";
  readonly result?: string;
  readonly error?: string;
}

/**
 * Render the aggregated AgentSwarm result as an XML string.
 *
 * Format:
 *   <agent_swarm_result>
 *   <summary>completed: N, failed: M</summary>
 *   <subagent ... outcome="completed">result text</subagent>
 *   ...
 *   </agent_swarm_result>
 *
 * Note (#114): A <resume_hint> element was previously emitted when any result
 * was non-completed, instructing the LLM to call AgentSwarm with
 * resume_agent_ids. The AgentSwarm tool schema has additionalProperties: false
 * and no resume_agent_ids parameter, so the hint was misleading and has been
 * removed.
 */
export function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const aborted = results.filter((r) => r.status === "aborted").length;

  const lines: string[] = [
    "<agent_swarm_result>",
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  for (const result of results) {
    const agentId =
      result.agentId === undefined
        ? ""
        : ` agent_id="${escapeXmlAttr(result.agentId)}"`;
    const mode = result.spec.kind === "resume" ? ' mode="resume"' : "";
    const item =
      result.spec.item === undefined
        ? ""
        : ` item="${escapeXmlAttr(result.spec.item)}"`;
    const state = result.state === undefined ? "" : ` state="${result.state}"`;
    const body =
      result.status === "completed"
        ? (result.result ?? "")
        : (result.error ?? "unknown error");

    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${escapeXmlBody(body)}</subagent>`,
    );
  }

  lines.push("</agent_swarm_result>");
  return lines.join("\n");
}

/**
 * Convert SubagentResult array (from controller) to SwarmRunResult array.
 */
export function toSwarmRunResults<T>(
  results: readonly SubagentResult<T>[],
): SwarmRunResult[] {
  return results.map((r) => {
    const spec = r.task.data as unknown as SwarmSpawnSpec | SwarmResumeSpec;
    return {
      spec,
      agentId: r.agentId,
      status: r.status,
      state: r.state,
      result: r.result,
      error: r.error,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSwarmSummary(
  completed: number,
  failed: number,
  aborted: number,
): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(", ");
}
