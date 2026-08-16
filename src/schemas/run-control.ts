// The typed run-control wire: the G2 gate decision and pause/resume/abort. The envelope half mirrors workspace/Sources/WorkspaceCore/MutationEnvelope.swift field for field, including its JSON key names, so one intent encoded by the Swift client decodes here and one result encoded here decodes there. Body and observed post-state are generic on both sides; run control binds them to the operations below and to the Run record. The gate body names exact facts — SHA, digest, evidence, target-main base — because an approval that named a floating "latest" pointer would authorize whatever landed after the engineer looked.

import { z } from "zod";
import {
  ArtifactRefIdSchema,
  DigestSchema,
  GitShaSchema,
  RevisionSchema,
  RunIdSchema,
} from "./hierarchy-ids";
import {
  DelegationGrantSchema,
  HierarchyNodeSchema,
  NodeIdSchema,
} from "./hierarchy-node";
import {
  PlanRevisionSchema,
  RunBudgetSchema,
  RunSchema,
  SpecRevisionSchema,
  TopologyDecisionSchema,
} from "./hierarchy-run";
import { DecimalUint64Schema } from "./session-protocol";
import { TaskDetailSchema } from "./task-detail";

/** The run epoch as it travels on the wire. The Run record holds it as a number; the Swift envelope models every concurrency token as a string, so it crosses as a decimal string and is compared as one. */
export const RunEpochTokenSchema = DecimalUint64Schema;

/** The state a mutation compares before it acts. The separate cases are what stop an intent from silently carrying neither token: strict objects reject a revision expectation that also smuggles an epoch, and the reverse. */
export const MutationExpectationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("revision"), revision: RevisionSchema }),
  z.strictObject({ kind: z.literal("epoch"), epoch: RunEpochTokenSchema }),
  z.strictObject({
    kind: z.literal("revision-and-epoch"),
    revision: RevisionSchema,
    epoch: RunEpochTokenSchema,
  }),
]);
export type MutationExpectation = z.infer<typeof MutationExpectationSchema>;

export const MutationFailureSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type MutationFailure = z.infer<typeof MutationFailureSchema>;

export const MutationOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("accepted") }),
  z.strictObject({
    status: z.literal("rejected"),
    failure: MutationFailureSchema,
  }),
]);
export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>;

/** The expectation schema is a parameter because a command may accept fewer kinds than the envelope can express: run control takes only the two-token form, while the envelope itself keeps all three. */
export const mutationIntentSchema = <
  Body extends z.ZodType,
  Expected extends z.ZodType,
>(
  body: Body,
  expected: Expected,
) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    intentId: z.string().min(1),
    expected,
    idempotencyKey: z.string().min(1),
    body,
  });

/** The observed post-state is required for both outcomes, so a rejection hands back the state that stayed in force instead of leaving the caller to infer it from an error. The post-state token lets the next intent continue without a refetch whose only purpose is learning the current revision and epoch. */
export const mutationResultSchema = <
  PostState extends z.ZodType,
  Token extends z.ZodType,
>(
  postState: PostState,
  token: Token,
) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    intentId: z.string().min(1),
    operationId: z.string().min(1),
    postStateToken: token,
    outcome: MutationOutcomeSchema,
    observedPostState: postState,
  });

export const ApproveG2BodySchema = z.strictObject({
  operation: z.literal("approve-g2"),
  runId: RunIdSchema,
  runStageSha: GitShaSchema,
  digest: DigestSchema,
  evidenceArtifactRefs: z.array(ArtifactRefIdSchema),
  targetMainBase: GitShaSchema,
});
export type ApproveG2Body = z.infer<typeof ApproveG2BodySchema>;

/** The operation that starts a run, and the only one whose run does not exist yet. It carries the whole P0 package as records rather than references, because there is nothing stored to refer to: the daemon writes the SpecRevision, PlanRevision, TopologyDecision and RunBudget it is given, then the Run pointing at them, then the run's root node. Nothing here is defaulted. A run whose package the daemon invented would put every later fence — budget, scope, gate — on facts nobody chose. The Run points at every record in this package, spec included, so spawn admission fences on the exact revisions the caller named here and never on a floating "latest" pointer. */
export const RunCreateBodySchema = z.strictObject({
  operation: z.literal("run-create"),
  runId: RunIdSchema,
  repo: z.string().min(1),
  instanceId: z.string().min(1),
  baseSha: GitShaSchema,
  rootNodeId: NodeIdSchema,
  spec: SpecRevisionSchema,
  plan: PlanRevisionSchema,
  topology: TopologyDecisionSchema,
  budget: RunBudgetSchema,
});
export type RunCreateBody = z.infer<typeof RunCreateBodySchema>;

/** The run root's delegation: one child node, the task assigned to it, and the grant that authorizes it, written together under daemon authority. This is the user's atomic bootstrap for the first delegated worker. The queen has a stable root principal but still no agents-table row; her later MCP writes resolve that principal through the live root provider run. THE GRANT IS THE TRUST ANCHOR. Everything below attenuates from it, so its scope bounds the whole subtree. paths must be non-empty: an empty scope is far more likely a caller who never considered it than a user who meant to authorize nothing, and a trust anchor nobody chose is the failure this operation exists to avoid. The budget is required by DelegationBudgetSchema and is never filled in here. */
export const RunDelegateBodySchema = z.strictObject({
  operation: z.literal("run-delegate"),
  runId: RunIdSchema,
  node: HierarchyNodeSchema,
  task: TaskDetailSchema,
  grant: DelegationGrantSchema,
});
export type RunDelegateBody = z.infer<typeof RunDelegateBodySchema>;

