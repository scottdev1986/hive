import { describe, expect, test } from "bun:test";
import {
  AgentBindingSchema,
  type DelegationGrant,
  DelegationGrantSchema,
  DelegationSpecSchema,
  HierarchyNodeSchema,
  isDelegationGrantAttenuation,
  SpawnBriefSchema,
} from "../../src/schemas/hierarchy-node";
import { SessionLocatorSchema } from "../../src/schemas/session-protocol";

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const nodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const childNodeId = "node_018f4f5e-0000-7000-8000-000000000002";
const grantId = "grant_018f4f5e-0000-7000-8000-000000000001";
const childGrantId = "grant_018f4f5e-0000-7000-8000-000000000002";
const briefId = "brief_018f4f5e-0000-7000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);
const createdAt = "2026-07-30T12:00:00.000Z";

const bindingRef = { nodeId, agentId: "lead", generation: 1 };
const childBindingRef = {
  nodeId: childNodeId,
  agentId: "worker",
  generation: 1,
};

const validNode = {
  nodeId,
  runId,
  parentNodeId: null,
  ownerNodeId: null,
  organizationalRole: "worker" as const,
  assignmentKind: "author" as const,
  taskScope: [taskId],
  capacityCharge: 1,
  lifecycle: "active" as const,
  revision: "1",
};

const validSpec = {
  objective: "Implement the task records",
  parentAcceptanceIds: ["A1"],
  childOutcome: "Schemas and tests are green",
  terminationCondition: "All assigned checks pass",
  inputs: {
    specRevision: { revision: "1", digest },
    planRevision: { revision: "1", digest },
    taskRevisions: [{ taskId, revision: "1" }],
    interfaceRevisions: [],
    baseSha: gitSha,
    prerequisites: [],
    sourceArtifactRefs: [],
  },
  boundaries: {
    allowedPaths: ["src/schemas"],
  },
  authority: {
    grantId,
    permittedOperations: ["read", "write", "test"] as const,
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
    owner: bindingRef,
  },
};

const parentGrant: DelegationGrant = {
  grantId,
  parentGrantId: null,
  issuer: bindingRef,
  subject: bindingRef,
  runId,
  taskIds: [taskId],
  descendantNodeIds: [childNodeId],
  paths: ["src/schemas"],
  branches: ["hive/worker"],
  actions: ["read", "write", "test", "spawn"],
  budget: {
    sessions: 2,
    tokens: 10_000,
    costCents: 100,
    wallTimeMs: 3_600_000,
    retries: 2,
  },
  expiresAt: "2026-07-30T14:00:00.000Z",
  hierarchyRevision: "1",
  runEpoch: 0,
  capabilityEpoch: 1,
  status: "active",
};

const childGrant: DelegationGrant = {
  ...parentGrant,
  grantId: childGrantId,
  parentGrantId: grantId,
  issuer: bindingRef,
  subject: childBindingRef,
  paths: ["src/schemas/hierarchy-node.ts"],
  actions: ["read", "write", "test"],
  budget: {
    sessions: 1,
    tokens: 8_000,
    costCents: 80,
    wallTimeMs: 3_000_000,
    retries: 1,
  },
  expiresAt: "2026-07-30T13:00:00.000Z",
};

const validSpawnBrief = {
  briefId,
  digest,
  engineerConstraints: {
    specRevision: { revision: "1", digest },
    excerpts: ["No store or daemon operations"],
  },
  computedPointers: {
    planRevision: { revision: "1", digest },
    taskRevisions: [{ taskId, revision: "1" }],
    contractRevisions: [],
    branch: "hive/worker",
    worktree: "/worktree",
    baseSha: gitSha,
    sourceProvenance: ["source excerpt"],
    graphProvenance: ["graph node"],
  },
  written: {
    goal: "Implement task records",
    done: [],
    remaining: "schemas",
    nextAction: "write tests",
    decisions: [],
    failures: [],
    uncertainty: "",
  },
  delegationSpec: validSpec,
  grant: childGrant,
  contextBudget: 10_000,
  recoveryCheckpoint: null,
  workManifest: null,
  agentId: "worker",
  generation: 1,
};

describe("HierarchyNodeSchema", () => {
  test("represents reviewer only as an assignment kind", () => {
    expect(
      HierarchyNodeSchema.safeParse({
        ...validNode,
        assignmentKind: "reviewer",
      }).success,
    ).toBe(true);
    expect(
      HierarchyNodeSchema.safeParse({
        ...validNode,
        organizationalRole: "reviewer",
        assignmentKind: "reviewer",
      }).success,
    ).toBe(false);
  });

  test("rejects malformed node and task ids", () => {
    expect(
      HierarchyNodeSchema.safeParse({ ...validNode, nodeId: "node-1" }).success,
    ).toBe(false);
    expect(
      HierarchyNodeSchema.safeParse({ ...validNode, taskScope: ["task-1"] })
        .success,
    ).toBe(false);
  });
});

