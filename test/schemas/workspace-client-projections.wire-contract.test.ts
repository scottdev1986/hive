import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  buildWorkspaceModelControlView,
  type WorkspaceModelControlView,
} from "../../src/daemon/routing-service/model-control-view";
import { canonicalJson } from "../../src/daemon/status-service/events";
import { type JsonValue, safeJsonParse } from "../../src/shared/json";
import {
  CapabilityRecordSchema,
  EffectiveDefaultSchema,
} from "../../src/schemas/capability";
import {
  HIERARCHY_ENTITY_KINDS,
  HierarchyNodeProjectionSchema,
  HierarchyRunProjectionSchema,
  HierarchySnapshotEntitySchema,
} from "../../src/schemas/hierarchy-projection";
import {
  PlanRevisionSchema,
  RunBudgetSchema,
  RunSchema,
  SpecRevisionSchema,
  TopologyDecisionSchema,
} from "../../src/schemas/hierarchy-run";
import {
  MemoryListPageSchema,
  MemoryMaintenanceProjectionSchema,
  MemoryOverviewProjectionSchema,
  MemoryRecallPreviewSchema,
} from "../../src/schemas/memory-projections";
import { QuotaStatusSchema } from "../../src/schemas/quota";
import { RouteInspectionSchema } from "../../src/schemas/routing-inspection";
import { RoutingPolicySchema } from "../../src/schemas/routing-policy";
import { WorkspaceSnapshotV2Schema } from "../../src/schemas/status-envelope";
import { TokenUsageSnapshotSchema } from "../../src/schemas/token-usage-schema";
import { buildModelControlSnapshotFixture } from "../fixtures/builders/model-control-snapshot";
import {
  type ClientProjectionFixture,
  OUTER_HORIZON_SCENARIO_NAMES,
  PROJECTION_AVAILABILITY,
  renderWorkspaceClientProjectionFixtures,
  WORKSPACE_CLIENT_FIXTURE_FILES,
} from "../fixtures/builders/workspace-client-projections";

// One test-side wrapper validates the client metadata without changing any
// daemon schema. Each non-null value is then parsed by the schema that owns it.
const projectionEvidenceSchema = z.union([
  z.null(),
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("disconnected"),
      transportLostAt: z.iso.datetime({ offset: true }),
    }),
    z.strictObject({
      kind: z.literal("unauthorized"),
      refusalCode: z.literal("read-not-authorized"),
    }),
    z.strictObject({
      kind: z.literal("conflicting"),
      competingRevision: z.string().min(1),
    }),
    z.strictObject({
      kind: z.literal("replaced"),
      supersedingSource: z.strictObject({
        revision: z.string().nullable(),
        generation: z.number().int().nullable(),
      }),
    }),
  ]),
]);

const fixtureSchema = <Schema extends z.ZodType>(valueSchema: Schema) =>
  z.strictObject({
    schemaVersion: z.literal(1),
    source: z.strictObject({
      revision: z.string().nullable(),
      generation: z.number().int().nullable(),
    }),
    observedAt: z.iso.datetime({ offset: true }).nullable(),
    freshness: z.enum(["current", "stale", "unknown"]),
    availability: z.enum(PROJECTION_AVAILABILITY),
    evidence: projectionEvidenceSchema,
    value: valueSchema.nullable(),
  });

const hierarchyH0Schema = z.strictObject({
  specRevision: SpecRevisionSchema,
  planRevision: PlanRevisionSchema,
  topologyDecision: TopologyDecisionSchema,
  runBudget: RunBudgetSchema,
  run: RunSchema,
});

const outerHorizonCorpusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scenarios: z
    .array(
      z.strictObject({
        name: z.enum(OUTER_HORIZON_SCENARIO_NAMES),
        snapshot: WorkspaceSnapshotV2Schema,
      }),
    )
    .length(8),
});

