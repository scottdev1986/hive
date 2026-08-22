#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildWorkspaceModelControlView,
  type WorkspaceModelControlView,
} from "../../../src/daemon/routing-service/model-control-view";
import { canonicalJson } from "../../../src/daemon/status-service/events";
import { projectStrandedManifestEntity } from "../../../src/daemon/status-service/status-hierarchy-projection";
import {
  HIERARCHY_ENTITY_KINDS,
  type HierarchySnapshotEntity,
  HierarchySnapshotEntitySchema,
} from "../../../src/schemas/hierarchy-projection";
import {
  BUDGET_DIMENSIONS,
  PlanRevisionSchema,
  RunBudgetSchema,
  RunSchema,
  SpecRevisionSchema,
  TopologyDecisionSchema,
} from "../../../src/schemas/hierarchy-run";
import {
  type MemoryListPage,
  MemoryListPageSchema,
  type MemoryMaintenanceProjection,
  MemoryMaintenanceProjectionSchema,
  type MemoryOverviewProjection,
  MemoryOverviewProjectionSchema,
  type MemoryRecallPreview,
  MemoryRecallPreviewSchema,
} from "../../../src/schemas/memory-projections";
import {
  type RouteInspection,
  RouteInspectionSchema,
} from "../../../src/schemas/routing-inspection";
import {
  type RoutingPolicy,
  RoutingPolicySchema,
} from "../../../src/schemas/routing-policy";
import {
  type WorkspaceSnapshotV2,
  WorkspaceSnapshotV2Schema,
} from "../../../src/schemas/status-envelope";
import { buildModelControlSnapshotFixture } from "./model-control-snapshot";
import type { JsonObject } from "../../../src/shared/json";

export const WORKSPACE_CLIENT_FIXTURE_DIRECTORY = resolve(
  import.meta.dir,
  "../../../workspace/Tests/WorkspaceCoreTests/Fixtures",
);

export const WORKSPACE_CLIENT_FIXTURE_FILES = {
  workspaceSnapshotV2: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "workspace-snapshot-v2-corpus.json",
  ),
  routingPolicy: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "routing-policy-corpus.json",
  ),
  routingInspection: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "routing-inspection-corpus.json",
  ),
  modelControl: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "model-control-corpus.json",
  ),
  hierarchyH0: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "hierarchy-h0-corpus.json",
  ),
  hierarchyProjectionV2: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "hierarchy-projection-v2-corpus.json",
  ),
  outerHorizon: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "outer-horizon-corpus.json",
  ),
  memoryOverview: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "memory-overview-corpus.json",
  ),
  memoryLibrary: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "memory-library-corpus.json",
  ),
  memoryRecall: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "memory-recall-corpus.json",
  ),
  memoryMaintenance: resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "memory-maintenance-corpus.json",
  ),
} as const;

export const PROJECTION_AVAILABILITY = [
  "current",
  "unknown",
  "stale",
  "disconnected",
  "unauthorized",
  "conflicting",
  "replaced",
] as const;

type ProjectionAvailability = (typeof PROJECTION_AVAILABILITY)[number];
type ProjectionFreshness = "current" | "stale" | "unknown";
type ProjectionEvidence =
  | null
  | {
      kind: "disconnected";
      transportLostAt: string;
    }
  | {
      kind: "unauthorized";
      refusalCode: "read-not-authorized";
    }
  | {
      kind: "conflicting";
      competingRevision: string;
    }
  | {
      kind: "replaced";
      supersedingSource: {
        revision: string | null;
        generation: number | null;
      };
    };

export interface ClientProjectionFixture<Value> {
  schemaVersion: 1;
  source: {
    revision: string | null;
    generation: number | null;
  };
  observedAt: string | null;
  freshness: ProjectionFreshness;
  availability: ProjectionAvailability;
  evidence: ProjectionEvidence;
  value: Value | null;
}

const CURRENT_AT = "2026-07-30T20:00:00.000Z";
const STALE_AT = "2026-07-29T20:00:00.000Z";

