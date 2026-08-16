// Succession in-process: the store, the three convergence paths, the explicit
// attestation, admission control, and the compact/replace decision. The
// biting cases are the ones where honesty costs something: a corrupt
// checkpoint must be named, a stale one must show every divergence, unknown
// usage must refuse, an attestation that was never measured must be refused,
// and a bootstrap must come from the journal and measured replies — never
// the agent table.
import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { hiveInstanceSuffix } from "../../src/hive-home/instance-identity";
import { MailStore } from "../../src/mail-service/store";
import { ManifestJournal } from "../../src/daemon/manifest-journal";
import {
  admitWork,
  checkpointRequestKind,
  decideCompactOrReplace,
  SuccessionService,
  SuccessionStateError,
  SuccessionStore,
  snapshotDiscrepancies,
} from "../../src/daemon/queen-provider-service/succession";
import {
  SUCCESSION_REQUIRED_READS,
  successionRequiredReadInstruction,
} from "../../src/daemon/queen-provider-service/succession-recovery";
import type { AgentRecord } from "../../src/schemas/agent";
import type { GrantAction } from "../../src/schemas/hierarchy-node";
import {
  type AgentSnapshotEntry,
  type BeginSuccessionRequest,
  type RunCheckpointInput,
  BeginSuccessionResponseSchema,
  CheckpointDecisionRefSchema,
  CheckpointStageRefSchema,
  CheckpointTaskRefSchema,
  ContextUsageSchema,
  digestCheckpointContent,
  digestRunCheckpoint,
  QueenSuccessionProjectionSchema,
  QueenSuccessionSchema,
  RunCheckpointSchema,
} from "../../src/schemas/run-checkpoint";
import { digestWorkManifest } from "../../src/schemas/work-manifest";

const INSTANCE = hiveInstanceSuffix();
const T0 = "2026-07-31T00:00:00.000Z";
const T1 = "2026-07-31T01:00:00.000Z";

function harness(
  reason: "exit-with-live-agents" | "provider-change" = "exit-with-live-agents",
) {
  const db = new HiveDatabase(":memory:");
  const journal = new ManifestJournal(db);
  const clock = { now: T0 };
  const service = new SuccessionService({
    db,
    mail: new MailStore(db),
    journal,
    instanceId: INSTANCE,
    reasonSource: () => reason,
    now: () => new Date(clock.now),
  });
  return { db, journal, service, clock };
}

function snap(
  agentName: string,
  branch: string | null = `hive/${agentName}-work`,
): AgentSnapshotEntry {
  return {
    agentName,
    status: "working",
    branch,
    worktreePath: `/repo/.hive/worktrees/${agentName}`,
    lastEventAt: T0,
  };
}

function checkpointInput(
  overrides: Partial<RunCheckpointInput> = {},
): RunCheckpointInput {
  return {
    instanceId: INSTANCE,
    reason: "task-completion",
    hierarchy: null,
    pendingMessages: [],
    artifacts: [],
    unresolvedQuestions: [],
    contextUsage: {
      kind: "measured",
      residentTokens: 10_000,
      measuredAt: T0,
    },
    model: null,
    decision: {
      decision: "compact",
      reason: "healthy warm root; compact in place",
    },
    agentSnapshot: [snap("maya")],
    replies: [],
    written: {
      goal: "keep the run moving",
      done: ["admitted maya"],
      failures: [],
      uncertainty: [],
      nextAction: "review maya's result",
      rollback: "relaunch the prior root",
    },
    ...overrides,
  };
}

function beginRequest(
  overrides: Partial<BeginSuccessionRequest> = {},
): BeginSuccessionRequest {
  return {
    reasonDetail:
      "orchestrator exited with code 9 while 1 agent(s) remained active",
    priorRootGeneration: 0,
    snapshot: [snap("maya")],
    ...overrides,
  };
}

/** The successor's credential as the gate sees it, and another valid one. */
const SUCCESSOR = { id: "cap-successor" } as never;
const attester = "cap-successor";

/** The fresh root's measured re-read, driven through the same gate the MCP
 * layer calls. */
function readBack(service: SuccessionService, capability = SUCCESSOR): void {
  service.gateRootToolCall(capability, "hive_status");
  service.gateRootToolCall(capability, "hive_mail_poll");
  service.gateRootToolCall(capability, "hive_task_list");
  service.gateRootToolCall(capability, "hive_run_checkpoint_get");
}

/** The fresh root's attestation through the same credential the gate
 * recorded her re-reads under. */
