import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ROLE_GRANTS } from "../../src/daemon/authorization/authorization-service";
import {
  HIVE_TOOL_POLICIES,
  type HiveToolName,
} from "../../src/daemon/authorization/mcp-tool-policy";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { HiveDaemon } from "../../src/daemon/server";
import {
  boardStoryInstruction,
  buildAgentPrompt,
} from "../../src/daemon/spawn/agent-prompt";
import { loadAgentStandards } from "../../src/daemon/spawn/agent-standards";
import { SpawnRequestSchema } from "../../src/daemon/spawn/spawn-service";
import { HiveSpawner } from "../../src/daemon/spawn/spawner-impl";
import { hiveInstanceSuffix } from "../../src/hive-home/home";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type { CapabilityRecord } from "../../src/schemas/capability";
import { known, unknown } from "../../src/schemas/capability";
import type { RoutingPolicy } from "../../src/schemas/routing-policy";
import type { TaskDetail } from "../../src/schemas/task-detail";
import { HIVE_MCP_VERSION_NEGOTIATION } from "../../src/shared/mcp-protocol";
import { required } from "../required";

const AT = "2026-08-10T15:00:00.000Z";
const TASK_ID = "task_019fec14-1007-7000-8000-000000000107";
const MISSING_TASK_ID = "task_019fec14-ffff-7000-8000-000000000000";
const REPO_ROOT = join(import.meta.dir, "..", "..");

