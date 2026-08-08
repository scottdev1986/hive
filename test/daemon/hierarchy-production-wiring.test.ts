// Proves the hierarchy writers and landing path are reachable through the
// daemon's authenticated MCP transport, not only through captured handlers.
// Fixtures enter through the same database and HierarchyStore APIs production
// uses; the assertions then observe the durable rows written by the real server.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import type { AgentRecord } from "../../src/schemas/agent";
import type {
  AgentBinding,
  AgentBindingRef,
  DelegationGrant,
  DelegationSpec,
  HierarchyNode,
} from "../../src/schemas/hierarchy-node";
import type {
  PlanRevision,
  Run,
  SpecRevision,
} from "../../src/schemas/hierarchy-run";
import type {
  TaskCreateInput,
  TaskDetail,
} from "../../src/schemas/task-detail";
import { TokenUsageStore } from "../../src/usage-service/token-usage";

const stamp = "2026-08-01T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const baseSha = "b".repeat(40);
const runId = "run_019fbd11-1000-7000-8000-000000000001";
const rootNodeId = "node_019fbd11-1000-7000-8000-000000000002";
const authorNodeId = "node_019fbd11-1000-7000-8000-000000000003";
const taskId = "task_019fbd11-1000-7000-8000-000000000004";
const missingGrantId = "grant_019fbd11-1000-7000-8000-000000000005";
const rootGrantId = "grant_019fbd11-1000-7000-8000-000000000006";
const workerNodeId = "node_019fbd11-1000-7000-8000-000000000007";
const workerRef = {
  nodeId: workerNodeId,
  agentId: "agent-worker",
  generation: 1,
} as const;
const authorRef = {
  nodeId: authorNodeId,
  agentId: "agent-author",
  generation: 1,
} as const;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by the production wiring proof");
  }
}

function run(): Run {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-production-wiring",
    approvedSpec: { revision: "1", digest },
    currentPlan: { revision: "1", digest },
    topology: { revision: "1", digest },
    phase: "P2",
    g1: {
      state: "approved",
      decider: "engineer",
      decidedAt: stamp,
      spec: { revision: "1", digest },
      plan: { revision: "1", digest },
      topology: { revision: "1", digest },
      budget: { revision: "1", digest },
    },
    g2: { state: "pending" },
    baseSha,
    budget: { revision: "1", digest },
    runEpoch: 0,
    lifecycle: "active",
  };
}

function node(nodeId: string, parentNodeId: string | null): HierarchyNode {
  return {
    nodeId,
    runId,
    parentNodeId,
    ownerNodeId: parentNodeId,
    organizationalRole: parentNodeId === null ? "lead-worker" : "worker",
    assignmentKind: "author",
    taskScope: [taskId],
    capacityCharge: 1,
    lifecycle: "active",
    revision: "1",
  };
}

function sessionLocator(agentId: string, generation = 1) {
  return {
    schemaVersion: 1,
    instanceId: "instance-production-wiring",
    subject: { kind: "agent", agentId },
    generation,
    sessionId: "ses_019fbd11-1000-7000-8000-000000000101",
    hostKind: "sessiond",
    engineBuildId: "test-build",
  } as const;
}

function agentRecord(
  id: string,
  name: string,
  branch: string,
  locator?: ReturnType<typeof sessionLocator>,
): AgentRecord {
  return {
    id,
    name,
    tool: "codex",
    model: "gpt-5",
    category: "simple_coding",
    status: "working",
    taskDescription: "Exercise production hierarchy wiring",
    worktreePath: `/worktrees/${name}`,
    branch,
    ...(locator === undefined ? {} : { sessionLocator: locator }),
    contextPct: null,
    createdAt: stamp,
    lastEventAt: stamp,
    capabilityEpoch: 1,
    readOnly: false,
    writeRevoked: false,
  };
}

