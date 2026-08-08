// The hierarchy subsystem's one public boundary. Everything that reads or writes hierarchy state goes through this object: the store instance, run-scoped fence derivation, authenticated record writes, promotion, the land classification that pairs with it, and run control. Callers hold the service and never the store, so there is one thing that IS the hierarchy rather than six that each own a piece. Every write method here authorizes the capability and resolves the caller's live binding INSIDE the same store transaction as the write. That ordering is the subsystem's rule, not an adapter's: a check that finishes before the transaction opens can be true at the check and false at the write.

import type { AgentRecord } from "../../schemas/agent";
import {
  type AgentBindingRef,
  DelegationGrantSchema,
  type HierarchyNode,
} from "../../schemas/hierarchy-node";
import type { Run } from "../../schemas/hierarchy-run";
import { ReviewSchema } from "../../schemas/integration-stage";
import type { CheckpointEvent } from "../../schemas/run-checkpoint";
import type {
  RunControlIntent,
  RunControlResult,
} from "../../schemas/run-control";
import {
  type TaskCreateInput,
  type TaskDetail,
  TaskDetailSchema,
} from "../../schemas/task-detail";
import { errorMessage } from "../../shared/error-message";
import type {
  Action,
  Capability,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import { HierarchyStore } from "../hierarchy-store";
import type { HierarchyLanding } from "../landing/landing-service";
import type { MachineMutationCoordinator } from "../mutation-lease";
import { SpawnAdmission } from "../spawn/admission";
import { RunControl } from "./hierarchy-run-control";
import { type PromotionAuthority, PromotionEngine } from "./promotion";
import type { AuthorityFences } from "./records";
import {
  bindingRef,
  type HierarchyActingBinding,
  isRootActingBinding,
  requireActingBinding,
} from "./tool-authority";

type AuthorizeTool = (
  capability: Capability,
  tool: string,
  action: Action,
  subject?: string,
  auditAllow?: boolean,
) => void;

export type HierarchyServiceOptions = {
  db: HiveDatabase;
  repoRoot: string;
  authorizeTool: AuthorizeTool;
  /** The daemon's record of a semantic boundary. Task completion, gate movement, and work landing are boundaries the daemon writes at the event rather than waiting for the root to volunteer one. The decision is already durable before this runs, so a throw here is logged and never charged against it. */
  writeBoundaryCheckpoint?: (event: CheckpointEvent, run: Run | null) => void;
  /** Landing mutates the machine, so it takes the machine-wide operation lease. */
  machineMutations?: Pick<MachineMutationCoordinator, "beginOperation">;
  onLanded?: (agent: AgentRecord, commit: string) => Promise<void>;
  now?: () => Date;
};

function sameBinding(left: AgentBindingRef, right: AgentBindingRef): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.agentId === right.agentId &&
    left.generation === right.generation
  );
}

export class HierarchyService {
  private readonly db: HiveDatabase;
  private readonly store: HierarchyStore;
  private readonly promotion: PromotionEngine;
  private readonly runControl: RunControl;
  /** Spawn admission, holding the identity reservations and pending launch briefs of hierarchy spawns in progress. That state is not durable, so it must have exactly one holder: a second SpawnAdmission over the same database would reserve identities the first cannot see. */
  readonly admission: SpawnAdmission;
  private readonly authorizeTool: AuthorizeTool;
  private readonly boundaryWriter?: HierarchyServiceOptions["writeBoundaryCheckpoint"];
  private readonly machineMutations?: Pick<
    MachineMutationCoordinator,
    "beginOperation"
  >;
  private readonly onLanded?: HierarchyServiceOptions["onLanded"];

  constructor(options: HierarchyServiceOptions) {
    this.db = options.db;
    this.store = new HierarchyStore(options.db);
    this.promotion = new PromotionEngine({
      store: this.store,
      repoRoot: options.repoRoot,
    });
    this.admission = new SpawnAdmission(this.store, options.now);
    this.authorizeTool = options.authorizeTool;
    this.machineMutations = options.machineMutations;
    this.onLanded = options.onLanded;
    this.boundaryWriter = options.writeBoundaryCheckpoint;
    this.runControl = new RunControl(this.store, (accepted, after) => {
      this.recordBoundary(
        accepted.body.operation === "approve-g1" ||
          accepted.body.operation === "approve-g2"
          ? "gate-transition"
          : "run-control",
        after,
      );
    });
  }