function entityDigest(entities: readonly unknown[]): string {
  return createHash("sha256")
    .update(canonicalJson(entities), "utf8")
    .digest("hex");
}

function projectionCases<Value>(
  value: Value,
  revision: string,
): ClientProjectionFixture<Value>[] {
  const present = (
    availability: ProjectionAvailability,
    freshness: ProjectionFreshness,
    observedAt: string,
    evidence: ProjectionEvidence,
  ): ClientProjectionFixture<Value> => ({
    schemaVersion: 1,
    source: { revision, generation: 1 },
    observedAt,
    freshness,
    availability,
    evidence,
    value,
  });
  const absent = (
    availability: "unknown" | "unauthorized",
    evidence: ProjectionEvidence,
  ): ClientProjectionFixture<Value> => ({
    schemaVersion: 1,
    source: { revision: null, generation: null },
    observedAt: null,
    freshness: "unknown",
    availability,
    evidence,
    value: null,
  });

  return [
    present("current", "current", CURRENT_AT, null),
    absent("unknown", null),
    present("stale", "stale", STALE_AT, null),
    present("disconnected", "stale", STALE_AT, {
      kind: "disconnected",
      transportLostAt: CURRENT_AT,
    }),
    absent("unauthorized", {
      kind: "unauthorized",
      refusalCode: "read-not-authorized",
    }),
    present("conflicting", "current", CURRENT_AT, {
      kind: "conflicting",
      competingRevision: `${revision}-competing`,
    }),
    present("replaced", "current", CURRENT_AT, {
      kind: "replaced",
      supersedingSource: {
        revision: `${revision}-replacement`,
        generation: 2,
      },
    }),
  ];
}

function memoryProjectionCases<
  Value extends {
    observedAt: string;
    sourceRevision: string;
    freshness: "live" | "cached";
  },
>(
  makeValue: (observedAt: string, freshness: "live" | "cached") => Value,
  revision: string,
): ClientProjectionFixture<Value>[] {
  const current = makeValue(CURRENT_AT, "live");
  const stale = makeValue(STALE_AT, "cached");
  const present = (
    availability: ProjectionAvailability,
    freshness: ProjectionFreshness,
    value: Value,
    evidence: ProjectionEvidence,
  ): ClientProjectionFixture<Value> => ({
    schemaVersion: 1,
    source: { revision, generation: 1 },
    observedAt: value.observedAt,
    freshness,
    availability,
    evidence,
    value,
  });
  return [
    present("current", "current", current, null),
    {
      schemaVersion: 1,
      source: { revision: null, generation: null },
      observedAt: null,
      freshness: "unknown",
      availability: "unknown",
      evidence: null,
      value: null,
    },
    present("stale", "stale", stale, null),
    present("disconnected", "stale", stale, {
      kind: "disconnected",
      transportLostAt: CURRENT_AT,
    }),
    {
      schemaVersion: 1,
      source: { revision: null, generation: null },
      observedAt: null,
      freshness: "unknown",
      availability: "unauthorized",
      evidence: { kind: "unauthorized", refusalCode: "read-not-authorized" },
      value: null,
    },
    present("conflicting", "current", current, {
      kind: "conflicting",
      competingRevision: `${revision}-competing`,
    }),
    present("replaced", "current", current, {
      kind: "replaced",
      supersedingSource: {
        revision: `${revision}-replacement`,
        generation: 2,
      },
    }),
  ];
}

const memoryConfig = {
  revision: "memory-config-7",
  eventsHotDays: 14,
  staleAfterDays: 90,
  sweepIntervalHours: 12,
  wakeBudgetTokens: 1200,
  embeddingProvider: "local" as const,
  embeddingModel: "fixture-embed-v1",
};

const memoryIndexes = {
  fts: { state: "ok" as const, articles: 3 },
  vectors: {
    state: "ok" as const,
    articles: 2,
    facts: 1,
    provider: "local" as const,
    model: "fixture-embed-v1",
    runtime: "ready",
  },
};

