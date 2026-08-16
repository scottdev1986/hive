import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import {
  assertAuthorityOnly,
  type PromotionAuthority,
  PromotionEngine,
  PromotionError,
} from "../../src/daemon/hierarchy-service/promotion";
import {
  type AgentBinding,
  type AgentBindingRef,
  type HierarchyNode,
  type DelegationGrant,
  DelegationGrantSchema,
} from "../../src/schemas/hierarchy-node";
import type { Run } from "../../src/schemas/hierarchy-run";
import type {
  IntegrationStage,
  Review,
} from "../../src/schemas/integration-stage";
import type { TaskDetail } from "../../src/schemas/task-detail";
import { bumpCapabilityEpoch, bumpHierarchyRevision } from "./fence-state";

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskId = "task_018f4f5e-0000-7000-8000-000000000001";
const otherTaskId = "task_018f4f5e-0000-7000-8000-000000000002";
const rootNodeId = "node_018f4f5e-0000-7000-8000-000000000001";
const authorNodeId = "node_018f4f5e-0000-7000-8000-000000000002";
const reviewerNodeId = "node_018f4f5e-0000-7000-8000-000000000003";
const leadNodeId = "node_018f4f5e-0000-7000-8000-000000000004";
const siblingLeadNodeId = "node_018f4f5e-0000-7000-8000-000000000005";
const stageId = "stage_018f4f5e-0000-7000-8000-000000000001";
const leadStageId = "stage_018f4f5e-0000-7000-8000-000000000002";
const siblingLeadStageId = "stage_018f4f5e-0000-7000-8000-000000000003";
const rootGrantId = "grant_018f4f5e-0000-7000-8000-000000000001";
const leafGrantId = "grant_018f4f5e-0000-7000-8000-000000000002";
const reviewId = "review_018f4f5e-0000-7000-8000-000000000001";
const promotionId = "promotion_018f4f5e-0000-7000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const branch = "hive/author-task";
const createdAt = "2099-01-01T00:00:00.000Z";

const rootRef = { nodeId: rootNodeId, agentId: "root", generation: 1 };
const authorRef = { nodeId: authorNodeId, agentId: "author", generation: 1 };
const reviewerRef = {
  nodeId: reviewerNodeId,
  agentId: "reviewer",
  generation: 1,
};

const roots: string[] = [];
const databases: HiveDatabase[] = [];

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "author",
      GIT_COMMITTER_EMAIL: "author@example.test",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }
  return result.stdout.toString().trim();
}

