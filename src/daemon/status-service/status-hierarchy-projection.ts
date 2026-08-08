import type {
  AgentBindingRef,
  HierarchyNode,
} from "../../schemas/hierarchy-node";
import {
  type AvailableField,
  absentField,
  HIERARCHY_ENTITY_KINDS,
  HIERARCHY_PROJECTION_SCHEMA_VERSION,
  type HierarchyBudgetProjection,
  HierarchyBudgetProjectionSchema,
  type HierarchyIncidentProjection,
  HierarchyIncidentProjectionSchema,
  type HierarchyNodeProjection,
  HierarchyNodeProjectionSchema,
  type HierarchyReviewProjection,
  HierarchyReviewProjectionSchema,
  type HierarchyReviewSummary,
  type HierarchyRootIdentity,
  type HierarchyRunProjection,
  HierarchyRunProjectionSchema,
  type HierarchySnapshotEntity,
  type HierarchyStrandedManifestProjection,
  HierarchyStrandedManifestProjectionSchema,
  type HierarchyTaskProjection,
  HierarchyTaskProjectionSchema,
  type HierarchyTaskSummary,
  presentField,
  type RecoveryIncident,
  type RunDecisionIncident,
  type StrandedManifestAttention,
} from "../../schemas/hierarchy-projection";
import type {
  Run,
  RunBudget,
  TopologyDecision,
} from "../../schemas/hierarchy-run";
import type { Review } from "../../schemas/integration-stage";
import type { OwnershipTransfer } from "../../schemas/ownership-transfer";
import type { RunControlDecision } from "../../schemas/run-control";
import type { TaskDetail } from "../../schemas/task-detail";

export const BREAKER_SOURCE_ABSENT =
  "no anomaly circuit-breaker record exists in the daemon";

export const UNSUPPLIED_SOURCE_DETAILS = {
  runDecisions: "no run-control decision source supplied for this snapshot",
  transfers: "no ownership-transfer source supplied for this snapshot",
  tasks: "no task source supplied for this snapshot",
  strandedManifests: "no stranded-manifest source supplied for this snapshot",
} as const;

/** Frozen records the projector knows how to read. Every field is optional: missing means that source was never supplied for this snapshot, which is projected as absent rather than as a zeroed fake. `bindings` is a map of nodeId → AgentBindingRef only. Full AgentBinding (with SessionLocator) is intentionally not accepted here so the projector cannot embed a locator into a node entity by accident. */
export type HierarchyProjectionInput = {
  run?: Run | null;
  topology?: TopologyDecision | null;
  budget?: RunBudget | null;
  nodes?: readonly HierarchyNode[] | null;
  bindings?: ReadonlyMap<string, AgentBindingRef> | null;
  reviews?: readonly Review[] | null;
  runDecisions?: readonly RunControlDecision[] | null;
  transfers?: readonly OwnershipTransfer[] | null;
  tasks?: readonly TaskDetail[] | null;
};

function entity(
  kind: string,
  id: string,
  entityRevision: string,
  projection: Record<string, unknown>,
  generation?: number,
): HierarchySnapshotEntity {
  return generation === undefined
    ? { kind, id, entityRevision, projection }
    : { kind, id, entityRevision, projection, generation };
}

function asRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function projectRun(
  run: Run,
  topology: TopologyDecision | null | undefined,
): HierarchyRunProjection {
  const root: HierarchyRootIdentity = {
    kind: "queen-root",
    runId: run.runId,
    instanceId: run.instanceId,
    repo: run.repo,
  };
  const shape: AvailableField<TopologyDecision["shape"]> =
    topology !== null && topology !== undefined
      ? presentField(topology.shape)
      : absentField("unmeasured", "no TopologyDecision supplied for this run");

  return HierarchyRunProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    runId: run.runId,
    entityRevision: run.revision,
    root: presentField(root),
    phase: presentField(run.phase),
    lifecycle: presentField(run.lifecycle),
    topologyShape: shape,
    g1: presentField(run.g1),
    g2: presentField(run.g2),
    topologySource: presentField("hierarchy"),
  });
}

function projectNode(
  node: HierarchyNode,
  bindings: ReadonlyMap<string, AgentBindingRef> | null | undefined,
): HierarchyNodeProjection {
  const binding = bindings?.get(node.nodeId);
  return HierarchyNodeProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    nodeId: node.nodeId,
    runId: node.runId,
    entityRevision: node.revision,
    parentNodeId: presentField(node.parentNodeId),
    ownerNodeId: presentField(node.ownerNodeId),
    organizationalRole: presentField(node.organizationalRole),
    assignmentKind: presentField(node.assignmentKind),
    taskScope: presentField(node.taskScope),
    lifecycle: presentField(node.lifecycle),
    binding:
      binding === undefined
        ? absentField("unmeasured", "no AgentBindingRef supplied for this node")
        : presentField(binding),
  });
}

function projectBudget(run: Run, budget: RunBudget): HierarchyBudgetProjection {
  return HierarchyBudgetProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    runId: run.runId,
    entityRevision: budget.revision,
    limits: presentField(budget.limits),
  });
}