  private recordBoundary(event: CheckpointEvent, run: Run | null): void {
    try {
      this.boundaryWriter?.(event, run);
    } catch (error) {
      console.error(
        `[hive] could not write the ${event} boundary checkpoint: ${errorMessage(
          error,
        )}`,
      );
    }
  }

  /** The fences a write must clear, read from the run at the moment of the write. Derived here and nowhere else: a second derivation is a second answer to "what is current", and one of them is stale. */
  private liveFences(
    runId: string,
    binding: AgentBindingRef,
    capabilityEpoch: number,
  ): AuthorityFences {
    const fences = this.store.getFences(runId);
    if (fences === null) {
      throw new Error(`run ${runId} has no hierarchy fences`);
    }
    return {
      expectedHierarchyRevision: fences.hierarchyRevision,
      expectedRunEpoch: fences.runEpoch,
      expectedCapabilityEpoch: capabilityEpoch,
      binding,
    };
  }

  private acting(
    capability: Capability,
    runId?: string,
  ): HierarchyActingBinding {
    return requireActingBinding(
      capability,
      {
        db: this.db,
        store: this.store,
      },
      runId,
    );
  }

  private nodeRunId(nodeId: string): string {
    const node = this.store.getNode(nodeId);
    if (node === null) {
      throw new Error(`owner node ${nodeId} must exist`);
    }
    return node.runId;
  }

  issueGrant(
    capability: Capability,
    input: Omit<
      ReturnType<typeof DelegationGrantSchema.parse>,
      "issuer" | "capabilityEpoch"
    >,
  ): ReturnType<HierarchyStore["putGrant"]> {
    return this.store.transaction(() => {
      this.authorizeTool(capability, "hive_grant_issue", "grant:issue");
      const acting = this.acting(capability, input.runId);
      const issuer = bindingRef(acting);
      // Grant fence pins the flat AgentRecord epoch (validated against the capability in requireActingBinding), not a frozen copy on the binding.
      const grant = DelegationGrantSchema.parse({
        ...input,
        issuer,
        capabilityEpoch: capability.epoch,
      });
      return this.store.putGrant(
        grant,
        {
          expectedHierarchyRevision: grant.hierarchyRevision,
          expectedRunEpoch: grant.runEpoch,
          expectedCapabilityEpoch: capability.epoch,
          binding: issuer,
        },
        isRootActingBinding(acting) ? "run-root" : "acting-binding",
      );
    });
  }

  createTask(capability: Capability, input: TaskCreateInput): TaskDetail {
    return this.store.transaction(() => {
      this.authorizeTool(capability, "hive_task_create", "task:write");
      const { runId, ...record } = input;
      const acting = this.acting(capability, runId);
      const owner = bindingRef(acting);
      const task = TaskDetailSchema.parse({
        ...record,
        ownerNodeId: acting.nodeId,
        delegationSpec: {
          ...input.delegationSpec,
          allowance: { ...input.delegationSpec.allowance, owner },
        },
      });
      return this.store.putTask(task);
    });
  }

  updateTask(
    capability: Capability,
    input: Omit<Parameters<HierarchyStore["updateTask"]>[0], "actorNodeId">,
  ): TaskDetail {
    const { before, task } = this.store.transaction(() => {
      this.authorizeTool(capability, "hive_task_update", "task:write");
      const current = this.store.getTask(input.taskId);
      const acting = this.acting(
        capability,
        current === null ? undefined : this.nodeRunId(current.ownerNodeId),
      );
      return {
        before: current,
        task: this.store.updateTask({
          ...input,
          actorNodeId: acting.nodeId,
        }),
      };
    });
    if (before?.state !== "completed" && task.state === "completed") {
      this.recordBoundary(
        "task-completion",
        this.store.getRun(this.nodeRunId(task.ownerNodeId)),
      );
    }
    return task;
  }