function refExists(root: string, ref: string): boolean {
  return (
    Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

interface GitWorld {
  root: string;
  baseSha: string;
  headSha: string;
}

function createGitWorld(createStageRef = true): GitWorld {
  const root = mkdtempSync(join(tmpdir(), "hive-derived-promotion-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "author");
  git(root, "config", "user.email", "author@example.test");
  writeFileSync(join(root, "app.ts"), "export const v = 1;\n");
  git(root, "add", "app.ts");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", branch);
  writeFileSync(join(root, "app.ts"), "export const v = 2;\n");
  git(root, "add", "app.ts");
  git(root, "commit", "-q", "-m", "candidate");
  const headSha = git(root, "rev-parse", "HEAD");
  if (createStageRef) {
    git(root, "update-ref", "refs/hive/run-stage", baseSha);
  }
  return { root, baseSha, headSha };
}

function validRun(world: GitWorld): Run {
  return {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-1",
    spec: { revision: "1", digest },
    currentPlan: { revision: "1", digest },
    topology: { revision: "1", digest },
    phase: "P1",
    g2: { state: "pending" },
    baseSha: world.baseSha,
    budget: { revision: "1", digest },
    runEpoch: 0,
    lifecycle: "active",
  };
}

function binding(
  ref: AgentBindingRef,
  world: GitWorld,
  bindingBranch: string,
  targetDb?: HiveDatabase,
): AgentBinding {
  const sessionSuffix =
    ref.agentId === "root" ? "01" : ref.agentId === "author" ? "02" : "03";
  const sessionLocator = {
    schemaVersion: 1 as const,
    instanceId: "instance-1",
    subject: { kind: "agent" as const, agentId: ref.agentId },
    generation: ref.generation,
    sessionId: `ses_018f4f5e-0000-7000-8000-0000000000${sessionSuffix}`,
    hostKind: "sessiond" as const,
    engineBuildId: "build-1",
  };
  if (targetDb !== undefined && targetDb.getAgentById(ref.agentId) === null) {
    targetDb.insertAgent({
      id: ref.agentId,
      name: ref.agentId,
      tool: "codex",
      model: "gpt-5",
      category: "simple_coding",
      status: "working",
      taskDescription: ref.agentId,
      worktreePath: `/worktrees/${ref.agentId}`,
      branch: bindingBranch,
      sessionLocator,
      contextPct: null,
      createdAt,
      lastEventAt: createdAt,
      capabilityEpoch: 1,
      readOnly: false,
      writeRevoked: false,
    });
  }
  return {
    ...ref,
    provider: "codex",
    model: "gpt-5",
    sessionLocator,
    worktree: `/worktrees/${ref.agentId}`,
    branch: bindingBranch,
    baseSha: world.baseSha,
    credentialId: `credential-${ref.agentId}`,
    boundAt: createdAt,
    unboundAt: null,
  };
}

function task(
  world: GitWorld,
  overrides: Partial<TaskDetail> = {},
): TaskDetail {
  return {
    taskId,
    revision: "1",
    parentTaskId: null,
    dependsOn: [],
    delegationSpec: {
      objective: "Produce one promotable candidate",
      parentAcceptanceIds: ["candidate"],
      childOutcome: "One reviewed commit",
      terminationCondition: "Candidate promoted",
      inputs: {
        specRevision: { revision: "1", digest },
        planRevision: { revision: "1", digest },
        taskRevisions: [{ taskId, revision: "1" }],
        interfaceRevisions: [],
        baseSha: world.baseSha,
        prerequisites: [],
        sourceArtifactRefs: [],
      },
      boundaries: {
        allowedPaths: ["src"],
      },
      authority: {
        grantId: leafGrantId,
        permittedOperations: ["write", "test", "promote"],
        environment: "worktree",
        worktree: "/worktrees/author",
        branch,
        explicitNonAuthority: [],
      },
      allowance: {
        sessions: 1,
        tokens: 1_000,
        costCents: 10,
        wallTimeMs: 60_000,
        retries: 0,
        blockers: [],
        owner: rootRef,
      },
    },
    acceptanceIds: ["candidate"],
    ownerNodeId: rootNodeId,
    assigneeNodeId: authorNodeId,
    pathLeases: [{ path: "src", mode: "write" }],
    branch,
    baseSha: world.baseSha,
    state: "in-progress",
    blockers: [],
    evidence: [],
    artifactRefs: [],
    ...overrides,
  };
}

function rootGrant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
  return {
    grantId: rootGrantId,
    parentGrantId: null,
    issuer: rootRef,
    subject: rootRef,
    runId,
    taskIds: [taskId],
    descendantNodeIds: [authorNodeId, reviewerNodeId],
    paths: ["src"],
    branches: [branch],
    actions: ["read", "write", "test", "spawn", "review", "promote"],
    budget: {
      sessions: 4,
      tokens: 10_000,
      costCents: 100,
      wallTimeMs: 600_000,
      retries: 2,
    },
    expiresAt: createdAt,
    hierarchyRevision: "0",
    runEpoch: 0,
    capabilityEpoch: 1,
    status: "active",
    ...overrides,
  };
}

function leafGrant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
  return {
    ...rootGrant(),
    grantId: leafGrantId,
    parentGrantId: rootGrantId,
    subject: authorRef,
    descendantNodeIds: [],
    actions: ["write", "test", "promote"],
    budget: {
      sessions: 1,
      tokens: 1_000,
      costCents: 10,
      wallTimeMs: 60_000,
      retries: 0,
    },
    ...overrides,
  };
}

function stage(
  world: GitWorld,
  overrides: Partial<IntegrationStage> = {},
): IntegrationStage {
  return {
    stageId,
    revision: "1",
    kind: "run",
    runId,
    ownerNodeId: null,
    daemonRef: "refs/hive/run-stage",
    baseSha: world.baseSha,
    headSha: world.baseSha,
    acceptedPromotionGrantIds: [promotionId],
    validation: { environment: "bun", evidenceArtifactRefs: [] },
    queueHighWater: 0,
    lifecycle: "active",
    ...overrides,
  } as IntegrationStage;
}

function review(world: GitWorld, overrides: Partial<Review> = {}): Review {
  return {
    reviewId,
    revision: "1",
    reviewer: reviewerRef,
    authors: [authorRef],
    candidate: {
      commitSha: world.headSha,
      patchDigest: digest,
      baseSha: world.baseSha,
    },
    revisions: {
      spec: { revision: "1", digest },
      task: { taskId, revision: "1" },
      contracts: [],
    },
    environment: { toolchain: "bun", environment: "test" },
    findings: [],
    verdict: "accepted",
    evidenceArtifactRefs: [],
    invalidation: { state: "current" },
    ...overrides,
  } as Review;
}

type SeedOptions = {
  leaf?: boolean;
  leafOverrides?: Partial<DelegationGrant>;
  review?: boolean;
  reviewOverrides?: Partial<Review>;
  authorParentNodeId?: string;
  extraNodes?: HierarchyNode[];
  extraStages?: IntegrationStage[];
};

function seed(
  targetDb: HiveDatabase,
  store: HierarchyStore,
  world: GitWorld,
  options: SeedOptions = {},
): void {
  store.putRun(validRun(world), null);
  store.putNode(
    {
      nodeId: rootNodeId,
      runId,
      parentNodeId: null,
      ownerNodeId: null,
      organizationalRole: "worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    },
    null,
  );
  store.putAgentBinding(binding(rootRef, world, "hive/root", targetDb), runId);
  for (const extraNode of options.extraNodes ?? []) {
    store.putNode(
      extraNode,
      null,
      undefined,
      extraNode.organizationalRole === "lead-worker"
        ? { binding: rootRef, expectedCapabilityEpoch: 1 }
        : undefined,
    );
  }
  for (const [nodeId, assignmentKind] of [
    [authorNodeId, "author"],
    [reviewerNodeId, "reviewer"],
  ] as const) {
    const parentNodeId =
      nodeId === authorNodeId
        ? (options.authorParentNodeId ?? rootNodeId)
        : rootNodeId;
    store.putNode(
      {
        nodeId,
        runId,
        parentNodeId,
        ownerNodeId: parentNodeId,
        organizationalRole: "worker",
        assignmentKind,
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
  }
  store.putAgentBinding(binding(authorRef, world, branch, targetDb), runId);
  store.putAgentBinding(
    binding(reviewerRef, world, "hive/reviewer", targetDb),
    runId,
  );
  const fences = {
    expectedHierarchyRevision: "0",
    expectedRunEpoch: 0,
    expectedCapabilityEpoch: 1,
    binding: rootRef,
  };
  store.putGrant(rootGrant(), fences);
  if (options.leaf !== false) {
    store.putGrant(leafGrant(options.leafOverrides), fences);
  }
  store.putTask(task(world));
  store.putIntegrationStage(stage(world), null);
  for (const extraStage of options.extraStages ?? []) {
    store.putIntegrationStage(extraStage, null);
  }
  if (options.review !== false) {
    store.putReview(review(world, options.reviewOverrides), runId);
  }
}

function openStore<T extends HierarchyStore = HierarchyStore>(
  make?: (db: HiveDatabase) => T,
): { db: HiveDatabase; store: T } {
  const db = new HiveDatabase(":memory:");
  databases.push(db);
  return { db, store: make?.(db) ?? (new HierarchyStore(db) as T) };
}

function engineFor(store: HierarchyStore, world: GitWorld): PromotionEngine {
  return new PromotionEngine({ store, repoRoot: world.root });
}

function authority(
  bindingRef: AgentBindingRef = authorRef,
  capabilityEpoch = 1,
): PromotionAuthority {
  return { binding: bindingRef, capabilityEpoch };
}

async function expectPromotionError(
  work: () => Promise<unknown>,
  code: PromotionError["code"],
  message?: RegExp,
): Promise<PromotionError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(PromotionError);
    const promotion = error as PromotionError;
    expect(promotion.code).toBe(code);
    if (message !== undefined) expect(promotion.message).toMatch(message);
    return promotion;
  }
  throw new Error(`expected PromotionError ${code}`);
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("derived promotion authority and evidence", () => {
  test("uses the unique run stage when no active lead stage is on the ancestry", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);

    const result = await engineFor(store, world).promote(authority());

    expect(result.commit).toBe(world.headSha);
    expect(result.daemonRef).toBe("refs/hive/run-stage");
    expect(result.stage.headSha).toBe(world.headSha);
    expect(result.stage.acceptedPromotionGrantIds).toEqual([promotionId]);
    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.headSha,
    );
  });

  test("uses the nearest active lead stage on the landing node ancestry", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    const leadNode: HierarchyNode = {
      nodeId: leadNodeId,
      runId,
      parentNodeId: rootNodeId,
      ownerNodeId: rootNodeId,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    };
    const leadStage = stage(world, {
      stageId: leadStageId,
      kind: "lead",
      ownerNodeId: leadNodeId,
      daemonRef: "refs/hive/lead-stage",
    });
    seed(db, store, world, {
      authorParentNodeId: leadNodeId,
      extraNodes: [leadNode],
      extraStages: [leadStage],
    });

    const result = await engineFor(store, world).promote(authority());

    expect(result.stage.stageId).toBe(leadStageId);
    expect(result.daemonRef).toBe("refs/hive/lead-stage");
  });

  test("a sibling lead stage does not displace the run stage", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    const siblingLead: HierarchyNode = {
      nodeId: siblingLeadNodeId,
      runId,
      parentNodeId: rootNodeId,
      ownerNodeId: rootNodeId,
      organizationalRole: "lead-worker",
      assignmentKind: "lead-coordination",
      taskScope: [taskId],
      capacityCharge: 1,
      lifecycle: "active",
      revision: "1",
    };
    seed(db, store, world, {
      extraNodes: [siblingLead],
      extraStages: [
        stage(world, {
          stageId: siblingLeadStageId,
          kind: "lead",
          ownerNodeId: siblingLeadNodeId,
          daemonRef: "refs/hive/sibling-stage",
        }),
      ],
    });

    const result = await engineFor(store, world).promote(authority());
    expect(result.stage.stageId).toBe(stageId);
    expect(store.getIntegrationStage(siblingLeadStageId)?.lifecycle).toBe(
      "active",
    );
  });

  test("first promotion creates the daemon ref from the stored stage", async () => {
    const world = createGitWorld(false);
    const { db, store } = openStore();
    seed(db, store, world);

    await engineFor(store, world).promote(authority());

    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.headSha,
    );
  });

  test("authority-only surface refuses forged caller evidence", () => {
    // Promotion grants and their caller-authored patch digests are obsolete on
    // this path: the stored review candidate is the only candidate evidence.
    const positive = authority();
    expect(Object.keys(positive).sort()).toEqual([
      "binding",
      "capabilityEpoch",
    ]);
    expect(() =>
      assertAuthorityOnly({
        ...positive,
        grant: leafGrant(),
        reviewId,
        targetRef: "refs/heads/main",
      } as PromotionAuthority),
    ).toThrow(/caller-supplied grant is refused/);
  });

  test("run root and non-author bindings are refused before task selection", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    const engine = engineFor(store, world);

    await expectPromotionError(
      () => engine.promote(authority(rootRef)),
      "ACTOR_NOT_AUTHOR",
      /run root node .* may not promote/,
    );
    await expectPromotionError(
      () => engine.promote(authority(reviewerRef)),
      "ACTOR_NOT_AUTHOR",
      /assignmentKind is reviewer, not author/,
    );
    const leadRef = { nodeId: leadNodeId, agentId: "lead", generation: 1 };
    store.putNode(
      {
        nodeId: leadNodeId,
        runId,
        parentNodeId: rootNodeId,
        ownerNodeId: rootNodeId,
        organizationalRole: "lead-worker",
        assignmentKind: "lead-coordination",
        taskScope: [taskId],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
      undefined,
      { binding: rootRef, expectedCapabilityEpoch: 1 },
    );
    store.putAgentBinding(binding(leadRef, world, "hive/lead", db), runId);
    await expectPromotionError(
      () => engine.promote(authority(leadRef)),
      "ACTOR_NOT_AUTHOR",
      /assignmentKind is lead-coordination, not author/,
    );
  });

  test("an aborted run refuses through the named admission seam", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    const activeRun = store.getRun(runId);
    if (activeRun === null) throw new Error("run fixture disappeared");
    store.putRun({ ...activeRun, revision: "2", lifecycle: "aborted" }, "1");

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "RUN_NOT_ADMITTED",
      /run lifecycle is aborted/,
    );
  });

  test("a paused run refuses admission independently", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    const activeRun = store.getRun(runId);
    if (activeRun === null) throw new Error("run fixture disappeared");
    store.putRun({ ...activeRun, revision: "2", lifecycle: "paused" }, "1");

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "RUN_NOT_ADMITTED",
      /run lifecycle is paused/,
    );
  });

  test("an unbound landing binding refuses independently", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    store.putAgentBinding(
      { ...binding(authorRef, world, branch), unboundAt: createdAt },
      runId,
    );
    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "CAPABILITY_EPOCH_FENCE",
      /binding .* is unbound/,
    );
  });

  test("stale capabilityEpoch refuses independently", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    bumpCapabilityEpoch(db, authorRef);

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "CAPABILITY_EPOCH_FENCE",
      /capabilityEpoch expected 1, current is 2/,
    );
  });

  test("stale hierarchyRevision refuses independently", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    bumpHierarchyRevision(db, runId);

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "HIERARCHY_REVISION_FENCE",
      /hierarchyRevision expected 0, current is 1/,
    );
  });

  test("stale runEpoch refuses independently", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    store.advanceRunEpoch(runId, 0);

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "RUN_EPOCH_FENCE",
      /runEpoch expected 0, current is 1/,
    );
  });

  test("wrong authenticated actor cannot use another binding's leaf grant", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    const forger = { ...authorRef, agentId: "forger" };
    store.putAgentBinding(binding(forger, world, branch, db), runId);

    await expectPromotionError(
      () => engineFor(store, world).promote(authority(forger)),
      "GRANT_INVALIDATED",
      /subject .* is not the landing binding/,
    );
  });

  test("zero and multiple assigned branch tasks refuse with distinct codes", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    store.putAgentBinding(binding(authorRef, world, "hive/other"), runId);
    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "TASK_NOT_ASSIGNED",
      /no task is assigned/,
    );

    store.putAgentBinding(binding(authorRef, world, branch), runId);
    const secondId = "task_018f4f5e-0000-7000-8000-000000000002";
    const second = task(world, {
      taskId: secondId,
      delegationSpec: {
        ...task(world).delegationSpec,
        inputs: {
          ...task(world).delegationSpec.inputs,
          taskRevisions: [{ taskId: secondId, revision: "1" }],
        },
      },
    });
    store.putTask(second);
    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "TASK_AMBIGUOUS",
      /multiple tasks are assigned/,
    );
  });

  test("missing leaf and missing parent rows fail closed by id", async () => {
    const missingLeafWorld = createGitWorld();
    const missingLeaf = openStore();
    seed(missingLeaf.db, missingLeaf.store, missingLeafWorld, { leaf: false });
    expect(missingLeaf.store.getGrant(leafGrantId)).toBeNull();
    await expectPromotionError(
      () => engineFor(missingLeaf.store, missingLeafWorld).promote(authority()),
      "GRANT_MISSING",
      /named by task .* is not stored/,
    );

    const missingParentWorld = createGitWorld();
    const missingParent = openStore();
    seed(missingParent.db, missingParent.store, missingParentWorld);
    expect(missingParent.store.getGrant(rootGrantId)).not.toBeNull();
    missingParent.db.database
      .query("DELETE FROM hierarchy_records WHERE kind = 'grant' AND id = ?")
      .run(rootGrantId);
    expect(missingParent.store.getGrant(rootGrantId)).toBeNull();
    await expectPromotionError(
      () =>
        engineFor(missingParent.store, missingParentWorld).promote(authority()),
      "GRANT_MISSING",
      /is missing parent/,
    );
  });

  test("dead and stale grant issuers refuse the stored chain", async () => {
    const deadWorld = createGitWorld();
    const dead = openStore();
    seed(dead.db, dead.store, deadWorld);
    dead.store.putAgentBinding(
      { ...binding(rootRef, deadWorld, "hive/root"), unboundAt: createdAt },
      runId,
    );
    await expectPromotionError(
      () => engineFor(dead.store, deadWorld).promote(authority()),
      "GRANT_INVALIDATED",
      /issuer binding .* is unbound/,
    );

    const staleWorld = createGitWorld();
    const stale = openStore();
    seed(stale.db, stale.store, staleWorld);
    bumpCapabilityEpoch(stale.db, rootRef);
    await expectPromotionError(
      () => engineFor(stale.store, staleWorld).promote(authority()),
      "GRANT_INVALIDATED",
      /records issuer capabilityEpoch 1, current is 2/,
    );
  });

  test("a valid expiresAt in the past refuses the grant", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    const originalNow = Date.now;
    Date.now = () => Date.parse("2100-01-01T00:00:00.000Z");
    try {
      await expectPromotionError(
        () => engineFor(store, world).promote(authority()),
        "GRANT_INVALIDATED",
        /expired at 2099-01-01T00:00:00.000Z/,
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("an invalidated grant refuses independently of expiry", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world, { leafOverrides: { status: "revoked" } });

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "GRANT_INVALIDATED",
      /status is revoked/,
    );
  });

  test("garbage expiresAt is refused at the schema door, not by the fence", () => {
    const valid = leafGrant();
    expect(DelegationGrantSchema.safeParse(valid).success).toBe(true);
    const parsed = DelegationGrantSchema.safeParse({
      ...valid,
      expiresAt: "not-a-timestamp",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.path[0] === "expiresAt"),
      ).toBe(true);
    }
  });

  test("missing review row is unknown, never admitted", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    expect(store.getReview(reviewId, "1")).not.toBeNull();
    db.database
      .query("DELETE FROM hierarchy_records WHERE kind = 'review' AND id = ?")
      .run(`${reviewId}:1`);
    expect(store.getReview(reviewId, "1")).toBeNull();

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "REVIEW_MISSING",
      /no live review names task/,
    );
  });

  test("a review for task B cannot admit the candidate for task A", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world, { review: false });
    const taskB = task(world, {
      taskId: otherTaskId,
      assigneeNodeId: reviewerNodeId,
      branch: "hive/task-b",
      delegationSpec: {
        ...task(world).delegationSpec,
        inputs: {
          ...task(world).delegationSpec.inputs,
          taskRevisions: [{ taskId: otherTaskId, revision: "1" }],
        },
        authority: {
          ...task(world).delegationSpec.authority,
          branch: "hive/task-b",
        },
      },
    });
    store.putTask(taskB);
    store.putReview(
      review(world, {
        revisions: {
          spec: { revision: "1", digest },
          task: { taskId: otherTaskId, revision: "1" },
          contracts: [],
        },
      }),
      runId,
    );

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "REVIEW_MISSING",
      new RegExp(`no live review names task ${taskId}@1`),
    );
  });

  test("a stored changes-requested review blocks promotion", async () => {
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world, {
      reviewOverrides: {
        findings: [
          {
            findingId: "blocking-1",
            summary: "candidate needs correction",
            severity: "blocking",
          },
        ],
        verdict: "changes-requested",
      },
    });

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "REVIEW_NOT_ADMITTED",
      /is not admitted for candidate/,
    );
  });

  test("predicted-result SHA mismatch refuses independently", async () => {
    const world = createGitWorld();
    git(world.root, "update-ref", `refs/heads/${branch}`, world.baseSha);
    const { db, store } = openStore();
    seed(db, store, world);

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "PREDICTED_SHA_MISMATCH",
      /predicted result .* does not match task branch/,
    );
    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.baseSha,
    );
  });

  test("a non-ancestor predicted result refuses", async () => {
    const world = createGitWorld();
    const tree = git(world.root, "rev-parse", `${world.headSha}^{tree}`);
    const unrelatedCommit = git(
      world.root,
      "commit-tree",
      tree,
      "-m",
      "unrelated candidate",
    );
    git(world.root, "update-ref", `refs/heads/${branch}`, unrelatedCommit);
    world.headSha = unrelatedCommit;
    const { db, store } = openStore();
    seed(db, store, world);

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "PREDICTED_SHA_MISMATCH",
      /is not a fast-forward of stage head/,
    );
    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.baseSha,
    );
  });
});

