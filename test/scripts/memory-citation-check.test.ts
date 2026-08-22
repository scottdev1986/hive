import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const check = join(
  import.meta.dir,
  "../../scripts/test-honesty/memory-citation-check.ts",
);
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fixture repo with known line counts, plus a memory scope whose wiki
 * holds the article under test. The checker resolves citations against the
 * repo root it is given, so the fixture never touches the real tree. */
function makeFixture(articleBodies: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "hive-memory-citation-check-"));
  fixtures.push(root);
  const repoRoot = join(root, "repo");
  const memoryRoot = join(root, "memory");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  mkdirSync(join(repoRoot, "docs/gone-soon"), { recursive: true });
  mkdirSync(join(memoryRoot, "wiki/topic"), { recursive: true });
  writeFileSync(
    join(repoRoot, "src/example.ts"),
    `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
  );
  writeFileSync(join(repoRoot, "Makefile"), "one\ntwo\nthree\n");
  for (const [name, body] of Object.entries(articleBodies)) {
    writeFileSync(join(memoryRoot, "wiki/topic", name), body);
  }
  return { repoRoot, memoryRoot };
}

function run(memoryRoot: string, repoRoot: string) {
  const result = Bun.spawnSync(["bun", check, memoryRoot, repoRoot], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("memory-citation-check", () => {
  test("passes when every citation resolves in range", () => {
    const { repoRoot, memoryRoot } = makeFixture({
      "ok.md": [
        "see src/example.ts:1-10 and src/example.ts:5 for the detail.",
        "the build entry is Makefile:2-3.",
      ].join("\n"),
    });
    const result = run(memoryRoot, repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3 citation(s) verified");
  });

  test("fails when a cited file does not exist", () => {
    const { repoRoot, memoryRoot } = makeFixture({
      "gone.md": "the accessor lives at src/daemon/lifecycle.ts:23-33 now.",
    });
    const result = run(memoryRoot, repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("src/daemon/lifecycle.ts:23-33");
    expect(result.stderr).toContain("cited file does not exist");
  });

  test("fails when a cited range is outside the file", () => {
    const { repoRoot, memoryRoot } = makeFixture({
      "range.md": "getHiveHome is at src/example.ts:22-24, and Makefile:41.",
    });
    const result = run(memoryRoot, repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("src/example.ts:22-24");
    expect(result.stderr).toContain("Makefile:41");
    expect(result.stderr).toContain("outside the file's 10 lines");
  });

  test("fails when a cited path is a directory", () => {
    const { repoRoot, memoryRoot } = makeFixture({
      "dir.md": "documented at docs/gone-soon:1-3.",
    });
    const result = run(memoryRoot, repoRoot);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("directory, not a file");
  });

  test("ignores prose that carries colons and digits without citing code", () => {
    const { repoRoot, memoryRoot } = makeFixture({
      "prose.md": [
        "updated: 2026-08-12",
        "rewritten as a success report by 20:32Z and refused at 14:27Z.",
        "the daemon listens on 127.0.0.1:63104 and localhost:63105.",
        "absolute paths like /Users/scott/example.ts:99 are not repo-relative.",
        "raw history stays at ../../raw/topic/2026-08-09-note.md:3 unread.",
      ].join("\n"),
    });
    const result = run(memoryRoot, repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0 citation(s) verified");
  });
});
