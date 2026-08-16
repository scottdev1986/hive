// The assembler half of the hierarchy rail: what StatusStore reads out of the
// database and hands to the projector.
//
// The projector's own tests prove what a record projects to. These prove the
// records reach it: every field the projection can render is fed from a store
// read, so a field that says "nothing supplied this" is never covering for a
// record that was sitting in the database the whole time.

import { afterEach, describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { ManifestJournal } from "../../src/daemon/manifest-journal";
import { StatusStore } from "../../src/daemon/status/status-store";
import { UNSUPPLIED_SOURCE_DETAILS } from "../../src/daemon/status-service/status-hierarchy-projection";
import type {
  AgentBinding,
  AgentBindingRef,
  DelegationSpec,
} from "../../src/schemas/hierarchy-node";
import {
  HIERARCHY_ENTITY_KINDS,
  HierarchyIncidentProjectionSchema,
  HierarchyNodeProjectionSchema,
  HierarchyReviewProjectionSchema,
  HierarchyStrandedManifestProjectionSchema,
  HierarchyTaskProjectionSchema,
} from "../../src/schemas/hierarchy-projection";
import type { Run } from "../../src/schemas/hierarchy-run";
import type {
  IntegrationStage,
  Review,
} from "../../src/schemas/integration-stage";
import type { RunControlDecision } from "../../src/schemas/run-control";
import type { TaskDetail } from "../../src/schemas/task-detail";
import type { WorkManifest } from "../../src/schemas/work-manifest";
import { required } from "../required";

const now = "2026-07-31T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const instanceId = "instance-assembly-test";
const runId = "run_019fb7c0-0000-7000-8000-000000000001";
const taskId = "task_019fb7c0-0000-7000-8000-000000000002";
const authorNodeId = "node_019fb7c0-0000-7000-8000-000000000003";
const reviewerNodeId = "node_019fb7c0-0000-7000-8000-000000000004";
const stageId = "stage_019fb7c0-0000-7000-8000-000000000005";
const reviewId = "review_019fb7c0-0000-7000-8000-000000000006";
const artifactId = "art_019fb7c0-0000-7000-8000-000000000008";
const grantId = "grant_019fb7c0-0000-7000-8000-000000000009";
const ref = { revision: "1", digest };

const authorRef: AgentBindingRef = {
  nodeId: authorNodeId,
  agentId: "author-agent",
  generation: 1,
};
const reviewerRef: AgentBindingRef = {
  nodeId: reviewerNodeId,
  agentId: "reviewer-agent",
  generation: 1,
};

const databases: HiveDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function run(): Run {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId,
    spec: ref,
    currentPlan: ref,
    topology: ref,
    phase: "P2",
    baseSha: gitSha,
    budget: ref,
    runEpoch: 0,
    lifecycle: "active",
  };
}

function binding(bound: AgentBindingRef): AgentBinding {
  return {
    ...bound,
    provider: "codex",
    model: "gpt-5",
    sessionLocator: {
      schemaVersion: 1,
      instanceId,
      subject: { kind: "agent", agentId: bound.agentId },
      generation: bound.generation,
      sessionId: `ses_019fb7c0-0000-7000-8000-00000000001${bound.generation}`,
      hostKind: "sessiond",
      engineBuildId: "test-build",
    },
    worktree: `/worktrees/${bound.agentId}`,
    branch: `hive/${bound.agentId}`,
    baseSha: gitSha,
    credentialId: `credential-${bound.agentId}`,
    boundAt: now,
    unboundAt: null,
  };
}

const delegationSpec: DelegationSpec = {
  objective: "Produce one validated candidate",
  parentAcceptanceIds: ["assembled"],
  childOutcome: "One reviewed commit",
  terminationCondition: "Review accepted",
  inputs: {
    specRevision: ref,
    planRevision: ref,
    taskRevisions: [{ taskId, revision: "1" }],
    interfaceRevisions: [],
    baseSha: gitSha,
    prerequisites: [],
    sourceArtifactRefs: [],
  },
  boundaries: {
    allowedPaths: ["src"],
  },
  authority: {
    grantId,
    permittedOperations: ["message"],
    environment: "worktree",
    worktree: "/worktrees/author-agent",
    branch: "hive/author-agent",
    explicitNonAuthority: ["promote"],
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
};

function task(): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec,
    acceptanceIds: ["assembled"],
    ownerNodeId: authorNodeId,
    assigneeNodeId: authorNodeId,
    pathLeases: [],
    branch: "hive/author-agent",
    baseSha: gitSha,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
  };
}

