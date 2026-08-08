// The board bootstrap as the queen actually reaches it: over the daemon's MCP
// server, through the registered tool and the capability layer. The board reads
// hierarchy records, and until a run root exists it renders empty — so what this
// proves is the whole chain, from an empty database to a task visible in
// GET /workspace-snapshot, plus the two things the tool must NOT do: open a
// second root, or open a run anything can spawn under.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { HiveDaemon } from "../../src/daemon/server";
import {
  SpawnAdmission,
  SpawnAdmissionError,
} from "../../src/daemon/spawn/admission";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type { AgentBindingRef } from "../../src/schemas/hierarchy-node";
import {
  digestCheckpointContent,
  RunCheckpointSchema,
} from "../../src/schemas/run-checkpoint";
import type { TaskCreateInput } from "../../src/schemas/task-detail";
import { required } from "../required";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-run-bootstrap-");
process.env.HIVE_HOME = home;

// The daemon reads HEAD to record what the run was opened against, so repoRoot
// has to be a real repository. This checkout is one, and the read is read-only.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AT = "2026-08-10T12:00:00.000Z";

class StubSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("this harness spawns nothing");
  }
}

/**
 * The queen's own live incarnation: a bound root terminal plus the provider run
 * launched into it, carrying no agentId because the root is a capability
 * subject with no agent record. Together these are what
 * `getActiveRootProviderRun` answers with, and what the bootstrap requires
 * before it will open a run on the queen's behalf.
 */
function seedLiveQueen(db: HiveDatabase, capabilityEpoch = 0): void {
  const terminal = {
    schemaVersion: 1 as const,
    instanceId: hiveInstanceSuffix(),
    subject: { kind: "root" as const },
    generation: 1,
    sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000b01",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-run-bootstrap",
  };
  db.bindTerminalHostSession({
    locator: terminal,
    visibility: {
      workspaceSessionId: "workspace-run-bootstrap",
      workspacePid: 4_100,
      workspaceStartToken: "4100:1",
      openTerminalRevision: "1",
    },
  });
  db.insertProviderRun({
    runId: "018f1e90-7b5a-7cc0-8000-000000000b02",
    agentId: null,
    terminal,
    provider: "codex",
    model: null,
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch,
    launchGrantId: "grant-run-bootstrap-root",
    startedAt: AT,
    endedAt: null,
    state: "running",
    exitReason: null,
  });
}

function harness() {
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new StubSpawner(),
    repoRoot: REPO_ROOT,
  });
  seedLiveQueen(db);
  return { daemon, db };
}

const authorized =
  (daemon: HiveDaemon, token: string) =>
  (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "127.0.0.1");
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

const callTool = async (
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; text: string; value: Record<string, unknown> }> => {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return {
      ok: result.isError !== true,
      text: JSON.stringify(result.content ?? ""),
      value: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : "?",
      value: {},
    };
  } finally {
    await client.close().catch(() => undefined);
  }
};

type Bootstrap = {
  kind: string;
  runId: string;
  rootNodeId: string;
  rootBinding: AgentBindingRef;
  taskInputs: {
    specRevision: { revision: string; digest: string };
    planRevision: { revision: string; digest: string };
    baseSha: string;
  };
  next: string;
};

const bootstrapOf = (result: { value: Record<string, unknown> }): Bootstrap =>
  required(result.value.bootstrap as Bootstrap | undefined, "bootstrap");

const queenToken = (daemon: HiveDaemon, epoch = 0): string =>
  daemon.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", { epoch }).token;

type SnapshotEntity = {
  kind: string;
  id: string;
  projection: Record<string, unknown>;
};