const memoryJob = {
  id: "00000007-retention-sweep",
  kind: "retention-sweep" as const,
  state: "succeeded" as const,
  requestedBy: "user",
  startedAt: "2026-07-30T19:50:00.000Z",
  finishedAt: "2026-07-30T19:50:02.000Z",
  progress: { step: "reading back", done: 1, total: 1 },
  summary: "deleted 2 aged events, demoted 1 article to stale",
  error: null,
  readback: { events: 8, facts: 4, ftsRows: 3 },
};

function envelope(
  observedAt: string,
  freshness: "live" | "cached",
  revision: string,
) {
  return {
    schemaVersion: 1 as const,
    observedAt,
    sourceRevision: revision,
    freshness,
  };
}

function memoryOverview(
  observedAt: string,
  freshness: "live" | "cached",
): MemoryOverviewProjection {
  return MemoryOverviewProjectionSchema.parse({
    ...envelope(observedAt, freshness, "memory-overview-r7"),
    wiki: {
      state: "ok",
      articles: 3,
      pitfalls: 1,
      unverifiedPitfalls: 1,
      scopes: [
        {
          scope: "repo",
          state: "ok",
          articles: 3,
          pitfalls: 1,
          unverifiedPitfalls: 1,
          rawObservations: 5,
        },
        {
          scope: "global",
          state: "empty",
          articles: 0,
          pitfalls: 0,
          unverifiedPitfalls: 0,
          rawObservations: 0,
        },
      ],
    },
    episodic: { state: "ok", events: 8, facts: 4, digests: 2 },
    indexes: memoryIndexes,
    config: memoryConfig,
    lastJobs: [memoryJob],
    gaps: [
      { code: "vectors-partial", detail: "one article has no vector yet" },
    ],
  });
}

function memoryLibrary(
  observedAt: string,
  freshness: "live" | "cached",
): MemoryListPage {
  return MemoryListPageSchema.parse({
    ...envelope(observedAt, freshness, "memory-library-r3"),
    state: "ok",
    items: [
      {
        kind: "article",
        key: "article\u0000repo\u0000retention-policy",
        scope: "repo",
        id: "retention-policy",
        title: "Retention policy",
        topic: "memory",
        updated: "2026-07-30",
        revision: "article-r2",
        source: "agent",
        status: "verified",
        verified: "2026-07-30",
        supersedes: [],
        rawRefs: ["raw/memory/2026-07-30-retention-policy.md"],
        evidence: "fixture observation",
      },
      {
        kind: "fact",
        key: "fact\u0000project\u00000000000000000042",
        scope: "project",
        id: "42",
        title: "Memory fixture fact",
        topic: "memory",
        updated: "2026-07-30T19:00:00.000Z",
        revision: "fact-r1",
        source: "user",
        status: "current",
        confidence: null,
        validAt: "2026-07-30T19:00:00.000Z",
        invalidAt: null,
      },
      {
        kind: "pitfall",
        key: "pitfall\u0000global\u0000stale-display",
        scope: "global",
        id: "stale-display",
        title: "Keep stale values visible",
        topic: "workspace",
        updated: "2026-07-29",
        revision: "pitfall-r4",
        source: "user",
        status: "unverified",
        verified: null,
        supersedes: [],
        rawRefs: ["raw/workspace/2026-07-29-stale-display.md"],
        evidence: "observed in the native shell",
      },
      {
        kind: "digest",
        key: "digest\u0000project\u00000000000000000009",
        scope: "project",
        id: "9",
        title: "angela session digest",
        topic: "session",
        updated: "2026-07-30T19:30:00.000Z",
        revision: "digest-r9",
        source: "digest compiler",
        status: "compiled",
        agent: "angela",
        sessionId: null,
      },
      {
        kind: "raw-ref",
        key: "raw-ref\u0000repo\u0000memory/2026-07-30-retention-policy",
        scope: "repo",
        id: "memory/2026-07-30-retention-policy",
        title: "2026-07-30-retention-policy.md",
        topic: "memory",
        updated: "2026-07-30",
        revision: "raw-r1",
        source: "raw/memory/2026-07-30-retention-policy.md",
        status: "immutable",
        path: "raw/memory/2026-07-30-retention-policy.md",
        bytes: 418,
      },
    ],
    nextCursor: null,
    total: 5,
  });
}