function stage(): IntegrationStage {
  return {
    stageId,
    revision: "1",
    kind: "run",
    runId,
    ownerNodeId: null,
    daemonRef: "refs/hive/run-stage",
    baseSha: gitSha,
    headSha: gitSha,
    acceptedPromotionGrantIds: [],
    validation: { environment: "bun", evidenceArtifactRefs: [artifactId] },
    queueHighWater: 0,
    lifecycle: "active",
  };
}

function review(): Review {
  return {
    reviewId,
    revision: "1",
    reviewer: reviewerRef,
    authors: [authorRef],
    candidate: {
      commitSha: candidateSha,
      patchDigest: digest,
      baseSha: gitSha,
    },
    revisions: {
      spec: ref,
      task: { taskId, revision: "1" },
      contracts: [],
    },
    environment: { toolchain: "bun", environment: "test" },
    findings: [],
    verdict: "accepted",
    evidenceArtifactRefs: [artifactId],
    invalidation: { state: "current" },
  };
}

function runControlDecision(): RunControlDecision {
  return {
    idempotencyKey: "run-pause-once",
    intentDigest: digest,
    result: {
      schemaVersion: 1,
      intentId: "intent-run-pause",
      operationId: "operation-run-pause",
      postStateToken: { kind: "revision-and-epoch", revision: "1", epoch: "0" },
      outcome: { status: "accepted" },
      observedPostState: run(),
    },
  };
}

const strandedManifest: WorkManifest = {
  agentId: "author-agent",
  agentName: "author",
  runId,
  nodeId: authorNodeId,
  branch: "hive/author-agent",
  worktreePath: "/worktrees/author-agent",
  dirtyFiles: ["src/server.ts"],
  unmergedCommits: 2,
  lastStatus: "working",
  classification: "stranded",
  classificationReason: "2 unmerged commit(s) and 1 dirty file(s) not on HEAD",
};

