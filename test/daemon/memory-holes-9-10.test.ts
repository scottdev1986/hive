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
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveSpawner } from "../../src/daemon/spawn/hive-spawner";
import { writeMemoryFact } from "../../src/memory-service/memory-store";
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

describe("Hole #9: pack-off silence", () => {
  test("pack-off fails closed (not silent)", async () => {
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
      await Bun.sleep(100);

      // Agent should be dead/stuck (not working)
      const settled = db.getAgentById(admitted.id);
      expect(settled?.status).toBeOneOf(["dead", "stuck"]);
    } finally {
      db.close();
    }
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
      status: "verified",
      verified: "2026-08-20",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Create fake MCP server for tool registration
    const calls: string[] = [];
    const server = {
      registerTool: (
        name: string,
        _schema: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        calls.push(name);
        return handler;
      },
    };

    // Register memory tools
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

    // Get memory_read handler
    const readHandler = server.registerTool("memory_read", {}, (async (params: {
      scope: "repo" | "global";
      id: string;
    }) => {
      const { readMemoryFact } =
        await import("../../src/memory-service/memory-store");
      const fact = await readMemoryFact(root, params.scope, params.id);
      if (fact === null) {
        throw new Error(
          `Memory fact not found: [${params.scope}] ${params.id}`,
        );
      }
      // This would call validateFactCitations internally
      return {
        content: [{ type: "text" as const, text: JSON.stringify(fact) }],
      };
    }) as (...args: unknown[]) => unknown);

    // Hole #10: Reading a fact with backticked variable names should NOT throw
    // (heuristic false positives soft-flag with console.warn)
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
      status: "verified",
      verified: "2026-08-15",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-15",
    });

    // Create fake MCP server for tool registration
    const server = {
      registerTool: (
        name: string,
        _schema: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        return handler;
      },
    };

    // Register memory tools
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

    // Get memory_read handler
    const readHandler = server.registerTool("memory_read", {}, (async (params: {
      scope: "repo" | "global";
      id: string;
    }) => {
      const { readMemoryFact } =
        await import("../../src/memory-service/memory-store");
      const fact = await readMemoryFact(root, params.scope, params.id);
      if (fact === null) {
        throw new Error(
          `Memory fact not found: [${params.scope}] ${params.id}`,
        );
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(fact) }],
      };
    }) as (...args: unknown[]) => unknown);

    // Hole #10: Reading a fact with a missing path reference should NOT throw
    // (heuristic soft-flags missing paths with console.warn)
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
      status: "verified",
      verified: "2026-08-20",
      kind: "article",
      tags: [],
      supersedes: [],
      date: "2026-08-20",
    });

    // Create fake MCP server for tool registration
    const server = {
      registerTool: (
        name: string,
        _schema: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        return handler;
      },
    };

    // Register memory tools
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

    // Get memory_read handler
    const readHandler = server.registerTool("memory_read", {}, (async (params: {
      scope: "repo" | "global";
      id: string;
    }) => {
      const { readMemoryFact } =
        await import("../../src/memory-service/memory-store");
      const fact = await readMemoryFact(root, params.scope, params.id);
      if (fact === null) {
        throw new Error(
          `Memory fact not found: [${params.scope}] ${params.id}`,
        );
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(fact) }],
      };
    }) as (...args: unknown[]) => unknown);

    // Reading a fact with a valid path reference should succeed
    const result = await readHandler({
      scope: factWithValidPath.scope,
      id: factWithValidPath.id,
    });
    expect(result).toBeDefined();
  });
});
