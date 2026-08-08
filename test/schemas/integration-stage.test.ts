import { describe, expect, test } from "bun:test";
import {
  IntegrationStageSchema,
  IntegrationStagesSchema,
  isReviewCurrentForCandidate,
  PromotionGrantSchema,
  ReviewSchema,
} from "../../src/schemas/integration-stage";

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const nodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const stageId = "stage_018f4f5e-0000-7000-8000-000000000001";
const leadStageId = "stage_018f4f5e-0000-7000-8000-000000000002";
const promotionGrantId = "promotion_018f4f5e-0000-7000-8000-000000000001";
const reviewId = "review_018f4f5e-0000-7000-8000-000000000001";
const artifactId = "art_018f4f5e-0000-7000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const changedDigest = `sha256:${"c".repeat(64)}`;
const gitSha = "b".repeat(40);
const nextGitSha = "c".repeat(40);
const createdAt = "2026-07-30T12:00:00.000Z";

const author = { nodeId, agentId: "author", generation: 1 };
const reviewer = { nodeId, agentId: "reviewer", generation: 2 };

const validRunStage = {
  stageId,
  revision: "1",
  kind: "run" as const,
  runId,
  ownerNodeId: null,
  daemonRef: "refs/hive/run-stage",
  baseSha: gitSha,
  headSha: gitSha,
  acceptedPromotionGrantIds: [promotionGrantId],
  validation: { environment: "bun", evidenceArtifactRefs: [artifactId] },
  queueHighWater: 3,
  lifecycle: "active" as const,
};

const validLeadStage = {
  ...validRunStage,
  stageId: leadStageId,
  kind: "lead" as const,
  ownerNodeId: nodeId,
  daemonRef: "refs/hive/lead-stage",
};

const validPromotionGrant = {
  promotionGrantId,
  runId,
  source: {
    taskId,
    branch: "hive/author-task",
    commitSha: gitSha,
    patchDigest: digest,
  },
  target: {
    stage: { stageId, revision: "1" },
    expectedBaseSha: gitSha,
    expectedHeadSha: gitSha,
  },
  predictedResultSha: nextGitSha,
  evidence: {
    task: { taskId, revision: "1" },
    review: { reviewId, revision: "1" },
    contractRevisions: [{ revision: "1", digest }],
    pathLeases: ["src/schemas"],
    ciArtifactRefs: [artifactId],
  },
  actions: {
    author: { binding: author, capabilityEpoch: 1 },
    reviewer: { binding: reviewer, capabilityEpoch: 2 },
    currentOwner: { binding: null, capabilityEpoch: 0 },
  },
  invalidation: "current" as const,
  hierarchyRevision: "1",
  runEpoch: 0,
  expiresAt: createdAt,
};

const validReview = {
  reviewId,
  revision: "1",
  reviewer,
  authors: [author],
  candidate: { commitSha: gitSha, patchDigest: digest, baseSha: gitSha },
  revisions: {
    spec: { revision: "1", digest },
    task: { taskId, revision: "1" },
    contracts: [{ revision: "1", digest }],
  },
  environment: { toolchain: "bun 1.x", environment: "linux" },
  findings: [],
  verdict: "accepted" as const,
  evidenceArtifactRefs: [artifactId],
  invalidation: { state: "current" as const },
};

describe("IntegrationStageSchema", () => {
  test("represents exactly one run stage for every represented run", () => {
    expect(
      IntegrationStagesSchema.safeParse([validRunStage, validLeadStage])
        .success,
    ).toBe(true);
    expect(
      IntegrationStagesSchema.safeParse([
        validRunStage,
        { ...validRunStage, stageId: leadStageId },
      ]).success,
    ).toBe(false);
    expect(IntegrationStagesSchema.safeParse([validLeadStage]).success).toBe(
      false,
    );
  });

  test("accepts one run stage for each of two runs", () => {
    expect(
      IntegrationStagesSchema.safeParse([
        validRunStage,
        {
          ...validRunStage,
          stageId: leadStageId,
          runId: "run_018f4f5e-0000-7000-8000-000000000002",
        },
      ]).success,
    ).toBe(true);
  });

  test("rejects malformed stage ids and unknown stage fields", () => {
    expect(
      IntegrationStageSchema.safeParse({ ...validRunStage, stageId: "stage-1" })
        .success,
    ).toBe(false);
    expect(
      IntegrationStageSchema.safeParse({ ...validRunStage, extra: "nope" })
        .success,
    ).toBe(false);
  });
});

describe("PromotionGrantSchema", () => {
  test("binds its target through typed stage state, never a caller-supplied ref", () => {
    expect(PromotionGrantSchema.safeParse(validPromotionGrant).success).toBe(
      true,
    );
    expect(
      PromotionGrantSchema.safeParse({
        ...validPromotionGrant,
        targetRef: "refs/heads/main",
      }).success,
    ).toBe(false);
    expect(
      PromotionGrantSchema.safeParse({
        ...validPromotionGrant,
        target: "refs/heads/main",
      }).success,
    ).toBe(false);
    expect(
      PromotionGrantSchema.safeParse({
        ...validPromotionGrant,
        target: { ...validPromotionGrant.target, ref: "refs/heads/main" },
      }).success,
    ).toBe(false);
  });

  test("rejects malformed promotion and target stage ids", () => {
    expect(
      PromotionGrantSchema.safeParse({
        ...validPromotionGrant,
        promotionGrantId: "promotion-1",
      }).success,
    ).toBe(false);
    expect(
      PromotionGrantSchema.safeParse({
        ...validPromotionGrant,
        target: {
          ...validPromotionGrant.target,
          stage: { ...validPromotionGrant.target.stage, stageId: "stage-1" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("ReviewSchema", () => {
  test("binds a current verdict to its exact patch digest and base", () => {
    const review = ReviewSchema.parse(validReview);

    expect(
      isReviewCurrentForCandidate(review, {
        patchDigest: digest,
        baseSha: gitSha,
      }),
    ).toBe(true);
    expect(
      isReviewCurrentForCandidate(review, {
        patchDigest: changedDigest,
        baseSha: gitSha,
      }),
    ).toBe(false);
    expect(
      isReviewCurrentForCandidate(review, {
        patchDigest: digest,
        baseSha: nextGitSha,
      }),
    ).toBe(false);
  });

  test("an invalidated review is never current for its matching candidate", () => {
    const review = ReviewSchema.parse({
      ...validReview,
      invalidation: { state: "invalidated", reason: "patch-changed" },
    });

    expect(
      isReviewCurrentForCandidate(review, {
        patchDigest: digest,
        baseSha: gitSha,
      }),
    ).toBe(false);
  });

  test("records invalidation explicitly and rejects malformed review ids", () => {
    expect(
      ReviewSchema.safeParse({
        ...validReview,
        invalidation: { state: "invalidated", reason: "patch-changed" },
      }).success,
    ).toBe(true);
    expect(
      ReviewSchema.safeParse({ ...validReview, reviewId: "review-1" }).success,
    ).toBe(false);
  });
});
