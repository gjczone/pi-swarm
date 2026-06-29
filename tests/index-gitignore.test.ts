/**
 * tests/index-gitignore.test.ts — #110: ensureGitignore must not create
 * .gitignore in a non-git directory, and must behave correctly in git repos.
 *
 * The auto-gitignore feature should only manage .gitignore when the project
 * is actually a git repository. Creating .gitignore in non-git directories
 * is unwanted side-effect pollution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGitignore } from "../src/shared/gitignore.js";

function gitInit(dir: string): void {
  execFileSync("git", ["init"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 5000,
  });
}

describe("#110 ensureGitignore: respects non-git directories", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT create .gitignore when cwd is not a git repository", () => {
    ensureGitignore(dir);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("creates .gitignore with the entry when cwd is a git repo and no .gitignore exists", () => {
    gitInit(dir);
    ensureGitignore(dir);
    const gitignorePath = join(dir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toContain(".pi/swarm/state/");
  });

  it("appends the entry to an existing .gitignore in a git repo", () => {
    gitInit(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
    ensureGitignore(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".pi/swarm/state/");
  });

  it("is a no-op when .gitignore already contains the entry", () => {
    gitInit(dir);
    const existing = "node_modules/\n.pi/swarm/state/\n";
    writeFileSync(join(dir, ".gitignore"), existing, "utf-8");
    ensureGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(existing);
  });
});