  startTaskFromSpawn(
    taskId: string,
    agentId: string,
    agentName: string,
  ): TaskDetail {
    return this.store.transaction(() => {
      const current = this.store.getTask(taskId);
      if (current === null) throw new Error(`task ${taskId} is not stored`);
      if (current.state === "completed" || current.state === "terminated") {
        throw new Error(`cannot spawn against ${current.state} task ${taskId}`);
      }
      const binding = this.store.findLiveBindingByAgentId(agentId);
      return this.store.updateTask({
        taskId,
        expectedRevision: current.revision,
        actorNodeId: current.ownerNodeId,
        state: "in-progress",
        ...(binding === null ? {} : { assigneeNodeId: binding.nodeId }),
        blockers: [
          `IN PROGRESS. Assignee: ${agentName} (${agentId}).`,
          ...current.blockers,
        ],
      });
    });
  }

  putReview(
    capability: Capability,
    review: Omit<ReturnType<typeof ReviewSchema.parse>, "reviewer">,
  ): ReturnType<HierarchyStore["putReview"]> {
    return this.store.transaction(() => {
      this.authorizeTool(capability, "hive_review_put", "review:write");
      const task = this.store.getTask(review.revisions.task.taskId);
      if (task === null) {
        throw new Error(
          `review task ${review.revisions.task.taskId} is not stored`,
        );
      }
      if (task.revision !== review.revisions.task.revision) {
        throw new Error(
          `review task ${task.taskId} expected revision ${review.revisions.task.revision}, current is ${task.revision}`,
        );
      }
      const ownerNode = this.store.getNode(task.ownerNodeId);
      if (ownerNode === null) {
        throw new Error(`review task ${task.taskId} has no stored owner node`);
      }
      const acting = this.acting(capability, ownerNode.runId);
      const node = this.store.getNode(acting.nodeId);
      if (node === null) {
        throw new Error(`review caller node ${acting.nodeId} does not exist`);
      }
      if (node.runId !== ownerNode.runId) {
        throw new Error(
          `review caller node ${node.nodeId} belongs to run ${node.runId}, not ${ownerNode.runId}`,
        );
      }
      if (node.assignmentKind !== "reviewer") {
        throw new Error(
          `review caller node ${node.nodeId} has assignment kind ${node.assignmentKind}, not reviewer`,
        );
      }
      if (!node.taskScope.includes(task.taskId)) {
        throw new Error(
          `review caller node ${node.nodeId} is not assigned to task ${task.taskId}`,
        );
      }
      for (const author of review.authors) {
        const authorBinding = this.store.getAgentBinding(author);
        const authorNode = this.store.getNode(author.nodeId);
        if (
          authorBinding === null ||
          authorBinding.unboundAt !== null ||
          authorNode === null ||
          authorNode.runId !== ownerNode.runId ||
          authorNode.assignmentKind !== "author" ||
          !authorNode.taskScope.includes(task.taskId)
        ) {
          throw new Error(
            `review author ${author.agentId}@${author.nodeId} is not a live author for task ${task.taskId}`,
          );
        }
      }
      const assigneeBindings =
        task.assigneeNodeId === null
          ? []
          : this.store
              .findBindingsByNode(task.assigneeNodeId)
              .filter((binding) => binding.unboundAt === null);
      if (
        !review.authors.some((author) =>
          assigneeBindings.some((binding) => sameBinding(author, binding)),
        )
      ) {
        throw new Error(
          `review authors do not include the live assignee for task ${task.taskId}`,
        );
      }
      return this.store.putReview(
        ReviewSchema.parse({ ...review, reviewer: bindingRef(acting) }),
        ownerNode.runId,
      );
    });
  }

  transferOwnership(
    capability: Capability,
    input: {
      transfer: Parameters<HierarchyStore["transferOwnership"]>[0];
      expectedHierarchyRevision: string;
      expectedRunEpoch: number;
    },
  ): ReturnType<HierarchyStore["transferOwnership"]> {
    const { transfer, expectedHierarchyRevision, expectedRunEpoch } = input;
    return this.store.transaction(() => {
      this.authorizeTool(
        capability,
        "hive_ownership_transfer",
        "ownership:transfer",
      );
      const acting = this.acting(capability, transfer.runId);
      const actingRef = bindingRef(acting);
      const successorGrant = this.store.getGrant(transfer.successorGrantId);
      if (successorGrant === null) {
        throw new Error(
          `successor grant ${transfer.successorGrantId} is not stored`,
        );
      }
      const successor = this.store.getAgentBinding(successorGrant.subject);
      if (successor === null) {
        throw new Error(
          `successor grant ${transfer.successorGrantId} subject binding is not stored`,
        );
      }
      if (successor.unboundAt !== null) {
        throw new Error(
          `successor grant ${transfer.successorGrantId} subject binding is unbound`,
        );
      }
      return this.store.transferOwnership(
        transfer,
        {
          expectedHierarchyRevision,
          expectedRunEpoch,
          expectedCapabilityEpoch: capability.epoch,
          binding: actingRef,
        },
        this.liveFences(
          transfer.runId,
          bindingRef(successor),
          this.store.liveCapabilityEpoch(successor),
        ),
      );
    });
  }