function binding(ref: AgentBindingRef): AgentBinding {
  const locator = sessionLocator(ref.agentId, ref.generation);
  return {
    ...ref,
    provider: "codex",
    model: "gpt-5",
    sessionLocator: locator,
    worktree: "/worktrees/author",
    branch: "hive/author",
    baseSha,
    credentialId: "cred-author",
    boundAt: stamp,
    unboundAt: null,
  };
}

function task(): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: {
      objective: "Exercise the authenticated production writer",
      parentAcceptanceIds: ["A1"],
      childOutcome: "The task is stored",
      terminationCondition: "The production proof passes",
      inputs: {
        specRevision: { revision: "1", digest },
        planRevision: { revision: "1", digest },
        taskRevisions: [],
        interfaceRevisions: [],
        baseSha,
        prerequisites: [],
        sourceArtifactRefs: [],
      },
      boundaries: {
        allowedPaths: ["src/daemon"],
      },
      authority: {
        grantId: missingGrantId,
        permittedOperations: ["read", "write", "promote"],
        environment: "worktree",
        worktree: "/worktrees/author",
        branch: "hive/author",
        explicitNonAuthority: [],
      },
      allowance: {
        sessions: 1,
        tokens: 1_000,
        costCents: 10,
        wallTimeMs: 60_000,
        retries: 0,
        blockers: [],
        owner: authorRef,
      },
    },
    acceptanceIds: ["A1"],
    ownerNodeId: authorNodeId,
    assigneeNodeId: authorNodeId,
    pathLeases: [{ path: "src/daemon", mode: "write" }],
    branch: "hive/author",
    baseSha,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

function taskCreateInput(): TaskCreateInput {
  const full = task();
  const { ownerNodeId: _ownerNodeId, delegationSpec, ...input } = full;
  const { owner: _owner, ...allowance } = delegationSpec.allowance;
  return {
    runId,
    ...input,
    delegationSpec: { ...delegationSpec, allowance },
  };
}

function admissionSpec(): DelegationSpec {
  return {
    objective: "Reserve one hierarchy worker",
    parentAcceptanceIds: ["A1"],
    childOutcome: "The worker identity is reserved",
    terminationCondition: "Admission completes",
    inputs: {
      specRevision: { revision: "1", digest },
      planRevision: { revision: "1", digest },
      taskRevisions: [{ taskId, revision: "1" }],
      interfaceRevisions: [],
      baseSha,
      prerequisites: [],
      sourceArtifactRefs: [],
    },
    boundaries: { allowedPaths: ["src/daemon"] },
    authority: {
      grantId: missingGrantId,
      permittedOperations: ["read", "write"],
      environment: "worktree",
      worktree: "/worktrees/worker",
      branch: "hive/worker",
      explicitNonAuthority: ["land"],
    },
    allowance: {
      sessions: 1,
      tokens: 2_000,
      costCents: 20,
      wallTimeMs: 60_000,
      retries: 0,
      blockers: [],
      owner: authorRef,
    },
  };
}

function admissionTask(spec: DelegationSpec): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: spec,
    acceptanceIds: ["A1"],
    ownerNodeId: authorNodeId,
    assigneeNodeId: workerNodeId,
    pathLeases: [{ path: "src/daemon", mode: "write" }],
    branch: "hive/worker",
    baseSha,
    state: "assigned",
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

function specRevision(): SpecRevision {
  return {
    runId,
    revision: "1",
    digest,
    createdAt: stamp,
    lifecycle: "proposed",
    objective: "Reserve one hierarchy worker",
    acceptanceIds: ["A1"],
    scope: "Hierarchy admission composition",
    nonGoals: [],
    constraints: { architecture: [], security: [], outwardEffect: [] },
    gatePolicy: {
      reviewLocGreenMax: 100,
      reviewLocAmberMax: 250,
      reviewFilesMax: 10,
    },
    evidenceArtifactRefs: [],
    proposer: "author",
    engineerApproval: null,
  };
}