function attestWith(
  service: SuccessionService,
  request: Parameters<SuccessionService["attest"]>[0],
  id = attester,
) {
  return service.attest(request, id);
}

function journalManifest(
  agentId: string,
  classification: "clean" | "stranded" | "unknown",
) {
  return {
    agentId,
    agentName: agentId.replace("agent-", ""),
    runId: null,
    nodeId: null,
    branch: `hive/${agentId}-work`,
    worktreePath: `/repo/.hive/worktrees/${agentId}`,
    dirtyFiles: classification === "clean" ? [] : ["src/server.ts"],
    unmergedCommits: classification === "clean" ? 0 : 2,
    lastStatus: "working",
    classification,
    classificationReason: `${classification} for the test`,
  };
}

describe("checkpoint provenance", () => {
  test("a checkpoint read selects latest or an exact revision without mutating storage", () => {
    const { service, db } = harness();
    const first = service.writeCheckpoint(checkpointInput());
    const second = service.writeCheckpoint(
      checkpointInput({ unresolvedQuestions: ["what changed?"] }),
    );
    const before = db.database
      .query(
        "SELECT COUNT(*) AS rows, MAX(CAST(revision AS INTEGER)) AS revision FROM run_checkpoints WHERE instanceId = ?",
      )
      .get(INSTANCE);

    expect(service.readCheckpoint()).toEqual({
      state: "present",
      digestVerified: true,
      checkpoint: second,
    });
    expect(service.readCheckpoint("1")).toEqual({
      state: "present",
      digestVerified: true,
      checkpoint: first,
    });
    expect(service.readCheckpoint("999")).toEqual({
      state: "absent",
      revision: "999",
    });
    expect(
      db.database
        .query(
          "SELECT COUNT(*) AS rows, MAX(CAST(revision AS INTEGER)) AS revision FROM run_checkpoints WHERE instanceId = ?",
        )
        .get(INSTANCE),
    ).toEqual(before);
    db.close();
  });

  test("a checkpoint whose digest no longer verifies is an explicit mismatch", () => {
    const { service, db } = harness();
    const checkpoint = service.writeCheckpoint(checkpointInput());
    const row = db.database
      .query(
        "SELECT document FROM run_checkpoints WHERE instanceId = ? AND revision = '1'",
      )
      .get(INSTANCE) as { document: string };
    const tampered = JSON.parse(row.document) as {
      unresolvedQuestions: string[];
    };
    tampered.unresolvedQuestions = ["tampered"];
    db.database
      .query(
        "UPDATE run_checkpoints SET document = ? WHERE instanceId = ? AND revision = '1'",
      )
      .run(JSON.stringify(tampered), INSTANCE);

    expect(service.readCheckpoint("1")).toEqual({
      state: "digest-mismatch",
      revision: checkpoint.revision,
      storedDigest: checkpoint.digest,
      detail: "checkpoint digest does not match its content",
    });
    db.close();
  });

  test("revision, creation time, and digest are assigned at creation and immutable after", () => {
    const { service, db } = harness();
    const first = service.writeCheckpoint(checkpointInput());
    const second = service.writeCheckpoint(checkpointInput());
    expect(first.revision).toEqual("1");
    expect(second.revision).toEqual("2");
    expect(first.createdAt).toEqual(T0);
    expect(first.digest).toMatch(/^sha256:/);
    expect(second.digest).not.toEqual(first.digest);
    expect(RunCheckpointSchema.parse(first)).toEqual(first);
    const { digest, ...unsigned } = second;
    expect(digestRunCheckpoint(unsigned)).toEqual(digest);
    db.close();
  });

  test.each(["graceful-shutdown", "owner-ruling"] as const)(
    "%s round-trips through the checkpoint schema and store",
    (reason) => {
      const { service, db } = harness();
      const checkpoint = service.writeCheckpoint(checkpointInput({ reason }));
      expect(
        RunCheckpointSchema.parse(JSON.parse(JSON.stringify(checkpoint)))
          .reason,
      ).toBe(reason);
      expect(service.readCheckpoint(checkpoint.revision)).toEqual({
        state: "present",
        digestVerified: true,
        checkpoint,
      });
      db.close();
    },
  );

  test("the real write path refuses a caller-supplied spine: revision, digest, createdAt", () => {
    const { service, db } = harness();
    for (const spine of [
      { revision: "999" },
      { digest: `sha256:${"0".repeat(64)}` },
      { createdAt: "2099-01-01T00:00:00.000Z" },
    ]) {
      expect(() =>
        service.writeCheckpoint({
          ...checkpointInput(),
          ...spine,
        } as RunCheckpointInput),
      ).toThrow();
    }
    // Positive control: the untampered input writes.
    expect(service.writeCheckpoint(checkpointInput()).revision).toEqual("1");
    db.close();
  });

  test("a tampered checkpoint fails verification as corrupt, with the detail saying how", () => {
    const { service, db } = harness();
    service.writeCheckpoint(checkpointInput());
    const row = db.database
      .query(
        "SELECT document FROM run_checkpoints WHERE instanceId = ? AND revision = '1'",
      )
      .get(INSTANCE) as { document: string };
    const tampered = JSON.parse(row.document) as { agentSnapshot: unknown[] };
    tampered.agentSnapshot = [];
    db.database
      .query(
        "UPDATE run_checkpoints SET document = ? WHERE instanceId = ? AND revision = '1'",
      )
      .run(JSON.stringify(tampered), INSTANCE);

    const load = new SuccessionStore(db).loadLatestCheckpoint(INSTANCE);
    expect(load.kind).toEqual("corrupt");
    if (load.kind === "corrupt") {
      expect(load.detail).toContain("digest verification");
    }
    db.close();
  });
});