const RunLifecycleBodySchema = <Operation extends string>(
  operation: Operation,
) =>
  z.strictObject({
    operation: z.literal(operation),
    runId: RunIdSchema,
  });

export const RunControlBodySchema = z.discriminatedUnion("operation", [
  ApproveG2BodySchema,
  RunCreateBodySchema,
  RunDelegateBodySchema,
  RunLifecycleBodySchema("run-pause"),
  RunLifecycleBodySchema("run-resume"),
  RunLifecycleBodySchema("run-abort"),
]);
export type RunControlBody = z.infer<typeof RunControlBodySchema>;

/** The revision and epoch a run that does not exist yet is expected at. "0" is already this store's sentinel for an absent record — casMutable reports a missing row as revision "0" — so run-create reuses it rather than inventing a second vocabulary for absence. It also keeps the expectation wire-compatible with WorkspaceCore/MutationEnvelope.swift, whose MutationExpectation is a closed enum: a new `kind` would fail to decode there. */
export const ABSENT_RUN_EXPECTATION = { revision: "0", epoch: "0" } as const;

/** Run control fences on both dimensions at once. A run's revision and its epoch move for different reasons — a package edit versus a pause — so an intent that could name only one of them could be a gate decision that ignored the other. Both are required, always. */
export const RunControlExpectationSchema = z.strictObject({
  kind: z.literal("revision-and-epoch"),
  revision: RevisionSchema,
  epoch: RunEpochTokenSchema,
});

export const RunControlIntentSchema = mutationIntentSchema(
  RunControlBodySchema,
  RunControlExpectationSchema,
).superRefine((intent, context) => {
  if (intent.body.operation !== "run-create") return;
  // A create cannot fence on live state, so it states the absence it expects. Refused here rather than in the daemon because a create that names a live revision has no post-state to report a rejection against.
  if (
    intent.expected.revision !== ABSENT_RUN_EXPECTATION.revision ||
    intent.expected.epoch !== ABSENT_RUN_EXPECTATION.epoch
  ) {
    context.addIssue({
      code: "custom",
      path: ["expected"],
      message: `run-create expects revision ${ABSENT_RUN_EXPECTATION.revision} and epoch ${ABSENT_RUN_EXPECTATION.epoch}, the absent-record sentinel`,
    });
  }
  for (const field of ["spec", "plan", "topology", "budget"] as const) {
    const record = intent.body[field];
    if (record.runId !== intent.body.runId) {
      context.addIssue({
        code: "custom",
        path: ["body", field, "runId"],
        message: `${field} belongs to run ${record.runId}, not ${intent.body.runId}`,
      });
    }
  }
});

/** The delegation rules that can be settled from the bytes alone, refused at the wire so they never reach a path that would have to invent a post-state for them. Everything requiring stored state is checked by the daemon. */
export const runDelegateWireRefusal = (
  body: RunDelegateBody,
): string | null => {
  if (body.grant.paths.length === 0) {
    return "run-delegate requires a non-empty grant path scope; it is the trust anchor for the whole run and is never defaulted";
  }
  if (body.grant.parentGrantId !== null) {
    return `run-delegate issues the root's own grant, which has no parent; got ${body.grant.parentGrantId}`;
  }
  for (const [label, recordRunId] of [
    ["node", body.node.runId],
    ["grant", body.grant.runId],
  ] as const) {
    if (recordRunId !== body.runId) {
      return `${label} belongs to run ${recordRunId}, not ${body.runId}`;
    }
  }
  if (body.task.assigneeNodeId !== body.node.nodeId) {
    return `task ${body.task.taskId} is not assigned to the delegated node ${body.node.nodeId}`;
  }
  if (body.grant.subject.nodeId !== body.node.nodeId) {
    return `grant subject is node ${body.grant.subject.nodeId}, not the delegated node ${body.node.nodeId}`;
  }
  if (!body.grant.taskIds.includes(body.task.taskId)) {
    return `grant does not cover task ${body.task.taskId}`;
  }
  return null;
};
export type RunControlIntent = z.infer<typeof RunControlIntentSchema>;

export const RunControlResultSchema = mutationResultSchema(
  RunSchema,
  RunControlExpectationSchema,
);
export type RunControlResult = z.infer<typeof RunControlResultSchema>;

/** One decision, stored under the idempotency key that bought it. intentDigest pins the exact bytes the key was spent on: the same bytes replay to this same decision, and different bytes under a spent key are refused rather than answered with another intent's outcome. */
export const RunControlDecisionSchema = z.strictObject({
  idempotencyKey: z.string().min(1),
  intentDigest: DigestSchema,
  result: RunControlResultSchema,
});
export type RunControlDecision = z.infer<typeof RunControlDecisionSchema>;

export const RUN_CONTROL_FAILURE_CODES = {
  revisionConflict: "revision-conflict",
  /** The expected epoch is not the run's current epoch. */
  epochConflict: "epoch-conflict",
  gateFactDrift: "gate-fact-drift",
  gateAlreadyDecided: "gate-already-decided",
  lifecycleInvalid: "lifecycle-invalid",
  idempotencyKeyReused: "idempotency-key-reused",
  runAlreadyExists: "run-already-exists",
  /** A delegation named records that do not agree with each other or the run. */
  delegationInvalid: "delegation-invalid",
} as const;
