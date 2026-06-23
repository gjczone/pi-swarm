/**
 * pi-invoke — resolve the pi CLI invocation command and arguments.
 *
 * Detects whether we are running inside a pi process (via process.argv)
 * or as a standalone npm package, and returns the appropriate
 * command + arguments to spawn a child pi instance.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve the command and arguments needed to invoke pi as a child process.
 * When running inside pi, reuses the current executable and script.
 * When running standalone, falls back to the `pi` CLI command.
 */
export function getPiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];

  // Bun virtual filesystem scripts cannot be reused directly.
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    // Running via a renamed binary (e.g., the pi binary itself).
    return { command: process.execPath, args };
  }

  // Generic Node/Bun runtime — rely on PATH to find `pi`.
  return { command: "pi", args };
}

/**
 * Build the standard pi CLI arguments for a subagent in --print mode.
 *
 * --print mode produces JSON Lines on stdout where each line is a
 * structured event (message_end, tool_result_end, etc.).
 */
export function buildSubagentArgs(opts: {
  task: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  cwd?: string;
  systemPromptFile?: string;
}): string[] {
  const args: string[] = ["--print"];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  }

  if (opts.maxTurns !== undefined) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  if (opts.systemPromptFile) {
    args.push("--append-system-prompt", opts.systemPromptFile);
  }

  args.push(opts.task);
  return args;
}
