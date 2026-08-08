// Hierarchy-run spawn admission. This module owns the authority check that happens before a provider starts, the generation-bound launch brief, and the binding written only after the provider proves ready. Flat spawns never enter this module.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentRecord } from "../../schemas/agent";
import {
  type AgentBinding,
  type AgentBindingRef,
  AgentBindingSchema,
  type AssignmentKind,
  AssignmentKindSchema,
  BriefIdSchema,
  type DelegationGrant,
  DelegationSpecSchema,
  GrantIdSchema,
  isDelegationGrantAttenuation,
  NodeIdSchema,
  type SpawnBrief,
  SpawnBriefSchema,
} from "../../schemas/hierarchy-node";
import type {
  PlanRevision,
  Run,
  SpecRevision,
} from "../../schemas/hierarchy-run";
import type { TaskDetail } from "../../schemas/task-detail";
import {
  RunIdSchema,
  SafeUintSchema,
  TaskIdSchema,
} from "../../schemas/hierarchy-ids";
import { systemClock } from "../../shared/clock";
import { canonicalJson } from "../status-service/status-service";
import type { HierarchyStore } from "../hierarchy-store";
import { ABORTED_RUN_ADMISSION_SEAM } from "../hierarchy-service/hierarchy-run-control";

export const SpawnBriefInputSchema = z.strictObject({
  engineerConstraints: SpawnBriefSchema.shape.engineerConstraints.omit({
    specRevision: true,
  }),
  written: SpawnBriefSchema.shape.written,
});

/** Hierarchy fields stay optional after `runId` so admission, rather than a generic parser, can name the missing authority fact precisely. A request without `runId` is parsed by the separate flat schema and never reaches this shape. */
export const HierarchySpawnFieldsSchema = z.strictObject({
  runId: RunIdSchema,
  runEpoch: SafeUintSchema.optional(),
  nodeId: NodeIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  delegationSpec: DelegationSpecSchema.optional(),
  grantId: GrantIdSchema.optional(),
  spawnBrief: SpawnBriefInputSchema.optional(),
});
export type HierarchySpawnFields = z.infer<typeof HierarchySpawnFieldsSchema>;

export type HierarchySpawnIdentity = Readonly<{
  nodeId: string;
  agentId: string;
  generation: number;
  capabilityEpoch: number;
}>;

export type HierarchyLaunchFacts = Omit<
  AgentBinding,
  keyof AgentBindingRef | "credentialId" | "boundAt" | "unboundAt"
>;

export type HierarchyRecipientBindingState = "legacy" | "bound" | "unbound";

export class SpawnAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnAdmissionError";
  }
}

type CheckedAuthority = {
  fields: HierarchySpawnFields;
  grant: DelegationGrant;
  planRevision: PlanRevision;
  run: Run & { g1: Extract<Run["g1"], { state: "approved" }> };
  specRevision: SpecRevision;
  task: TaskDetail;
};

type Attempt = {
  assignmentKind: AssignmentKind;
  binding: AgentBinding | null;
  failed: boolean;
  fields: HierarchySpawnFields;
  identity: HierarchySpawnIdentity;
  launchFacts: HierarchyLaunchFacts | null;
  briefTaken: boolean;
};

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameBinding(left: AgentBindingRef, right: AgentBindingRef): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.agentId === right.agentId &&
    left.generation === right.generation
  );
}

function pathWithin(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}

type SpawnBriefContent = Omit<SpawnBrief, "digest">;

