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
  PositiveGenerationSchema,
  SessionLocatorSchema,
  SessionProtocolProviderSchema,
} from "./session-protocol";

export const NodeIdSchema = domainUuidV7Schema("node");

export const GrantIdSchema = domainUuidV7Schema("grant");

export const BriefIdSchema = domainUuidV7Schema("brief");

export const ORGANIZATIONAL_ROLES = ["lead-worker", "worker"] as const;
export const OrganizationalRoleSchema = z.enum(ORGANIZATIONAL_ROLES);

export const ASSIGNMENT_KINDS = [
  "author",
  "reviewer",
  "researcher",
  "lead-coordination",
] as const;
export const AssignmentKindSchema = z.enum(ASSIGNMENT_KINDS);
export type AssignmentKind = z.infer<typeof AssignmentKindSchema>;

export const HIERARCHY_NODE_LIFECYCLE = [
  "active",
  "completed",
  "terminated",
] as const;
export const HierarchyNodeLifecycleSchema = z.enum(HIERARCHY_NODE_LIFECYCLE);

export const HierarchyNodeSchema = z.strictObject({
  nodeId: NodeIdSchema,
  runId: RunIdSchema,
  parentNodeId: NodeIdSchema.nullable(),
  ownerNodeId: NodeIdSchema.nullable(),
  organizationalRole: OrganizationalRoleSchema,
  assignmentKind: AssignmentKindSchema,
  taskScope: z.array(TaskIdSchema),
  capacityCharge: SafeUintSchema,
  lifecycle: HierarchyNodeLifecycleSchema,
  revision: RevisionSchema,
});
export type HierarchyNode = z.infer<typeof HierarchyNodeSchema>;

export const AgentBindingRefSchema = z.strictObject({
  nodeId: NodeIdSchema,
  agentId: z.string().min(1),
  generation: PositiveGenerationSchema,
});
export type AgentBindingRef = z.infer<typeof AgentBindingRefSchema>;

export const AgentBindingSchema = z.strictObject({
  ...AgentBindingRefSchema.shape,
  provider: SessionProtocolProviderSchema,
  model: z.string().min(1),
  sessionLocator: SessionLocatorSchema,
  worktree: z.string().min(1),
  branch: z.string().min(1),
  baseSha: GitShaSchema,
  credentialId: z.string().min(1),
  // capabilityEpoch is not stored here. The flat AgentRecord counter is the one live credential-rotation fence; a second copy on the binding could not advance through any production door and diverged after handoff.
  boundAt: CreatedAtSchema,
  unboundAt: CreatedAtSchema.nullable(),
});
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

export const RepoPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "path must stay within the repository",
  );

export const GRANT_ACTIONS = [
  "read",
  "write",
  "test",
  "spawn",
  "message",
  "review",
  "promote",
] as const;
export const GrantActionSchema = z.enum(GRANT_ACTIONS);
export type GrantAction = z.infer<typeof GrantActionSchema>;

export const DelegationBudgetSchema = z.strictObject({
  sessions: SafeUintSchema,
  tokens: SafeUintSchema,
  costCents: SafeUintSchema,
  wallTimeMs: SafeUintSchema,
  retries: SafeUintSchema,
});

export const DelegationSpecSchema = z.strictObject({
  objective: z.string().min(1),
  parentAcceptanceIds: z.array(z.string().min(1)).min(1),
  childOutcome: z.string().min(1),
  terminationCondition: z.string().min(1),
  inputs: z.strictObject({
    specRevision: RevisionRefSchema,
    planRevision: RevisionRefSchema,
    taskRevisions: z.array(
      z.strictObject({ taskId: TaskIdSchema, revision: RevisionSchema }),
    ),
    interfaceRevisions: z.array(RevisionRefSchema),
    baseSha: GitShaSchema,
    prerequisites: z.array(TaskIdSchema),
    sourceArtifactRefs: z.array(ArtifactRefIdSchema),
  }),
  boundaries: z.strictObject({
    allowedPaths: z.array(RepoPathSchema),
  }),
  authority: z.strictObject({
    grantId: GrantIdSchema,
    permittedOperations: z.array(GrantActionSchema),
    environment: z.string().min(1),
    worktree: z.string().min(1),
    branch: z.string().min(1),
    explicitNonAuthority: z.array(z.string().min(1)),
  }),
  allowance: z.strictObject({
    ...DelegationBudgetSchema.shape,
    blockers: z.array(z.string().min(1)),
    owner: AgentBindingRefSchema,
  }),
});
export type DelegationSpec = z.infer<typeof DelegationSpecSchema>;

export const DELEGATION_GRANT_STATUS = [
  "active",
  "revoked",
  "expired",
] as const;
export const DelegationGrantStatusSchema = z.enum(DELEGATION_GRANT_STATUS);

