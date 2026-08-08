// Serialized daemon-only ref writer: the single door hierarchy work reaches a stage ref through. Promotion accepts only the hierarchy binding resolved from the authenticated session. The assigned task, its delegation-grant chain, reviews, candidate commit, and stage all come from durable records or git. The engine repeats those reads at every write boundary so a retired binding or rewritten grant cannot land on facts that were true only during a precheck.

import {
  type AgentBinding,
  type AgentBindingRef,
  type DelegationGrant,
  isDelegationGrantAttenuation,
} from "../../schemas/hierarchy-node";
import type { Run } from "../../schemas/hierarchy-run";
import type { IntegrationStage, Review } from "../../schemas/integration-stage";
import type { TaskDetail } from "../../schemas/task-detail";
import { HierarchyConflictError } from "./records";
import type { HierarchyStore } from "../hierarchy-store";
import { runGit } from "../../adapters/git";
import {
  isReviewAdmittedForCandidate,
  type ReviewAdmissionReader,
} from "./review-admission";
import { ABORTED_RUN_ADMISSION_SEAM } from "./hierarchy-run-control";
import { canonicalJson } from "../status-service/status-service";
import { errorMessage } from "../../shared/error-message";

const nextRevision = (current: string): string =>
  (BigInt(current) + 1n).toString();
const ZERO_SHA = "0".repeat(40);

type RefWriteKind = "created" | "updated";

export type PromotionFailureCode =
  | "RUN_NOT_ADMITTED"
  | "ACTOR_NOT_AUTHOR"
  | "TASK_NOT_ASSIGNED"
  | "TASK_AMBIGUOUS"
  | "GRANT_MISSING"
  | "GRANT_INVALIDATED"
  | "STAGE_MISMATCH"
  | "REVIEW_MISSING"
  | "REVIEW_MISMATCH"
  | "REVIEW_NOT_ADMITTED"
  | "VALIDATION_EVIDENCE_STORE_MISSING"
  | "PREDICTED_SHA_MISMATCH"
  | "HIERARCHY_REVISION_FENCE"
  | "RUN_EPOCH_FENCE"
  | "CAPABILITY_EPOCH_FENCE"
  | "RECORD_CAS"
  | "REF_CAS"
  | "GIT";

export class PromotionError extends Error {
  readonly code: PromotionFailureCode;

  constructor(code: PromotionFailureCode, message: string) {
    super(message);
    this.name = "PromotionError";
    this.code = code;
  }
}

export type PromotionAuthority = {
  binding: AgentBindingRef;
  capabilityEpoch: number;
};

export type PromoteResult = {
  stage: IntegrationStage;
  commit: string;
  daemonRef: string;
};

export type PromotionEngineOptions = {
  store: HierarchyStore;
  repoRoot: string;
};

type StoredPromotionPlan = {
  binding: AgentBinding;
  node: NonNullable<ReturnType<HierarchyStore["getNode"]>>;
  run: Run;
  fences: { hierarchyRevision: string; runEpoch: number };
  task: TaskDetail;
  chain: DelegationGrant[];
  reviews: Review[];
  candidate: Review["candidate"];
  stage: IntegrationStage;
};

/**
 * Serializes validation and stage-ref writes so one promotion cannot validate
 * against state another promotion moves before its CAS. Construct one per daemon.
 */
export class PromotionEngine {
  private readonly store: HierarchyStore;
  private readonly repoRoot: string;
  private writerTail: Promise<void> = Promise.resolve();

  constructor(options: PromotionEngineOptions) {
    this.store = options.store;
    this.repoRoot = options.repoRoot;
  }

