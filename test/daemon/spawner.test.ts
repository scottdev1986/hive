import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/db";
import {
  SpawnBatchRequestSchema,
  SpawnRequestSchema,
} from "../../src/daemon/spawner";
import { HiveSpawner } from "../../src/daemon/spawner-impl";

describe("hive_spawn schema after the router cutover", () => {
  test("accepts category routing with the long-context requirement modifier", () => {
    expect(
      SpawnRequestSchema.parse({
        task: "Review the authentication flow",
        category: "code_review",
        reviewOfTool: "codex",
        minContextTokens: 1_000_000,
        readOnly: true,
      }),
    ).toEqual({
      task: "Review the authentication flow",
      category: "code_review",
      reviewOfTool: "codex",
      minContextTokens: 1_000_000,
      readOnly: true,
    });
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
          name: "maya",
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