  /** Who may hang a new node where. The run root may create anywhere in its own run; anyone else may create only under a node it already holds — its own seat or a descendant of it. That is the same containment relation grants are checked against, so authority over a subtree means one thing in this codebase rather than two. The run root itself is not creatable here: it must exist before any hierarchy identity can act, so no caller could authorize it. */
  private assertMayCreateUnder(
    acting: AgentBindingRef,
    runId: string,
    parentNodeId: string | null,
  ): void {
    if (parentNodeId === null) {
      throw new Error(
        "a run root is not created through this tool: it exists before any hierarchy identity can act",
      );
    }
    const actingNode = this.store.getNode(acting.nodeId);
    if (actingNode === null || actingNode.runId !== runId) {
      throw new Error(
        `acting node ${acting.nodeId} does not belong to run ${runId}`,
      );
    }
    if (actingNode.parentNodeId === null) return;
    if (!this.store.nodeIsUnderAncestor(parentNodeId, actingNode.nodeId)) {
      throw new Error(
        `acting node ${actingNode.nodeId} is not the run root and does not hold parent ${parentNodeId}`,
      );
    }
  }

  createNode(capability: Capability, node: HierarchyNode): HierarchyNode {
    return this.store.transaction(() => {
      this.authorizeTool(capability, "hive_node_create", "node:create");
      const acting = this.acting(capability, node.runId);
      this.assertMayCreateUnder(acting, node.runId, node.parentNodeId);
      return this.store.putNode(node, null, undefined, {
        binding: bindingRef(acting),
        expectedCapabilityEpoch: capability.epoch,
      });
    });
  }

  /** Classify one agent's land without letting a dead hierarchy identity fall through to the flat main merger. Null means the store has no hierarchy evidence for this agent at all; every partial or stale hierarchy identity fails closed. The authority derived here is bound into the returned `land`, so resolving and landing cannot be wired apart: a caller holding this object lands with exactly this authority, and a caller holding none cannot land through the hierarchy at all. */
  resolveLand(capability: Capability, name: string): HierarchyLanding | null {
    const target = this.db.getAgentByName(name);
    if (target === null) return null;
    const bindings = this.store.findBindingsByAgent(target.id);
    const grants = this.store.findGrantsBySubjectAgent(target.id);
    if (bindings.length === 0 && grants.length === 0) return null;

    const acting = this.acting(capability);
    const locator = target.sessionLocator;
    if (
      target.id !== acting.agentId ||
      locator === undefined ||
      locator.subject.kind !== "agent" ||
      locator.subject.agentId !== acting.agentId ||
      locator.generation !== acting.generation
    ) {
      throw new Error(
        `hierarchy land caller ${capability.subject} is not ${name}'s exact live binding`,
      );
    }
    const authority: PromotionAuthority = {
      binding: bindingRef(acting),
      capabilityEpoch: capability.epoch,
    };
    return { land: () => this.land(authority) };
  }

  private async land(
    authority: PromotionAuthority,
  ): Promise<{ commit: string }> {
    const operation = await this.machineMutations?.beginOperation("landing");
    try {
      const landed = await this.promotion.promote(authority);
      const agent = this.db.getAgentById(authority.binding.agentId);
      if (agent !== null) await this.onLanded?.(agent, landed.commit);
      this.recordBoundary("promotion-boundary", null);
      return { commit: landed.commit };
    } finally {
      operation?.release();
    }
  }

  applyRunControl(intent: RunControlIntent, decider: string): RunControlResult {
    return this.runControl.apply(intent, decider);
  }

  /** Read one task's full record. No authority check: callers that expose this over MCP authorize on their own surface (hive_task_get). */
  getTask(taskId: string): TaskDetail | null {
    return this.store.getTask(taskId);
  }

  listTasks(): TaskDetail[] {
    return this.store.listAllTasks();
  }
}