function memoryRecall(
  observedAt: string,
  freshness: "live" | "cached",
): MemoryRecallPreview {
  return MemoryRecallPreviewSchema.parse({
    ...envelope(observedAt, freshness, "memory-recall-r5"),
    purpose: "explicit-recall",
    query: "retention",
    state: "ok",
    semantic: "hybrid",
    warning: null,
    note: "Results carry scope, source status, and rank.",
    budget: 800,
    tokens: 96,
    truncated: false,
    omitted: 0,
    omittedPitfalls: 0,
    omittedArticles: 0,
    partitions: [
      {
        class: "pitfall",
        reservedTokens: 400,
        usedTokens: 0,
        kept: 0,
        omitted: 0,
      },
      {
        class: "article",
        reservedTokens: 400,
        usedTokens: 96,
        kept: 1,
        omitted: 0,
      },
    ],
    rows: [
      {
        rank: 1,
        class: "article",
        scope: "repo",
        topic: "memory",
        id: "retention-policy",
        date: "2026-07-30",
        title: "Retention policy",
        snippet: "Aged events are deleted while facts remain.",
        status: "verified",
        flag: null,
      },
    ],
    triggerPhrase: null,
    mutation: "none",
    highWaterAdvanced: false,
  });
}

function memoryMaintenance(
  observedAt: string,
  freshness: "live" | "cached",
): MemoryMaintenanceProjection {
  return MemoryMaintenanceProjectionSchema.parse({
    ...envelope(observedAt, freshness, "memory-maintenance-r9"),
    config: memoryConfig,
    indexes: memoryIndexes,
    consolidation: { state: "ok", candidates: 2 },
    jobs: {
      state: "ok",
      recent: [
        {
          ...memoryJob,
          id: "00000008-reindex",
          kind: "reindex",
          state: "running",
          finishedAt: null,
          progress: { step: "rebuilding index", done: 0, total: null },
          summary: "",
          readback: null,
        },
        memoryJob,
      ],
    },
  });
}

function workspaceSnapshot(): WorkspaceSnapshotV2 {
  const entities = [
    {
      kind: "agent",
      id: "agent-fixture",
      generation: 3,
      entityRevision: "8",
      projection: {
        activity: "working",
        provider: "codex",
      },
    },
  ];
  return WorkspaceSnapshotV2Schema.parse({
    schemaVersion: 2,
    instanceId: "instance-fixture",
    seq: "8",
    entities,
    createdAt: CURRENT_AT,
    contentSha256: entityDigest(entities),
  });
}

