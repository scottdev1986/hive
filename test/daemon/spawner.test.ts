import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  assignmentKindForSpawn,
  SpawnBatchRequestSchema,
  SpawnRequestSchema,
} from "../../src/daemon/spawn/spawn-service";
import {
  agentUiLaunchArgv,
  HiveSpawner,
  protocolProviderArgv,
} from "../../src/daemon/spawn/spawner-impl";

describe("hive_spawn schema after the router cutover", () => {
  test("launches the protocol frontend with the selected installed runtime", () => {
    expect(
      agentUiLaunchArgv({
        hiveCommand: ["/opt/hive"],
        subject: "maya",
        provider: "codex",
        executable: "/opt/codex",
        daemonPort: 4317,
        providerRunId: "018f1e90-7b5a-7cc0-8000-0000000007a1",
        worktreePath: "/repo/.hive/worktrees/maya",
        journalPath: "/hive/agent-ui/session/outbound.jsonl",
        model: "gpt-5.6-codex",
        effort: "high",
        readOnly: true,
        instructionPath: "/hive/runtime/prompts/session.txt",
        kickoff: "Begin the assigned task.",
        providerArgv: ["-c", "mcp_servers.hive.enabled=true"],
      }),
    ).toEqual([
      "/opt/hive",
      "agent-ui",
      "--subject",
      "maya",
      "--provider",
      "codex",
      "--executable",
      "/opt/codex",
      "--port",
      "4317",
      "--provider-run-id",
      "018f1e90-7b5a-7cc0-8000-0000000007a1",
      "--worktree",
      "/repo/.hive/worktrees/maya",
      "--journal",
      "/hive/agent-ui/session/outbound.jsonl",
      "--model",
      "gpt-5.6-codex",
      "--effort",
      "high",
      "--read-only",
      "--instruction",
      "/hive/runtime/prompts/session.txt",
      "--provider-argv",
      '["-c","mcp_servers.hive.enabled=true"]',
      "--kickoff",
      "Begin the assigned task.",
    ]);
  });

  test("forwards only protocol-supported provider arguments", () => {
    expect(protocolProviderArgv("claude", ["claude", "--flag"])).toEqual([
      "--flag",
    ]);
    expect(
      protocolProviderArgv("codex", [
        "codex",
        "-c",
        "features.apps=false",
        "--sandbox",
        "workspace-write",
      ]),
    ).toEqual(["-c", "features.apps=false"]);
    expect(protocolProviderArgv("kimi", ["sh", "-lc", "kimi --yolo"])).toEqual(
      [],
    );
  });

  test("refuses an agent frontend launch without a provider run identity", () => {
    expect(() =>
      agentUiLaunchArgv({
        hiveCommand: ["/opt/hive"],
        subject: "maya",
        provider: "codex",
        executable: "/opt/codex",
        daemonPort: 4317,
        providerRunId: "",
        worktreePath: "/repo/.hive/worktrees/maya",
        journalPath: "/hive/agent-ui/session/outbound.jsonl",
        model: "gpt-5.6-codex",
        readOnly: false,
        instructionPath: "/hive/runtime/prompts/session.txt",
        kickoff: "Begin the assigned task.",
        providerArgv: [],
      }),
    ).toThrow("provider run identity is unavailable");
  });

  test("registers code-review spawns as reviewer assignments", () => {
    expect(assignmentKindForSpawn({ category: "code_review" })).toBe(
      "reviewer",
    );
    expect(assignmentKindForSpawn({ category: "standard_coding" })).toBe(
      "author",
    );
  });

  test("tiers are gone and long_context is not a category", () => {
    expect(
      SpawnRequestSchema.safeParse({
        task: "Build it",
        category: "complex_coding",
        tier: "deep",
      }).success,
    ).toBeFalse();
    expect(
      SpawnRequestSchema.safeParse({
        task: "Read a large document",
        category: "long_context",
      }).success,
    ).toBeFalse();
  });

  test("caller-selected agent names are not part of the spawn contract", () => {
    expect(
      SpawnRequestSchema.safeParse({
        task: "Build it",
        category: "simple_coding",
        name: "maya",
      }).success,
    ).toBeFalse();
    expect(
      SpawnBatchRequestSchema.safeParse({
        requests: [
          { task: "Build it", category: "simple_coding", name: "maya" },
        ],
      }).success,
    ).toBeFalse();
  });

  test("batch spawn accepts bounded independent requests", () => {
    expect(
      SpawnBatchRequestSchema.parse({
        requests: [
          { task: "Build A", category: "simple_coding" },
          { task: "Build B", category: "debugging" },
        ],
      }).requests,
    ).toHaveLength(2);
    expect(
      SpawnBatchRequestSchema.safeParse({ requests: [] }).success,
    ).toBeFalse();
  });

  test("does not infer a model vendor from its name when catalogs are unreadable", async () => {
    const db = new HiveDatabase(":memory:");
    const notReached = async (): Promise<never> => {
      throw new Error("terminal host should not be reached");
    };
    const spawner = new HiveSpawner({
      db,
      repoRoot: process.cwd(),
      port: 4317,
      config: {},
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      sessiond: {
        prepareAgentCreation: async () => null,
        admit: async () => null,
        terminalHost: {
          create: notReached,
          inspect: notReached,
          terminate: notReached,
        },
      },
    });

    try {
      await expect(
        spawner.spawn({
          task: "Use the explicitly named model",
          category: "simple_coding",
          model: "claude-opus-4-8",
        }),
      ).rejects.toThrow(
        /no vendor's catalog could be read.*no tool= was given/s,
      );
      expect(db.listAgents()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