const snapshot = async (daemon: HiveDaemon): Promise<SnapshotEntity[]> => {
  const { token } = daemon.capabilities.mint("user", "user");
  const response = await daemon.fetch(
    new Request("http://hive/workspace-snapshot", {
      headers: { Host: "127.0.0.1", Authorization: `Bearer ${token}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { entities: SnapshotEntity[] };
  return body.entities;
};

const findEntity = (
  entities: SnapshotEntity[],
  kind: string,
  id: string,
): SnapshotEntity | undefined =>
  entities.find((item) => item.kind === kind && item.id === id);

/**
 * The tracking-task convention: a task the root owns and nobody is assigned,
 * carrying read-only authority and a zero allowance. It exists to be looked at
 * on the board, so it claims no capacity and delegates nothing.
 *
 * Built from the bootstrap result and nothing else. That is the point of the
 * exercise: if this function needed a store read, the tool result would not be
 * enough to follow up on, and a caller holding only MCP could not write it.
 */
function trackingTask(bootstrap: Bootstrap): TaskCreateInput {
  const { specRevision, planRevision, baseSha } = bootstrap.taskInputs;
  return {
    runId: bootstrap.runId,
    taskId: `task_${Bun.randomUUIDv7()}`,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: {
      objective: "track board bootstrap on the queen's own board",
      parentAcceptanceIds: ["root-coordination"],
      childOutcome: "the item is visible and can be moved to completed",
      terminationCondition: "the queen marks it completed",
      inputs: {
        specRevision,
        planRevision,
        taskRevisions: [],
        interfaceRevisions: [],
        baseSha,
        prerequisites: [],
        sourceArtifactRefs: [],
      },
      boundaries: { allowedPaths: [] },
      authority: {
        grantId: `grant_${Bun.randomUUIDv7()}`,
        permittedOperations: ["read"],
        environment: "none",
        worktree: "none",
        branch: "none",
        explicitNonAuthority: ["no delegation authority"],
      },
      allowance: {
        sessions: 0,
        tokens: 0,
        costCents: 0,
        wallTimeMs: 0,
        retries: 0,
        blockers: [],
      },
    },
    acceptanceIds: ["root-coordination"],
    assigneeNodeId: null,
    pathLeases: [],
    branch: "none",
    baseSha,
    state: "planned",
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

describe("hive_run_bootstrap", () => {
  test("opens the run, root node and root binding on an empty database", async () => {
    const { daemon, db } = harness();
    const store = new HierarchyStore(db);
    // The board's own precondition: with no run there is nothing to project.
    expect(store.listRuns()).toEqual([]);

    const result = await callTool(
      daemon,
      queenToken(daemon),
      "hive_run_bootstrap",
    );

    expect(result.ok).toBe(true);
    const bootstrap = bootstrapOf(result);
    expect(bootstrap.kind).toBe("created");
    const run = required(store.getRun(bootstrap.runId), "run");
    expect(run.lifecycle).toBe("active");
    expect(run.instanceId).toBe(hiveInstanceSuffix());
    const root = required(store.getNode(bootstrap.rootNodeId), "root node");
    expect(root.parentNodeId).toBeNull();
    expect(root.ownerNodeId).toBeNull();
    expect(store.getRootBinding(bootstrap.runId)?.nodeId).toBe(
      bootstrap.rootNodeId,
    );
    expect(bootstrap.next).toContain("daemon fills both owner identities");
    expect(bootstrap.next).toContain("taskInputs");
  });

  test("the task inputs it returns name records the store actually holds", async () => {
    // The refs are only worth returning if they are true of stored state. Each
    // is read back by the revision it names and compared on digest, so a
    // fabricated or drifted ref fails here rather than in the queen's hands.
    const { daemon, db } = harness();

    const bootstrap = bootstrapOf(
      await callTool(daemon, queenToken(daemon), "hive_run_bootstrap"),
    );

    const store = new HierarchyStore(db);
    const { specRevision, planRevision, baseSha } = bootstrap.taskInputs;
    const spec = required(
      store.getSpecRevision(bootstrap.runId, specRevision.revision),
      "stored spec",
    );
    const plan = required(
      store.getPlanRevision(bootstrap.runId, planRevision.revision),
      "stored plan",
    );
    expect(spec.digest).toBe(specRevision.digest);
    expect(plan.digest).toBe(planRevision.digest);
    expect(baseSha).toBe(
      required(store.getRun(bootstrap.runId), "run").baseSha,
    );
    // The run states this spec but has not approved it, which is why the ref
    // cannot simply be read off Run.approvedSpec.
    expect(store.getRun(bootstrap.runId)?.approvedSpec).toBeNull();
  });

  test("a second call returns the same root instead of opening another", async () => {
    const { daemon, db } = harness();
    const token = queenToken(daemon);

    const first = bootstrapOf(
      await callTool(daemon, token, "hive_run_bootstrap"),
    );
    const second = bootstrapOf(
      await callTool(daemon, token, "hive_run_bootstrap"),
    );

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("existing");
    expect(second.runId).toBe(first.runId);
    expect(second.rootNodeId).toBe(first.rootNodeId);
    expect(second.rootBinding).toEqual(first.rootBinding);
    // Both kinds answer identically, so a caller never has to open the run to
    // learn what an `existing` answer left out.
    expect(second.taskInputs).toEqual(first.taskInputs);
    // The claim that matters is about the store, not the answer: one root.
    expect(new HierarchyStore(db).listRuns()).toHaveLength(1);
  });

  test("the run it opens grants nothing: G1 pending and a zero budget", async () => {
    const { daemon, db } = harness();

    const bootstrap = bootstrapOf(
      await callTool(daemon, queenToken(daemon), "hive_run_bootstrap"),
    );

    const store = new HierarchyStore(db);
    const run = required(store.getRun(bootstrap.runId), "run");
    expect(run.g1).toEqual({ state: "pending" });
    expect(run.g2).toEqual({ state: "pending" });
    expect(run.approvedSpec).toBeNull();
    const budget = required(
      store.getRunBudget(bootstrap.runId, run.budget.revision),
      "budget",
    );
    for (const [dimension, limit] of Object.entries(budget.limits)) {
      expect({ dimension, hard: limit.hard }).toEqual({ dimension, hard: 0 });
    }
  });

  test("accepted task completion checkpoints the exact updated task ref", async () => {
    const { daemon, db } = harness();
    const token = queenToken(daemon);
    const store = new HierarchyStore(db);

    const bootstrap = bootstrapOf(
      await callTool(daemon, token, "hive_run_bootstrap"),
    );
    const task = trackingTask(bootstrap);

    const created = await callTool(daemon, token, "hive_task_create", task);
    expect({ ok: created.ok, text: created.text }).toEqual({
      ok: true,
      text: created.text,
    });

    const entities = await snapshot(daemon);
    // A positive control on the reader: the run and node are found by the same
    // (kind, id) lookup the task assertion uses, so an empty task list below is
    // a real absence rather than a key this test spelled wrong.
    expect(
      findEntity(entities, "hierarchy-run", bootstrap.runId),
    ).toBeDefined();
    expect(
      findEntity(entities, "hierarchy-node", bootstrap.rootNodeId),
    ).toBeDefined();
    const taskEntity = findEntity(
      entities,
      "hierarchy-task",
      `${bootstrap.runId}:tasks`,
    );
    expect(JSON.stringify(taskEntity?.projection)).toContain(task.taskId);

    const updated = await callTool(daemon, token, "hive_task_update", {
      taskId: task.taskId,
      expectedRevision: "1",
      state: "completed",
    });
    expect({ ok: updated.ok, text: updated.text }).toEqual({
      ok: true,
      text: updated.text,
    });
    const completed = required(store.getTask(task.taskId), "completed task");
    expect(completed.state).toBe("completed");

    const row = db.database
      .query(
        "SELECT document FROM run_checkpoints WHERE instanceId = ? ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1",
      )
      .get(hiveInstanceSuffix()) as { document: string } | null;
    const checkpoint = RunCheckpointSchema.parse(
      JSON.parse(required(row, "task-completion checkpoint").document),
    );
    expect(checkpoint.reason).toBe("task-completion");
    expect(checkpoint.written).toBeNull();
    expect(checkpoint.hierarchy?.runId).toBe(bootstrap.runId);
    expect(checkpoint.hierarchy?.tasks).toContainEqual({
      taskId: completed.taskId,
      revision: completed.revision,
      digest: digestCheckpointContent(completed),
    });

    const afterTasks = findEntity(
      await snapshot(daemon),
      "hierarchy-task",
      `${bootstrap.runId}:tasks`,
    );
    expect(JSON.stringify(afterTasks?.projection)).toContain(task.taskId);
    expect(JSON.stringify(afterTasks?.projection)).toContain("completed");
  });

  test("a tracking task admits no spawn, because its run has no approved G1", async () => {
    // The poison risk: a task on the board is a task admission can read. This
    // asserts the refusal rather than assuming it — with the tracking task
    // stored and named, preflight still refuses, and it refuses on the gate.
    const { daemon, db } = harness();
    const token = queenToken(daemon);
    const store = new HierarchyStore(db);

    const bootstrap = bootstrapOf(
      await callTool(daemon, token, "hive_run_bootstrap"),
    );
    const run = required(store.getRun(bootstrap.runId), "run");
    const task = trackingTask(bootstrap);
    expect((await callTool(daemon, token, "hive_task_create", task)).ok).toBe(
      true,
    );
    const storedTask = required(store.getTask(task.taskId), "tracking task");

    expect(() =>
      new SpawnAdmission(store).preflight(
        {
          runId: bootstrap.runId,
          runEpoch: run.runEpoch,
          nodeId: bootstrap.rootNodeId,
          taskId: task.taskId,
          delegationSpec: storedTask.delegationSpec,
          grantId: storedTask.delegationSpec.authority.grantId,
        },
        "lead-coordination",
      ),
    ).toThrow(SpawnAdmissionError);
    expect(() =>
      new SpawnAdmission(store).preflight(
        { runId: bootstrap.runId, taskId: task.taskId },
        "lead-coordination",
      ),
    ).toThrow(`hierarchy Run ${bootstrap.runId} has no approved G1`);
  });

  test("a writer and a reader are refused; only the orchestrator may open a run", async () => {
    const { daemon, db } = harness();

    for (const role of ["writer", "reader"] as const) {
      const { token } = daemon.capabilities.mint("maya", role);
      const refused = await callTool(daemon, token, "hive_run_bootstrap");

      expect({ role, ok: refused.ok }).toEqual({ role, ok: false });
      expect(refused.text).toContain("run:bootstrap");
    }
    // The refusal is authority, not a no-op: nothing was written either time.
    expect(new HierarchyStore(db).listRuns()).toEqual([]);
  });

  test("the queen can find the tool, and the other roles cannot see it", async () => {
    // Refusing a call and offering the tool are different surfaces: a queen who
    // cannot SEE hive_run_bootstrap has no supported path either, however
    // correctly it would answer her. Each role's catalog is non-empty, so a
    // `false` below is a tool withheld rather than a catalog that failed.
    const { daemon } = harness();
    const seen: Record<string, { total: number; offered: boolean }> = {};

    for (const [subject, role] of [
      [ORCHESTRATOR_NAME, "orchestrator"],
      ["maya", "writer"],
      ["rex", "reader"],
    ] as const) {
      const { token } = daemon.capabilities.mint(subject, role);
      const client = new Client({ name: "test", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL("http://hive/mcp"),
        { fetch: authorized(daemon, token) },
      );
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      seen[role] = {
        total: names.length,
        offered: names.includes("hive_run_bootstrap"),
      };
      await client.close().catch(() => undefined);
    }

    expect(seen.orchestrator?.offered).toBe(true);
    expect(seen.writer?.offered).toBe(false);
    expect(seen.reader?.offered).toBe(false);
    for (const [role, catalog] of Object.entries(seen)) {
      expect({ role, empty: catalog.total === 0 }).toEqual({
        role,
        empty: false,
      });
    }
  });

  test("a queen whose capability lost the provider epoch is refused", async () => {
    const { daemon, db } = harness();

    const stale = await callTool(
      daemon,
      queenToken(daemon, 3),
      "hive_run_bootstrap",
    );

    expect(stale.ok).toBe(false);
    expect(stale.text).toContain("live provider epoch");
    expect(new HierarchyStore(db).listRuns()).toEqual([]);
  });
});
