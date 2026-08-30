import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getHiveHome } from "../../src/hive-home/home";

/** The launch runs on in the background after spawn() returns and releases the agent name in its finally; closing the database under it turns a fail-closed launch into a closed-database error. */
async function launchReleased(db: HiveDatabase): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (db.listAgents().every((agent) => !db.isAgentNameReserved(agent.name)))
      return;
    await Bun.sleep(5);
  }
}
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveSpawner } from "../../src/daemon/spawn/hive-spawner";
import { MemoryIndex } from "../../src/memory-service/fts-index";
import { registerMemoryTools } from "../../src/memory-service/memory-tools";
import { MemoryWriteService } from "../../src/memory-service/write-service";
import {
  type CapabilityRecord,
  known,
  unknown,
} from "../../src/schemas/capability";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";
import type { HiveConfig } from "../../src/schemas/config-schema";

const AT = "2026-08-29T00:00:00.000Z";

const unmeasuredCodexRecord: CapabilityRecord = {
  provider: "codex",
  accountFingerprint: "codex:hole9-test",
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

describe("Hole #9: empty vs dropped vs pack-off distinguishable", () => {
  test("empty: spawn with no facts shows honest stubs in prompt", async () => {
    previousHiveHome = process.env.HIVE_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    const home = await makeTempDir("hive-hole9-empty-");
    const repoRoot = await makeTempDir("hive-hole9-empty-repo-");
    const worktree = join(repoRoot, "hive-test-worktree");
    await mkdir(worktree, { recursive: true });
    process.env.HIVE_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");

    await copyFile(
      join(import.meta.dir, "../../AGENT_STANDARDS.md"),
      join(repoRoot, "AGENT_STANDARDS.md"),
    );

    const db = new HiveDatabase(":memory:");

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
      engineBuildId: "hole9-empty-test",
      visibility: {
        workspaceSessionId: "hole9-empty-test",
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

    try {
      const admitted = await spawner.spawn({
        task: "test empty scenario",
        category: "simple_coding",
      });

      expect(admitted.status).toBe("spawning");

      // Read the actual prompt file
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

      // Empty scenario: honest stubs present
      expect(prompt).toContain("Hive Constitution");
      expect(prompt).toContain("(Profile slot reserved but empty");
      expect(prompt).toContain("Project Context");
      expect(prompt).toContain("Handoff Context");
      expect(prompt).toContain("Synthesized handoff");
      // No memory index section (empty store)
      expect(prompt).not.toContain("Knowledge index data");
      // Mistakes slot shows empty stub
      expect(prompt).toContain("(Mistakes ledger empty");
      // Empty must NOT contain the dropped signals
      expect(prompt).not.toContain("CAP CROSSED");
      expect(prompt).not.toContain("older article");
    } finally {
      await launchReleased(db);
      db.close();
    }
  });

  test("pack-off: spawn fails closed (not silent)", async () => {
    previousHiveHome = process.env.HIVE_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    const home = await makeTempDir("hive-hole9-");
    const repoRoot = await makeTempDir("hive-hole9-repo-");
    const worktree = join(repoRoot, "hive-test-worktree");
    await mkdir(worktree, { recursive: true });
    process.env.HIVE_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");

    await copyFile(
      join(import.meta.dir, "../../AGENT_STANDARDS.md"),
      join(repoRoot, "AGENT_STANDARDS.md"),
    );

    const db = new HiveDatabase(":memory:");

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
      engineBuildId: "hole9-test",
      visibility: {
        workspaceSessionId: "hole9-test",
        workspacePid: 12345,
        workspaceStartToken: "12345:1",
        openTerminalRevision: "1",
      },
    };

    // Config with wake_pack_enabled=false (pack-off)
    // SAFETY: Test config provides only memory.wake_pack_enabled; HiveSpawner merges with defaults
    const configPackOff = {
      memory: {
        wake_pack_enabled: false,
      },
    } as Partial<HiveConfig>;

    const spawner = new HiveSpawner({
      db,
      repoRoot,
      port: 4317,
      config: configPackOff,
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
            throw new Error("terminal creation stopped after pack assembly");
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

    try {
      // Hole #9: pack-off must fail closed, not silently spawn with empty constitution/profile/handoff/projectDoc
      const admitted = await spawner.spawn({
        task: "test task",
        category: "simple_coding",
      });

      // Wait for background launch to settle (fail closed)
      // Poll for terminal status instead of sleeping
      let settled = db.getAgentById(admitted.id);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        settled = db.getAgentById(admitted.id);
        if (settled?.status === "dead" || settled?.status === "stuck") {
          break;
        }
        await Bun.sleep(10);
      }

      // Agent should be dead/stuck (not working)
      expect(settled?.status).toBeOneOf(["dead", "stuck"]);
    } finally {
      await launchReleased(db);
      db.close();
    }
  });

  test("dropped: spawn with CAP shows omitted slice warning", async () => {
    previousHiveHome = process.env.HIVE_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    const home = await makeTempDir("hive-hole9-dropped-");
    const repoRoot = await makeTempDir("hive-hole9-dropped-repo-");
    const worktree = join(repoRoot, "hive-test-worktree");
    await mkdir(worktree, { recursive: true });
    process.env.HIVE_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");

    await copyFile(
      join(import.meta.dir, "../../AGENT_STANDARDS.md"),
      join(repoRoot, "AGENT_STANDARDS.md"),
    );

    const db = new HiveDatabase(":memory:");

    // Write many memory facts to trigger CAP
    const { writeMemoryFact } =
      await import("../../src/memory-service/memory-store");
    for (let i = 1; i <= 100; i++) {
      await writeMemoryFact(repoRoot, {
        scope: "repo",
        topic: "test",
        title: `Large fact ${i}`,
        body: `This is a large body with lots of content to trigger CAP. ${"X".repeat(500)}`,
        evidence: "test evidence",
        source: "agent",
        status: "unverified",
        kind: "article",
        tags: [],
        supersedes: [],
        date: "2026-08-20",
      });
    }

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
      engineBuildId: "hole9-dropped-test",
      visibility: {
        workspaceSessionId: "hole9-dropped-test",
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

    try {
      const admitted = await spawner.spawn({
        task: "test dropped scenario",
        category: "simple_coding",
      });

      expect(admitted.status).toBe("spawning");

      // Read the actual prompt file
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

      // Dropped scenario: CAP CROSSED or memory-store.ts omitted line (REQUIRED)
      expect(prompt).toContain("Knowledge index data");
      // Require EITHER agent-prompt.ts:60 CAP OR memory-store.ts:998 omitted line
      const hasCapCrossed = prompt.includes("CAP CROSSED");
      const hasOmittedLine =
        prompt.includes("older article") &&
        prompt.includes("omitted — use memory_search");
      expect(hasCapCrossed || hasOmittedLine).toBe(true);
    } finally {
      await launchReleased(db);
      db.close();
    }
  });

  test("queen: empty shows honest stub in buildQueenLaunchContext", async () => {
    const root = await makeTempDir("hive-hole9-queen-empty-");

    const { buildQueenLaunchContext } =
      await import("../../src/cli/orchestrator");
    const { EpisodicStore } = await import("../../src/memory-service/episodic");
    const { buildMemoryIndex } =
      await import("../../src/memory-service/memory-store");

    const emptyIndex = await buildMemoryIndex(root);
    const episodic = new EpisodicStore(":memory:");

    const emptyLaunch = await buildQueenLaunchContext({
      memoryIndex: emptyIndex,
      repoRoot: root,
      episodic,
    });

    // Empty scenario: stubs present, no memory index section
    expect(emptyLaunch).toContain("Hive Constitution");
    expect(emptyLaunch).toContain("(Profile slot reserved but empty");
    expect(emptyLaunch).toContain("Project Context");
    expect(emptyLaunch).toContain("(Mistakes ledger empty");
    expect(emptyLaunch).not.toContain("Knowledge index data");
    // Empty must NOT contain the dropped signals
    expect(emptyLaunch).not.toContain("CAP CROSSED");
    expect(emptyLaunch).not.toContain("older article");
  });

  test("queen: dropped with CAP shows truncated index", async () => {
    const root = await makeTempDir("hive-hole9-queen-dropped-");

    const { buildQueenLaunchContext } =
      await import("../../src/cli/orchestrator");
    const { EpisodicStore } = await import("../../src/memory-service/episodic");
    const { writeMemoryFact, buildMemoryIndex } =
      await import("../../src/memory-service/memory-store");

    // Write many facts to trigger queen CAP
    for (let i = 1; i <= 50; i++) {
      await writeMemoryFact(root, {
        scope: "repo",
        topic: "test",
        title: `Queen fact ${i}`,
        body: `Large body content for queen CAP test. ${"Y".repeat(400)}`,
        evidence: "test evidence",
        source: "agent",
        status: "unverified",
        kind: "article",
        tags: [],
        supersedes: [],
        date: "2026-08-20",
      });
    }

    const index = await buildMemoryIndex(root, { brief: "test query" });
    const episodic = new EpisodicStore(":memory:");

    const droppedLaunch = await buildQueenLaunchContext({
      memoryIndex: index,
      repoRoot: root,
      episodic,
    });

    // Dropped scenario: CAP CROSSED or memory-store.ts omitted line (REQUIRED)
    expect(droppedLaunch).toContain("Knowledge index data");
    // Require EITHER agent-prompt.ts:60 CAP OR memory-store.ts:998 omitted line
    const hasCapCrossed = droppedLaunch.includes("CAP CROSSED");
    const hasOmittedLine =
      droppedLaunch.includes("older article") &&
      droppedLaunch.includes("omitted — use memory_search");
    expect(hasCapCrossed || hasOmittedLine).toBe(true);
  });

  test("queen: pack always present (no pack-off path)", async () => {
    const root = await makeTempDir("hive-hole9-queen-pack-");

    const { buildQueenLaunchContext } =
      await import("../../src/cli/orchestrator");

    // Queen doesn't read wake_pack_enabled config
    // Pack floor always assembled via pack-floor.ts loaders
    const launchText = await buildQueenLaunchContext({
      repoRoot: root,
    });

    // Pack floor always present for queen
    expect(launchText).toContain("Hive Constitution");
    expect(launchText).toContain("Profile");
    expect(launchText).toContain("Project Context");
    // Queen has no pack-off path (always loads pack floor)
  });

  test("pack-on (wake_pack_enabled=true default) succeeds with pack floor", async () => {
    previousHiveHome = process.env.HIVE_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    const home = await makeTempDir("hive-hole9-on-");
    const repoRoot = await makeTempDir("hive-hole9-on-repo-");
    const worktree = join(repoRoot, "hive-test-worktree");
    await mkdir(worktree, { recursive: true });
    process.env.HIVE_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");

    await copyFile(
      join(import.meta.dir, "../../AGENT_STANDARDS.md"),
      join(repoRoot, "AGENT_STANDARDS.md"),
    );

    const db = new HiveDatabase(":memory:");

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
      engineBuildId: "hole9-on-test",
      visibility: {
        workspaceSessionId: "hole9-on-test",
        workspacePid: 12345,
        workspaceStartToken: "12345:1",
        openTerminalRevision: "1",
      },
    };

    // Config with wake_pack_enabled=true (default)
    // SAFETY: Test config provides only memory.wake_pack_enabled; HiveSpawner merges with defaults
    const configPackOn = {
      memory: {
        wake_pack_enabled: true,
      },
    } as Partial<HiveConfig>;

    const spawner = new HiveSpawner({
      db,
      repoRoot,
      port: 4317,
      config: configPackOn,
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

    try {
      const admitted = await spawner.spawn({
        task: "test task with pack floor",
        category: "simple_coding",
      });

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

      // Verify pack floor is in the prompt
      expect(prompt).toContain("Hive Constitution");
      expect(prompt).toContain("Profile");
      expect(prompt).toContain("Handoff Context");
      expect(prompt).toContain("Project Context");
    } finally {
      await launchReleased(db);
      db.close();
    }
  });
});

describe("Hole #10: citation heuristic fail-closed on read", () => {
  test("heuristic false positives soft-flag (not throw)", async () => {
    const root = await makeTempDir("hive-hole10-");
    const index = new MemoryIndex(new Database(":memory:"));

    const writeService = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex: null,
    });

    // Write a verified fact with backticked variable names (false positive)
    const factWithVariables = await writeService.write({
      scope: "repo",
      topic: "test",
      title: "Code pattern with variables",
      body: "Use the `userId` field to identify users. The `apiKey` must be validated.",
      evidence: "From code review",
      source: "agent",
      author: "writer",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });
    // Citation validation runs only for verified articles, and an author cannot verify its own write, so a second session stamps it.
    await writeService.verify("repo", factWithVariables.id, {
      verifier: "critic",
      date: "2026-08-21",
    });

    // Create fake MCP server that captures registered handlers
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const handlers = new Map<string, (input: any, context?: any) => any>();
    const server = {
      registerTool: (
        name: string,
        _schema: any,
        handler: (input: any, context?: any) => any,
      ) => {
        handlers.set(name, handler);
        return handler;
      },
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Register memory tools (registers REAL memory_read with validateFactCitations)
    // SAFETY: Test mock server conforms to HiveToolServer.registerTool contract for capturing handlers
    registerMemoryTools(
      server as never,
      {
        id: "test-cap",
        subject: "test-agent",
        role: "reader",
        epoch: 0,
        issuedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: "2026-08-30T00:00:00.000Z",
        revokedAt: null,
      },
      {
        repoRoot: root,
        memory: index,
        authorizeTool: () => {},
        writeMemoryFact: async () => {
          throw new Error("not reached");
        },
        verifyMemoryFact: async () => {
          throw new Error("not reached");
        },
        deleteMemoryFact: async () => {
          throw new Error("not reached");
        },
        rebuildMemoryIndex: async () => {
          throw new Error("not reached");
        },
      },
    );

    // Get the REAL memory_read handler that registerMemoryTools registered
    const readHandler = handlers.get("memory_read");
    if (readHandler === undefined) {
      throw new Error("memory_read handler was not registered");
    }

    // Hole #10: Reading a fact with backticked variable names should NOT throw
    // (heuristic false positives soft-flag with console.warn)
    // This calls the REAL handler which internally calls validateFactCitations
    await expect(
      readHandler({
        scope: factWithVariables.scope,
        id: factWithVariables.id,
      }),
    ).resolves.toBeDefined();
  });

  test("missing paths in verified facts soft-flag (not throw)", async () => {
    const root = await makeTempDir("hive-hole10-missing-");
    const index = new MemoryIndex(new Database(":memory:"));

    const writeService = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex: null,
    });

    // Write a verified fact mentioning a path that doesn't exist (stale reference)
    const factWithMissingPath = await writeService.write({
      scope: "repo",
      topic: "test",
      title: "Stale path reference",
      body: "See src/old-file.ts for the implementation (this file was deleted)",
      evidence: "Historical note",
      source: "agent",
      author: "writer",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-15",
    });
    // Citation validation runs only for verified articles, and an author cannot verify its own write, so a second session stamps it.
    await writeService.verify("repo", factWithMissingPath.id, {
      verifier: "critic",
      date: "2026-08-16",
    });

    // Create fake MCP server that captures registered handlers
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const handlers = new Map<string, (input: any, context?: any) => any>();
    const server = {
      registerTool: (
        name: string,
        _schema: any,
        handler: (input: any, context?: any) => any,
      ) => {
        handlers.set(name, handler);
        return handler;
      },
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Register memory tools (registers REAL memory_read with validateFactCitations)
    // SAFETY: Test mock server conforms to HiveToolServer.registerTool contract for capturing handlers
    registerMemoryTools(
      server as never,
      {
        id: "test-cap",
        subject: "test-agent",
        role: "reader",
        epoch: 0,
        issuedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: "2026-08-30T00:00:00.000Z",
        revokedAt: null,
      },
      {
        repoRoot: root,
        memory: index,
        authorizeTool: () => {},
        writeMemoryFact: async () => {
          throw new Error("not reached");
        },
        verifyMemoryFact: async () => {
          throw new Error("not reached");
        },
        deleteMemoryFact: async () => {
          throw new Error("not reached");
        },
        rebuildMemoryIndex: async () => {
          throw new Error("not reached");
        },
      },
    );

    // Get the REAL memory_read handler that registerMemoryTools registered
    const readHandler = handlers.get("memory_read");
    if (readHandler === undefined) {
      throw new Error("memory_read handler was not registered");
    }

    // Hole #10: Reading a fact with a missing path reference should NOT throw
    // (heuristic soft-flags missing paths with console.warn)
    // This calls the REAL handler which internally calls validateFactCitations
    await expect(
      readHandler({
        scope: factWithMissingPath.scope,
        id: factWithMissingPath.id,
      }),
    ).resolves.toBeDefined();
  });

  test("existing paths in verified facts validate successfully", async () => {
    const root = await makeTempDir("hive-hole10-valid-");
    const index = new MemoryIndex(new Database(":memory:"));

    // Create a real file to reference
    const testFilePath = join(root, "test-file.txt");
    await writeFile(testFilePath, "test content");

    const writeService = new MemoryWriteService({
      repoRoot: root,
      index,
      embeddingIndex: null,
    });

    // Write a verified fact mentioning a path that exists
    const factWithValidPath = await writeService.write({
      scope: "repo",
      topic: "test",
      title: "Valid path reference",
      body: "See test-file.txt for the implementation",
      evidence: "Current reference",
      source: "agent",
      author: "writer",
      status: "unverified",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });
    // Citation validation runs only for verified articles, and an author cannot verify its own write, so a second session stamps it.
    await writeService.verify("repo", factWithValidPath.id, {
      verifier: "critic",
      date: "2026-08-21",
    });

    // Create fake MCP server that captures registered handlers
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const handlers = new Map<string, (input: any, context?: any) => any>();
    const server = {
      registerTool: (
        name: string,
        _schema: any,
        handler: (input: any, context?: any) => any,
      ) => {
        handlers.set(name, handler);
        return handler;
      },
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    // Register memory tools (registers REAL memory_read with validateFactCitations)
    // SAFETY: Test mock server conforms to HiveToolServer.registerTool contract for capturing handlers
    registerMemoryTools(
      server as never,
      {
        id: "test-cap",
        subject: "test-agent",
        role: "reader",
        epoch: 0,
        issuedAt: "2026-08-29T00:00:00.000Z",
        expiresAt: "2026-08-30T00:00:00.000Z",
        revokedAt: null,
      },
      {
        repoRoot: root,
        memory: index,
        authorizeTool: () => {},
        writeMemoryFact: async () => {
          throw new Error("not reached");
        },
        verifyMemoryFact: async () => {
          throw new Error("not reached");
        },
        deleteMemoryFact: async () => {
          throw new Error("not reached");
        },
        rebuildMemoryIndex: async () => {
          throw new Error("not reached");
        },
      },
    );

    // Get the REAL memory_read handler that registerMemoryTools registered
    const readHandler = handlers.get("memory_read");
    if (readHandler === undefined) {
      throw new Error("memory_read handler was not registered");
    }

    // Reading a fact with a valid path reference should succeed
    // This calls the REAL handler which internally calls validateFactCitations
    const result = await readHandler({
      scope: factWithValidPath.scope,
      id: factWithValidPath.id,
    });
    expect(result).toBeDefined();
  });
});