describe("derived promotion write boundaries", () => {
  class MovingFenceStore extends HierarchyStore {
    fenceReads = 0;
    moved = false;
    armed = false;

    constructor(
      db: HiveDatabase,
      private readonly moveOnRead: number,
    ) {
      super(db);
    }

    override getFences(id: string) {
      if (this.armed) {
        this.fenceReads += 1;
        if (this.fenceReads === this.moveOnRead && !this.moved) {
          this.moved = true;
          super.advanceRunEpoch(id, 0);
        }
      }
      return super.getFences(id);
    }
  }

  test("pre-ref fence movement refuses without moving either domain", async () => {
    const world = createGitWorld();
    const { db, store } = openStore((db) => new MovingFenceStore(db, 2));
    seed(db, store, world);
    store.armed = true;

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "RUN_EPOCH_FENCE",
    );
    expect(store.moved).toBe(true);
    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.baseSha,
    );
    expect(store.getIntegrationStage(stageId)?.headSha).toBe(world.baseSha);
  });

  test("final-transaction fence movement rolls the ref back to the stored head", async () => {
    const world = createGitWorld();
    const { db, store } = openStore((db) => new MovingFenceStore(db, 3));
    seed(db, store, world);
    store.armed = true;

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "RUN_EPOCH_FENCE",
    );
    expect(store.moved).toBe(true);
    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.baseSha,
    );
    expect(store.getIntegrationStage(stageId)?.headSha).toBe(world.baseSha);
    expect(store.getIntegrationStage(stageId)?.revision).toBe("1");
  });

  test("a failed first promotion restores the daemon ref to absent", async () => {
    const world = createGitWorld(false);
    const { db, store } = openStore((db) => new MovingFenceStore(db, 3));
    seed(db, store, world);
    expect(refExists(world.root, "refs/hive/run-stage")).toBe(false);
    store.armed = true;

    await expectPromotionError(
      () => engineFor(store, world).promote(authority()),
      "RUN_EPOCH_FENCE",
    );
    expect(store.moved).toBe(true);
    expect(refExists(world.root, "refs/hive/run-stage")).toBe(false);
    expect(store.getIntegrationStage(stageId)?.headSha).toBe(world.baseSha);
    expect(store.getIntegrationStage(stageId)?.revision).toBe("1");
  });

  test("concurrent promotion serializes and only one stage write wins", async () => {
    // Callers no longer supply a stage revision. Re-derivation and this record
    // CAS race are the surviving equivalent of the old stale-revision input.
    const world = createGitWorld();
    const { db, store } = openStore();
    seed(db, store, world);
    const engine = engineFor(store, world);

    const outcomes = await Promise.allSettled([
      engine.promote(authority()),
      engine.promote(authority()),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(PromotionError);
      expect((rejected.reason as PromotionError).code).toBe("RECORD_CAS");
    }
    expect(store.getIntegrationStage(stageId)?.revision).toBe("2");
    expect(git(world.root, "rev-parse", "refs/hive/run-stage")).toBe(
      world.headSha,
    );
  });
});