async function routingPolicy(): Promise<RoutingPolicy> {
  const path = resolve(
    WORKSPACE_CLIENT_FIXTURE_DIRECTORY,
    "routing-policy-wire.json",
  );
  return RoutingPolicySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function routingInspection(): RouteInspection {
  return RouteInspectionSchema.parse({
    schemaVersion: 1,
    category: "complex_coding",
    policyRevision: 6,
    scope: "complex_coding",
    mode: "user-weighted",
    routeDigest: `sha256:${"c".repeat(64)}`,
    candidates: [
      {
        candidate: {
          provider: "claude",
          model: "claude-opus-4-8",
          effort: { mode: "exact", value: "high" },
          weight: 60,
        },
        effectiveWeight: 60,
        configuredShare: 0.6,
        liveShare: 0.8,
        eligible: true,
        effectiveEffort: "high",
        refusal: null,
      },
      {
        candidate: {
          provider: "codex",
          model: "gpt-5.6-sol",
          effort: { mode: "hive-decides" },
          weight: 25,
        },
        effectiveWeight: 25,
        configuredShare: 0.25,
        liveShare: 0,
        eligible: false,
        effectiveEffort: "high",
        refusal: {
          gate: "pool-excluded",
          detail: "the candidate's quota pool is drained",
          retryAt: "2026-07-30T21:00:00.000Z",
        },
      },
      {
        candidate: {
          provider: "grok",
          model: "grok-4-1-fast",
          effort: { mode: "provider-controlled" },
          weight: 15,
        },
        effectiveWeight: 15,
        configuredShare: 0.15,
        liveShare: 0.2,
        eligible: true,
        effectiveEffort: null,
        refusal: null,
      },
    ],
    refusal: null,
    balance: [
      { provider: "claude", model: "claude-opus-4-8", current: 0.25 },
      { provider: "codex", model: "gpt-5.6-sol", current: -0.25 },
    ],
    inspectedAt: CURRENT_AT,
  });
}

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const taskIdA = "task_018f4f5e-0000-7000-8000-0000000000a1";
const taskIdB = "task_018f4f5e-0000-7000-8000-0000000000a2";
const artifactId = "art_018f4f5e-0000-7000-8000-000000000003";
const digest = `sha256:${"a".repeat(64)}`;
const gitSha = "b".repeat(40);
const revisionRef = { revision: "1", digest };
const taskDag = [
  { taskId: taskIdA, dependsOn: [] },
  { taskId: taskIdB, dependsOn: [taskIdA] },
];

function hierarchyH0() {
  const common = {
    runId,
    revision: "1",
    digest,
    createdAt: CURRENT_AT,
    lifecycle: "approved" as const,
  };
  const specRevision = SpecRevisionSchema.parse({
    ...common,
    objective: "Freeze the Workspace client contracts",
    acceptanceIds: ["U1"],
    scope: "frozen client wires",
    nonGoals: ["no daemon mutation implementation"],
    constraints: {
      architecture: ["immutable render inputs"],
      security: ["no client-side storage access"],
      outwardEffect: ["schema and fixture changes only"],
    },
    gatePolicy: {
      reviewLocGreenMax: 100,
      reviewLocAmberMax: 250,
      reviewFilesMax: 10,
    },
    evidenceArtifactRefs: [artifactId],
    proposer: "queen",
    engineerApproval: {
      approvedBy: "engineer",
      approvedAt: CURRENT_AT,
    },
  });
  const planRevision = PlanRevisionSchema.parse({
    ...common,
    parentRevision: null,
    taskDag,
    topologyRationale: "the frozen wires are independent fixture modules",
    proposer: "queen",
  });
  const topologyDecision = TopologyDecisionSchema.parse({
    ...common,
    ["shape"]: "direct",
    decomposition: {
      planRevision: revisionRef,
      taskDag,
    },
    coupling: {
      sharedFiles: [],
      sharedInvariants: ["one immutable projection boundary"],
      interfaceMaturity: "frozen",
      dependencyDepth: 0,
      expectedIntegrationConflict: "none",
    },
    parallelValue: {
      independentWorkUnits: 5,
      predictedCriticalPath: "client fixture validation",
      expectedWallClockBenefit: "independent wire mirrors compile together",
    },
    coordinationCost: {
      leadLoad: "low",
      reviewLoad: "one review",
      communicationLoad: "low",
      ciLoad: "Swift and Bun contract suites",
      promotionQueueLoad: "one candidate",
    },
    budgetEvidence: {
      reservedSessions: 1,
      tokensOrCostEstimate: "bounded",
      wallTimeEstimate: "one task",
      reviewerCapacity: "one reviewer",
      perLeadCrewLimit: 0,
    },
    decisionProvenance: {
      proposer: "queen",
      engineerDecision: {
        outcome: "approved",
        decidedBy: "engineer",
        decidedAt: CURRENT_AT,
      },
      specRevision: revisionRef,
      rationale: "one client task owns the common boundary",
    },
  });
  const limit = { hard: 10, soft: 8, reserved: 2, used: 1 };
  const runBudget = RunBudgetSchema.parse({
    ...common,
    limits: Object.fromEntries(
      BUDGET_DIMENSIONS.map((dimension) => [dimension, limit]),
    ),
    anomalyThresholds: { retryRateMax: 5 },
  });
  const run = RunSchema.parse({
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-fixture",
    spec: revisionRef,
    currentPlan: revisionRef,
    topology: revisionRef,
    phase: "P1",
    baseSha: gitSha,
    budget: revisionRef,
    runEpoch: 1,
    lifecycle: "active",
  });

  return {
    specRevision,
    planRevision,
    topologyDecision,
    runBudget,
    run,
  };
}

const HIERARCHY_GOLDEN_DIRECTORY = resolve(
  import.meta.dir,
  "../hierarchy-snapshot",
);

async function readHierarchyGolden(
  name: string,
): Promise<HierarchySnapshotEntity[]> {
  return HierarchySnapshotEntitySchema.array().parse(
    JSON.parse(
      await readFile(
        resolve(HIERARCHY_GOLDEN_DIRECTORY, `${name}.json`),
        "utf8",
      ),
    ),
  );
}

/** The v2 hierarchy projection as Swift receives it. Active projections are read from the checked-in daemon goldens only — no retired train/contract-conflict reconstruction. The scenarios put each availability answer on the wire: present, unmeasured, and source-absent. */
async function hierarchyProjectionV2() {
  const pick = (
    entities: readonly HierarchySnapshotEntity[],
    kind: string,
  ): JsonObject => {
    const entity = entities.find((row) => row.kind === kind);
    if (entity === undefined) {
      throw new Error(`golden scenario has no ${kind} entity`);
    }
    return entity.projection;
  };

  const fullHive = await readHierarchyGolden("full-hive");
  return {
    run: pick(fullHive, HIERARCHY_ENTITY_KINDS.run),
    node: pick(fullHive, HIERARCHY_ENTITY_KINDS.node),
    budget: pick(fullHive, HIERARCHY_ENTITY_KINDS.budget),
    review: pick(fullHive, HIERARCHY_ENTITY_KINDS.review),
    incident: pick(fullHive, HIERARCHY_ENTITY_KINDS.incident),
    recoveryIncident: pick(
      await readHierarchyGolden("ownership-transfer"),
      HIERARCHY_ENTITY_KINDS.incident,
    ),
    unmeasuredRun: pick(
      await readHierarchyGolden("all-absent"),
      HIERARCHY_ENTITY_KINDS.run,
    ),
    stranded: projectStrandedManifestEntity([
      {
        nodeId: "node_018f4f5e-0000-7000-8000-000000000106",
        agentId: "emma",
        branch: "hive/emma",
        workManifestRevision: { revision: "1", digest },
        unmergedCommits: 2,
        dirtyFileCount: 1,
        disposition: "preserve",
      },
    ]).projection,
  };
}

export const OUTER_HORIZON_SCENARIO_NAMES = [
  "full-hive-dense-19",
  "empty",
  "direct",
  "flat-present-empty",
  "lead-loss",
  "ownership-transfer",
  "all-absent",
  "unknown-entity-kind",
] as const;

type OuterHorizonScenarioName = (typeof OUTER_HORIZON_SCENARIO_NAMES)[number];

export interface OuterHorizonCorpus {
  schemaVersion: 1;
  scenarios: Array<{
    name: OuterHorizonScenarioName;
    snapshot: WorkspaceSnapshotV2;
  }>;
}

async function outerHorizonCorpus(): Promise<OuterHorizonCorpus> {
  const direct = await readHierarchyGolden("direct");
  const scenarios: Array<{
    name: OuterHorizonScenarioName;
    entities: HierarchySnapshotEntity[];
  }> = [
    {
      name: "full-hive-dense-19",
      entities: await readHierarchyGolden("full-hive-dense-19"),
    },
    { name: "empty", entities: [] },
    { name: "direct", entities: direct },
    {
      name: "flat-present-empty",
      entities: await readHierarchyGolden("flat"),
    },
    {
      name: "lead-loss",
      entities: await readHierarchyGolden("lead-loss"),
    },
    {
      name: "ownership-transfer",
      entities: await readHierarchyGolden("ownership-transfer"),
    },
    {
      name: "all-absent",
      entities: await readHierarchyGolden("all-absent"),
    },
    {
      name: "unknown-entity-kind",
      entities: [
        ...direct,
        HierarchySnapshotEntitySchema.parse({
          kind: "hierarchy-future-state",
          id: "future-state-fixture",
          entityRevision: "1",
          projection: { wireLabel: "future state" },
        }),
      ],
    },
  ];

  return {
    schemaVersion: 1,
    scenarios: scenarios.map(({ name, entities }, index) => ({
      name,
      snapshot: WorkspaceSnapshotV2Schema.parse({
        schemaVersion: 2,
        instanceId: "instance-fixture",
        seq: String(index + 1),
        entities,
        createdAt: CURRENT_AT,
        contentSha256: entityDigest(entities),
      }),
    })),
  };
}

export async function buildWorkspaceClientProjectionFixtures(): Promise<{
  workspaceSnapshotV2: ClientProjectionFixture<WorkspaceSnapshotV2>[];
  routingPolicy: ClientProjectionFixture<RoutingPolicy>[];
  routingInspection: ClientProjectionFixture<RouteInspection>[];
  modelControl: ClientProjectionFixture<WorkspaceModelControlView>[];
  hierarchyH0: ClientProjectionFixture<ReturnType<typeof hierarchyH0>>[];
  hierarchyProjectionV2: ClientProjectionFixture<
    Awaited<ReturnType<typeof hierarchyProjectionV2>>
  >[];
  outerHorizon: OuterHorizonCorpus;
  memoryOverview: ClientProjectionFixture<MemoryOverviewProjection>[];
  memoryLibrary: ClientProjectionFixture<MemoryListPage>[];
  memoryRecall: ClientProjectionFixture<MemoryRecallPreview>[];
  memoryMaintenance: ClientProjectionFixture<MemoryMaintenanceProjection>[];
}> {
  const policy = await routingPolicy();
  const modelControlSnapshot = await buildModelControlSnapshotFixture();
  const modelControl = buildWorkspaceModelControlView(
    modelControlSnapshot,
    policy,
  );
  return {
    workspaceSnapshotV2: projectionCases(workspaceSnapshot(), "8"),
    routingPolicy: projectionCases(policy, String(policy.revision)),
    routingInspection: projectionCases(
      routingInspection(),
      String(policy.revision),
    ),
    modelControl: projectionCases(modelControl, String(policy.revision)),
    hierarchyH0: projectionCases(hierarchyH0(), "1"),
    hierarchyProjectionV2: projectionCases(await hierarchyProjectionV2(), "3"),
    outerHorizon: await outerHorizonCorpus(),
    memoryOverview: memoryProjectionCases(memoryOverview, "memory-overview-r7"),
    memoryLibrary: memoryProjectionCases(memoryLibrary, "memory-library-r3"),
    memoryRecall: memoryProjectionCases(memoryRecall, "memory-recall-r5"),
    memoryMaintenance: memoryProjectionCases(
      memoryMaintenance,
      "memory-maintenance-r9",
    ),
  };
}

const prettyJSON = <T>(value: T): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export async function renderWorkspaceClientProjectionFixtures(): Promise<
  Record<string, string>
> {
  const fixtures = await buildWorkspaceClientProjectionFixtures();
  return Object.fromEntries(
    Object.entries(WORKSPACE_CLIENT_FIXTURE_FILES).map(([name, path]) => [
      path,
      // SAFETY: The test owns this value and its fields.
      prettyJSON(fixtures[name as keyof typeof fixtures]),
    ]),
  );
}

if (import.meta.main) {
  const rendered = await renderWorkspaceClientProjectionFixtures();
  for (const [path, contents] of Object.entries(rendered)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    console.log(path);
  }
}