function planRevision(): PlanRevision {
  return {
    runId,
    revision: "1",
    digest,
    createdAt: stamp,
    lifecycle: "proposed",
    parentRevision: null,
    taskDag: [{ taskId, dependsOn: [] }],
    topologyRationale: "One worker proves the admission holder",
    proposer: "author",
  };
}

function admissionGrants(): readonly [DelegationGrant, DelegationGrant] {
  const root: DelegationGrant = {
    grantId: rootGrantId,
    parentGrantId: null,
    issuer: authorRef,
    subject: authorRef,
    runId,
    taskIds: [taskId],
    descendantNodeIds: [workerNodeId],
    paths: ["src/daemon"],
    branches: ["hive/worker"],
    actions: ["read", "write", "spawn"],
    budget: {
      sessions: 2,
      tokens: 5_000,
      costCents: 50,
      wallTimeMs: 120_000,
      retries: 1,
    },
    // HiveDaemon builds SpawnAdmission on the real system clock (no test now
    // seam). A near-term expiresAt made this composition proof fail the moment
    // wall time passed it — full-suite red after 2026-08-10T12:00Z, green
    // before. Pin far ahead so the live-grant check is independent of when the
    // suite runs; expiry itself is covered in spawn-admission.test.ts.
    expiresAt: "2099-01-01T00:00:00.000Z",
    hierarchyRevision: "0",
    runEpoch: 0,
    capabilityEpoch: 1,
    status: "active",
  };
  return [
    root,
    {
      ...root,
      grantId: missingGrantId,
      parentGrantId: rootGrantId,
      subject: workerRef,
      descendantNodeIds: [],
      actions: ["read", "write"],
      budget: {
        sessions: 1,
        tokens: 2_000,
        costCents: 20,
        wallTimeMs: 60_000,
        retries: 0,
      },
    },
  ];
}