  async promote(authority: PromotionAuthority): Promise<PromoteResult> {
    assertAuthorityOnly(authority);
    return this.serialized(() => this.promoteUnlocked(authority));
  }

  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writerTail;
    let release!: () => void;
    this.writerTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async promoteUnlocked(
    authority: PromotionAuthority,
  ): Promise<PromoteResult> {
    const prepared = this.store.transaction(() =>
      this.deriveStoredPlan(authority),
    );
    await this.assertBranchTip(prepared);

    const beforeRef = this.store.transaction(() =>
      this.deriveStoredPlan(authority),
    );
    this.assertSamePlan(prepared, beforeRef, "before the ref CAS");
    await this.assertBranchTip(beforeRef);

    const refWrite = await this.casUpdateRef(
      prepared.stage.daemonRef,
      prepared.candidate.commitSha,
      prepared.stage.headSha,
    );

    try {
      return this.store.transaction(() => {
        const atWrite = this.deriveStoredPlan(authority);
        this.assertSamePlan(prepared, atWrite, "at the record write");
        const stage = atWrite.stage;
        const nextStage: IntegrationStage = {
          ...stage,
          revision: nextRevision(stage.revision),
          headSha: atWrite.candidate.commitSha,
        };
        const written = this.store.putIntegrationStage(
          nextStage,
          stage.revision,
        );
        return {
          stage: written,
          commit: atWrite.candidate.commitSha,
          daemonRef: stage.daemonRef,
        };
      });
    } catch (caught) {
      const error =
        caught instanceof HierarchyConflictError
          ? new PromotionError(
              "RECORD_CAS",
              `stage record moved to revision ${caught.currentRevision} at the write`,
            )
          : caught;
      try {
        await this.rollbackRef(
          prepared.stage.daemonRef,
          prepared.stage.headSha,
          prepared.candidate.commitSha,
          refWrite,
        );
      } catch (rollback) {
        const original = errorMessage(error);
        const rollbackMessage = errorMessage(rollback);
        throw new PromotionError(
          "REF_CAS",
          `promotion failed (${original}) and stage ref ${prepared.stage.daemonRef} could not be rolled back: ${rollbackMessage}`,
        );
      }
      throw error;
    }
  }

