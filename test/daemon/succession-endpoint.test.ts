import { describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { HiveDaemon } from "../../src/daemon/server";
import { definedFields } from "../../src/shared/defined-fields";
import { type JsonValue, safeJsonParse } from "../../src/shared/json";
import { mintSessionRequestId } from "../../src/daemon/session-host/locators";
import {
  type CapabilityProvider,
  CAPABILITY_PROVIDERS,
} from "../../src/schemas/provider";
import { ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type { Run } from "../../src/schemas/hierarchy-run";
import {
  QueenProviderProjectionSchema,
  SetLiveQueenProviderResponseSchema,
} from "../../src/schemas/queen-provider";
import {
  QueenSuccessionProjectionSchema,
  RunCheckpointSchema,
} from "../../src/schemas/run-checkpoint";
import { bindRootSession } from "../mail-test-support";
import { required } from "../required";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-queen-succession-");
process.env.HIVE_HOME = home;

const T0 = "2026-07-31T00:00:00.000Z";
const SPAWN_TASK_ID = "task_018f4f5e-0000-7000-8000-000000000001";

const ALL_AVAILABLE = {
  claude: { available: true },
  codex: { available: true },
  grok: { available: true },
  kimi: { available: true },
  opencode: { available: true },
} as const;

function harness() {
  const db = new HiveDatabase(":memory:");
  const observation = { provider: null as CapabilityProvider | null };
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-queen-succession-noop",
    queenVendorAvailability: () => ALL_AVAILABLE,
    queenRootObservation: () => observation.provider,
  });
  bindRootSession(db);
  return { daemon, db, observation };
}

function insertMaya(db: HiveDatabase): void {
  db.insertAgent({
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status: "working",
    taskDescription: "maya's task",
    worktreePath: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-work",
    contextPct: null,
    createdAt: T0,
    lastEventAt: T0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  });
}

const MAYA_SNAPSHOT = [
  {
    agentName: "maya",
    status: "working",
    branch: "hive/maya-work",
    worktreePath: "/repo/.hive/worktrees/maya",
    lastEventAt: T0,
  },
];

const VALID_BEGIN = {
  reasonDetail:
    "orchestrator exited with code 9 while 1 agent(s) remained active",
  priorRootGeneration: 0,
  snapshot: MAYA_SNAPSHOT,
};

/** Backup generation the attestation must name: durable prior + 1. */
function expectedBackupGeneration(declaration: {
  succession: { priorRootGeneration: number };
}): number {
  return declaration.succession.priorRootGeneration + 1;
}