export function spawnBriefDigest(content: SpawnBriefContent): string {
  const hash = createHash("sha256").update(canonicalJson(content), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function exactSpecExcerpts(spec: SpecRevision): ReadonlySet<string> {
  return new Set([
    spec.objective,
    spec.scope,
    ...spec.nonGoals,
    ...spec.constraints.architecture,
    ...spec.constraints.security,
    ...spec.constraints.outwardEffect,
  ]);
}

export class SpawnAdmission {
  private readonly attempts = new Map<string, Attempt>();
  private readonly launchContexts = new Map<string, SpawnBrief>();

  constructor(
    private readonly store: HierarchyStore,
    private readonly now: () => Date = systemClock,
    private readonly makeBriefId: () => string = () =>
      `brief_${Bun.randomUUIDv7()}`,
  ) {}

  preflight(
    input: HierarchySpawnFields,
    assignmentKind: AssignmentKind,
  ): HierarchySpawnIdentity {
    const fields = HierarchySpawnFieldsSchema.parse(input);
    const parsedKind = AssignmentKindSchema.parse(assignmentKind);
    return this.store.transaction(() => {
      const checked = this.requireAuthority(fields, parsedKind);
      const identity = freezeDeep({
        ...checked.grant.subject,
        capabilityEpoch: checked.grant.capabilityEpoch,
      });
      // A failed attempt holds no launch — every other path already refuses to carry one — so it must not outrank a corrected retry, which would wedge the node's identity until restart. What keeps this closed is the store: an identity that was ever bound is refused just below, failed or not.
      const reserved = this.attempts.get(identity.agentId);
      if (reserved !== undefined && !reserved.failed) {
        throw new SpawnAdmissionError(
          `hierarchy identity ${identity.agentId} generation ${String(identity.generation)} is already reserved`,
        );
      }
      this.requireUnboundIdentity(identity);
      this.attempts.set(identity.agentId, {
        assignmentKind: parsedKind,
        binding: null,
        failed: false,
        fields,
        identity,
        launchFacts: null,
        briefTaken: false,
      });
      return identity;
    });
  }

  prepareLaunch(
    identity: HierarchySpawnIdentity,
    facts: HierarchyLaunchFacts,
  ): void {
    const attempt = this.requireAttempt(identity);
    this.store.transaction(() => {
      const checked = this.requireAuthority(
        attempt.fields,
        attempt.assignmentKind,
      );
      this.assertIdentity(identity, checked.grant);
      this.requireUnboundIdentity(identity);
      this.assertLaunchFacts(attempt.fields, identity, facts);
      if (this.launchContexts.has(identity.agentId)) {
        throw new SpawnAdmissionError("SpawnBrief was already created");
      }
      const briefInput = attempt.fields.spawnBrief;
      if (briefInput === undefined) {
        throw new SpawnAdmissionError(
          "hierarchy spawn requires a SpawnBrief input",
        );
      }
      const delegationSpec = checked.task.delegationSpec;
      const content: SpawnBriefContent = {
        briefId: BriefIdSchema.parse(this.makeBriefId()),
        engineerConstraints: {
          specRevision: checked.run.g1.spec,
          excerpts: briefInput.engineerConstraints.excerpts,
        },
        computedPointers: {
          planRevision: {
            revision: checked.planRevision.revision,
            digest: checked.planRevision.digest,
          },
          taskRevisions: delegationSpec.inputs.taskRevisions,
          contractRevisions: delegationSpec.inputs.interfaceRevisions,
          branch: facts.branch,
          worktree: facts.worktree,
          baseSha: facts.baseSha,
          sourceProvenance: delegationSpec.inputs.sourceArtifactRefs,
          graphProvenance: [],
        },
        written: briefInput.written,
        delegationSpec,
        grant: checked.grant,
        contextBudget: delegationSpec.allowance.tokens,
        recoveryCheckpoint: null,
        workManifest: null,
        agentId: identity.agentId,
        generation: identity.generation,
      };
      const brief = freezeDeep(
        SpawnBriefSchema.parse({
          ...content,
          digest: spawnBriefDigest(content),
        }),
      );
      this.assertBrief(checked, facts, brief);
      attempt.launchFacts = structuredClone(facts);
      this.launchContexts.set(identity.agentId, brief);
    });
  }

  takeLaunchContext(identity: HierarchySpawnIdentity): SpawnBrief {
    const attempt = this.requireAttempt(identity);
    const brief = this.launchContexts.get(identity.agentId);
    if (brief === undefined) {
      throw new SpawnAdmissionError(
        "SpawnBrief launch context was already taken",
      );
    }
    this.launchContexts.delete(identity.agentId);
    attempt.briefTaken = true;
    return brief;
  }

  revalidateLaunch(identity: HierarchySpawnIdentity): void {
    const attempt = this.requireAttempt(identity);
    const launchFacts = attempt.launchFacts;
    if (!attempt.briefTaken || launchFacts === null) {
      throw new SpawnAdmissionError(
        "hierarchy launch provenance is not ready for provider launch",
      );
    }
    this.store.transaction(() => {
      const checked = this.requireAuthority(
        attempt.fields,
        attempt.assignmentKind,
      );
      this.assertIdentity(identity, checked.grant);
      this.requireUnboundIdentity(identity);
      this.assertLaunchFacts(attempt.fields, identity, launchFacts);
    });
  }

  bindAfterReadiness(
    identity: HierarchySpawnIdentity,
    credentialId: string,
  ): AgentBinding {
    const attempt = this.requireAttempt(identity);
    if (!attempt.briefTaken) {
      throw new SpawnAdmissionError(
        "hierarchy binding requires the one-shot launch context to be consumed",
      );
    }
    if (attempt.launchFacts === null) {
      throw new SpawnAdmissionError("hierarchy launch facts are unavailable");
    }
    return this.store.transaction(() => {
      const checked = this.requireAuthority(
        attempt.fields,
        attempt.assignmentKind,
      );
      this.assertIdentity(identity, checked.grant);
      this.requireUnboundIdentity(identity);
      const binding = AgentBindingSchema.parse({
        nodeId: identity.nodeId,
        agentId: identity.agentId,
        generation: identity.generation,
        ...attempt.launchFacts,
        credentialId,
        boundAt: this.now().toISOString(),
        unboundAt: null,
      });
      this.assertBindingIdentity(binding);
      const stored = this.store.putAgentBinding(binding, attempt.fields.runId);
      attempt.binding = structuredClone(stored);
      return stored;
    });
  }

  failLaunch(identity: HierarchySpawnIdentity): AgentBinding | null {
    const attempt = this.findAttempt(identity);
    attempt.failed = true;
    // The brief was minted for this attempt alone, and nothing can take it now that the attempt is failed. Keeping it would only refuse the retry its own brief — the same identity wedged one step later.
    this.launchContexts.delete(identity.agentId);
    return this.store.transaction(() => {
      const ownedBinding = attempt.binding;
      if (ownedBinding === null) return null;
      const binding = this.store.getAgentBinding(attempt.identity);
      if (
        binding === null ||
        binding.unboundAt !== null ||
        !sameJson(binding, ownedBinding)
      ) {
        return binding;
      }
      return this.store.putAgentBinding(
        { ...binding, unboundAt: this.now().toISOString() },
        attempt.fields.runId,
      );
    });
  }

  recipientBindingState(
    recipient: AgentRecord,
  ): HierarchyRecipientBindingState {
    const attempt = this.attempts.get(recipient.id);
    if (attempt?.failed) return "unbound";
    const grants = this.store.findGrantsBySubjectAgent(recipient.id);
    if (grants.length === 0) {
      return attempt === undefined ? "legacy" : "unbound";
    }
    const locator = recipient.sessionLocator;
    if (locator === undefined) return "unbound";
    if (
      attempt !== undefined &&
      attempt.identity.generation !== locator.generation
    ) {
      return "unbound";
    }
    const exactGrants = grants.filter(
      (candidate) => candidate.subject.generation === locator.generation,
    );
    if (exactGrants.length !== 1) return "unbound";
    const grant = exactGrants[0];
    if (grant === undefined) return "unbound";
    const binding = this.store.getAgentBinding(grant.subject);
    if (
      binding === null ||
      binding.unboundAt !== null ||
      (attempt !== undefined &&
        (attempt.binding === null || !sameJson(attempt.binding, binding))) ||
      binding.agentId !== recipient.id ||
      binding.provider !== recipient.tool ||
      binding.model !== recipient.model ||
      !sameJson(binding.sessionLocator, locator) ||
      binding.worktree !== recipient.worktreePath ||
      binding.branch !== recipient.branch
    ) {
      return "unbound";
    }
    return "bound";
  }

  private requireAuthority(
    fields: HierarchySpawnFields,
    assignmentKind: AssignmentKind,
  ): CheckedAuthority {
    const run = this.store.getRun(fields.runId);
    if (run === null) {
      throw new SpawnAdmissionError(
        `hierarchy Run ${fields.runId} does not exist`,
      );
    }
    const g1 = run.g1;
    if (g1.state !== "approved" || run.approvedSpec === null) {
      throw new SpawnAdmissionError(
        `hierarchy Run ${fields.runId} has no approved G1`,
      );
    }
    const approvedRun = { ...run, g1 };
    const specRevision = this.store.getSpecRevision(
      fields.runId,
      g1.spec.revision,
    );
    if (specRevision === null || specRevision.digest !== g1.spec.digest) {
      throw new SpawnAdmissionError(
        `hierarchy Run ${fields.runId} has no stored approved SpecRevision`,
      );
    }
    const planRevision = this.store.getPlanRevision(
      fields.runId,
      run.currentPlan.revision,
    );
    if (
      planRevision === null ||
      planRevision.digest !== run.currentPlan.digest
    ) {
      throw new SpawnAdmissionError(
        `hierarchy Run ${fields.runId} has no stored current PlanRevision`,
      );
    }
    if (!sameJson(run.approvedSpec, g1.spec) || run.lifecycle !== "active") {
      throw new SpawnAdmissionError(
        `hierarchy Run ${fields.runId} is not active under its approved G1 (${ABORTED_RUN_ADMISSION_SEAM})`,
      );
    }
    if (fields.runEpoch === undefined) {
      throw new SpawnAdmissionError("hierarchy spawn requires runEpoch");
    }
    const fences = this.store.getFences(fields.runId);
    if (
      fences === null ||
      run.runEpoch !== fences.runEpoch ||
      fields.runEpoch !== fences.runEpoch
    ) {
      throw new SpawnAdmissionError(
        `hierarchy spawn runEpoch ${String(fields.runEpoch)} is not the live runEpoch`,
      );
    }
    if (fields.taskId === undefined) {
      throw new SpawnAdmissionError(
        "hierarchy spawn requires an assigned Task",
      );
    }
    const task = this.store.getTask(fields.taskId);
    if (task === null) {
      throw new SpawnAdmissionError(
        `assigned Task ${fields.taskId} does not exist`,
      );
    }
    if (fields.nodeId === undefined) {
      throw new SpawnAdmissionError("assigned Task requires a hierarchy node");
    }
    const node = this.store.getNode(fields.nodeId);
    if (
      node === null ||
      node.runId !== fields.runId ||
      node.lifecycle !== "active" ||
      node.assignmentKind !== assignmentKind ||
      !node.taskScope.includes(fields.taskId)
    ) {
      throw new SpawnAdmissionError(
        `Task ${fields.taskId} is not in an active ${assignmentKind} node for Run ${fields.runId}`,
      );
    }
    if (task.assigneeNodeId !== fields.nodeId || task.state !== "assigned") {
      throw new SpawnAdmissionError(
        `Task ${fields.taskId} is not assigned to node ${fields.nodeId}`,
      );
    }
    if (fields.delegationSpec === undefined) {
      throw new SpawnAdmissionError(
        "hierarchy spawn requires a DelegationSpec",
      );
    }
    if (!sameJson(task.delegationSpec, fields.delegationSpec)) {
      throw new SpawnAdmissionError(
        `DelegationSpec does not match assigned Task ${fields.taskId}`,
      );
    }
    const spec = fields.delegationSpec;
    if (
      !sameJson(spec.inputs.specRevision, g1.spec) ||
      !sameJson(spec.inputs.planRevision, run.currentPlan) ||
      !spec.inputs.taskRevisions.some(
        (ref) => ref.taskId === task.taskId && ref.revision === task.revision,
      ) ||
      spec.inputs.baseSha !== task.baseSha ||
      task.baseSha !== run.baseSha
    ) {
      throw new SpawnAdmissionError(
        "DelegationSpec pointers do not match the approved Run and assigned Task",
      );
    }
    if (fields.grantId === undefined) {
      throw new SpawnAdmissionError("hierarchy spawn requires a grant");
    }
    if (spec.authority.grantId !== fields.grantId) {
      throw new SpawnAdmissionError(
        "DelegationSpec authority does not name the spawn grant",
      );
    }
    const grant = this.store.getGrant(fields.grantId);
    if (grant === null) {
      throw new SpawnAdmissionError(
        `spawn grant ${fields.grantId} does not exist`,
      );
    }
    if (
      grant.runId !== fields.runId ||
      grant.subject.nodeId !== fields.nodeId ||
      task.ownerNodeId !== grant.issuer.nodeId ||
      node.ownerNodeId !== task.ownerNodeId ||
      !grant.taskIds.includes(fields.taskId) ||
      !grant.branches.includes(task.branch) ||
      spec.authority.branch !== task.branch ||
      !sameBinding(spec.allowance.owner, grant.issuer) ||
      !spec.authority.permittedOperations.every((action) =>
        grant.actions.includes(action),
      ) ||
      spec.allowance.sessions > grant.budget.sessions ||
      spec.allowance.tokens > grant.budget.tokens ||
      spec.allowance.costCents > grant.budget.costCents ||
      spec.allowance.wallTimeMs > grant.budget.wallTimeMs ||
      spec.allowance.retries > grant.budget.retries ||
      !task.pathLeases.every((lease) =>
        grant.paths.some((scope) => pathWithin(lease.path, scope)),
      ) ||
      !spec.boundaries.allowedPaths.every((path) =>
        grant.paths.some((scope) => pathWithin(path, scope)),
      )
    ) {
      throw new SpawnAdmissionError(
        "spawn grant does not cover the assigned Task and DelegationSpec",
      );
    }
    this.requireGrantChain(grant, fields.runId, fences);
    return {
      fields,
      grant,
      planRevision,
      run: approvedRun,
      specRevision,
      task,
    };
  }

  private requireGrantChain(
    grant: DelegationGrant,
    runId: string,
    fences: { hierarchyRevision: string; runEpoch: number },
  ): void {
    const visited = new Set<string>();
    let child = grant;
    let immediateParent: DelegationGrant | null = null;
    for (;;) {
      if (visited.has(child.grantId)) {
        throw new SpawnAdmissionError("spawn grant chain contains a cycle");
      }
      visited.add(child.grantId);
      this.requireLiveGrant(child, runId, fences);
      if (child.parentGrantId === null) break;
      const parent = this.store.getGrant(child.parentGrantId);
      if (parent === null) {
        throw new SpawnAdmissionError(
          `parent grant ${child.parentGrantId} does not exist`,
        );
      }
      if (!isDelegationGrantAttenuation(parent, child)) {
        throw new SpawnAdmissionError(
          `grant ${child.grantId} is not a valid attenuation of ${parent.grantId}`,
        );
      }
      if (immediateParent === null) immediateParent = parent;
      child = parent;
    }
    if (
      immediateParent === null &&
      this.store.rootBindingMatches(runId, grant.issuer)
    ) {
      return;
    }
    if (
      immediateParent === null ||
      !immediateParent.actions.includes("spawn")
    ) {
      throw new SpawnAdmissionError(
        "spawn grant requires a parent grant with spawn authority",
      );
    }
  }

  private requireLiveGrant(
    grant: DelegationGrant,
    runId: string,
    fences: { hierarchyRevision: string; runEpoch: number },
  ): void {
    if (
      grant.status !== "active" ||
      Date.parse(grant.expiresAt) <= this.now().getTime() ||
      grant.runId !== runId ||
      grant.hierarchyRevision !== fences.hierarchyRevision ||
      grant.runEpoch !== fences.runEpoch
    ) {
      throw new SpawnAdmissionError(
        `grant ${grant.grantId} is not live under the current Run fences`,
      );
    }
    if (this.store.rootBindingMatches(runId, grant.issuer)) {
      if (grant.capabilityEpoch !== 0) {
        throw new SpawnAdmissionError(
          `grant ${grant.grantId} has a stale root capability epoch`,
        );
      }
      return;
    }
    const issuer = this.store.getAgentBinding(grant.issuer);
    if (
      issuer === null ||
      issuer.unboundAt !== null ||
      this.store.liveCapabilityEpoch(issuer) !== grant.capabilityEpoch
    ) {
      throw new SpawnAdmissionError(
        `grant ${grant.grantId} has no live issuer binding`,
      );
    }
  }

  private assertLaunchFacts(
    fields: HierarchySpawnFields,
    identity: HierarchySpawnIdentity,
    facts: HierarchyLaunchFacts,
  ): void {
    const spec = fields.delegationSpec;
    if (
      spec === undefined ||
      fields.spawnBrief === undefined ||
      facts.worktree !== spec.authority.worktree ||
      facts.branch !== spec.authority.branch ||
      facts.baseSha !== spec.inputs.baseSha
    ) {
      throw new SpawnAdmissionError(
        "launch worktree, branch, or base does not match delegated provenance",
      );
    }
    this.assertBindingIdentity({
      nodeId: identity.nodeId,
      agentId: identity.agentId,
      generation: identity.generation,
      ...facts,
      credentialId: "not-yet-issued",
      boundAt: this.now().toISOString(),
      unboundAt: null,
    });
  }

  private assertBrief(
    checked: CheckedAuthority,
    facts: HierarchyLaunchFacts,
    brief: SpawnBrief,
  ): void {
    const spec = checked.task.delegationSpec;
    const permittedExcerpts = exactSpecExcerpts(checked.specRevision);
    const { digest, ...content } = brief;
    if (
      digest !== spawnBriefDigest(content) ||
      !brief.engineerConstraints.excerpts.every((excerpt) =>
        permittedExcerpts.has(excerpt),
      ) ||
      !sameJson(brief.engineerConstraints.specRevision, checked.run.g1.spec) ||
      !sameJson(brief.computedPointers.planRevision, {
        revision: checked.planRevision.revision,
        digest: checked.planRevision.digest,
      }) ||
      !sameJson(
        brief.computedPointers.taskRevisions,
        spec.inputs.taskRevisions,
      ) ||
      !sameJson(
        brief.computedPointers.contractRevisions,
        spec.inputs.interfaceRevisions,
      ) ||
      brief.computedPointers.worktree !== facts.worktree ||
      brief.computedPointers.branch !== facts.branch ||
      brief.computedPointers.baseSha !== facts.baseSha ||
      !sameJson(
        brief.computedPointers.sourceProvenance,
        spec.inputs.sourceArtifactRefs,
      ) ||
      brief.computedPointers.graphProvenance.length !== 0 ||
      !sameJson(brief.delegationSpec, spec) ||
      !sameJson(brief.grant, checked.grant) ||
      brief.contextBudget !== spec.allowance.tokens ||
      brief.recoveryCheckpoint !== null ||
      brief.workManifest !== null ||
      brief.agentId !== checked.grant.subject.agentId ||
      brief.generation !== checked.grant.subject.generation
    ) {
      throw new SpawnAdmissionError(
        "SpawnBrief facts do not match the admitted hierarchy records",
      );
    }
  }

  private assertBindingIdentity(binding: AgentBinding): void {
    if (
      binding.sessionLocator.subject.kind !== "agent" ||
      binding.sessionLocator.subject.agentId !== binding.agentId ||
      binding.sessionLocator.generation !== binding.generation
    ) {
      throw new SpawnAdmissionError(
        "AgentBinding identity does not match its SessionLocator",
      );
    }
  }

  private assertIdentity(
    expected: HierarchySpawnIdentity,
    grant: DelegationGrant,
  ): void {
    if (
      !sameBinding(expected, grant.subject) ||
      grant.capabilityEpoch !== expected.capabilityEpoch
    ) {
      throw new SpawnAdmissionError(
        "reserved hierarchy identity no longer matches the spawn grant",
      );
    }
  }

  private requireAttempt(identity: HierarchySpawnIdentity): Attempt {
    const attempt = this.findAttempt(identity);
    if (attempt.failed) {
      throw new SpawnAdmissionError(
        `hierarchy identity ${identity.agentId} generation ${String(identity.generation)} belongs to a failed launch`,
      );
    }
    return attempt;
  }

  private findAttempt(identity: HierarchySpawnIdentity): Attempt {
    const attempt = this.attempts.get(identity.agentId);
    if (attempt === undefined || !sameBinding(attempt.identity, identity)) {
      throw new SpawnAdmissionError(
        `hierarchy identity ${identity.agentId} generation ${String(identity.generation)} is not reserved`,
      );
    }
    return attempt;
  }

  private requireUnboundIdentity(identity: HierarchySpawnIdentity): void {
    if (this.store.getAgentBinding(identity) !== null) {
      throw new SpawnAdmissionError(
        `hierarchy identity ${identity.agentId} generation ${String(identity.generation)} is already bound`,
      );
    }
  }
}