  private deriveStoredPlan(authority: PromotionAuthority): StoredPromotionPlan {
    const binding = this.requireLiveBinding(authority);
    const node = this.store.getNode(binding.nodeId);
    if (node === null) {
      throw new PromotionError(
        "RUN_NOT_ADMITTED",
        `no hierarchy node ${binding.nodeId} for landing binding ${binding.agentId}`,
      );
    }
    if (node.lifecycle !== "active") {
      throw new PromotionError(
        "RUN_NOT_ADMITTED",
        `landing node ${node.nodeId} lifecycle is ${node.lifecycle}`,
      );
    }
    if (node.parentNodeId === null) {
      throw new PromotionError(
        "ACTOR_NOT_AUTHOR",
        `run root node ${node.nodeId} may not promote a stage`,
      );
    }
    if (node.assignmentKind !== "author") {
      throw new PromotionError(
        "ACTOR_NOT_AUTHOR",
        `landing node ${node.nodeId} assignmentKind is ${node.assignmentKind}, not author`,
      );
    }

    const run = this.store.getRun(node.runId);
    if (run === null) {
      throw new PromotionError(
        "RUN_NOT_ADMITTED",
        `no run ${node.runId}; ${ABORTED_RUN_ADMISSION_SEAM}`,
      );
    }
    if (run.lifecycle !== "active") {
      throw new PromotionError(
        "RUN_NOT_ADMITTED",
        `run lifecycle is ${run.lifecycle}; ${ABORTED_RUN_ADMISSION_SEAM}`,
      );
    }
    const fences = this.store.getFences(run.runId);
    if (fences === null) {
      throw new PromotionError(
        "RUN_NOT_ADMITTED",
        `no fences for run ${run.runId}`,
      );
    }

    const tasks = this.store
      .listTasks(run.runId)
      .filter(
        (task) =>
          task.assigneeNodeId === binding.nodeId &&
          task.branch === binding.branch &&
          task.state !== "terminated",
      );
    if (tasks.length === 0) {
      throw new PromotionError(
        "TASK_NOT_ASSIGNED",
        `no task is assigned to ${binding.agentId}@${binding.nodeId} on branch ${binding.branch}`,
      );
    }
    if (tasks.length > 1) {
      throw new PromotionError(
        "TASK_AMBIGUOUS",
        `multiple tasks are assigned to ${binding.agentId}@${binding.nodeId} on branch ${binding.branch}: ${tasks.map((task) => task.taskId).join(", ")}`,
      );
    }
    const task = tasks[0];
    if (task === undefined) throw new Error("unreachable task selection");
    if (
      !task.delegationSpec.authority.permittedOperations.includes("promote") ||
      task.delegationSpec.authority.explicitNonAuthority.includes("promote") ||
      task.delegationSpec.authority.branch !== task.branch
    ) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `task ${task.taskId} does not delegate promote authority on branch ${task.branch}`,
      );
    }

    const chain = this.requireGrantChain(
      task.delegationSpec.authority.grantId,
      task,
      authority,
      run.runId,
      fences,
    );

    const stage = this.deriveAllowedStage(node, run.runId);
    if (stage.lifecycle !== "active") {
      throw new PromotionError(
        "STAGE_MISMATCH",
        `stage ${stage.stageId} lifecycle is ${stage.lifecycle}`,
      );
    }

    const reviews = this.requireStoredReviews(task, authority, run.runId);
    const candidate = reviews[0]?.candidate;
    if (candidate === undefined)
      throw new Error("unreachable review selection");
    if (candidate.baseSha !== stage.baseSha) {
      throw new PromotionError(
        "REVIEW_MISMATCH",
        `stored review base ${candidate.baseSha} is not stage base ${stage.baseSha}`,
      );
    }
    if (candidate.commitSha === stage.headSha) {
      throw new PromotionError(
        "RECORD_CAS",
        `stage ${stage.stageId} already contains candidate ${candidate.commitSha}`,
      );
    }

    return {
      binding,
      node,
      run,
      fences,
      task,
      chain,
      reviews,
      candidate,
      stage,
    };
  }

  private deriveAllowedStage(
    landingNode: StoredPromotionPlan["node"],
    runId: string,
  ): IntegrationStage {
    const stages = this.store.listIntegrationStages(runId);
    let ancestorId = landingNode.parentNodeId;
    while (ancestorId !== null) {
      const leadStages = stages.filter(
        (stage) =>
          stage.kind === "lead" &&
          stage.lifecycle === "active" &&
          stage.ownerNodeId === ancestorId,
      );
      if (leadStages.length > 1) {
        throw new PromotionError(
          "STAGE_MISMATCH",
          `ancestor node ${ancestorId} owns multiple active lead stages: ${leadStages.map((stage) => stage.stageId).join(", ")}`,
        );
      }
      const leadStage = leadStages[0];
      if (leadStage !== undefined) return leadStage;
      const ancestor = this.store.getNode(ancestorId);
      ancestorId = ancestor?.parentNodeId ?? null;
    }

    const runStages = stages.filter((stage) => stage.kind === "run");
    if (runStages.length !== 1) {
      throw new PromotionError(
        "STAGE_MISMATCH",
        `run ${runId} must have exactly one run stage, found ${String(runStages.length)}`,
      );
    }
    const runStage = runStages[0];
    if (runStage === undefined)
      throw new Error("unreachable run stage selection");
    return runStage;
  }

  private requireLiveBinding(authority: PromotionAuthority): AgentBinding {
    const live = this.store.getAgentBinding(authority.binding);
    if (live === null) {
      throw new PromotionError(
        "CAPABILITY_EPOCH_FENCE",
        `no binding for ${bindingLabel(authority.binding)}`,
      );
    }
    if (live.unboundAt !== null) {
      throw new PromotionError(
        "CAPABILITY_EPOCH_FENCE",
        `binding ${bindingLabel(authority.binding)} is unbound`,
      );
    }
    const flatEpoch = this.store.liveCapabilityEpoch(authority.binding);
    if (flatEpoch !== authority.capabilityEpoch) {
      throw new PromotionError(
        "CAPABILITY_EPOCH_FENCE",
        `capabilityEpoch expected ${String(authority.capabilityEpoch)}, current is ${String(flatEpoch)}`,
      );
    }
    return live;
  }

  private requireGrantChain(
    leafGrantId: string,
    task: TaskDetail,
    authority: PromotionAuthority,
    runId: string,
    fences: { hierarchyRevision: string; runEpoch: number },
  ): DelegationGrant[] {
    const leaf = this.store.getGrant(leafGrantId);
    if (leaf === null) {
      throw new PromotionError(
        "GRANT_MISSING",
        `delegation grant ${leafGrantId} named by task ${task.taskId} is not stored`,
      );
    }

    const leafToRoot: DelegationGrant[] = [];
    const seen = new Set<string>();
    let cursor: DelegationGrant = leaf;
    for (;;) {
      if (seen.has(cursor.grantId)) {
        throw new PromotionError(
          "GRANT_INVALIDATED",
          `delegation grant chain for ${leafGrantId} contains a cycle at ${cursor.grantId}`,
        );
      }
      seen.add(cursor.grantId);
      leafToRoot.push(cursor);
      if (cursor.parentGrantId === null) break;
      const parent = this.store.getGrant(cursor.parentGrantId);
      if (parent === null) {
        throw new PromotionError(
          "GRANT_MISSING",
          `delegation grant chain for ${leafGrantId} is missing parent ${cursor.parentGrantId}`,
        );
      }
      cursor = parent;
    }
    const chain = leafToRoot.reverse();

    let parent: DelegationGrant | null = null;
    for (const link of chain) {
      this.assertGrantLive(link, runId, fences);
      if (parent !== null && !isDelegationGrantAttenuation(parent, link)) {
        throw new PromotionError(
          "GRANT_INVALIDATED",
          `delegation grant ${link.grantId} is not a valid attenuation of ${parent.grantId}`,
        );
      }
      parent = link;
    }

    if (!sameBinding(leaf.subject, authority.binding)) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${leaf.grantId} subject ${bindingLabel(leaf.subject)} is not the landing binding ${bindingLabel(authority.binding)}`,
      );
    }
    if (!leaf.actions.includes("promote")) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${leaf.grantId} does not authorize promote`,
      );
    }
    if (!leaf.taskIds.includes(task.taskId)) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${leaf.grantId} does not cover task ${task.taskId}`,
      );
    }
    if (!leaf.branches.includes(task.branch)) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${leaf.grantId} does not cover branch ${task.branch}`,
      );
    }
    return chain;
  }

  private assertGrantLive(
    grant: DelegationGrant,
    runId: string,
    fences: { hierarchyRevision: string; runEpoch: number },
  ): void {
    if (grant.status !== "active") {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} status is ${grant.status}`,
      );
    }
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} expired at ${grant.expiresAt}`,
      );
    }
    if (grant.runId !== runId) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} belongs to run ${grant.runId}, not ${runId}`,
      );
    }
    if (grant.hierarchyRevision !== fences.hierarchyRevision) {
      throw new PromotionError(
        "HIERARCHY_REVISION_FENCE",
        `delegation grant ${grant.grantId} hierarchyRevision expected ${grant.hierarchyRevision}, current is ${fences.hierarchyRevision}`,
      );
    }
    if (grant.runEpoch !== fences.runEpoch) {
      throw new PromotionError(
        "RUN_EPOCH_FENCE",
        `delegation grant ${grant.grantId} runEpoch expected ${String(grant.runEpoch)}, current is ${String(fences.runEpoch)}`,
      );
    }

    const issuer = this.store.getAgentBinding(grant.issuer);
    if (issuer === null) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} has no issuer binding ${bindingLabel(grant.issuer)}`,
      );
    }
    if (issuer.unboundAt !== null) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} issuer binding ${bindingLabel(grant.issuer)} is unbound`,
      );
    }
    const issuerEpoch = this.store.liveCapabilityEpoch(issuer);
    if (issuerEpoch !== grant.capabilityEpoch) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} records issuer capabilityEpoch ${String(grant.capabilityEpoch)}, current is ${String(issuerEpoch)}`,
      );
    }
    if (grant.parentGrantId === null) return;
    const issuerNode = this.store.getNode(grant.issuer.nodeId);
    if (issuerNode === null || issuerNode.runId !== runId) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} has no issuer node on run ${runId}`,
      );
    }
    if (
      issuerNode.parentNodeId !== null &&
      issuerNode.organizationalRole !== "lead-worker"
    ) {
      throw new PromotionError(
        "GRANT_INVALIDATED",
        `delegation grant ${grant.grantId} issuer node ${issuerNode.nodeId} no longer holds lead-worker standing`,
      );
    }
  }

  /** The reviews a promotion stands on are derived from the store, never named by the caller: every live review naming the exact task revision with the landing binding among its authors must converge on one candidate, and each must independently admit that candidate. A live review that declines or fails independence refuses the land — a reviewer cannot be bypassed by going unnamed. */
  private requireStoredReviews(
    task: TaskDetail,
    authority: PromotionAuthority,
    runId: string,
  ): Review[] {
    const reviews = this.store
      .listReviews(runId)
      .filter(
        (review) =>
          review.revisions.task.taskId === task.taskId &&
          review.revisions.task.revision === task.revision &&
          review.authors.some((author) =>
            sameBinding(author, authority.binding),
          ),
      );
    if (reviews.length === 0) {
      throw new PromotionError(
        "REVIEW_MISSING",
        `no live review names task ${task.taskId}@${task.revision} with the landing binding among its authors`,
      );
    }
    const candidate = reviews[0]?.candidate;
    if (candidate === undefined)
      throw new Error("unreachable review selection");
    for (const review of reviews) {
      if (canonicalJson(review.candidate) !== canonicalJson(candidate)) {
        throw new PromotionError(
          "REVIEW_MISMATCH",
          `review ${review.reviewId}@${review.revision} does not describe the same candidate as the other stored reviews`,
        );
      }
    }

    const reader: ReviewAdmissionReader = {
      candidateAuthorAgentIds: (forCandidate) => [
        ...new Set(
          reviews
            .filter(
              (review) =>
                canonicalJson(review.candidate) === canonicalJson(forCandidate),
            )
            .flatMap((review) =>
              review.authors.map((author) => author.agentId),
            ),
        ),
      ],
      hasOverlappingAuthorTask: (reviewer, reviewedTaskId) => {
        const reviewedTask = this.store.getTask(reviewedTaskId);
        return reviewedTask?.assigneeNodeId === reviewer.nodeId;
      },
      hasFreshValidationEvidenceAt: (commitSha) => {
        throw missingValidationEvidenceStore(commitSha);
      },
    };
    for (const review of reviews) {
      if (!isReviewAdmittedForCandidate(review, candidate, reader)) {
        throw new PromotionError(
          "REVIEW_NOT_ADMITTED",
          `review ${review.reviewId} is not admitted for candidate ${candidate.commitSha}`,
        );
      }
    }
    return reviews;
  }

  private assertSamePlan(
    prepared: StoredPromotionPlan,
    current: StoredPromotionPlan,
    when: string,
  ): void {
    if (planFingerprint(prepared) !== planFingerprint(current)) {
      throw new PromotionError(
        "RECORD_CAS",
        `promotion records changed ${when}`,
      );
    }
  }

  private async assertBranchTip(plan: StoredPromotionPlan): Promise<void> {
    const branchRef = `refs/heads/${plan.task.branch}`;
    const resolved = await runGit(this.repoRoot, [
      "rev-parse",
      "--verify",
      `${branchRef}^{commit}`,
    ]);
    if (resolved.exitCode !== 0) {
      throw new PromotionError(
        "PREDICTED_SHA_MISMATCH",
        `task branch ${plan.task.branch} does not resolve to a commit in ${this.repoRoot}`,
      );
    }
    const tip = resolved.stdout.trim();
    if (tip !== plan.candidate.commitSha) {
      throw new PromotionError(
        "PREDICTED_SHA_MISMATCH",
        `predicted result ${plan.candidate.commitSha} does not match task branch ${plan.task.branch} at ${tip}`,
      );
    }
  }

  /** Atomic, fast-forward-only stage-ref move. */
  private async casUpdateRef(
    daemonRef: string,
    newSha: string,
    expectedHeadSha: string,
  ): Promise<RefWriteKind> {
    const object = await runGit(this.repoRoot, ["cat-file", "-t", newSha]);
    if (object.exitCode !== 0 || object.stdout.trim() !== "commit") {
      throw new PromotionError(
        "PREDICTED_SHA_MISMATCH",
        `predicted result ${newSha} is not a commit in ${this.repoRoot}`,
      );
    }

    if (newSha !== expectedHeadSha) {
      const ancestor = await runGit(this.repoRoot, [
        "merge-base",
        "--is-ancestor",
        expectedHeadSha,
        newSha,
      ]);
      if (ancestor.exitCode !== 0) {
        throw new PromotionError(
          "PREDICTED_SHA_MISMATCH",
          `predicted result ${newSha} is not a fast-forward of stage head ${expectedHeadSha}`,
        );
      }
    }

    const current = await runGit(this.repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      daemonRef,
    ]);
    if (current.exitCode !== 0) {
      const create = await runGit(this.repoRoot, [
        "update-ref",
        daemonRef,
        newSha,
        ZERO_SHA,
      ]);
      if (create.exitCode !== 0) {
        throw new PromotionError(
          "REF_CAS",
          create.stderr.trim() ||
            `git update-ref CAS failed creating ${daemonRef}`,
        );
      }
      const readback = await runGit(this.repoRoot, [
        "rev-parse",
        "--verify",
        daemonRef,
      ]);
      if (readback.exitCode !== 0 || readback.stdout.trim() !== newSha) {
        throw new PromotionError(
          "REF_CAS",
          `stage ref ${daemonRef} was not left at ${newSha}`,
        );
      }
      return "created";
    }

    const tip = current.stdout.trim();
    if (tip !== expectedHeadSha) {
      throw new PromotionError(
        "REF_CAS",
        `stage ref ${daemonRef} is at ${tip}, stage expected ${expectedHeadSha}`,
      );
    }
    const update = await runGit(this.repoRoot, [
      "update-ref",
      daemonRef,
      newSha,
      expectedHeadSha,
    ]);
    if (update.exitCode !== 0) {
      throw new PromotionError(
        "REF_CAS",
        update.stderr.trim() || `git update-ref CAS failed for ${daemonRef}`,
      );
    }
    return "updated";
  }

  private async rollbackRef(
    daemonRef: string,
    priorSha: string,
    promotedSha: string,
    refWrite: RefWriteKind,
  ): Promise<void> {
    if (refWrite === "created") {
      const remove = await runGit(this.repoRoot, [
        "update-ref",
        "-d",
        daemonRef,
        promotedSha,
      ]);
      if (remove.exitCode !== 0) {
        throw new PromotionError(
          "REF_CAS",
          remove.stderr.trim() ||
            `git update-ref rollback failed deleting ${daemonRef}`,
        );
      }
      const readback = await runGit(this.repoRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        daemonRef,
      ]);
      if (readback.exitCode === 0) {
        throw new PromotionError(
          "REF_CAS",
          `stage ref ${daemonRef} was not restored to its absent state`,
        );
      }
      return;
    }
    const rollback = await runGit(this.repoRoot, [
      "update-ref",
      daemonRef,
      priorSha,
      promotedSha,
    ]);
    if (rollback.exitCode !== 0) {
      throw new PromotionError(
        "REF_CAS",
        rollback.stderr.trim() ||
          `git update-ref rollback failed for ${daemonRef}`,
      );
    }
    const readback = await runGit(this.repoRoot, [
      "rev-parse",
      "--verify",
      daemonRef,
    ]);
    if (readback.exitCode !== 0 || readback.stdout.trim() !== priorSha) {
      throw new PromotionError(
        "REF_CAS",
        `stage ref ${daemonRef} was not restored to ${priorSha}`,
      );
    }
  }
}

function sameBinding(left: AgentBindingRef, right: AgentBindingRef): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.agentId === right.agentId &&
    left.generation === right.generation
  );
}

function bindingLabel(binding: AgentBindingRef): string {
  return `${binding.agentId}@${binding.nodeId}#${String(binding.generation)}`;
}

function planFingerprint(plan: StoredPromotionPlan): string {
  return canonicalJson({
    binding: plan.binding,
    node: plan.node,
    run: plan.run,
    fences: plan.fences,
    task: plan.task,
    chain: plan.chain,
    reviews: plan.reviews,
    candidate: plan.candidate,
    stage: plan.stage,
  });
}

function missingValidationEvidenceStore(commitSha: string): PromotionError {
  return new PromotionError(
    "VALIDATION_EVIDENCE_STORE_MISSING",
    `no durable validation-evidence store exists for commit ${commitSha}`,
  );
}

/** Refuse runtime smuggling even though production supplies this object itself. */
export function assertAuthorityOnly(authority: PromotionAuthority): void {
  const allowed = new Set(["binding", "capabilityEpoch"]);
  for (const key of Object.keys(authority as Record<string, unknown>)) {
    if (allowed.has(key)) continue;
    throw new PromotionError(
      "STAGE_MISMATCH",
      `caller-supplied ${key} is refused; promotion evidence is derived from stored records`,
    );
  }
}