describe("succession convergence", () => {
  test("a valid checkpoint: proof binds the ref, and only the explicit attestation completes it", () => {
    const { service, db } = harness();
    const checkpoint = service.writeCheckpoint(checkpointInput());

    const response = service.begin(beginRequest());
    expect(BeginSuccessionResponseSchema.parse(response)).toEqual(response);
    const { succession } = response;
    expect(QueenSuccessionSchema.parse(succession)).toEqual(succession);
    expect(succession.revision).toEqual("1");
    expect(succession.proof).toEqual({
      kind: "checkpoint",
      ref: { revision: "1", digest: checkpoint.digest },
    });
    expect(succession.discrepancies).toEqual([]);
    expect(succession.attestation).toBeNull();
    expect(response.bootstrap).toEqual([]);

    // A wrong digest is refused, and the refusal completes nothing.
    readBack(service);
    expect(() =>
      attestWith(service, {
        successionId: succession.successionId,
        generation: 1,
        checkpointDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow(SuccessionStateError);
    expect(service.projection().succession?.state).toEqual("recovering");

    const attested = attestWith(service, {
      successionId: succession.successionId,
      generation: 1,
      checkpointDigest: checkpoint.digest,
    });
    expect(attested.attestation?.checkpointDigest).toEqual(checkpoint.digest);
    expect(attested.newRootGeneration).toEqual(1);

    const projection = service.projection(new Date(T1));
    expect(QueenSuccessionProjectionSchema.parse(projection)).toEqual(
      projection,
    );
    expect(projection.succession?.state).toEqual("attested");
    expect(projection.contradictions).toEqual([]);
    expect(projection.latestCheckpoint).toEqual({
      revision: "1",
      digest: checkpoint.digest,
    });
    db.close();
  });

  test("a corrupt checkpoint: converges on no-checkpoint with the contradiction visible after attestation", () => {
    const { service, db } = harness();
    service.writeCheckpoint(checkpointInput());
    db.database
      .query(
        "UPDATE run_checkpoints SET document = ? WHERE instanceId = ? AND revision = '1'",
      )
      .run("{not json", INSTANCE);

    const { succession } = service.begin(beginRequest());
    expect(succession.proof.kind).toEqual("no-checkpoint");
    if (succession.proof.kind === "no-checkpoint") {
      expect(succession.proof.detail).toContain("not readable JSON");
    }
    expect(succession.discrepancies).toHaveLength(1);

    // Against a no-checkpoint proof, only a null digest attests.
    readBack(service);
    expect(() =>
      attestWith(service, {
        successionId: succession.successionId,
        generation: 1,
        checkpointDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).toThrow(/no-checkpoint proof/);
    const attested = attestWith(service, {
      successionId: succession.successionId,
      generation: 1,
      checkpointDigest: null,
    });
    expect(attested.attestation?.checkpointDigest).toBeNull();

    const projection = service.projection();
    expect(projection.succession?.state).toEqual("attested");
    expect(projection.contradictions).toEqual(succession.discrepancies);
    expect(projection.latestCheckpoint).toBeNull();
    db.close();
  });

  test("a stale checkpoint: every divergence is named and stays visible", () => {
    const { service, db } = harness();
    service.writeCheckpoint(
      checkpointInput({
        agentSnapshot: [snap("maya", "hive/maya-old"), snap("goner")],
      }),
    );

    const { succession } = service.begin(
      beginRequest({
        snapshot: [snap("maya", "hive/maya-new"), snap("rookie")],
      }),
    );
    expect(succession.proof.kind).toEqual("checkpoint");
    expect(succession.discrepancies).toEqual([
      "agent maya moved branch: checkpoint recorded hive/maya-old, measured hive/maya-new",
      "checkpoint names agent goner (working) but no live agent answers to that name",
      "live agent rookie is absent from the checkpoint",
    ]);

    readBack(service);
    attestWith(service, {
      successionId: succession.successionId,
      generation: 1,
      checkpointDigest:
        succession.proof.kind === "checkpoint"
          ? succession.proof.ref.digest
          : null,
    });
    expect(service.projection().contradictions).toHaveLength(3);
    db.close();
  });

  test("no checkpoint: bootstrap reads the journal and measured replies, never the agent table alone", () => {
    const { service, journal, db } = harness();
    db.insertAgent({
      id: "agent-ghost",
      name: "ghost",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "complex_coding",
      status: "working",
      taskDescription: "row without a journal entry",
      worktreePath: "/repo/.hive/worktrees/ghost",
      branch: "hive/ghost-work",
      contextPct: null,
      createdAt: T0,
      lastEventAt: T0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } as AgentRecord);
    const stranded = journal.append(journalManifest("agent-maya", "stranded"));
    journal.append(journalManifest("agent-clean", "clean"));
    const unknown = journal.append(journalManifest("agent-oliver", "unknown"));

    const { succession, bootstrap } = service.begin(beginRequest());
    expect(succession.proof).toEqual({
      kind: "no-checkpoint",
      detail: "no checkpoint has been written for this instance",
    });
    expect(
      bootstrap.map((entry) => [
        entry.agentName,
        entry.classification,
        entry.workManifest.revision,
        entry.workManifest.digest,
      ]),
    ).toEqual([
      ["maya", "stranded", "1", stranded.digest],
      ["oliver", "unknown", "1", unknown.digest],
    ]);
    expect(bootstrap[0]?.workManifest.digest).toEqual(
      digestWorkManifest(journalManifest("agent-maya", "stranded")),
    );

    // The successor attests, then writes her first checkpoint — the
    // bootstrap that makes new work admissible again.
    readBack(service);
    attestWith(service, {
      successionId: succession.successionId,
      generation: 1,
      checkpointDigest: null,
    });
    const first = service.writeRootCheckpoint({
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
        uncertainty: ["maya's actual progress"],
        nextAction: "reconcile with maya",
        rollback: "relaunch the prior root",
      },
      unresolvedQuestions: [],
      model: null,
    });
    expect(first.revision).toEqual("1");
    expect(service.admitNewWork().admit).toEqual(true);
    db.close();
  });

  test("the daemon assigns the reason; the caller cannot", () => {
    const pending = harness("provider-change");
    const { succession } = pending.service.begin(beginRequest());
    expect(succession.reason).toEqual("provider-change");
    pending.db.close();
  });

  test("an open succession's contradictions survive a newer declaration", () => {
    const { service, db } = harness();
    db.database
      .query(
        "INSERT INTO run_checkpoints (instanceId, revision, recordedAt, document) VALUES (?, '1', ?, ?)",
      )
      .run(INSTANCE, T0, "{corrupt");
    const first = service.begin(beginRequest());
    expect(first.succession.discrepancies).toHaveLength(1);

    service.writeCheckpoint(checkpointInput());
    const second = service.begin(
      beginRequest({
        snapshot: [snap("maya", "hive/maya-moved")],
        priorRootGeneration: 1,
      }),
    );
    expect(second.succession.revision).toEqual("2");

    const projection = service.projection();
    expect(projection.contradictions).toEqual([
      ...first.succession.discrepancies,
      ...second.succession.discrepancies,
    ]);
    expect(projection.succession?.state).toEqual("recovering");
    db.close();
  });
});

describe("the explicit attestation", () => {
  test("one canonical recovery list drives all four required reads", () => {
    expect(SUCCESSION_REQUIRED_READS).toEqual([
      { tool: "hive_status", proof: "status" },
      { tool: "hive_mail_poll", proof: "inbox" },
      { tool: "hive_task_list", proof: "board" },
      { tool: "hive_run_checkpoint_get", proof: "checkpoint" },
    ]);
    expect(successionRequiredReadInstruction()).toBe(
      "hive_status, hive_mail_poll, hive_task_list, and hive_run_checkpoint_get",
    );
  });

  function openSuccession() {
    const { service, db } = harness();
    const checkpoint = service.writeCheckpoint(checkpointInput());
    const { succession } = service.begin(beginRequest());
    return { service, db, checkpoint, succession };
  }

  test("every validation refuses independently: no open succession, wrong id, wrong generation, wrong digest, unmeasured re-read", () => {
    const { service, db, checkpoint, succession } = openSuccession();
    // Durable root is empty in this harness → prior 0 → backup generation 1.
    expect(succession.priorRootGeneration).toEqual(0);
    const expectedGeneration = succession.priorRootGeneration + 1;
    const attempt = (overrides: Record<string, unknown>) =>
      attestWith(service, {
        successionId: succession.successionId,
        generation: expectedGeneration,
        checkpointDigest: checkpoint.digest,
        ...overrides,
      } as never);

    // The re-read was never measured: the first refusal names it.
    expect(() => attempt({})).toThrow(/re-read is not measured/);
    expect(() =>
      attempt({ successionId: "qsc_00000000-0000-7000-8000-000000000000" }),
    ).toThrow(/not the open succession/);
    // Wrong generation refuses against the durable prior, not a process-local
    // claim the supervisor invents.
    expect(() => attempt({ generation: 7 })).toThrow(
      new RegExp(`expects ${expectedGeneration}`),
    );
    expect(() =>
      attempt({ checkpointDigest: `sha256:${"0".repeat(64)}` }),
    ).toThrow(/daemon verified/);
    service.gateRootToolCall(SUCCESSOR, "hive_status");
    expect(() => attempt({})).toThrow(/missing inbox/);
    service.gateRootToolCall(SUCCESSOR, "hive_mail_poll");
    service.gateRootToolCall(SUCCESSOR, "hive_task_list");
    service.gateRootToolCall(SUCCESSOR, "hive_run_checkpoint_get");
    expect(attempt({}).attestation?.checkpointDigest).toEqual(
      checkpoint.digest,
    );
    // Once attested, nothing is open.
    expect(() => attempt({})).toThrow(/no succession is open/);
    db.close();
  });

  test("begin stores the durable root generation, not the request claim", () => {
    const { service, db } = harness();
    // Plant a durable root binding at generation 4.
    db.bindTerminalHostSession({
      locator: {
        schemaVersion: 1,
        instanceId: INSTANCE,
        subject: { kind: "root" },
        generation: 4,
        sessionId: "ses_018f4f5e-0000-7000-8000-000000000099",
        hostKind: "sessiond",
        engineBuildId: "test-build",
      },
      visibility: {
        workspaceSessionId: "workspace-succession",
        workspacePid: 4100,
        workspaceStartToken: "4100:1",
        openTerminalRevision: "1",
      },
    });
    expect(service.durableRootGeneration()).toEqual(4);

    const checkpoint = service.writeCheckpoint(checkpointInput());
    const declared = service.begin(
      beginRequest({ priorRootGeneration: 0 /* lying process-local claim */ }),
    );
    expect(declared.succession.priorRootGeneration).toEqual(4);
    // Attest expects 5; a process-local "1" refuses against the durable prior.
    readBack(service);
    expect(() =>
      attestWith(service, {
        successionId: declared.succession.successionId,
        generation: 1,
        checkpointDigest: checkpoint.digest,
      }),
    ).toThrow(/expects 5/);
    expect(
      attestWith(service, {
        successionId: declared.succession.successionId,
        generation: 5,
        checkpointDigest: checkpoint.digest,
      }).newRootGeneration,
    ).toEqual(5);
    db.close();
  });

  test("who is measured: a different valid queen credential's reads contribute nothing", () => {
    const { service, db, checkpoint, succession } = openSuccession();
    const predecessor = { id: "cap-predecessor" } as never;
    // The predecessor's credential reads both surfaces — validly, measurably.
    readBack(service, predecessor);
    // The successor attests: her OWN re-read was never measured, so every
    // refusal names the missing reads, and nothing completes.
    expect(() =>
      attestWith(
        service,
        {
          successionId: succession.successionId,
          generation: 1,
          checkpointDigest: checkpoint.digest,
        },
        attester,
      ),
    ).toThrow(/missing status and inbox/);
    expect(service.projection().succession?.state).toEqual("recovering");
    // Her own reads, under her own credential, are the only ones that count.
    readBack(service);
    expect(
      attestWith(service, {
        successionId: succession.successionId,
        generation: 1,
        checkpointDigest: checkpoint.digest,
      }).attestation?.checkpointDigest,
    ).toEqual(checkpoint.digest);
    db.close();
  });

  test("while a succession is open the root's authority is gated to the recovery tools", () => {
    const { service, db, checkpoint, succession } = openSuccession();
    for (const gated of [
      "hive_spawn",
      "hive_spawn_many",
      "hive_land",
      "hive_run_checkpoint",
      "hive_kill",
      "memory_write",
    ]) {
      expect(() => service.gateRootToolCall(SUCCESSOR, gated)).toThrow(
        /awaits attestation/,
      );
    }
    for (const allowed of [
      "hive_status",
      "hive_mail_poll",
      "hive_mail_claim",
      "hive_mail_complete",
      "hive_mail_status",
      "hive_mail_publish",
      "hive_task_list",
      "hive_run_checkpoint_get",
      "hive_succession_attest",
    ]) {
      expect(() => service.gateRootToolCall(SUCCESSOR, allowed)).not.toThrow();
    }
    // The reads above were measured; attesting lifts the gate.
    attestWith(service, {
      successionId: succession.successionId,
      generation: 1,
      checkpointDigest: checkpoint.digest,
    });
    expect(() =>
      service.gateRootToolCall(SUCCESSOR, "hive_spawn"),
    ).not.toThrow();
    db.close();
  });

  test("the measured replies land on the open succession and nowhere else", () => {
    const { service, db, checkpoint, succession } = openSuccession();
    const updated = service.recordRecoveryReplies({
      successionId: succession.successionId,
      replies: [
        { agentName: "maya", confirmed: true },
        { agentName: "noah", confirmed: false },
      ],
    });
    expect(updated.replies).toEqual([
      { agentName: "maya", confirmed: true },
      { agentName: "noah", confirmed: false },
    ]);
    expect(() =>
      service.recordRecoveryReplies({
        successionId: "qsc_00000000-0000-7000-8000-000000000000",
        replies: [],
      }),
    ).toThrow(/no open succession/);

    readBack(service);
    attestWith(service, {
      successionId: succession.successionId,
      generation: 1,
      checkpointDigest: checkpoint.digest,
    });
    expect(() =>
      service.recordRecoveryReplies({
        successionId: succession.successionId,
        replies: [],
      }),
    ).toThrow(/no open succession/);
    db.close();
  });
});

describe("checkpoint content", () => {
  test("a populated store produces populated refs: tasks, stage, and artifacts are bound, not emptied", () => {
    const { service, db } = harness();
    const store = new HierarchyStore(db);
    const runId = "run_018f4f5e-0000-7000-8000-000000000001";
    const ref = { revision: "1", digest: `sha256:${"a".repeat(64)}` };
    const run = {
      runId,
      revision: "1",
      repo: "hive",
      instanceId: INSTANCE,
      spec: ref,
      currentPlan: ref,
      topology: ref,
      phase: "P1" as const,
      g2: { state: "pending" as const },
      baseSha: "b".repeat(40),
      budget: ref,
      runEpoch: 0,
      lifecycle: "active" as const,
    };
    store.putRun(run, null);
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
    const task = {
      taskId: "task_018f4f5e-0000-7000-8000-000000000001",
      revision: "1",
      parentTaskId: null,
      dependsOn: [],
      delegationSpec: {
        objective: "prove the refs",
        parentAcceptanceIds: ["A1"],
        childOutcome: "refs are populated",
        terminationCondition: "checks pass",
        inputs: {
          specRevision: ref,
          planRevision: ref,
          taskRevisions: [],
          interfaceRevisions: [],
          baseSha: "b".repeat(40),
          prerequisites: [],
          sourceArtifactRefs: [],
        },
        boundaries: {
          allowedPaths: ["src/daemon"],
        },
        authority: {
          grantId: "grant_018f4f5e-0000-7000-8000-000000000001",
          permittedOperations: ["read", "write", "test"] as GrantAction[],
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
      pathLeases: [{ path: "src/daemon", mode: "write" as const }],
      branch: "hive/worker",
      baseSha: "b".repeat(40),
      state: "in-progress" as const,
      blockers: [],
      evidence: ["art_018f4f5e-0000-7000-8000-000000000009"],
      artifactRefs: ["art_018f4f5e-0000-7000-8000-000000000003"],
    };
    store.putTask(task);
    store.putIntegrationStage(
      {
        stageId: "stage_018f4f5e-0000-7000-8000-000000000001",
        revision: "1",
        kind: "run",
        runId,
        ownerNodeId: null,
        daemonRef: "refs/hive/run-stage",
        baseSha: "b".repeat(40),
        headSha: "b".repeat(40),
        acceptedPromotionGrantIds: [],
        validation: { environment: "bun", evidenceArtifactRefs: [] },
        queueHighWater: 0,
        lifecycle: "active",
      } as never,
      null,
    );
    // An accepted run-control decision, written through the store's own put.
    const decision = {
      idempotencyKey: "key-pause",
      intentDigest: `sha256:${"d".repeat(64)}`,
      result: {
        schemaVersion: 1 as const,
        intentId: "intent-pause",
        operationId: "op_018f4f5e-0000-7000-8000-000000000001",
        postStateToken: {
          kind: "revision-and-epoch" as const,
          revision: "2",
          epoch: "1",
        },
        outcome: { status: "accepted" as const },
        observedPostState: {
          ...run,
          revision: "2",
          runEpoch: 1,
          lifecycle: "paused" as const,
        },
      },
    };
    store.putRunControlDecision(runId, decision);
    const checkpoint = service.writeBoundaryCheckpoint("gate-transition", run);
    expect(checkpoint.hierarchy?.runId).toEqual(runId);
    expect(checkpoint.hierarchy?.tasks).toEqual([
      {
        taskId: "task_018f4f5e-0000-7000-8000-000000000001",
        revision: "1",
        digest: digestCheckpointContent(task),
      },
    ]);
    expect(checkpoint.hierarchy?.decisions).toEqual([
      {
        idempotencyKey: "key-pause",
        revision: "2",
        digest: digestCheckpointContent(decision),
      },
    ]);
    const storedStage = store.getIntegrationStage(
      "stage_018f4f5e-0000-7000-8000-000000000001",
    );
    expect(storedStage).not.toBeNull();
    expect(checkpoint.hierarchy?.promotionQueue).toEqual([
      {
        stageId: "stage_018f4f5e-0000-7000-8000-000000000001",
        revision: "1",
        digest: digestCheckpointContent(storedStage),
      },
    ]);
    expect(checkpoint.artifacts.sort()).toEqual([
      "art_018f4f5e-0000-7000-8000-000000000003",
      "art_018f4f5e-0000-7000-8000-000000000009",
    ]);
    // The task ref's digest recomputes over the stored record: drift would
    // change it.
    const stored = store.getTask(task.taskId);
    expect(stored).not.toBeNull();
    expect(checkpoint.hierarchy?.tasks[0]?.digest).toEqual(
      digestCheckpointContent(stored),
    );
    db.close();
  });

  test("no run and no records means measured-empty, not unfilled", () => {
    const { service, db } = harness();
    const checkpoint = service.writeBoundaryCheckpoint("run-control", null);
    expect(checkpoint.hierarchy).toBeNull();
    expect(checkpoint.artifacts).toEqual([]);
    db.close();
  });

  test("a ref without its record's identity is refused at the door, for every kind", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    // Positive control first: with the identity, each ref parses.
    expect(
      CheckpointTaskRefSchema.safeParse({
        taskId: "task_018f4f5e-0000-7000-8000-000000000001",
        revision: "1",
        digest,
      }).success,
    ).toEqual(true);
    for (const schema of [
      CheckpointTaskRefSchema,
      CheckpointDecisionRefSchema,
      CheckpointStageRefSchema,
    ]) {
      // Bare {revision, digest} — the old identity-less shape — never parses.
      expect(schema.safeParse({ revision: "1", digest }).success).toEqual(
        false,
      );
    }
  });

  test("a drifted decision result changes the bound digest", () => {
    const { db } = harness();
    const decision = {
      idempotencyKey: "key-pause",
      intentDigest: `sha256:${"d".repeat(64)}`,
      result: {
        schemaVersion: 1 as const,
        intentId: "intent-pause",
        operationId: "op_018f4f5e-0000-7000-8000-000000000001",
        postStateToken: {
          kind: "revision-and-epoch" as const,
          revision: "2",
          epoch: "1",
        },
        outcome: { status: "accepted" as const },
        observedPostState: { revision: "2" },
      },
    };
    const bound = digestCheckpointContent(decision);
    // Only the recorded outcome drifts — the intent bytes are untouched.
    const drifted = {
      ...decision,
      result: { ...decision.result, outcome: { status: "rejected" } },
    };
    expect(digestCheckpointContent(drifted)).not.toEqual(bound);
    // And the whole-record digest recomputes identically for identical content.
    expect(digestCheckpointContent(structuredClone(decision))).toEqual(bound);
    db.close();
  });
});

describe("admission control", () => {
  test("unknown usage refuses without a checkpoint and admits with one", () => {
    const usage = { kind: "unknown" as const, reason: "no measurement" };
    const refused = admitWork({ usage, checkpointed: false });
    expect(refused.admit).toEqual(false);
    if (!refused.admit) {
      expect(refused.reason).toContain(
        "Fix: hive_run_checkpoint at a semantic boundary, then retry",
      );
    }
    expect(admitWork({ usage, checkpointed: true }).admit).toEqual(true);
    // Absent is unknown, never zero: the door refuses missing keys, and the
    // positive control proves the reader can see a real measured zero.
    expect(ContextUsageSchema.safeParse({}).success).toEqual(false);
    expect(ContextUsageSchema.safeParse(undefined).success).toEqual(false);
    expect(
      ContextUsageSchema.safeParse({
        kind: "measured",
        residentTokens: 0,
        measuredAt: T0,
      }).success,
    ).toEqual(true);
  });

  test("measured usage admits only when resident + control work + reserve fits the ceiling", () => {
    const base = {
      checkpointed: true,
      remainingControlWorkTokens: 5_000,
      handoffReserveTokens: 20_000,
      absoluteResidentTokenCeiling: 200_000,
    };
    const usage = {
      kind: "measured" as const,
      residentTokens: 175_000,
      measuredAt: T0,
    };
    expect(admitWork({ ...base, usage }).admit).toEqual(true);
    const over = admitWork({
      ...base,
      usage: { ...usage, residentTokens: 175_001 },
    });
    expect(over.admit).toEqual(false);
    if (!over.admit) {
      expect(over.reason).toContain("200001");
      expect(over.reason).toContain("200000");
      expect(over.reason).toContain(
        "Fix: hive_run_checkpoint at a semantic boundary, then retry",
      );
    }
  });

  test("the root's admission gate reads the checkpoint table, not a claim", () => {
    const { service, db } = harness();
    // No checkpoint: the gate refuses, and the refusal names the remedy.
    const refused = service.admitNewWork();
    expect(refused.admit).toEqual(false);
    if (!refused.admit) {
      expect(refused.reason).toContain("unknown");
      expect(refused.reason).toContain("required");
      expect(refused.reason).toContain(
        "Fix: hive_run_checkpoint at a semantic boundary, then retry",
      );
    }
    service.writeCheckpoint(checkpointInput());
    expect(service.admitNewWork().admit).toEqual(true);
    db.close();
  });
});

describe("semantic checkpoint requests", () => {
  test("required exactly for repeated failure, provider compaction, and unknown context", () => {
    const expected: Array<
      [Parameters<typeof checkpointRequestKind>[0], "requested" | "required"]
    > = [
      ["task-completion", "requested"],
      ["gate-transition", "requested"],
      ["run-control", "requested"],
      ["promotion-boundary", "requested"],
      ["repeated-failure", "required"],
      ["provider-compaction", "required"],
      ["unknown-context", "required"],
    ];
    for (const [event, kind] of expected) {
      expect([event, checkpointRequestKind(event)]).toEqual([event, kind]);
    }
  });
});

describe("compact versus replace", () => {
  const healthy = {
    warm: true,
    repeatedSameSubgoalFailure: false,
    ceilingReached: false,
    externalEvent: null,
  } as const;

  test("a healthy warm root compacts in place", () => {
    expect(decideCompactOrReplace(healthy).decision).toEqual("compact");
  });

  test("each replacement trigger independently forces a fresh root", () => {
    const triggers = [
      { ...healthy, repeatedSameSubgoalFailure: true },
      { ...healthy, warm: false },
      { ...healthy, ceilingReached: true },
      { ...healthy, externalEvent: "crash" as const },
      { ...healthy, externalEvent: "provider" as const },
      { ...healthy, externalEvent: "user" as const },
    ];
    for (const trigger of triggers) {
      expect(decideCompactOrReplace(trigger).decision).toEqual("replace");
    }
  });
});

describe("snapshot staleness comparison", () => {
  test("an identical snapshot names no discrepancies", () => {
    const { service, db } = harness();
    const checkpoint = service.writeCheckpoint(checkpointInput());
    expect(snapshotDiscrepancies(checkpoint, [snap("maya")])).toEqual([]);
    db.close();
  });
});