/** A run with one of every record the hierarchy rail reads. */
function seed(db: HiveDatabase): void {
  const store = new HierarchyStore(db);
  store.putRun(run(), null);
  // One root per run: the reviewer hangs under the author rather than
  // standing up a second null-parent node.
  for (const nodeId of [authorNodeId, reviewerNodeId]) {
    store.putNode(
      {
        nodeId,
        runId,
        parentNodeId: nodeId === authorNodeId ? null : authorNodeId,
        ownerNodeId: null,
        organizationalRole: "worker",
        assignmentKind: nodeId === authorNodeId ? "author" : "reviewer",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
  }
  store.putAgentBinding(binding(authorRef), runId);
  store.putAgentBinding(binding(reviewerRef), runId);
  store.putTask(task());
  store.putIntegrationStage(stage(), null);
  store.putReview(review(), runId);
  store.putRunControlDecision(runId, runControlDecision());
  new ManifestJournal(db).append(strandedManifest);
}

function entityOf(
  snapshot: { entities: readonly { kind: string }[] },
  kind: string,
) {
  return required(snapshot.entities.find((entity) => entity.kind === kind)) as {
    kind: string;
    id: string;
    projection: Record<string, unknown>;
  };
}

describe("the hierarchy snapshot assembler", () => {
  test("a stored task reaches the snapshot as a hierarchy-task entity", async () => {
    // The board is one store read: a field left unfed would report "nothing
    // supplied this" over records that were in the database the whole time.
    const db = new HiveDatabase(":memory:");
    databases.push(db);
    seed(db);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();
    const board = HierarchyTaskProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.task).projection,
    );
    expect(board.tasks).toEqual({
      availability: "present",
      value: [
        {
          taskId,
          revision: "1",
          state: "in-progress",
          ownerNodeId: authorNodeId,
          assigneeNodeId: authorNodeId,
          parentTaskId: null,
          dependsOn: [],
          branch: "hive/author-agent",
          blockers: [],
          evidence: [],
        },
      ],
    });
  });

  test("a run with no tasks reads present-and-empty, not unread", async () => {
    // A run that holds no task answers "none recorded" — never "the source
    // was not read".
    const db = new HiveDatabase(":memory:");
    databases.push(db);
    const store = new HierarchyStore(db);
    store.putRun(run(), null);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();
    const board = HierarchyTaskProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.task).projection,
    );
    expect(board.tasks).toEqual({ availability: "present", value: [] });
  });

  test("no projected field claims a source the assembler never read", async () => {
    // The probe: drop any store read from StatusStore.hierarchyEntities and the
    // matching detail string appears here. A silent nil cannot pass — an
    // unsupplied source is spelled out in the projection.
    const db = new HiveDatabase(":memory:");
    databases.push(db);
    seed(db);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();
    const wire = JSON.stringify(snapshot.entities);
    for (const detail of Object.values(UNSUPPLIED_SOURCE_DETAILS)) {
      expect(wire).not.toContain(detail);
    }
  });

  test("bindings, reviews, incidents and stranded work all come from the store", async () => {
    const db = new HiveDatabase(":memory:");
    databases.push(db);
    seed(db);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();

    const node = HierarchyNodeProjectionSchema.parse(
      required(snapshot.entities.find((entity) => entity.id === authorNodeId))
        .projection,
    );
    expect(node.binding).toEqual({ availability: "present", value: authorRef });

    const reviews = HierarchyReviewProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.review).projection,
    );
    if (reviews.reviews.availability !== "present") {
      throw new Error("the store holds one review");
    }
    expect(reviews.reviews.value.map((summary) => summary.reviewId)).toEqual([
      reviewId,
    ]);

    const incidents = HierarchyIncidentProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.incident).projection,
    );
    expect(incidents.runDecision).toEqual({
      availability: "present",
      value: [
        {
          idempotencyKey: "run-pause-once",
          intentDigest: digest,
          outcome: { status: "accepted" },
          observedRevision: "1",
        },
      ],
    });
    // Read and empty for the kinds this run never produced…
    expect(incidents.recovery).toEqual({ availability: "present", value: [] });
    // …and unreadable for the one whose record type does not exist.
    expect(incidents.breaker.reason).toBe("source-absent");

    const stranded = HierarchyStrandedManifestProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.strandedManifest).projection,
    );
    if (stranded.items.availability !== "present") {
      throw new Error("the journal holds one stranded capture");
    }
    expect(stranded.items.value.map((item) => item.branch)).toEqual([
      "hive/author-agent",
    ]);
  });

  test("stranded work survives a repo that has no hierarchy Run yet", async () => {
    // The window every repo passes through before its first Run, and the one
    // where captures are most common. The row is keyed by agent, so gating it
    // on run-keyed state would drop exactly the work nobody is tracking.
    const db = new HiveDatabase(":memory:");
    databases.push(db);
    const journal = new ManifestJournal(db);
    // The nodeless case: work no run could ever have claimed.
    journal.append({ ...strandedManifest, runId: null, nodeId: null });
    expect(journal.listAttention()).toHaveLength(1);
    expect(new HierarchyStore(db).listRuns()).toEqual([]);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();
    const stranded = HierarchyStrandedManifestProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.strandedManifest).projection,
    );
    if (stranded.items.availability !== "present") {
      throw new Error("the journal holds one capture and the store read it");
    }
    expect(stranded.items.value.map((item) => item.nodeId)).toEqual([null]);
  });

  test("an empty repo still answers about stranded work", async () => {
    // Nothing anywhere: the row must say "read, none recorded" rather than
    // vanish, or a reader cannot tell the daemon looked.
    const db = new HiveDatabase(":memory:");
    databases.push(db);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();
    const stranded = HierarchyStrandedManifestProjectionSchema.parse(
      entityOf(snapshot, HIERARCHY_ENTITY_KINDS.strandedManifest).projection,
    );
    expect(stranded.items).toEqual({ availability: "present", value: [] });
    // No topology is asserted for a repo with neither runs nor assignments.
    expect(
      snapshot.entities.filter(
        (entity) => entity.kind !== HIERARCHY_ENTITY_KINDS.strandedManifest,
      ),
    ).toEqual([]);
  });

  test("an unbound node projects an absent binding, never a stale one", async () => {
    const db = new HiveDatabase(":memory:");
    databases.push(db);
    seed(db);
    const store = new HierarchyStore(db);
    store.putAgentBinding({ ...binding(authorRef), unboundAt: now }, runId);

    const snapshot = await new StatusStore(db, instanceId).fetchSnapshot();
    const node = HierarchyNodeProjectionSchema.parse(
      required(
        snapshot.entities.find(
          (entity) =>
            entity.kind === HIERARCHY_ENTITY_KINDS.node &&
            entity.id === authorNodeId,
        ),
      ).projection,
    );
    expect(node.binding.availability).toBe("absent");
  });
});