export const DelegationGrantSchema = z.strictObject({
  grantId: GrantIdSchema,
  parentGrantId: GrantIdSchema.nullable(),
  issuer: AgentBindingRefSchema,
  subject: AgentBindingRefSchema,
  runId: RunIdSchema,
  taskIds: z.array(TaskIdSchema),
  descendantNodeIds: z.array(NodeIdSchema),
  paths: z.array(RepoPathSchema),
  branches: z.array(z.string().min(1)),
  actions: z.array(GrantActionSchema),
  budget: DelegationBudgetSchema,
  expiresAt: CreatedAtSchema,
  hierarchyRevision: RevisionSchema,
  runEpoch: SafeUintSchema,
  capabilityEpoch: SafeUintSchema,
  status: DelegationGrantStatusSchema,
});
export type DelegationGrant = z.infer<typeof DelegationGrantSchema>;

function isSubset<T>(child: readonly T[], parent: readonly T[]): boolean {
  const permitted = new Set(parent);
  return child.every((value) => permitted.has(value));
}

function isPathWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function sameBinding(left: AgentBindingRef, right: AgentBindingRef): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.agentId === right.agentId &&
    left.generation === right.generation
  );
}

/** Returns true only when a child grant stays inside every bound of its parent. Equality is allowed because a delegation hop may preserve one dimension while narrowing another. New authority still requires a new grant record; this check only answers whether that new record is monotonic. A revoked or expired parent always fails closed here; later store re-checks are defense in depth, not the first place revocation takes effect. capabilityEpoch is deliberately not compared between parent and child. Each grant pins its issuer's flat AgentRecord epoch at write time; parent and child are issued by different agents, so equality between the two numbers is an accident of nobody having rotated yet. Epoch currency is a per-grant fact: a child is refused when its parent no longer carries its issuer's current flat epoch. */
export function isDelegationGrantAttenuation(
  parent: DelegationGrant,
  child: DelegationGrant,
): boolean {
  return (
    parent.status === "active" &&
    child.parentGrantId === parent.grantId &&
    sameBinding(child.issuer, parent.subject) &&
    (child.subject.nodeId === parent.subject.nodeId ||
      parent.descendantNodeIds.includes(child.subject.nodeId)) &&
    child.runId === parent.runId &&
    child.hierarchyRevision === parent.hierarchyRevision &&
    child.runEpoch === parent.runEpoch &&
    isSubset(child.taskIds, parent.taskIds) &&
    isSubset(child.descendantNodeIds, parent.descendantNodeIds) &&
    child.paths.every((path) =>
      parent.paths.some((scope) => isPathWithin(path, scope)),
    ) &&
    isSubset(child.branches, parent.branches) &&
    isSubset(child.actions, parent.actions) &&
    child.budget.sessions <= parent.budget.sessions &&
    child.budget.tokens <= parent.budget.tokens &&
    child.budget.costCents <= parent.budget.costCents &&
    child.budget.wallTimeMs <= parent.budget.wallTimeMs &&
    child.budget.retries <= parent.budget.retries &&
    Date.parse(child.expiresAt) <= Date.parse(parent.expiresAt)
  );
}

export const SpawnBriefSchema = z.strictObject({
  briefId: BriefIdSchema,
  digest: DigestSchema,
  engineerConstraints: z.strictObject({
    specRevision: RevisionRefSchema,
    excerpts: z.array(z.string().min(1)).min(1),
  }),
  computedPointers: z.strictObject({
    planRevision: RevisionRefSchema,
    taskRevisions: z.array(
      z.strictObject({ taskId: TaskIdSchema, revision: RevisionSchema }),
    ),
    contractRevisions: z.array(RevisionRefSchema),
    branch: z.string().min(1),
    worktree: z.string().min(1),
    baseSha: GitShaSchema,
    sourceProvenance: z.array(z.string().min(1)),
    graphProvenance: z.array(z.string().min(1)),
  }),
  written: z.strictObject({
    goal: z.string().min(1),
    done: z.array(z.string().min(1)),
    remaining: z.string().min(1),
    nextAction: z.string().min(1),
    decisions: z.array(z.string().min(1)),
    failures: z.array(
      z.strictObject({ failure: z.string().min(1), reason: z.string().min(1) }),
    ),
    uncertainty: z.string(),
  }),
  delegationSpec: DelegationSpecSchema,
  grant: DelegationGrantSchema,
  contextBudget: SafeUintSchema,
  recoveryCheckpoint: z.string().min(1).nullable(),
  workManifest: z
    .strictObject({
      manifestId: z.string().min(1),
      revision: RevisionRefSchema,
    })
    .nullable(),
  agentId: z.string().min(1),
  generation: PositiveGenerationSchema,
});
export type SpawnBrief = z.infer<typeof SpawnBriefSchema>;
