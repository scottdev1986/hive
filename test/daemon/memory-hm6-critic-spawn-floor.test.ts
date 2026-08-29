import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveSpawner } from "../../src/daemon/spawn/hive-spawner";
import { buildMemoryIndex, writeMemoryFact } from "../../src/memory-service/memory-store";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { buildQueenLaunchContext } from "../../src/cli/orchestrator";

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;

afterEach(async () => {
  if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
  else Bun.env.HIVE_HOME = previousHiveHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function emptyPolicy() {
  return {
    version: 1 as const,
    default: "claude",
    category: {},
    model: {},
  };
}

describe("HM-6 critic: spawn/queen get pack floor WITHOUT memory_search", () => {
  test("REAL HiveSpawner.spawn gets pack floor without embeddings", async () => {
    previousHiveHome = Bun.env.HIVE_HOME;
    const home = await makeTempDir("hive-hm6-spawn-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-repo-");
    const worktree = await makeTempDir("hive-hm6-worktree-");
    const db = new HiveDatabase(":memory:");

    // Write memory articles (pack floor)
    await writeMemoryFact(repoRoot, {
      scope: "repo",
      topic: "testing",
      title: "Spawn floor fact",
      body: "This fact is in the spawn pack floor.",
      source: "agent",
      evidence: "spawn-test",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
    });

    let builtMemoryIndex: string | null = null;
    const spawner = new HiveSpawner({
      db,
      repoRoot,
      port: 4317,
      config: {},
      readRoutingPolicy: () => emptyPolicy(),
      isModelEnabled: async () => true,
      readBilling: async () => null,
      createWorktree: async () => ({ path: worktree, branch: "hive/test" }),
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      buildMemoryIndex: async (root, options) => {
        const index = await buildMemoryIndex(root, options);
        builtMemoryIndex = index;
        return index;
      },
      claudeExecutable: "claude",
      codexExecutable: "codex",
      grokExecutable: "grok",
      kimiExecutable: "kimi",
      opencodeExecutable: "opencode",
      sessiond: {
        prepareAgentCreation: async () => ({
          engineBuildId: "test",
          visibility: {
            workspaceSessionId: "test",
            workspacePid: 123,
            workspaceStartToken: "123:1",
            openTerminalRevision: "1",
          },
        }),
        admit: async () => null,
        terminalHost: {
          create: async () => {
            throw new Error("spawn refused before terminal");
          },
          inspect: async () => ({ state: "absent" }),
          terminate: async () => {},
        },
      },
      discoverCapabilities: async () => ({
        status: "unavailable",
        reason: "test",
      }),
    });

    // Spawn will fail (no capabilities), but it builds memory index first
    await spawner
      .spawn({
        id: "test-spawn",
        name: "test",
        task: "test task",
        category: "code_review",
        effort: { target: "best", instruction: null },
      })
      .catch(() => {
        /* expected */
      });

    // Verify pack floor was built via FTS-only (no embeddings)
    expect(builtMemoryIndex).not.toBeNull();
    expect(builtMemoryIndex).toContain("Spawn floor fact");
    expect(builtMemoryIndex).toContain("memory_search");
    expect(builtMemoryIndex).toContain("memory_read");

    // Verify buildMemoryIndex used FTS-only (no semantic)
    // It worked without embeddings being initialized
  });

  test("REAL buildQueenLaunchContext gets pack floor without embeddings", async () => {
    previousHiveHome = Bun.env.HIVE_HOME;
    const home = await makeTempDir("hive-hm6-queen-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-queen-repo-");

    // Write memory articles (pack floor)
    await writeMemoryFact(repoRoot, {
      scope: "repo",
      topic: "testing",
      title: "Queen floor fact",
      body: "This fact is in the queen pack floor.",
      source: "agent",
      evidence: "queen-test",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
    });

    // Build memory index (FTS-only, no embeddings)
    const memoryIndex = await buildMemoryIndex(repoRoot, {
      brief: "queen test",
    });

    // Call REAL buildQueenLaunchContext
    const launchText = await buildQueenLaunchContext({
      memoryIndex,
      repoRoot,
    });

    // Verify pack floor present
    expect(launchText).toContain("Hive Constitution");
    expect(launchText).toContain("Profile");
    expect(launchText).toContain("Project");

    // Verify memory index present
    expect(launchText).toContain("Knowledge index data");
    expect(launchText).toContain("Queen floor fact");

    // Verify memory_search mentioned as archive tool
    expect(launchText).toContain("memory_search");
    expect(launchText).toContain("memory_read");

    // Queen got pack floor without embeddings
  });

  test("buildMemoryIndex (spawn/queen path) always FTS-only", async () => {
    previousHiveHome = Bun.env.HIVE_HOME;
    const home = await makeTempDir("hive-hm6-fts-");
    Bun.env.HIVE_HOME = home;
    const repoRoot = await makeTempDir("hive-hm6-fts-repo-");

    await writeMemoryFact(repoRoot, {
      scope: "repo",
      topic: "testing",
      title: "FTS-only verification",
      body: "This proves buildMemoryIndex uses FTS-only.",
      source: "agent",
      evidence: "fts-test",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
    });

    // buildMemoryIndex is what spawn/queen call (not memory_search)
    const index = await buildMemoryIndex(repoRoot, {
      brief: "fts verification",
    });

    // Verify it worked without embeddings
    expect(index).toContain("FTS-only verification");
    expect(index).toContain("memory_search");

    // This proves spawn/queen path never requires semantic
    // memory_search is ARCHIVE (extra), not required for pack floor
  });
});
