import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MarkDeadRequestSchema,
  registerAgentControlTools,
} from "../../src/daemon/recovery/agent-control-tools";
import type { Capability } from "../../src/schemas/capability";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import type { AgentRecord } from "../../src/schemas/agent";
import { OUTSIDE_REPO_TMPDIR } from "../outside-repo-tmpdir";
import type { JsonObject, JsonValue } from "../../src/shared/json";

import { required } from "../required";

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build server",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-server",
    contextPct: null,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

// SAFETY: The test owns this value and its fields.
const userCapability = {
  role: "user",
  subject: "user",
} as Capability;

describe("hive_mark_dead options", () => {
  test("schema accepts removeWorktree and rejects the retired discardWork", () => {
    expect(MarkDeadRequestSchema.parse({ agent: "maya" })).toEqual({
      agent: "maya",
    });
    expect(
      MarkDeadRequestSchema.parse({
        agent: "maya",
        removeWorktree: true,
      }),
    ).toEqual({
      agent: "maya",
      removeWorktree: true,
    });
    expect(
      MarkDeadRequestSchema.safeParse({ agent: "maya", discardWork: true })
        .success,
    ).toBe(false);
  });

  test("default mark_dead passes no teardown options (worktree stays)", async () => {
    const calls: Array<{ removeWorktree?: boolean } | undefined> = [];
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent());
    const tools = new Map<string, (args: JsonObject) => Promise<object>>();
    registerAgentControlTools(
      // SAFETY: The test owns this value and its fields.
      {
        registerTool: (
          name: string,
          _meta: JsonValue,
          handler: (args: JsonObject) => Promise<object>,
        ) => {
          tools.set(name, handler);
        },
      } as never,
      userCapability,
      {
        db,
        // SAFETY: The test owns this value and its fields.
        terminalHost: {} as never,
        authorizeTool: () => {},
        hasNeverBoundSessiondGeneration: () => true,
        killAgentTeardown: async (_agent, options) => {
          calls.push(options);
          return { agent: required(db.getAgentByName("maya")) };
        },
        listSalvageableRefs: async () => [],
        releaseSalvageableRef: async (ref) => ({ released: ref }),
        keepSalvageableRef: async (ref) => ({ kept: ref, tip: "0".repeat(40) }),
        mintDestructiveDecision: async () =>
          Promise.reject(new Error("unused")),
        executeDestructiveDecision: async () =>
          Promise.reject(new Error("unused")),
        listSettlementCases: async () => [],
      },
    );
    const markDead = required(tools.get("hive_mark_dead"));
    await markDead({ agent: "maya" });
    expect(calls).toEqual([undefined]);
  });

  test("flagged mark_dead forwards removeWorktree only", async () => {
    const calls: Array<{ removeWorktree?: boolean } | undefined> = [];
    const db = new HiveDatabase(":memory:");
    db.insertAgent(agent());
    const tools = new Map<string, (args: JsonObject) => Promise<object>>();
    registerAgentControlTools(
      // SAFETY: The test owns this value and its fields.
      {
        registerTool: (
          name: string,
          _meta: JsonValue,
          handler: (args: JsonObject) => Promise<object>,
        ) => {
          tools.set(name, handler);
        },
      } as never,
      userCapability,
      {
        db,
        // SAFETY: The test owns this value and its fields.
        terminalHost: {} as never,
        authorizeTool: () => {},
        hasNeverBoundSessiondGeneration: () => true,
        killAgentTeardown: async (_agent, options) => {
          calls.push(options);
          return { agent: required(db.getAgentByName("maya")) };
        },
        listSalvageableRefs: async () => [],
        releaseSalvageableRef: async (ref) => ({ released: ref }),
        keepSalvageableRef: async (ref) => ({ kept: ref, tip: "0".repeat(40) }),
        mintDestructiveDecision: async () =>
          Promise.reject(new Error("unused")),
        executeDestructiveDecision: async () =>
          Promise.reject(new Error("unused")),
        listSettlementCases: async () => [],
      },
    );
    const markDead = required(tools.get("hive_mark_dead"));
    await markDead({
      agent: "maya",
      removeWorktree: true,
    });
    expect(calls).toEqual([{ removeWorktree: true }]);
  });

  test("removeWorktree cannot bypass an unprovable settlement", async () => {
    const { HiveDaemon } = await import("../../src/daemon/server");
    const removals: string[] = [];
    const db = new HiveDatabase(":memory:");
    const repo = await mkdtemp(join(OUTSIDE_REPO_TMPDIR, "mark-dead-opts-"));
    db.insertAgent(agent());
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: {
        spawn: async () => {
          throw new Error("no spawn");
        },
      },
      repoRoot: repo,
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
    });
    try {
      const defaultKill = await daemon.killAgentTeardown(
        required(db.getAgentByName("maya")),
      );
      expect(defaultKill.worktree.outcome).toBe("preserved-stranded");
      expect(removals).toEqual([]);

      // Re-insert a live row for the flagged path.
      db.upsertAgent(agent({ status: "idle" }));
      const flagged = await daemon.killAgentTeardown(
        required(db.getAgentByName("maya")),
        { removeWorktree: true },
      );
      expect(flagged.worktree.outcome).toBe("preserved-stranded");
      expect(removals).toEqual([]);
    } finally {
      await daemon.stop();
      db.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