async function connectAs(daemon: HiveDaemon, subject: string): Promise<Client> {
  const { token } = daemon.capabilities.mint(subject, "writer", { epoch: 1 });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", "127.0.0.1");
        headers.set("Authorization", `Bearer ${token}`);
        return daemon.fetch(new Request(input, { ...init, headers }));
      },
    },
  );
  const client = new Client({
    name: "hierarchy-production-wiring-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  return client;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return JSON.stringify(result.content ?? "");
}

describe("authenticated hierarchy production wiring", () => {
  test("real MCP registration writes a task and routes hierarchy land without flat fallthrough", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "hive-hierarchy-prod-repo-"));
    tempRoots.push(repoRoot);

    const db = new HiveDatabase(":memory:");
    const store = new HierarchyStore(db);
    const flatLandCalls: string[] = [];
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db,
      repoRoot,
      daemonLog: () => undefined,
      projectGate: async () => {},
      landBranch: async (_root, branch) => {
        flatLandCalls.push(branch);
        return { commit: "c".repeat(40), landedCommits: ["c".repeat(40)] };
      },
    });

    const locator = sessionLocator(authorRef.agentId);
    db.insertAgent(
      agentRecord(authorRef.agentId, "author", "hive/author", locator),
    );
    db.insertAgent(agentRecord("agent-flat", "flat", "hive/flat"));
    store.putRun(run(), null);
    store.putNode(node(rootNodeId, null), null);
    store.putNode(node(authorNodeId, rootNodeId), null);
    store.putAgentBinding(binding(authorRef), runId);

    const author = await connectAs(daemon, "author");
    const flat = await connectAs(daemon, "flat");
    try {
      const tools = (await author.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(
        expect.arrayContaining([
          "hive_grant_issue",
          "hive_task_create",
          "hive_task_update",
          "hive_review_put",
          "hive_ownership_transfer",
        ]),
      );

      const created = await author.callTool({
        name: "hive_task_create",
        arguments: taskCreateInput(),
      });
      expect(created.isError).not.toBe(true);
      expect(store.getTask(taskId)).toEqual(task());

      const forgedPromotion = await author.callTool({
        name: "hive_land",
        arguments: {
          agent: "author",
          capabilityEpoch: 1,
          promotionActor: authorRef,
          promotionGrant: { grantId: missingGrantId },
        },
      });
      expect(forgedPromotion.isError).toBe(true);
      expect(resultText(forgedPromotion)).toMatch(/promotionActor/);
      expect(flatLandCalls).toEqual([]);

      const hierarchyLand = await author.callTool({
        name: "hive_land",
        arguments: { agent: "author", capabilityEpoch: 999 },
      });
      expect(hierarchyLand.isError).toBe(true);
      expect(resultText(hierarchyLand)).toContain(
        `delegation grant ${missingGrantId} named by task ${taskId} is not stored`,
      );
      expect(flatLandCalls).toEqual([]);

      const flatLand = await flat.callTool({
        name: "hive_land",
        arguments: { agent: "flat", capabilityEpoch: 1 },
      });
      expect(flatLand.isError).not.toBe(true);
      expect(flatLandCalls).toEqual(["hive/flat"]);
    } finally {
      await author.close().catch(() => undefined);
      await flat.close().catch(() => undefined);
      await daemon.stop();
      db.close();
    }
  });

  // src/cli/daemon.ts builds the spawner BEFORE the daemon, so it reads spawn
  // admission through a thunk over this property. Nothing else exercises that
  // composition, so without this the thunk could resolve to undefined and every
  // hierarchy spawn would refuse with "hierarchy admission is unavailable"
  // while the whole suite stayed green.
  test("the daemon exposes the live spawn admission the spawner reads", async () => {
    const db = new HiveDatabase(":memory:");
    const store = new HierarchyStore(db);
    const locator = sessionLocator(authorRef.agentId);
    db.insertAgent(
      agentRecord(authorRef.agentId, "author", "hive/author", locator),
    );
    const tokenUsage = new TokenUsageStore(db);
    await tokenUsage.startSession("/repo", stamp);
    const authorSubject = tokenUsage.subjectIdForAgent(authorRef.agentId);
    if (authorSubject === null) throw new Error("author usage subject missing");
    tokenUsage.recordProtocolUsage(authorSubject, [
      {
        key: "hierarchy-composition",
        counts: {
          inputTokens: 1_000,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          outputTokens: 0,
          reasoningTokens: null,
        },
        observedAt: stamp,
        source: "fixture",
      },
    ]);
    store.putRun(run(), null);
    store.putSpecRevision(specRevision());
    store.putPlanRevision(planRevision(), 0);
    store.putNode(node(authorNodeId, null), null);
    store.putNode(
      {
        ...node(workerNodeId, authorNodeId),
        ownerNodeId: authorNodeId,
      },
      null,
    );
    store.putAgentBinding(binding(authorRef), runId);
    const spec = admissionSpec();
    store.putTask(admissionTask(spec));
    const fences = {
      expectedHierarchyRevision: "0",
      expectedRunEpoch: 0,
      expectedCapabilityEpoch: 1,
      binding: authorRef,
    } as const;
    for (const grant of admissionGrants()) {
      store.putGrant(grant, fences);
    }

    let daemon!: HiveDaemon;
    const hierarchyAdmission = () => daemon.hierarchy.admission;
    daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      db,
      tokenUsage,
      repoRoot: "/repo",
      daemonLog: () => undefined,
    });
    try {
      const fields = {
        runId,
        runEpoch: 0,
        nodeId: workerNodeId,
        taskId,
        delegationSpec: spec,
        grantId: missingGrantId,
      };
      expect(hierarchyAdmission().preflight(fields, "author")).toMatchObject(
        workerRef,
      );
      expect(() =>
        daemon.hierarchy.admission.preflight(fields, "author"),
      ).toThrow("already reserved");
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