async function readJSON(path: string): Promise<JsonValue> {
  const parsed = safeJsonParse(await readFile(path, "utf8"));
  if (parsed === undefined) {
    throw new Error(`${path} was not JSON`);
  }
  return parsed;
}

function expectSevenStateMatrix(
  fixtures: ClientProjectionFixture<unknown>[],
): void {
  expect(fixtures.map((fixture) => fixture.availability)).toEqual([
    ...PROJECTION_AVAILABILITY,
  ]);

  const expected = {
    current: { freshness: "current", hasValue: true },
    unknown: { freshness: "unknown", hasValue: false },
    stale: { freshness: "stale", hasValue: true },
    disconnected: { freshness: "stale", hasValue: true },
    unauthorized: { freshness: "unknown", hasValue: false },
    conflicting: { freshness: "current", hasValue: true },
    replaced: { freshness: "current", hasValue: true },
  } as const;

  for (const fixture of fixtures) {
    const state = expected[fixture.availability];
    expect(fixture.freshness).toBe(state.freshness);
    expect(fixture.value !== null).toBe(state.hasValue);
    if (state.hasValue) {
      expect(fixture.observedAt).not.toBeNull();
      expect(
        fixture.source.revision !== null || fixture.source.generation !== null,
      ).toBe(true);
    } else {
      expect(fixture.observedAt).toBeNull();
      expect(fixture.source).toEqual({
        revision: null,
        generation: null,
      });
    }

    switch (fixture.availability) {
      case "current":
      case "unknown":
      case "stale":
        expect(fixture.evidence).toBeNull();
        break;
      case "disconnected":
        expect(fixture.evidence?.kind).toBe("disconnected");
        if (fixture.evidence?.kind === "disconnected") {
          expect(fixture.evidence.transportLostAt).toBe(
            "2026-07-30T20:00:00.000Z",
          );
        }
        break;
      case "unauthorized":
        expect(fixture.evidence).toEqual({
          kind: "unauthorized",
          refusalCode: "read-not-authorized",
        });
        break;
      case "conflicting":
        expect(fixture.evidence?.kind).toBe("conflicting");
        if (fixture.evidence?.kind === "conflicting") {
          expect(fixture.evidence.competingRevision).not.toBe(
            fixture.source.revision,
          );
        }
        break;
      case "replaced":
        expect(fixture.evidence?.kind).toBe("replaced");
        if (fixture.evidence?.kind === "replaced") {
          const superseding = fixture.evidence.supersedingSource;
          expect(
            superseding.revision !== null || superseding.generation !== null,
          ).toBe(true);
          expect(superseding).not.toEqual(fixture.source);
        }
        break;
    }
  }

  // Removing only the availability label must still leave seven distinct
  // states. This catches a corpus that merely renames identical wrapper bytes.
  const withoutAvailability = fixtures.map(
    ({ availability: _availability, ...fixture }) => canonicalJson(fixture),
  );
  expect(new Set(withoutAvailability).size).toBe(fixtures.length);
}