const request = (
  daemon: HiveDaemon,
  token: string | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return daemon.fetch(
    new Request(`http://hive${path}`, {
      method,
      headers,
      ...definedFields({
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    }),
  );
};

async function callTool(
  daemon: HiveDaemon,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; error: string; content: unknown }> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Host", "127.0.0.1");
        headers.set("Authorization", `Bearer ${token}`);
        return daemon.fetch(new Request(url, { ...init, headers }));
      },
    },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    return {
      ok: result.isError !== true,
      error: result.isError === true ? JSON.stringify(result.content) : "",
      content: result.content,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "?",
      content: null,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Parse the one JSON text block a tool result carries. */
function toolJson(content: unknown): JsonValue {
  const blocks = content as Array<{ type: string; text: string }>;
  const parsed = safeJsonParse(blocks[0]?.text ?? "null");
  if (parsed === undefined) {
    throw new Error("tool result was not JSON");
  }
  return parsed;
}

/** The client projection must parse, say only idle|pending|failed, and never
 * carry a succession word — at any phase. */
async function expectClientWireOpaque(
  daemon: HiveDaemon,
  token: string,
): Promise<void> {
  const response = await request(daemon, token, "GET", "/queen-provider");
  expect(response.status).toEqual(200);
  const body = (await response.json()) as Record<string, unknown>;
  const projection = QueenProviderProjectionSchema.parse(body);
  expect(["idle", "pending", "failed"]).toContain(projection.change.state);
  const keys = JSON.stringify(Object.keys(body));
  for (const word of [
    "fence",
    "generation",
    "checkpoint",
    "handoff",
    "verification",
    "attestation",
  ]) {
    expect(keys).not.toContain(word);
  }
}

const steer = async (daemon: HiveDaemon, token: string) =>
  (
    (await (
      await request(daemon, token, "GET", "/queen-succession/steer")
    ).json()) as { tool: string | null }
  ).tool;

const successionProjection = async (daemon: HiveDaemon, token: string) =>
  QueenSuccessionProjectionSchema.parse(
    await (
      await request(daemon, token, "GET", "/queen-succession/projection")
    ).json(),
  );

describe("the replaced seam", () => {
  test("the old supervisor endpoints are gone", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    expect(
      (await request(daemon, token, "GET", "/queen-provider/launch-tool"))
        .status,
    ).toEqual(404);
    expect(
      (
        await request(daemon, token, "POST", "/queen-provider/launch-failure", {
          provider: "kimi",
          detail: "gone",
        })
      ).status,
    ).toEqual(404);
    await daemon.stop();
  });

  test("every one of the five vendors swaps the same way, and a failed change steers back", async () => {
    const { daemon, observation } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    let revision = 0;
    for (const provider of CAPABILITY_PROVIDERS) {
      const accepted = SetLiveQueenProviderResponseSchema.parse(
        await (
          await request(daemon, token, "POST", "/queen-provider", {
            provider,
            expectedRevision: String(revision),
          })
        ).json(),
      );
      revision += 1;
      expect(accepted.receipt.revision).toEqual(String(revision));
      expect(await steer(daemon, token)).toEqual(provider);
      // Pending until that vendor is OBSERVED running.
      observation.provider = provider;
      expect(await steer(daemon, token)).toEqual(provider);
      const projection = QueenProviderProjectionSchema.parse(
        await (await request(daemon, token, "GET", "/queen-provider")).json(),
      );
      expect(projection.change.state).toEqual("idle");
      expect(projection.liveProvider).toEqual(provider);
    }
    // The failure path: a change to the next vendor fails, the steer returns
    // to the provider that was live when the change was accepted.
    await request(daemon, token, "POST", "/queen-provider", {
      provider: "codex",
      expectedRevision: String(revision),
    });
    expect(await steer(daemon, token)).toEqual("codex");
    const reported = await request(
      daemon,
      token,
      "POST",
      "/queen-succession/launch-failure",
      { provider: "codex", detail: "codex CLI is broken" },
    );
    expect(reported.status).toEqual(200);
    expect(await steer(daemon, token)).toEqual(
      required(CAPABILITY_PROVIDERS.at(-1)),
    );
    const failed = QueenProviderProjectionSchema.parse(
      await (await request(daemon, token, "GET", "/queen-provider")).json(),
    );
    expect(failed.change.state).toEqual("failed");
    expect(failed.change.failure).toEqual("codex CLI is broken");
    await daemon.stop();
  });

  test("begin, replies, and launch-failure are user-only, like the provider change itself", async () => {
    const { daemon } = harness();
    for (const [subject, role] of [
      ["maya", "writer"],
      ["viewer", "reader"],
      ["orchestrator", "orchestrator"],
    ] as const) {
      const { token } = daemon.capabilities.mint(subject, role);
      for (const [path, body] of [
        ["/queen-succession/prepare-launch", VALID_BEGIN],
        [
          "/queen-succession/replies",
          {
            successionId: "qsc_00000000-0000-7000-8000-000000000000",
            replies: [],
          },
        ],
        [
          "/queen-succession/launch-failure",
          { provider: "kimi", detail: "not yours to report" },
        ],
      ] as const) {
        expect(
          (await request(daemon, token, "POST", path, body)).status,
        ).toEqual(403);
      }
    }
    const { token } = daemon.capabilities.mint("user", "user");
    expect(
      (
        await request(
          daemon,
          token,
          "POST",
          "/queen-succession/prepare-launch",
          {
            requestId: mintSessionRequestId(),
            provider: "claude",
            cwd: "/repo",
            reason: "root-exit-with-live-agents",
            reasonDetail: VALID_BEGIN.reasonDetail,
          },
        )
      ).status,
    ).toEqual(200);
    await daemon.stop();
  });

  test("a malformed begin is refused whole", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    for (const body of [
      {},
      null,
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: VALID_BEGIN.reasonDetail,
        priorRootGeneration: -1,
      },
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "not-a-reason",
        reasonDetail: VALID_BEGIN.reasonDetail,
      },
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: VALID_BEGIN.reasonDetail,
        replies: [],
      },
    ]) {
      expect(
        (
          await request(
            daemon,
            token,
            "POST",
            "/queen-succession/prepare-launch",
            body,
          )
        ).status,
      ).toEqual(400);
    }
    await daemon.stop();
  });
});

