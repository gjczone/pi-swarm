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
  mkdirSync,
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

describe("#123 ensureGitignore: writes to .pi/.gitignore, never project root", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gi-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT create any gitignore when cwd is not a git repository", () => {
    ensureGitignore(dir);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".pi", ".gitignore"))).toBe(false);
  });

  it("does NOT create .gitignore at project root even in a git repo", () => {
    gitInit(dir);
    ensureGitignore(dir);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("creates .pi/.gitignore with the entry when git repo and no .pi/.gitignore exists", () => {
    gitInit(dir);
    ensureGitignore(dir);
    const piGitignorePath = join(dir, ".pi", ".gitignore");
    expect(existsSync(piGitignorePath)).toBe(true);
    expect(readFileSync(piGitignorePath, "utf-8")).toContain(
      "swarm/state/",
    );
  });

  it("appends the entry to an existing .pi/.gitignore in a git repo", () => {
    gitInit(dir);
    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, ".gitignore"), "node_modules/\n", "utf-8");
    ensureGitignore(dir);
    const content = readFileSync(join(piDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("swarm/state/");
  });

  it("is a no-op when .pi/.gitignore already contains the entry", () => {
    gitInit(dir);
    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    const existing = "node_modules/\nswarm/state/\n";
    writeFileSync(join(piDir, ".gitignore"), existing, "utf-8");
    ensureGitignore(dir);
    expect(readFileSync(join(piDir, ".gitignore"), "utf-8")).toBe(existing);
  });

  it("never touches a root .gitignore even if it exists", () => {
    gitInit(dir);
    const rootGitignore = join(dir, ".gitignore");
    const original = "dist/\n";
    writeFileSync(rootGitignore, original, "utf-8");
    ensureGitignore(dir);
    expect(readFileSync(rootGitignore, "utf-8")).toBe(original);
    expect(existsSync(join(dir, ".pi", ".gitignore"))).toBe(true);
  });
});