describe("Workspace client projection fixtures shared with Swift", () => {
  test("checked-in corpora are deterministic generator output", async () => {
    const rendered = await renderWorkspaceClientProjectionFixtures();
    for (const [path, expected] of Object.entries(rendered)) {
      expect(await readFile(path, "utf8")).toBe(expected);
    }
  });

  test("WorkspaceSnapshotV2 covers every immutable client state", async () => {
    const fixtures = z
      .array(fixtureSchema(WorkspaceSnapshotV2Schema))
      .parse(
        await readJSON(WORKSPACE_CLIENT_FIXTURE_FILES.workspaceSnapshotV2),
      );
    expectSevenStateMatrix(fixtures);
  });

  test("routing policy covers every immutable client state", async () => {
    const fixtures = z
      .array(fixtureSchema(RoutingPolicySchema))
      .parse(await readJSON(WORKSPACE_CLIENT_FIXTURE_FILES.routingPolicy));
    expectSevenStateMatrix(fixtures);
  });

  test("routing inspection covers exclusions without rewriting weights", async () => {
    const fixtures = z
      .array(fixtureSchema(RouteInspectionSchema))
      .parse(await readJSON(WORKSPACE_CLIENT_FIXTURE_FILES.routingInspection));
    expectSevenStateMatrix(fixtures);

    const current = fixtures.find(
      (fixture) => fixture.availability === "current",
    )?.value;
    expect(current).not.toBeNull();
    const excluded = current?.candidates.find(
      (candidate) => !candidate.eligible,
    );
    expect(excluded?.candidate.weight).toBe(25);
    expect(excluded?.configuredShare).toBe(0.25);
    expect(excluded?.liveShare).toBe(0);
  });

  test("model control uses the exact production presentation builder", async () => {
    const fixtures = z
      .array(fixtureSchema(z.unknown()))
      .parse(await readJSON(WORKSPACE_CLIENT_FIXTURE_FILES.modelControl));
    expectSevenStateMatrix(fixtures);

    const snapshot = await buildModelControlSnapshotFixture();
    const policy = RoutingPolicySchema.parse(
      await readJSON(
        resolve(
          import.meta.dir,
          "../../workspace/Tests/WorkspaceCoreTests/Fixtures/routing-policy-wire.json",
        ),
      ),
    );
    const expected = buildWorkspaceModelControlView(snapshot, policy);
    for (const fixture of fixtures) {
      if (fixture.value === null) continue;
      validateModelControlNestedContracts(
        fixture.value as WorkspaceModelControlView,
      );
      expect(fixture.value).toEqual(expected);
    }
    validateModelControlNestedContracts(expected);
  });

  test("all five H0 records cover every immutable client state", async () => {
    const fixtures = z
      .array(fixtureSchema(hierarchyH0Schema))
      .parse(await readJSON(WORKSPACE_CLIENT_FIXTURE_FILES.hierarchyH0));
    expectSevenStateMatrix(fixtures);
  });

  test("outer horizon snapshots cover the eight named hierarchy states", async () => {
    const corpus = outerHorizonCorpusSchema.parse(
      await readJSON(WORKSPACE_CLIENT_FIXTURE_FILES.outerHorizon),
    );
    expect(corpus.scenarios[0]?.name).toBe("full-hive-dense-19");

    const scenarios = new Map(
      corpus.scenarios.map((scenario) => [scenario.name, scenario.snapshot]),
    );
    expect(scenarios.size).toBe(8);
    for (const name of OUTER_HORIZON_SCENARIO_NAMES) {
      expect(scenarios.has(name)).toBe(true);
    }

    for (const snapshot of scenarios.values()) {
      WorkspaceSnapshotV2Schema.parse(snapshot);
      expect(snapshot.contentSha256).toBe(
        createHash("sha256")
          .update(canonicalJson(snapshot.entities), "utf8")
          .digest("hex"),
      );
    }

    const golden = async (name: string) =>
      HierarchySnapshotEntitySchema.array().parse(
        await readJSON(
          resolve(
            import.meta.dir,
            `../fixtures/hierarchy-snapshot/${name}.json`,
          ),
        ),
      );
    for (const [scenarioName, goldenName] of [
      ["full-hive-dense-19", "full-hive-dense-19"],
      ["direct", "direct"],
      ["flat-present-empty", "flat"],
      ["lead-loss", "lead-loss"],
      ["ownership-transfer", "ownership-transfer"],
      ["all-absent", "all-absent"],
    ] as const) {
      expect(scenarios.get(scenarioName)?.entities ?? []).toEqual(
        await golden(goldenName),
      );
    }

    const empty = scenarios.get("empty");
    expect(empty?.entities).toEqual([]);

    const allAbsentRun = HierarchyRunProjectionSchema.parse(
      scenarios
        .get("all-absent")
        ?.entities.find((entity) => entity.kind === HIERARCHY_ENTITY_KINDS.run)
        ?.projection,
    );
    expect(allAbsentRun.root.availability).toBe("absent");

    const direct = await golden("direct");
    const unknown = scenarios.get("unknown-entity-kind")?.entities;
    expect(unknown?.slice(0, -1) ?? []).toEqual(direct);
    expect(unknown?.at(-1)).toEqual({
      kind: "hierarchy-future-state",
      id: "future-state-fixture",
      entityRevision: "1",
      projection: { wireLabel: "future state" },
    });

    // Retired train/contract-conflict fields are gone from the honest corpus.
    const flat = scenarios.get("flat-present-empty")?.entities ?? [];
    expect(flat.some((entity) => entity.kind === "hierarchy-train")).toBe(
      false,
    );
    expect(
      flat.find((entity) => entity.kind === HIERARCHY_ENTITY_KINDS.incident)
        ?.projection.contractConflict,
    ).toBeUndefined();

    const denseNodes = scenarios
      .get("full-hive-dense-19")
      ?.entities.filter((entity) => entity.kind === HIERARCHY_ENTITY_KINDS.node)
      .map((entity) => HierarchyNodeProjectionSchema.parse(entity.projection));
    expect(denseNodes).toHaveLength(19);
    expect(denseNodes?.length ?? 0).toBeLessThanOrEqual(32);
    const crewByLead = new Map<string, number>();
    for (const node of denseNodes ?? []) {
      if (
        node.ownerNodeId.availability === "present" &&
        node.ownerNodeId.value !== null
      ) {
        crewByLead.set(
          node.ownerNodeId.value,
          (crewByLead.get(node.ownerNodeId.value) ?? 0) + 1,
        );
      }
    }
    expect(Math.max(...crewByLead.values())).toBeLessThanOrEqual(3);
  });

  for (const [name, file, schema] of [
    [
      "memory overview",
      WORKSPACE_CLIENT_FIXTURE_FILES.memoryOverview,
      MemoryOverviewProjectionSchema,
    ],
    [
      "memory library",
      WORKSPACE_CLIENT_FIXTURE_FILES.memoryLibrary,
      MemoryListPageSchema,
    ],
    [
      "memory recall",
      WORKSPACE_CLIENT_FIXTURE_FILES.memoryRecall,
      MemoryRecallPreviewSchema,
    ],
    [
      "memory maintenance",
      WORKSPACE_CLIENT_FIXTURE_FILES.memoryMaintenance,
      MemoryMaintenanceProjectionSchema,
    ],
  ] as const) {
    test(`${name} covers every immutable client state`, async () => {
      const fixtures = z
        .array(fixtureSchema(schema))
        .parse(await readJSON(file));
      expectSevenStateMatrix(fixtures);
    });
  }
});

// Model control has no whole-wire Zod validator. Exact production-builder
// equality pins the daemon presentation, while exported nested schemas verify
// the raw evidence it preserves.
function validateModelControlNestedContracts(
  view: WorkspaceModelControlView,
): void {
  expect(Object.keys(view).sort()).toEqual([
    "observedAt",
    "providers",
    "routing",
    "schemaVersion",
    "snapshot",
    "tokenSessions",
  ]);
  RoutingPolicySchema.parse(view.routing.policy);
  const { snapshot } = view;
  for (const provider of Object.values(snapshot.providers)) {
    if (provider.status !== "ok") continue;
    for (const record of provider.records) {
      CapabilityRecordSchema.parse(record);
    }
    EffectiveDefaultSchema.parse(provider.effectiveDefault);
  }
  if (snapshot.tokenUsage !== null) {
    TokenUsageSnapshotSchema.parse(snapshot.tokenUsage);
  }
  if (snapshot.quota !== null) {
    for (const quota of snapshot.quota) {
      QuotaStatusSchema.parse(quota);
    }
  }
}