function projectReviews(
  runId: string,
  reviews: readonly Review[],
): HierarchyReviewProjection {
  const summaries: HierarchyReviewSummary[] = reviews.map((review) => ({
    reviewId: review.reviewId,
    revision: review.revision,
    verdict: review.verdict,
    invalidation: review.invalidation,
    reviewer: review.reviewer,
    candidate: review.candidate,
    taskId: review.revisions.task.taskId,
  }));
  const entityRevision =
    reviews.length === 0
      ? "0"
      : reviews
          .map((review) => BigInt(review.revision))
          .reduce((a, b) => (a > b ? a : b))
          .toString();
  return HierarchyReviewProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    runId,
    entityRevision,
    reviews: presentField(summaries),
  });
}

function maxRevision(revisions: readonly string[]): string {
  return revisions.length === 0
    ? "0"
    : revisions
        .map((revision) => BigInt(revision))
        .reduce((a, b) => (a > b ? a : b))
        .toString();
}

/** The board rows from the stored tasks. The summaries carry stored facts in the order the store returned them; an unsupplied source reads unfed, which is how "the daemon never looked" stays distinct from "this run has none". */
function projectTasks(
  runId: string,
  tasks: readonly TaskDetail[] | null | undefined,
): HierarchyTaskProjection {
  if (tasks === null || tasks === undefined) {
    return HierarchyTaskProjectionSchema.parse({
      schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
      runId,
      entityRevision: "0",
      tasks: absentField("unmeasured", UNSUPPLIED_SOURCE_DETAILS.tasks),
    });
  }
  const summaries: HierarchyTaskSummary[] = tasks.map((task) => ({
    taskId: task.taskId,
    revision: task.revision,
    state: task.state,
    ownerNodeId: task.ownerNodeId,
    assigneeNodeId: task.assigneeNodeId,
    parentTaskId: task.parentTaskId,
    dependsOn: task.dependsOn,
    branch: task.branch,
    blockers: task.blockers,
    evidence: task.evidence,
  }));
  return HierarchyTaskProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    runId,
    entityRevision: maxRevision(tasks.map((task) => task.revision)),
    tasks: presentField(summaries),
  });
}

function toRunDecisionIncident(
  decision: RunControlDecision,
): RunDecisionIncident {
  const outcome = decision.result.outcome;
  return {
    idempotencyKey: decision.idempotencyKey,
    intentDigest: decision.intentDigest,
    outcome:
      outcome.status === "accepted"
        ? { status: "accepted" }
        : { status: "rejected", failureCode: outcome.failure.code },
    observedRevision: decision.result.observedPostState.revision,
  };
}

function toRecoveryIncident(transfer: OwnershipTransfer): RecoveryIncident {
  return {
    transferId: transfer.transferId,
    reason: transfer.reason,
    lostOwnerNodeId: transfer.lostOwnerNodeId,
    successorNodeId: transfer.successorNodeId,
    hierarchyRevision: transfer.hierarchyRevision,
  };
}

function projectIncidents(
  runId: string,
  input: HierarchyProjectionInput,
): HierarchyIncidentProjection {
  const decisions = input.runDecisions;
  const transfers = input.transfers;
  return HierarchyIncidentProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    runId,
    entityRevision: maxRevision([
      ...(decisions ?? []).map(
        (decision) => decision.result.observedPostState.revision,
      ),
      ...(transfers ?? []).map((transfer) => transfer.hierarchyRevision),
    ]),
    runDecision:
      decisions === null || decisions === undefined
        ? absentField("unmeasured", UNSUPPLIED_SOURCE_DETAILS.runDecisions)
        : presentField(decisions.map(toRunDecisionIncident)),
    recovery:
      transfers === null || transfers === undefined
        ? absentField("unmeasured", UNSUPPLIED_SOURCE_DETAILS.transfers)
        : presentField(transfers.map(toRecoveryIncident)),
    breaker: {
      availability: "absent",
      reason: "source-absent",
      detail: BREAKER_SOURCE_ABSENT,
    },
  });
}

/** The stranded-manifest attention row. Kept out of the per-run entity list because the manifest journal is keyed by agent, not by run: attributing a capture to a run would mean deriving an attribution the source does not carry, and a branchless or nodeless capture could then be attributed to nothing and silently dropped. Each item names its own node instead. */
export function projectStrandedManifestEntity(
  items: readonly StrandedManifestAttention[] | null | undefined,
): HierarchySnapshotEntity {
  const projection: HierarchyStrandedManifestProjection =
    HierarchyStrandedManifestProjectionSchema.parse({
      schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
      runId: null,
      entityRevision: "0",
      items:
        items === null || items === undefined
          ? absentField(
              "unmeasured",
              UNSUPPLIED_SOURCE_DETAILS.strandedManifests,
            )
          : presentField([...items]),
    });
  return entity(
    HIERARCHY_ENTITY_KINDS.strandedManifest,
    "hierarchy:stranded",
    "0",
    asRecord(projection),
  );
}