describe("AgentBindingSchema", () => {
  test("embeds SessionLocator without changing its shape", () => {
    const sessionLocator = {
      schemaVersion: 1 as const,
      instanceId: "instance-1",
      subject: { kind: "agent" as const, agentId: "worker" },
      generation: 1,
      sessionId: "ses_018f4f5e-0000-7000-8000-000000000001",
      hostKind: "sessiond" as const,
      engineBuildId: "build-1",
    };
    const parsed = AgentBindingSchema.parse({
      ...childBindingRef,
      provider: "codex",
      model: "gpt-5",
      sessionLocator,
      worktree: "/worktree",
      branch: "hive/worker",
      baseSha: gitSha,
      credentialId: "credential-1",
      boundAt: createdAt,
      unboundAt: null,
    });

    expect(parsed.sessionLocator).toEqual(
      SessionLocatorSchema.parse(sessionLocator),
    );
    expect(
      AgentBindingSchema.safeParse({
        ...parsed,
        sessionLocator: { ...sessionLocator, displayName: "worker" },
      }).success,
    ).toBe(false);
  });
});

describe("DelegationGrant attenuation", () => {
  test("accepts a child that narrows its parent", () => {
    expect(DelegationGrantSchema.safeParse(childGrant).success).toBe(true);
    expect(isDelegationGrantAttenuation(parentGrant, childGrant)).toBe(true);
  });

  test("rejects a child whose subject is outside the parent's crew", () => {
    expect(
      isDelegationGrantAttenuation(parentGrant, {
        ...childGrant,
        subject: {
          nodeId: "node_018f4f5e-0000-7000-8000-000000000003",
          agentId: "outsider",
          generation: 1,
        },
      }),
    ).toBe(false);
  });

  test.each(["revoked", "expired"] as const)(
    "rejects a child of a %s parent",
    (status) => {
      expect(
        isDelegationGrantAttenuation({ ...parentGrant, status }, childGrant),
      ).toBe(false);
    },
  );

  test.each([
    ["task", { taskIds: ["task_018f4f5e-0000-7000-8000-000000000002"] }],
    ["descendant", { descendantNodeIds: [nodeId] }],
    ["path", { paths: ["src"] }],
    ["branch", { branches: ["hive/other"] }],
    ["action", { actions: ["read", "promote"] }],
    ["expiry", { expiresAt: "2026-07-30T15:00:00.000Z" }],
    ["sessions", { budget: { ...childGrant.budget, sessions: 3 } }],
    ["tokens", { budget: { ...childGrant.budget, tokens: 10_001 } }],
    ["cost", { budget: { ...childGrant.budget, costCents: 101 } }],
    ["wall time", { budget: { ...childGrant.budget, wallTimeMs: 3_600_001 } }],
    ["retries", { budget: { ...childGrant.budget, retries: 3 } }],
    ["hierarchy revision", { hierarchyRevision: "2" }],
    ["run epoch", { runEpoch: 1 }],
  ] as const)("rejects widened %s authority", (_name, patch) => {
    expect(
      isDelegationGrantAttenuation(parentGrant, {
        ...childGrant,
        ...patch,
      } as DelegationGrant),
    ).toBe(false);
  });

  test("accepts a child whose capabilityEpoch differs from its parent's", () => {
    // The two epochs count rotations of two different bindings, so a child
    // ahead of its parent is what a rotated issuer looks like, not a widening.
    expect(
      isDelegationGrantAttenuation(parentGrant, {
        ...childGrant,
        capabilityEpoch: parentGrant.capabilityEpoch + 3,
      }),
    ).toBe(true);
    expect(
      isDelegationGrantAttenuation(
        { ...parentGrant, capabilityEpoch: 7 },
        childGrant,
      ),
    ).toBe(true);
  });

  test("rejects a malformed grant id", () => {
    expect(
      DelegationGrantSchema.safeParse({ ...childGrant, grantId: "grant-1" })
        .success,
    ).toBe(false);
  });
});

describe("DelegationSpecSchema and SpawnBriefSchema", () => {
  test("round-trips the bounded delegation and immutable spawn input", () => {
    const delegationSpec = DelegationSpecSchema.parse(validSpec);
    const spawnBrief = SpawnBriefSchema.parse({
      ...validSpawnBrief,
      delegationSpec,
    });

    expect(
      SpawnBriefSchema.parse(JSON.parse(JSON.stringify(spawnBrief))),
    ).toEqual(spawnBrief);
  });

  test("rejects a malformed brief id", () => {
    expect(
      SpawnBriefSchema.safeParse({
        ...validSpawnBrief,
        briefId: "brief-1",
      }).success,
    ).toBe(false);
  });
});
