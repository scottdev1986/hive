import { z } from "zod";
import {
  ArtifactRefIdSchema,
  CreatedAtSchema,
  DigestSchema,
  domainUuidV7Schema,
  GitShaSchema,
  RevisionRefSchema,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
  TaskIdSchema,
} from "./hierarchy-ids";
import {
  AgentBindingRefSchema,
  NodeIdSchema,
  RepoPathSchema,
} from "./hierarchy-node";

export const IntegrationStageIdSchema = domainUuidV7Schema("stage");

export const PromotionGrantIdSchema = domainUuidV7Schema("promotion");

export const ReviewIdSchema = domainUuidV7Schema("review");

export const INTEGRATION_STAGE_LIFECYCLES = ["active", "closed"] as const;
export const IntegrationStageLifecycleSchema = z.enum(
  INTEGRATION_STAGE_LIFECYCLES,
);

const IntegrationStageShape = {
  stageId: IntegrationStageIdSchema,
  revision: RevisionSchema,
  runId: RunIdSchema,
  daemonRef: z.string().min(1),
  baseSha: GitShaSchema,
  headSha: GitShaSchema,
  acceptedPromotionGrantIds: z.array(PromotionGrantIdSchema),
  validation: z.strictObject({
    environment: z.string().min(1),
    evidenceArtifactRefs: z.array(ArtifactRefIdSchema),
  }),
  queueHighWater: SafeUintSchema,
  lifecycle: IntegrationStageLifecycleSchema,
} as const;

export const IntegrationStageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...IntegrationStageShape,
    kind: z.literal("run"),
    ownerNodeId: z.null(),
  }),
  z.strictObject({
    ...IntegrationStageShape,
    kind: z.literal("lead"),
    ownerNodeId: NodeIdSchema,
  }),
]);
export type IntegrationStage = z.infer<typeof IntegrationStageSchema>;

export const IntegrationStagesSchema = z
  .array(IntegrationStageSchema)
  .superRefine((stages, context) => {
    const runStagesByRun = new Map<string, number[]>();

    for (const [index, stage] of stages.entries()) {
      if (stage.kind !== "run") continue;
      const indices = runStagesByRun.get(stage.runId) ?? [];
      indices.push(index);
      runStagesByRun.set(stage.runId, indices);
    }

    const runIds = new Set(stages.map((stage) => stage.runId));
    for (const runId of runIds) {
      const indices = runStagesByRun.get(runId) ?? [];
      if (indices.length === 1) continue;
      context.addIssue({
        code: "custom",
        message: "each represented run needs exactly one run stage",
        path: indices[0] === undefined ? [] : [indices[0], "kind"],
      });
    }
  });

export const IntegrationStageRefSchema = z.strictObject({
  stageId: IntegrationStageIdSchema,
  revision: RevisionSchema,
});

export const PROMOTION_INVALIDATION_STATES = [
  "current",
  "invalidated",
] as const;
export const PromotionInvalidationStateSchema = z.enum(
  PROMOTION_INVALIDATION_STATES,
);

const PromotionActionBindingSchema = z.strictObject({
  binding: AgentBindingRefSchema.nullable(),
  capabilityEpoch: SafeUintSchema,
});

export const PromotionGrantSchema = z.strictObject({
  promotionGrantId: PromotionGrantIdSchema,
  runId: RunIdSchema,
  source: z.strictObject({
    taskId: TaskIdSchema,
    branch: z.string().min(1),
    commitSha: GitShaSchema,
    patchDigest: DigestSchema,
  }),
  target: z.strictObject({
    stage: IntegrationStageRefSchema,
    expectedBaseSha: GitShaSchema,
    expectedHeadSha: GitShaSchema,
  }),
  predictedResultSha: GitShaSchema,
  evidence: z.strictObject({
    task: z.strictObject({ taskId: TaskIdSchema, revision: RevisionSchema }),
    review: z.strictObject({
      reviewId: ReviewIdSchema,
      revision: RevisionSchema,
    }),
    contractRevisions: z.array(RevisionRefSchema),
    pathLeases: z.array(RepoPathSchema),
    ciArtifactRefs: z.array(ArtifactRefIdSchema),
  }),
  actions: z.strictObject({
    author: PromotionActionBindingSchema,
    reviewer: PromotionActionBindingSchema,
    currentOwner: PromotionActionBindingSchema,
  }),
  invalidation: PromotionInvalidationStateSchema,
  hierarchyRevision: RevisionSchema,
  runEpoch: SafeUintSchema,
  expiresAt: CreatedAtSchema,
});

export const REVIEW_VERDICTS = ["accepted", "changes-requested"] as const;
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);

export const ReviewInvalidationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("current") }),
  z.strictObject({
    state: z.literal("invalidated"),
    reason: z.enum(["patch-changed", "base-changed", "revision-changed"]),
  }),
]);

export const ReviewSchema = z.strictObject({
  reviewId: ReviewIdSchema,
  revision: RevisionSchema,
  reviewer: AgentBindingRefSchema,
  authors: z.array(AgentBindingRefSchema).min(1),
  candidate: z.strictObject({
    commitSha: GitShaSchema,
    patchDigest: DigestSchema,
    baseSha: GitShaSchema,
  }),
  revisions: z.strictObject({
    spec: RevisionRefSchema,
    task: z.strictObject({ taskId: TaskIdSchema, revision: RevisionSchema }),
    contracts: z.array(RevisionRefSchema),
  }),
  environment: z.strictObject({
    toolchain: z.string().min(1),
    environment: z.string().min(1),
  }),
  findings: z.array(
    z.strictObject({
      findingId: z.string().min(1),
      summary: z.string().min(1),
      severity: z.enum(["note", "blocking"]),
    }),
  ),
  verdict: ReviewVerdictSchema,
  evidenceArtifactRefs: z.array(ArtifactRefIdSchema),
  invalidation: ReviewInvalidationSchema,
});
export type Review = z.infer<typeof ReviewSchema>;

export function isReviewCurrentForCandidate(
  review: Review,
  candidate: Pick<Review["candidate"], "patchDigest" | "baseSha">,
): boolean {
  return (
    review.invalidation.state === "current" &&
    review.candidate.patchDigest === candidate.patchDigest &&
    review.candidate.baseSha === candidate.baseSha
  );
}