export function projectHierarchyEntities(
  input: HierarchyProjectionInput,
): HierarchySnapshotEntity[] {
  if (input.run !== null && input.run !== undefined) {
    return projectHierarchyPath(input);
  }

  return projectAllAbsent();
}

function projectAllAbsent(): HierarchySnapshotEntity[] {
  const runId = "run_00000000-0000-7000-8000-0000000000a0";
  const absentRun = HierarchyRunProjectionSchema.parse({
    schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
    runId,
    entityRevision: "0",
    root: absentField("unmeasured", "no Run record supplied"),
    phase: absentField("unmeasured", "no Run record supplied"),
    lifecycle: absentField("unmeasured", "no Run record supplied"),
    topologyShape: absentField("unmeasured", "no TopologyDecision supplied"),
    g1: absentField("unmeasured", "no Run record supplied"),
    g2: absentField("unmeasured", "no Run record supplied"),
    topologySource: absentField(
      "unmeasured",
      "no hierarchy or legacy source supplied",
    ),
  });
  return [
    entity(HIERARCHY_ENTITY_KINDS.run, runId, "0", asRecord(absentRun)),
    entity(
      HIERARCHY_ENTITY_KINDS.task,
      `${runId}:tasks`,
      "0",
      asRecord(projectTasks(runId, null)),
    ),
    entity(
      HIERARCHY_ENTITY_KINDS.budget,
      `${runId}:budget`,
      "0",
      asRecord(
        HierarchyBudgetProjectionSchema.parse({
          schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
          runId,
          entityRevision: "0",
          limits: absentField("unmeasured", "no RunBudget supplied"),
        }),
      ),
    ),
    entity(
      HIERARCHY_ENTITY_KINDS.review,
      `${runId}:reviews`,
      "0",
      asRecord(
        HierarchyReviewProjectionSchema.parse({
          schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
          runId,
          entityRevision: "0",
          reviews: absentField("unmeasured", "no Review records supplied"),
        }),
      ),
    ),
    entity(
      HIERARCHY_ENTITY_KINDS.incident,
      `${runId}:incident`,
      "0",
      asRecord(projectIncidents(runId, {})),
    ),
  ];
}

function projectHierarchyPath(
  input: HierarchyProjectionInput,
): HierarchySnapshotEntity[] {
  const run = input.run;
  if (run === null || run === undefined) {
    return projectAllAbsent();
  }

  const entities: HierarchySnapshotEntity[] = [];
  const runProjection = projectRun(run, input.topology);
  entities.push(
    entity(
      HIERARCHY_ENTITY_KINDS.run,
      run.runId,
      run.revision,
      asRecord(runProjection),
    ),
  );

  for (const node of input.nodes ?? []) {
    const nodeProjection = projectNode(node, input.bindings);
    entities.push(
      entity(
        HIERARCHY_ENTITY_KINDS.node,
        node.nodeId,
        node.revision,
        asRecord(nodeProjection),
        input.bindings?.get(node.nodeId)?.generation,
      ),
    );
  }

  const tasks = projectTasks(run.runId, input.tasks);
  entities.push(
    entity(
      HIERARCHY_ENTITY_KINDS.task,
      `${run.runId}:tasks`,
      tasks.entityRevision,
      asRecord(tasks),
    ),
  );

  if (input.budget !== null && input.budget !== undefined) {
    entities.push(
      entity(
        HIERARCHY_ENTITY_KINDS.budget,
        `${run.runId}:budget`,
        input.budget.revision,
        asRecord(projectBudget(run, input.budget)),
      ),
    );
  } else {
    entities.push(
      entity(
        HIERARCHY_ENTITY_KINDS.budget,
        `${run.runId}:budget`,
        "0",
        asRecord(
          HierarchyBudgetProjectionSchema.parse({
            schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
            runId: run.runId,
            entityRevision: "0",
            limits: absentField("unmeasured", "no RunBudget supplied"),
          }),
        ),
      ),
    );
  }

  if (input.reviews !== null && input.reviews !== undefined) {
    entities.push(
      entity(
        HIERARCHY_ENTITY_KINDS.review,
        `${run.runId}:reviews`,
        "0",
        asRecord(projectReviews(run.runId, input.reviews)),
      ),
    );
  } else {
    entities.push(
      entity(
        HIERARCHY_ENTITY_KINDS.review,
        `${run.runId}:reviews`,
        "0",
        asRecord(
          HierarchyReviewProjectionSchema.parse({
            schemaVersion: HIERARCHY_PROJECTION_SCHEMA_VERSION,
            runId: run.runId,
            entityRevision: "0",
            reviews: absentField("unmeasured", "no Review records supplied"),
          }),
        ),
      ),
    );
  }

  const incidents = projectIncidents(run.runId, input);
  entities.push(
    entity(
      HIERARCHY_ENTITY_KINDS.incident,
      `${run.runId}:incident`,
      incidents.entityRevision,
      asRecord(incidents),
    ),
  );

  return entities;
}
