import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHiveHome } from "../../src/hive-home/home";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveSpawner } from "../../src/daemon/spawn/hive-spawner";
import {
  buildMemoryIndex,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import { buildQueenLaunchContext } from "../../src/cli/orchestrator";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../../src/schemas/capability";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";

const AT = "2026-08-29T00:00:00.000Z";

const unmeasuredCodexRecord: CapabilityRecord = {
  provider: "codex",
  accountFingerprint: "codex:hm6-test",
  cliVersion: "test",
  canonicalId: "gpt-test",
  variant: null,
  launchToken: "gpt-test",
  displayName: "gpt-test",
  aliases: [],
  entitled: known(true, "codex.model/list", AT),
  hidden: known(false, "codex.model/list", AT),
  supportsEffort: unknown("surface-silent", "codex.model/list", AT),
  supportedEffortLevels: unknown("surface-silent", "codex.model/list", AT),
  defaultEffort: unknown("surface-silent", "codex.model/list", AT),
  observedAt: AT,
};

const tempRoots: string[] = [];
let previousHiveHome: string | undefined;
let previousCodexHome: string | undefined;

afterEach(async () => {
  if (previousHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = previousHiveHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
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

describe("HM-6 critic: spawn/queen get pack floor WITHOUT memory_search", () => {
  test("REAL HiveSpawner.spawn writes prompt with pack floor (FTS-only)", async () => {
    previousHiveHome = process.env.HIVE_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    const home = await makeTempDir("hive-hm6-spawn-");
    const repoRoot = await makeTempDir("hive-hm6-repo-");
    const worktree = join(repoRoot, "hive-test-worktree");
    await mkdir(worktree, { recursive: true });
    process.env.HIVE_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");

    // Copy AGENT_STANDARDS.md (required for spawn)
    await copyFile(
      join(import.meta.dir, "../../AGENT_STANDARDS.md"),
      join(repoRoot, "AGENT_STANDARDS.md"),
    );

    const db = new HiveDatabase(":memory:");

    // Write memory articles (pack floor)
    await writeMemoryFact(repoRoot, {
      scope: "repo",
      topic: "testing",
      title: "Spawn floor fact",
      body: "This fact is in the spawn pack floor without embeddings.",
      source: "agent",
      evidence: "spawn-test",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
    });

    const policy: RoutingPolicy = {
      schemaVersion: 3,
      revision: 1,
      updatedAt: AT,
      provisional: false,
      providers: {},
      models: [],
      global: null,
      categories: {
        simple_coding: {
          mode: "user-weighted",
          candidates: [
            {
              provider: "codex",
              model: "gpt-test",
              effort: { mode: "provider-controlled" },
              weight: 1,
            },
          ],
        },
      },
    };

    const admission = {
      engineBuildId: "hm6-test",
      visibility: {
        workspaceSessionId: "hm6-test",
        workspacePid: 12345,
        workspaceStartToken: "12345:1",
        openTerminalRevision: "1",
      },
    };

    const spawner = new HiveSpawner({
      db,
      repoRoot,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policy,
      isModelEnabled: async () => true,
      discoverCapabilities: async (provider) =>
        provider === "codex"
          ? {
              status: "ok",
              records: [unmeasuredCodexRecord],
              effectiveDefault: {
                provider: "codex",
                model: unknown("field-absent", "codex.config/read", AT),
                effort: unknown("field-absent", "codex.config/read", AT),
              },
            }
          : { status: "unavailable", reason: "not in fixture" },
      readBilling: async () => null,
      createWorktree: async () => ({
        path: worktree,
        branch: "hive/test",
      }),
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      listCodexMcpServers: async () => [],
      claudeExecutable: "claude",
      codexExecutable: "codex",
      grokExecutable: "grok",
      kimiExecutable: "kimi",
      opencodeExecutable: "opencode",
      writeTerminalLaunchSpec: async () => {
        throw new Error("terminal creation stopped after prompt assembly");
      },
      sessiond: {
        prepareAgentCreation: async () => admission,
        admit: async () => null,
        terminalHost: {
          create: async () => {
            throw new Error("terminal creation stopped after prompt assembly");
          },
          inspect: async () => {
            throw new Error("not reached");
          },
          terminate: async () => {
            throw new Error("not reached");
          },
        },
      },
    });

    let admittedName: string | null = null;
    try {
      const admitted = await spawner.spawn({
        task: "test task",
        category: "simple_coding",
      });
      admittedName = admitted.name;
      expect(admitted.status).toBe("spawning");

      // Read the actual prompt file from getHiveHome()/runtime/prompts/
      const promptDirectory = join(getHiveHome(), "runtime", "prompts");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (await readdir(promptDirectory).catch(() => [])).some((name) =>
            name.endsWith(".txt"),
          )
        ) {
          break;
        }
        await Bun.sleep(5);
      }
      const promptName = (await readdir(promptDirectory)).find((name) =>
        name.endsWith(".txt"),
      );
      expect(promptName).toBeDefined();
      if (promptName === undefined)
        throw new Error("launch prompt was not written");

      const prompt = await readFile(join(promptDirectory, promptName), "utf8");

      // Verify pack floor is in the prompt WITHOUT requiring memory_search
      expect(prompt).toContain("Spawn floor fact");
      expect(prompt).toContain("Knowledge index data");
      expect(prompt).toContain("memory_search");
      expect(prompt).toContain("memory_read");

      // This proves spawn got pack floor via buildMemoryIndex (FTS-only)
      // memory_search is mentioned as an ARCHIVE tool, not required for pack
    } finally {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!db.isAgentNameReserved(admittedName ?? "")) break;
        await Bun.sleep(5);
      }
      db.close();
    }
  });

  test("REAL buildQueenLaunchContext includes pack floor (FTS-only)", async () => {
    previousHiveHome = process.env.HIVE_HOME;
    const home = await makeTempDir("hive-hm6-queen-");
    const repoRoot = await makeTempDir("hive-hm6-queen-repo-");
    process.env.HIVE_HOME = home;

    // Write memory articles (pack floor)
    await writeMemoryFact(repoRoot, {
      scope: "repo",
      topic: "testing",
      title: "Queen floor fact",
      body: "This fact is in the queen pack floor without embeddings.",
      source: "agent",
      evidence: "queen-test",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
    });

    // Build REAL memory index via buildMemoryIndex (FTS-only, no embeddings)
    const memoryIndex = await buildMemoryIndex(repoRoot, {
      brief: "queen test",
    });

    // Mock episodic store for loadRecentMistakes
    const episodic = {
      listEvents: () => [],
    };

    // Call REAL buildQueenLaunchContext with real index
    const launchText = await buildQueenLaunchContext({
      repoRoot,
      memoryIndex,
      episodic,
    });

    // Verify pack floor present WITHOUT requiring memory_search
    expect(launchText).toContain("Hive Constitution");
    expect(launchText).toContain("Profile");
    expect(launchText).toContain("Project");

    // Verify memory index present (built via FTS-only path)
    expect(launchText).toContain("Knowledge index data");
    expect(launchText).toContain("Queen floor fact");

    // memory_search is mentioned as archive tool, not required for pack
    expect(launchText).toContain("memory_search");
    expect(launchText).toContain("memory_read");

    // Queen got pack floor via buildMemoryIndex (FTS-only, no embeddings)
  });
});