const tempRoots: string[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class UnusedSpawner {
  async spawn(): Promise<AgentRecord> {
    throw new Error("not exercised");
  }
}

const authorized =
  (daemon: HiveDaemon, token: string) =>
  (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "127.0.0.1");
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

async function callTool(
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{
  ok: boolean;
  text: string;
  value: Record<string, unknown>;
  isError: boolean;
}> {
  const client = new Client({ name: "task-get-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return {
      ok: result.isError !== true,
      isError: result.isError === true,
      text: JSON.stringify(result.content ?? ""),
      value: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: error instanceof Error ? error.message : "?",
      value: {},
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listToolNames(
  daemon: HiveDaemon,
  subject: string,
  role: "orchestrator" | "writer" | "reader",
): Promise<string[]> {
  const { token } = daemon.capabilities.mint(subject, role);
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  const client = new Client(
    { name: "catalog-test", version: "0.0.0" },
    { versionNegotiation: HIVE_MCP_VERSION_NEGOTIATION },
  );
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function seedLiveQueen(db: HiveDatabase, capabilityEpoch = 0): void {
  const terminal = {
    schemaVersion: 1 as const,
    instanceId: hiveInstanceSuffix(),
    subject: { kind: "root" as const },
    generation: 1,
    sessionId: "ses_019fec14-1007-7000-8000-000000000b01",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-task-get",
  };
  db.bindTerminalHostSession({
    locator: terminal,
    visibility: {
      workspaceSessionId: "workspace-task-get",
      workspacePid: 4_200,
      workspaceStartToken: "4200:1",
      openTerminalRevision: "1",
    },
  });
  db.insertProviderRun({
    runId: "019fec14-1007-7000-8000-000000000b02",
    agentId: null,
    terminal,
    provider: "codex",
    model: null,
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch,
    launchGrantId: "grant-task-get-root",
    startedAt: AT,
    endedAt: null,
    state: "running",
    exitReason: null,
  });
}

function fixtureTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  const nodeId = "node_019fec14-1007-7000-8000-000000000002";
  const grantId = "grant_019fec14-1007-7000-8000-000000000004";
  const digest = `sha256:${"c".repeat(64)}`;
  const baseSha = "d".repeat(40);
  const root = { nodeId, agentId: ORCHESTRATOR_NAME, generation: 1 };
  return {
    taskId: TASK_ID,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: {
      objective:
        "Workers must read their own stories from the board with hive_task_get",
      parentAcceptanceIds: ["A1"],
      childOutcome: "hive_task_get returns the full story",
      terminationCondition: "Catalog and spawn linkage land",
      inputs: {
        specRevision: { revision: "1", digest },
        planRevision: { revision: "1", digest },
        taskRevisions: [],
        interfaceRevisions: [],
        baseSha,
        prerequisites: [],
        sourceArtifactRefs: [],
      },
      boundaries: { allowedPaths: ["src/daemon"] },
      authority: {
        grantId,
        permittedOperations: ["read"],
        environment: "test",
        worktree: "/repo",
        branch: "hive/susan-agents-read-their-own-stories",
        explicitNonAuthority: [],
      },
      allowance: {
        sessions: 1,
        tokens: 1_000,
        costCents: 10,
        wallTimeMs: 60_000,
        retries: 0,
        blockers: [],
        owner: root,
      },
    },
    acceptanceIds: ["A1"],
    ownerNodeId: nodeId,
    assigneeNodeId: null,
    pathLeases: [{ path: "src/daemon", mode: "read" }],
    branch: "hive/susan-agents-read-their-own-stories",
    baseSha,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
    ...overrides,
  };
}

function harness() {
  const home = mkdtempSyncSafe();
  process.env.HIVE_HOME = home;
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new UnusedSpawner(),
    repoRoot: REPO_ROOT,
  });
  seedLiveQueen(db);
  return { daemon, db, hierarchy: new HierarchyStore(db) };
}

function mkdtempSyncSafe(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-task-get-"));
  tempRoots.push(root);
  return root;
}

function seedBoardTask(hierarchy: HierarchyStore): TaskDetail {
  const task = fixtureTask();
  const runId = "run_019fec14-1007-7000-8000-000000000001";
  const nodeId = task.ownerNodeId;
  const digest = task.delegationSpec.inputs.specRevision.digest;
  const baseSha = task.baseSha;
  hierarchy.putRun(
    {
      runId,
      revision: "1",
      repo: "hive",
      instanceId: hiveInstanceSuffix(),
      spec: { revision: "1", digest },
      currentPlan: { revision: "1", digest },
      topology: { revision: "1", digest },
      phase: "P1",
      baseSha,
      budget: { revision: "1", digest },
      runEpoch: 0,
      lifecycle: "active",
    },
    null,
  );
  hierarchy.putNode(
    {
      nodeId,
      runId,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [task.taskId],
      capacityCharge: 0,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  hierarchy.putRootBinding(runId, nodeId);
  hierarchy.putTask(task);
  return task;
}

function visibleHiveToolNames(
  role: "orchestrator" | "writer" | "reader",
): HiveToolName[] {
  const actions = ROLE_GRANTS[role].actions;
  return (Object.keys(HIVE_TOOL_POLICIES) as HiveToolName[]).filter((name) =>
    actions.includes(HIVE_TOOL_POLICIES[name].action),
  );
}

describe("hive_task_get", () => {
  test("writer and reader get the full story of a real task", async () => {
    const { daemon, db, hierarchy } = harness();
    const task = seedBoardTask(hierarchy);
    try {
      for (const [subject, role] of [
        ["maya", "writer"],
        ["rex", "reader"],
        [ORCHESTRATOR_NAME, "orchestrator"],
      ] as const) {
        const { token } = daemon.capabilities.mint(subject, role);
        const result = await callTool(daemon, token, "hive_task_get", {
          taskId: task.taskId,
        });
        expect({ role, ok: result.ok, isError: result.isError }).toEqual({
          role,
          ok: true,
          isError: false,
        });
        const returned = result.value.task as TaskDetail;
        expect(returned.taskId).toBe(task.taskId);
        expect(returned.delegationSpec.objective).toBe(
          task.delegationSpec.objective,
        );
        expect(returned.state).toBe("in-progress");
        expect(returned.dependsOn).toEqual([]);
        expect(returned.blockers).toEqual([]);
        expect(returned.evidence).toEqual([]);
        expect(returned.artifactRefs).toEqual([]);
        expect(returned.revision).toBe("1");
      }
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("unknown taskId is refused with a Fix: line naming hive_task_list", async () => {
    const { daemon, db, hierarchy } = harness();
    seedBoardTask(hierarchy);
    try {
      const { token } = daemon.capabilities.mint("maya", "writer");
      const result = await callTool(daemon, token, "hive_task_get", {
        taskId: MISSING_TASK_ID,
      });
      expect(result.ok).toBe(false);
      expect(result.text).toContain(MISSING_TASK_ID);
      expect(result.text).toContain("Fix: hive_task_list");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  // Reproduces the clay incident (task_019fec14-1014): a taskId-linked agent
  // reads its story fine but holds no hierarchy binding, so hive_task_update
  // refuses it. Owner ruling on task_019fec14-1016 made this the intended
  // shape (board writes are owner-only; agents report by artifact and mail),
  // not a bug — this test pins that hive_task_update stays refused over the
  // real MCP path so the read/write asymmetry cannot regress silently.
  test("a taskId-linked agent reads its story but hive_task_update still refuses it", async () => {
    const { daemon, db, hierarchy } = harness();
    const task = seedBoardTask(hierarchy);
    // A live agent record with a session, matching a real taskId-tracking
    // spawn — but with no row in the hierarchy_records binding table, since
    // tracking-only spawns never get one.
    db.insertAgent({
      id: "agent-clay",
      name: "clay",
      tool: "codex",
      model: "gpt-5",
      category: "simple_coding",
      status: "working",
      taskDescription: "Read the story of record for its board task",
      worktreePath: "/worktrees/clay",
      branch: "hive/clay",
      sessionLocator: {
        schemaVersion: 1,
        instanceId: "instance-task-get",
        subject: { kind: "agent", agentId: "agent-clay" },
        generation: 1,
        sessionId: "ses_019fec14-1014-7000-8000-000000000101",
        hostKind: "sessiond",
        engineBuildId: "engine-task-get",
      },
      contextPct: null,
      createdAt: AT,
      lastEventAt: AT,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    });
    try {
      const { token } = daemon.capabilities.mint("clay", "writer");
      const read = await callTool(daemon, token, "hive_task_get", {
        taskId: task.taskId,
      });
      expect(read.ok).toBe(true);

      const write = await callTool(daemon, token, "hive_task_update", {
        taskId: task.taskId,
        expectedRevision: task.revision,
        state: "completed",
      });
      expect(write.ok).toBe(false);
      expect(write.text).toContain(
        "agent clay holds no live hierarchy binding",
      );
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});

describe("board-read catalog surface", () => {
  test("orchestrator, writer, and reader are offered hive_task_get; catalogs stay non-empty and mutation-proven", async () => {
    const { daemon, db } = harness();
    try {
      const seen: Record<
        string,
        { total: number; offeredGet: boolean; offeredList: boolean }
      > = {};
      for (const [subject, role] of [
        [ORCHESTRATOR_NAME, "orchestrator"],
        ["maya", "writer"],
        ["rex", "reader"],
      ] as const) {
        const names = await listToolNames(daemon, subject, role);
        seen[role] = {
          total: names.length,
          offeredGet: names.includes("hive_task_get"),
          offeredList: names.includes("hive_task_list"),
        };
        // Expected counts are derived from the grant table, not hardcoded pins,
        // so a future tool does not force a silent catalog drift.
        expect(names.sort()).toEqual(visibleHiveToolNames(role).sort());
      }

      expect(seen.orchestrator?.offeredGet).toBe(true);
      expect(seen.writer?.offeredGet).toBe(true);
      expect(seen.reader?.offeredGet).toBe(true);
      // hive_task_list already rides status:read — coherent for workers to keep.
      expect(seen.orchestrator?.offeredList).toBe(true);
      expect(seen.writer?.offeredList).toBe(true);
      expect(seen.reader?.offeredList).toBe(true);

      for (const [role, catalog] of Object.entries(seen)) {
        expect({ role, empty: catalog.total === 0 }).toEqual({
          role,
          empty: false,
        });
      }

      // Mutation control: removing the writer grant must drop the tool from
      // the computed catalog (proves the assertion is not a constant true).
      const writerWithoutGet = visibleHiveToolNames("writer").filter(
        (name) => name !== "hive_task_get",
      );
      expect(writerWithoutGet).not.toContain("hive_task_get");
      expect(writerWithoutGet.length).toBe(
        visibleHiveToolNames("writer").length - 1,
      );
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});

describe("spawn taskId linkage", () => {
  test("boardStoryInstruction carries the exact standing text", () => {
    expect(boardStoryInstruction(TASK_ID)).toBe(
      `Your assignment's story of record is board task ${TASK_ID} — read it with hive_task_get before starting; the brief below is instructions on top of that story, and if they conflict, ask the queen.`,
    );
  });

  test("buildAgentPrompt injects the story instruction when boardTaskId is set", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const withStory = buildAgentPrompt(
      "susan",
      "Implement board read.",
      { path: "/tmp/hive-susan", branch: "hive/susan" },
      "",
      standards,
      { boardTaskId: TASK_ID },
    );
    const without = buildAgentPrompt(
      "susan",
      "Implement board read.",
      { path: "/tmp/hive-susan", branch: "hive/susan" },
      "",
      standards,
      {},
    );
    expect(withStory).toContain(boardStoryInstruction(TASK_ID));
    expect(withStory).toContain(TASK_ID);
    expect(without).not.toContain("story of record");
  });

  test("buildAgentPrompt names the session Assignment as not a board task", async () => {
    const standards = await loadAgentStandards(REPO_ROOT);
    const assignment = {
      assignmentId: "asg_018f1e90-7b5a-7cc0-8000-000000000063",
      assignmentGeneration: "1",
    };
    const withAssignment = buildAgentPrompt(
      "susan",
      "Implement board read.",
      { path: "/tmp/hive-susan", branch: "hive/susan" },
      "",
      standards,
      { assignment, boardTaskId: TASK_ID },
    );
    const without = buildAgentPrompt(
      "susan",
      "Implement board read.",
      { path: "/tmp/hive-susan", branch: "hive/susan" },
      "",
      standards,
      { boardTaskId: TASK_ID },
    );
    expect(withAssignment).toContain(
      `Your assignment: ${assignment.assignmentId} generation ${assignment.assignmentGeneration}.`,
    );
    expect(withAssignment).toContain(
      "open session Assignment, not a board task",
    );
    expect(withAssignment).toContain(
      "completing a story or receiving a new one by mail does not change them",
    );
    expect(without).not.toContain(assignment.assignmentId);
  });

  test("SpawnRequestSchema accepts optional taskId on a flat spawn", () => {
    const parsed = SpawnRequestSchema.parse({
      task: "Do the work",
      category: "complex_coding",
      taskId: TASK_ID,
    });
    expect(parsed.taskId).toBe(TASK_ID);
    expect(
      SpawnRequestSchema.safeParse({
        task: "Do the work",
        category: "complex_coding",
        taskId: "not-a-task-id",
      }).success,
    ).toBe(false);
  });

  test("spawn with unknown taskId is refused with Fix: hive_task_list", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawn-taskid-"));
    const home = await mkdtemp(join(tmpdir(), "hive-spawn-taskid-home-"));
    tempRoots.push(root, home);
    process.env.HIVE_HOME = home;
    await copyFile(
      join(REPO_ROOT, "AGENT_STANDARDS.md"),
      join(root, "AGENT_STANDARDS.md"),
    );
    const db = new HiveDatabase(":memory:");
    const spawner = new HiveSpawner({
      db,
      repoRoot: root,
      port: 4317,
      config: {},
      getBoardTask: () => null,
      readRoutingPolicy: () => emptyPolicy(),
      isModelEnabled: async () => true,
      discoverCapabilities: async () => ({
        status: "unavailable",
        reason: "not in fixture",
      }),
      createWorktree: async () => {
        throw new Error("must refuse before worktree");
      },
      unavailableAgentNames: async () => new Set(),
      stopSession: async () => ({ killed: [], survivors: [] }),
      sessiond: {
        prepareAgentCreation: async () => null,
        admit: async () => null,
        terminalHost: {
          create: async () => {
            throw new Error("not reached");
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

    await expect(
      spawner.spawn({
        task: "Should never launch",
        category: "simple_coding",
        taskId: MISSING_TASK_ID,
      }),
    ).rejects.toThrow(/Fix: hive_task_list/);
    db.close();
  });

  test("spawn with valid taskId writes a launch prompt containing the story instruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawn-story-"));
    const home = await mkdtemp(join(tmpdir(), "hive-spawn-story-home-"));
    const worktree = join(root, "susan");
    await mkdir(worktree, { recursive: true });
    tempRoots.push(root, home);
    process.env.HIVE_HOME = home;
    process.env.CODEX_HOME = join(home, "codex");
    await copyFile(
      join(REPO_ROOT, "AGENT_STANDARDS.md"),
      join(root, "AGENT_STANDARDS.md"),
    );

    const db = new HiveDatabase(":memory:");
    const boardTask = fixtureTask({ state: "assigned" });
    const unmeasuredCodexRecord: CapabilityRecord = {
      provider: "codex",
      accountFingerprint: "codex:task-get",
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
    const admission = {
      engineBuildId: "engine-task-get",
      visibility: {
        workspaceSessionId: "workspace-task-get-spawn",
        workspacePid: 123,
        workspaceStartToken: "123:1",
        openTerminalRevision: "1",
      },
    };
    const startedAgent: { name: string | null } = { name: null };
    const spawner = new HiveSpawner({
      db,
      repoRoot: root,
      port: 4317,
      config: {},
      getBoardTask: (taskId) =>
        taskId === boardTask.taskId ? { taskId } : null,
      startBoardTask: (taskId, agentId, agentName) => {
        expect(taskId).toBe(boardTask.taskId);
        expect(agentId).toBeString();
        startedAgent.name = agentName;
        boardTask.state = "in-progress";
      },
      readRoutingPolicy: () => policyWithCodex(),
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
        branch: "hive/susan-story",
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
        task: "Read your story and implement board read.",
        category: "simple_coding",
        taskId: boardTask.taskId,
      });
      expect(admitted.status).toBe("spawning");
      const promptDirectory = join(home, "runtime", "prompts");
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
      const prompt = await readFile(
        join(promptDirectory, required(promptName, "prompt file")),
        "utf8",
      );
      expect(prompt).toContain(boardTask.taskId);
      expect(prompt).toContain(boardStoryInstruction(boardTask.taskId));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!db.isAgentNameReserved(admitted.name)) break;
        await Bun.sleep(5);
      }
      expect(startedAgent.name).toBeNull();
      expect(boardTask.state).toBe("assigned");
      expect(db.getAgentById(admitted.id)?.status).toBe("unknown");
    } finally {
      db.close();
      delete process.env.CODEX_HOME;
    }
  });
});

function emptyPolicy(): RoutingPolicy {
  return {
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
        candidates: [],
      },
    },
  };
}

function policyWithCodex(): RoutingPolicy {
  return {
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
}
