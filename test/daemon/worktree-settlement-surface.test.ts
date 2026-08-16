import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ROLE_GRANTS } from "../../src/daemon/authorization/authorization-service";

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

describe("settlement mutation surface", () => {
  test("production has one worktree/branch mutation module and no public remover", async () => {
    const sourceRoot = join(import.meta.dir, "../../src");
    const hits: Array<{ path: string; pattern: string }> = [];
    for (const path of await sourceFiles(sourceRoot)) {
      const source = await readFile(path, "utf8");
      for (const pattern of [
        '"worktree", "remove"',
        '"branch", "-D"',
        '"update-ref", "-d"',
      ]) {
        if (source.includes(pattern)) {
          hits.push({ path: relative(sourceRoot, path), pattern });
        }
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    expect([...new Set(hits.map(({ path }) => path))].sort()).toEqual([
      "adapters/worktrees.ts",
    ]);
    const adapter = await import("../../src/adapters/worktrees");
    expect("removeWorktree" in adapter).toBe(false);
    expect("resetLandedBranch" in adapter).toBe(false);
    expect("releaseStewardshipRef" in adapter).toBe(false);
  });

  test("the user and the queen can mint destructive authority; writer and reader cannot", () => {
    expect(ROLE_GRANTS.user.actions).toContain("settlement:decide");
    expect(ROLE_GRANTS.orchestrator.actions).toContain("settlement:decide");
    expect(ROLE_GRANTS.writer.actions).not.toContain("settlement:decide");
    expect(ROLE_GRANTS.reader.actions).not.toContain("settlement:decide");
    expect(ROLE_GRANTS.orchestrator.actions).toContain("settlement:execute");
  });
});