describe("a succession through the production paths", () => {
  test("only the explicit attestation completes it, after a measured re-read; observation never attests", async () => {
    const { daemon, observation } = harness();
    insertMaya(daemon.db);
    const user = daemon.capabilities.mint("user", "user").token;
    const queen = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;

    // The production checkpoint write: the root's own tool, daemon-filled.
    const written = await callTool(daemon, queen, "hive_run_checkpoint", {
      reason: "task-completion",
      contextUsage: {
        kind: "measured",
        residentTokens: 10_000,
        measuredAt: T0,
      },
      decision: { decision: "compact", reason: "healthy warm root" },
      written: {
        goal: "keep the run moving",
        done: ["maya admitted"],
        failures: [],
        uncertainty: [],
        nextAction: "review maya",
        rollback: "relaunch the prior root",
      },
      unresolvedQuestions: [],
      model: null,
    });
    expect(written.ok).toEqual(true);
    const checkpoint = RunCheckpointSchema.parse(toolJson(written.content));
    expect(checkpoint.revision).toEqual("1");
    expect(checkpoint.agentSnapshot.map((entry) => entry.agentName)).toEqual([
      "maya",
    ]);
    expect(checkpoint.written?.goal).toEqual("keep the run moving");
    const read = await callTool(daemon, queen, "hive_run_checkpoint_get", {});
    expect(read.ok).toEqual(true);
    expect(toolJson(read.content)).toEqual({
      state: "present",
      digestVerified: true,
      checkpoint,
    });
    expect(
      toolJson(
        (
          await callTool(daemon, queen, "hive_run_checkpoint_get", {
            revision: "999",
          })
        ).content,
      ),
    ).toEqual({ state: "absent", revision: "999" });
    await expectClientWireOpaque(daemon, user);

    // The declaration: the checkpoint is the proof, nothing contradicts.
    const began = await request(
      daemon,
      user,
      "POST",
      "/queen-succession/prepare-launch",
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: VALID_BEGIN.reasonDetail,
      },
    );
    expect(began.status).toEqual(200);
    const declaration = (await began.json()) as {
      succession: {
        successionId: string;
        priorRootGeneration: number;
        proof:
          | { kind: "checkpoint"; ref: { revision: string; digest: string } }
          | { kind: "no-checkpoint"; detail: string };
        discrepancies: string[];
        attestation: null;
      };
    };
    const backupGeneration = expectedBackupGeneration(declaration);
    expect(declaration.succession.proof).toEqual({
      kind: "checkpoint",
      ref: { revision: "1", digest: checkpoint.digest },
    });
    expect(declaration.succession.discrepancies).toEqual([]);

    // The measured replies land on the record.
    const replies = await request(
      daemon,
      user,
      "POST",
      "/queen-succession/replies",
      {
        successionId: declaration.succession.successionId,
        replies: [{ agentName: "maya", confirmed: true }],
      },
    );
    expect(replies.status).toEqual(200);
    await expectClientWireOpaque(daemon, user);

    // The gate: while the succession is open the root's authority is the
    // recovery tools only.
    const gatedSpawn = await callTool(daemon, queen, "hive_spawn", {
      task: "work that must wait",
      category: "simple_coding",
      taskId: SPAWN_TASK_ID,
    });
    expect(gatedSpawn.ok).toEqual(false);
    expect(gatedSpawn.error).toContain("awaits attestation");
    const gatedCheckpoint = await callTool(
      daemon,
      queen,
      "hive_run_checkpoint",
      {
        reason: "task-completion",
        contextUsage: { kind: "unknown", reason: "unmeasured" },
        decision: { decision: "compact", reason: "x" },
        written: {
          goal: "x",
          done: [],
          failures: [],
          uncertainty: [],
          nextAction: "x",
          rollback: "x",
        },
        unresolvedQuestions: [],
        model: null,
      },
    );
    expect(gatedCheckpoint.ok).toEqual(false);
    expect(gatedCheckpoint.error).toContain("awaits attestation");

    // Observation is not an attestation: the fresh root observed running
    // changes nothing about the record.
    observation.provider = "claude";
    await expectClientWireOpaque(daemon, user);
    expect(
      (await successionProjection(daemon, user)).succession?.state,
    ).toEqual("recovering");

    // An attestation without the measured re-read is refused.
    const premature = await callTool(daemon, queen, "hive_succession_attest", {
      successionId: declaration.succession.successionId,
      generation: backupGeneration,
      checkpointDigest: checkpoint.digest,
    });
    expect(premature.ok).toEqual(false);
    expect(premature.error).toContain("re-read is not measured");

    // The measured re-read, through the root's own tools.
    expect((await callTool(daemon, queen, "hive_status")).ok).toEqual(true);
    expect(
      (await callTool(daemon, queen, "hive_mail_poll", { recipient: "queen" }))
        .ok,
    ).toEqual(true);
    expect((await callTool(daemon, queen, "hive_task_list")).ok).toEqual(true);
    expect(
      (await callTool(daemon, queen, "hive_run_checkpoint_get", {})).ok,
    ).toEqual(true);

    // A wrong digest is refused; the exact one completes the succession.
    const wrong = await callTool(daemon, queen, "hive_succession_attest", {
      successionId: declaration.succession.successionId,
      generation: backupGeneration,
      checkpointDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(wrong.ok).toEqual(false);
    expect(wrong.error).toContain("daemon verified");
    const attested = await callTool(daemon, queen, "hive_succession_attest", {
      successionId: declaration.succession.successionId,
      generation: backupGeneration,
      checkpointDigest: checkpoint.digest,
    });
    expect(attested.ok).toEqual(true);
    const projection = await successionProjection(daemon, user);
    expect(projection.succession?.state).toEqual("attested");
    expect(projection.succession?.newRootGeneration).toEqual(backupGeneration);
    expect(projection.contradictions).toEqual([]);
    await expectClientWireOpaque(daemon, user);

    // The gate is lifted: a spawn now reaches the spawner (which refuses,
    // proving the refusal is no longer the gate's).
    const admitted = await callTool(daemon, queen, "hive_spawn", {
      task: "work after attestation",
      category: "simple_coding",
      taskId: SPAWN_TASK_ID,
    });
    expect(admitted.ok).toEqual(false);
    expect(admitted.error).toContain("no spawns in this test");
    await daemon.stop();
  });

  test("no checkpoint: the successor attests 'no checkpoint', writes the first one, and admission opens", async () => {
    const { daemon, observation } = harness();
    const user = daemon.capabilities.mint("user", "user").token;
    const queen = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;

    // Before anything: unknown usage and no checkpoint refuse new work.
    const refused = await callTool(daemon, queen, "hive_spawn", {
      task: "the very first work",
      category: "simple_coding",
      taskId: SPAWN_TASK_ID,
    });
    expect(refused.ok).toEqual(false);
    expect(refused.error).toContain("unknown");

    const began = await request(
      daemon,
      user,
      "POST",
      "/queen-succession/prepare-launch",
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: VALID_BEGIN.reasonDetail,
      },
    );
    const declaration = (await began.json()) as {
      succession: {
        successionId: string;
        priorRootGeneration: number;
        proof: { kind: string; detail?: string };
      };
      bootstrap: unknown[];
    };
    const backupGeneration = expectedBackupGeneration(declaration);
    expect(declaration.succession.proof.kind).toEqual("no-checkpoint");
    expect(declaration.bootstrap).toEqual([]);

    observation.provider = "claude";
    expect((await callTool(daemon, queen, "hive_status")).ok).toEqual(true);
    expect(
      (await callTool(daemon, queen, "hive_mail_poll", { recipient: "queen" }))
        .ok,
    ).toEqual(true);
    expect((await callTool(daemon, queen, "hive_task_list")).ok).toEqual(true);
    expect(
      (await callTool(daemon, queen, "hive_run_checkpoint_get", {})).ok,
    ).toEqual(true);
    // Only a null digest attests a no-checkpoint proof.
    const wrong = await callTool(daemon, queen, "hive_succession_attest", {
      successionId: declaration.succession.successionId,
      generation: backupGeneration,
      checkpointDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(wrong.ok).toEqual(false);
    expect(wrong.error).toContain("no-checkpoint proof");
    expect(
      (
        await callTool(daemon, queen, "hive_succession_attest", {
          successionId: declaration.succession.successionId,
          generation: backupGeneration,
          checkpointDigest: null,
        })
      ).ok,
    ).toEqual(true);

    // The gate lifted, she writes her first checkpoint — the bootstrap the
    // design names — and admission opens.
    const first = await callTool(daemon, queen, "hive_run_checkpoint", {
      reason: "unknown-context",
      contextUsage: { kind: "unknown", reason: "fresh root has not measured" },
      decision: {
        decision: "replace",
        reason: "no-checkpoint bootstrap; the context is cold",
      },
      written: {
        goal: "recover the run",
        done: ["attested no checkpoint"],
        failures: [],
        uncertainty: [],
        nextAction: "reconcile with maya",
        rollback: "relaunch the prior root",
      },
      unresolvedQuestions: [],
      model: null,
    });
    expect(first.ok).toEqual(true);
    expect((toolJson(first.content) as { revision: string }).revision).toEqual(
      "1",
    );
    const admitted = await callTool(daemon, queen, "hive_spawn", {
      task: "work after the first checkpoint",
      category: "simple_coding",
      taskId: SPAWN_TASK_ID,
    });
    expect(admitted.ok).toEqual(false);
    expect(admitted.error).toContain("no spawns in this test");
    await daemon.stop();
  });

  test("a run-control decision writes the boundary checkpoint binding the run spine", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const runId = "run_018f4f5e-0000-7000-8000-000000000001";
    const digest = `sha256:${"a".repeat(64)}`;
    const ref = { revision: "1", digest };
    const run: Run = {
      runId,
      revision: "1",
      repo: "hive",
      instanceId: "instance-fixture",
      spec: ref,
      currentPlan: ref,
      topology: ref,
      phase: "P1",
      baseSha: "f".repeat(40),
      budget: ref,
      runEpoch: 0,
      lifecycle: "active",
    };
    new HierarchyStore(daemon.db).putRun(run, null);
    const store = new HierarchyStore(daemon.db);
    store.putNode(
      {
        nodeId: "node_018f4f5e-0000-7000-8000-000000000001",
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: ["task_018f4f5e-0000-7000-8000-000000000001"],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    store.putNode(
      {
        nodeId: "node_018f4f5e-0000-7000-8000-000000000002",
        runId,
        parentNodeId: "node_018f4f5e-0000-7000-8000-000000000001",
        ownerNodeId: "node_018f4f5e-0000-7000-8000-000000000001",
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: ["task_018f4f5e-0000-7000-8000-000000000001"],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    store.putTask({
      taskId: "task_018f4f5e-0000-7000-8000-000000000001",
      revision: "1",
      parentTaskId: null,
      dependsOn: [],
      delegationSpec: {
        objective: "boundary refs",
        parentAcceptanceIds: ["A1"],
        childOutcome: "refs populated",
        terminationCondition: "checks pass",
        inputs: {
          specRevision: ref,
          planRevision: ref,
          taskRevisions: [],
          interfaceRevisions: [],
          baseSha: "f".repeat(40),
          prerequisites: [],
          sourceArtifactRefs: [],
        },
        boundaries: {
          allowedPaths: ["src/daemon"],
        },
        authority: {
          grantId: "grant_018f4f5e-0000-7000-8000-000000000001",
          permittedOperations: ["read", "write", "test"],
          environment: "worktree",
          worktree: "/worktree",
          branch: "hive/worker",
          explicitNonAuthority: ["land"],
        },
        allowance: {
          sessions: 1,
          tokens: 10_000,
          costCents: 100,
          wallTimeMs: 3_600_000,
          retries: 2,
          blockers: [],
          owner: {
            nodeId: "node_018f4f5e-0000-7000-8000-000000000001",
            agentId: "lead",
            generation: 1,
          },
        },
      },
      acceptanceIds: ["A1"],
      ownerNodeId: "node_018f4f5e-0000-7000-8000-000000000001",
      assigneeNodeId: "node_018f4f5e-0000-7000-8000-000000000002",
      pathLeases: [{ path: "src/daemon", mode: "write" }],
      branch: "hive/worker",
      baseSha: "f".repeat(40),
      state: "in-progress",
      blockers: [],
      evidence: [],
      artifactRefs: ["art_018f4f5e-0000-7000-8000-000000000003"],
    });
    store.putIntegrationStage(
      {
        stageId: "stage_018f4f5e-0000-7000-8000-000000000001",
        revision: "1",
        kind: "run",
        runId,
        ownerNodeId: null,
        daemonRef: "refs/hive/run-stage",
        baseSha: "f".repeat(40),
        headSha: "f".repeat(40),
        acceptedPromotionGrantIds: [],
        validation: { environment: "bun", evidenceArtifactRefs: [] },
        queueHighWater: 0,
        lifecycle: "active",
      } as never,
      null,
    );

    const decided = await request(daemon, token, "POST", "/run-control", {
      schemaVersion: 1,
      intentId: "intent-pause",
      expected: { kind: "revision-and-epoch", revision: "1", epoch: "0" },
      idempotencyKey: "key-pause",
      body: { operation: "run-pause", runId },
    });
    expect(decided.status).toEqual(200);
    expect((await decided.json()).outcome.status).toEqual("accepted");

    const row = daemon.db.database
      .query(
        "SELECT document FROM run_checkpoints WHERE instanceId = ? ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1",
      )
      .get((await successionProjection(daemon, token)).instanceId) as {
      document: string;
    } | null;
    expect(row).not.toBeNull();
    const checkpoint = JSON.parse(row?.document ?? "{}") as {
      reason: string;
      hierarchy: {
        runId: string;
        phase: string;
        tasks: Array<{ taskId: string; revision: string; digest: string }>;
        decisions: Array<{
          idempotencyKey: string;
          revision: string;
          digest: string;
        }>;
        promotionQueue: Array<{
          stageId: string;
          revision: string;
          digest: string;
        }>;
      } | null;
      artifacts: string[];
      written: unknown;
    };
    expect(checkpoint.reason).toEqual("run-control");
    expect(checkpoint.hierarchy?.runId).toEqual(runId);
    expect(checkpoint.hierarchy?.phase).toEqual("P1");
    expect(checkpoint.hierarchy).not.toHaveProperty("gates");
    // The refs the schema promises are really bound from the live records,
    // by identity and whole-record digest: the task, the stage, the artifact
    // ids — and the pause decision itself, by idempotency key and the run
    // revision it produced.
    expect(checkpoint.hierarchy?.tasks).toHaveLength(1);
    expect(checkpoint.hierarchy?.tasks[0]).toMatchObject({
      taskId: "task_018f4f5e-0000-7000-8000-000000000001",
      revision: "1",
    });
    expect(checkpoint.hierarchy?.tasks[0]?.digest).toMatch(/^sha256:/);
    expect(checkpoint.hierarchy?.promotionQueue).toHaveLength(1);
    expect(checkpoint.hierarchy?.promotionQueue[0]).toMatchObject({
      stageId: "stage_018f4f5e-0000-7000-8000-000000000001",
      revision: "1",
    });
    expect(checkpoint.hierarchy?.decisions).toHaveLength(1);
    expect(checkpoint.hierarchy?.decisions[0]?.idempotencyKey).toEqual(
      "key-pause",
    );
    expect(checkpoint.hierarchy?.decisions[0]?.revision).toEqual("2");
    expect(checkpoint.hierarchy?.decisions[0]?.digest).toMatch(/^sha256:/);
    expect(checkpoint.artifacts).toEqual([
      "art_018f4f5e-0000-7000-8000-000000000003",
    ]);
    expect(checkpoint.written).toBeNull();
    // The boundary checkpoint makes new work admissible again.
    expect(
      (await successionProjection(daemon, token)).latestCheckpoint?.digest,
    ).toMatch(/^sha256:/);
    await daemon.stop();
  });

  test("who is measured: a different valid queen credential's reads contribute nothing", async () => {
    const { daemon } = harness();
    const user = daemon.capabilities.mint("user", "user").token;
    const predecessor = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;
    const successor = daemon.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
    ).token;

    const began = await request(
      daemon,
      user,
      "POST",
      "/queen-succession/prepare-launch",
      {
        requestId: mintSessionRequestId(),
        provider: "claude",
        cwd: "/repo",
        reason: "root-exit-with-live-agents",
        reasonDetail: VALID_BEGIN.reasonDetail,
      },
    );
    const declaration = (await began.json()) as {
      succession: { successionId: string; priorRootGeneration: number };
    };
    const successionId = declaration.succession.successionId;
    const backupGeneration = expectedBackupGeneration(declaration);

    // The predecessor's credential reads both surfaces — validly, measurably.
    expect((await callTool(daemon, predecessor, "hive_status")).ok).toEqual(
      true,
    );
    expect(
      (
        await callTool(daemon, predecessor, "hive_mail_poll", {
          recipient: "queen",
        })
      ).ok,
    ).toEqual(true);
    // The successor attests: her own re-read was never measured.
    const premature = await callTool(
      daemon,
      successor,
      "hive_succession_attest",
      {
        successionId,
        generation: backupGeneration,
        checkpointDigest: null,
      },
    );
    expect(premature.ok).toEqual(false);
    expect(premature.error).toContain("missing status and inbox");
    expect(
      (await successionProjection(daemon, user)).succession?.state,
    ).toEqual("recovering");

    // Her own reads, under her own credential, are the only ones that count.
    expect((await callTool(daemon, successor, "hive_status")).ok).toEqual(true);
    expect(
      (
        await callTool(daemon, successor, "hive_mail_poll", {
          recipient: "queen",
        })
      ).ok,
    ).toEqual(true);
    expect((await callTool(daemon, successor, "hive_task_list")).ok).toEqual(
      true,
    );
    expect(
      (await callTool(daemon, successor, "hive_run_checkpoint_get", {})).ok,
    ).toEqual(true);
    expect(
      (
        await callTool(daemon, successor, "hive_succession_attest", {
          successionId,
          generation: backupGeneration,
          checkpointDigest: null,
        })
      ).ok,
    ).toEqual(true);
    expect(
      (await successionProjection(daemon, user)).succession?.state,
    ).toEqual("attested");
    await daemon.stop();
  });

  test("replies for a succession that is not open are a clean 409", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await request(
      daemon,
      token,
      "POST",
      "/queen-succession/replies",
      {
        successionId: "qsc_00000000-0000-7000-8000-000000000000",
        replies: [],
      },
    );
    expect(response.status).toEqual(409);
    await daemon.stop();
  });
});
