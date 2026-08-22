import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BREAKER_SOURCE_ABSENT,
  projectHierarchyEntities,
  projectStrandedManifestEntity,
  UNSUPPLIED_SOURCE_DETAILS,
} from "../../src/daemon/status-service/status-hierarchy-projection";
import {
  ABSENCE_REASONS,
  HIERARCHY_ENTITY_KINDS,
  HierarchyBudgetProjectionSchema,
  HierarchyIncidentProjectionSchema,
  HierarchyNodeProjectionSchema,
  HierarchyReviewProjectionSchema,
  HierarchyRunProjectionSchema,
  HierarchyStrandedManifestProjectionSchema,
  HierarchyTaskProjectionSchema,
} from "../../src/schemas/hierarchy-projection";
import {
  FIXTURE_RUN_ID,
  FIXTURE_STRANDED_ITEMS,
  SCENARIO_BUILDERS,
  type ScenarioName,
} from "../fixtures/hierarchy-snapshot/builders";
import type { JsonObject } from "../../src/shared/json";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/hierarchy-snapshot");

const GOLDEN_SCENARIOS = [
  "direct",
  "flat",
  "full-hive",
  "full-hive-dense-19",
  "lead-loss",
  "ownership-transfer",
  "all-absent",
  "partial",
] as const satisfies readonly ScenarioName[];

function entitiesByKind(
  entities: ReturnType<typeof projectHierarchyEntities>,
  kind: string,
) {
  return entities.filter((entity) => entity.kind === kind);
}

function requireOne<T>(items: readonly T[], label: string): T {
  if (items[0] === undefined) {
    throw new Error(`expected at least one ${label}`);
  }
  return items[0];
}

function parseRun(entity: { projection: JsonObject }) {
  return HierarchyRunProjectionSchema.parse(entity.projection);
}

function parseNode(entity: { projection: JsonObject }) {
  return HierarchyNodeProjectionSchema.parse(entity.projection);
}

function soleKind(
  entities: ReturnType<typeof projectHierarchyEntities>,
  kind: string,
) {
  return requireOne(entitiesByKind(entities, kind), kind);
}

function parseIncident(input: Parameters<typeof projectHierarchyEntities>[0]) {
  return HierarchyIncidentProjectionSchema.parse(
    soleKind(projectHierarchyEntities(input), HIERARCHY_ENTITY_KINDS.incident)
      .projection,
  );
}

function parseTask(input: Parameters<typeof projectHierarchyEntities>[0]) {
  return HierarchyTaskProjectionSchema.parse(
    soleKind(projectHierarchyEntities(input), HIERARCHY_ENTITY_KINDS.task)
      .projection,
  );
}

describe("hierarchy-snapshot-projection", () => {
  test("golden fixtures exist for all eight snapshot scenarios", () => {
    const files = readdirSync(FIXTURE_DIR).filter((name) =>
      name.endsWith(".json"),
    );
    for (const scenario of GOLDEN_SCENARIOS) {
      expect(files).toContain(`${scenario}.json`);
    }
  });

  test("golden fixtures match the pure projector output (mutation-proof)", () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      const input = SCENARIO_BUILDERS[scenario]();
      const projected = projectHierarchyEntities(input);
      // SAFETY: The test owns this value and its fields.
      const golden = JSON.parse(
        readFileSync(join(FIXTURE_DIR, `${scenario}.json`), "utf8"),
      ) as ReturnType<typeof projectHierarchyEntities>;
      expect(projected).toEqual(golden);
    }
  });

  test("the dense golden reaches 19 nodes without crossing either session limit", () => {
    const entities = projectHierarchyEntities(
      SCENARIO_BUILDERS["full-hive-dense-19"](),
    );
    const nodes = entitiesByKind(entities, HIERARCHY_ENTITY_KINDS.node).map(
      parseNode,
    );
    expect(nodes).toHaveLength(19);
    expect(nodes.length).toBeLessThanOrEqual(32);

    const leads = new Set(
      nodes
        .filter(
          (node) =>
            node.organizationalRole.availability === "present" &&
            node.organizationalRole.value === "lead-worker",
        )
        .map((node) => node.nodeId),
    );
    const crewByLead = new Map<string, number>();
    for (const node of nodes) {
      if (
        node.ownerNodeId.availability !== "present" ||
        node.ownerNodeId.value === null
      ) {
        continue;
      }
      expect(leads.has(node.ownerNodeId.value)).toBe(true);
      crewByLead.set(
        node.ownerNodeId.value,
        (crewByLead.get(node.ownerNodeId.value) ?? 0) + 1,
      );
    }
    expect(Math.max(...crewByLead.values())).toBe(3);

    const projectedBudget = HierarchyBudgetProjectionSchema.parse(
      soleKind(entities, HIERARCHY_ENTITY_KINDS.budget).projection,
    );
    if (projectedBudget.limits.availability !== "present") {
      throw new Error("the dense fixture supplies its run budget");
    }
    expect(projectedBudget.limits.value.activeSessions).toEqual({
      hard: 32,
      soft: 24,
      reserved: 19,
      used: 19,
    });
    expect(projectedBudget.limits.value.perLeadCrew.hard).toBe(3);
  });

  test("acceptance row 02: direct, flat, and full-hive share root/worker semantics", () => {
    for (const scenario of ["direct", "flat", "full-hive"] as const) {
      const entities = projectHierarchyEntities(SCENARIO_BUILDERS[scenario]());
      const runs = entitiesByKind(entities, HIERARCHY_ENTITY_KINDS.run);
      expect(runs).toHaveLength(1);
      const run = parseRun(requireOne(runs, "run"));
      expect(run.root.availability).toBe("present");
      if (run.root.availability === "present") {
        expect(run.root.value.kind).toBe("queen-root");
        expect(run.root.value.runId).toBe(FIXTURE_RUN_ID);
      }
      expect(run.topologySource).toEqual({
        availability: "present",
        value: "hierarchy",
      });
      expect(run.topologyKind.availability).toBe("present");
      if (run.topologyKind.availability === "present") {
        expect(run.topologyKind.value).toBe(scenario);
      }

      const nodes = entitiesByKind(entities, HIERARCHY_ENTITY_KINDS.node).map(
        parseNode,
      );
      expect(nodes.length).toBeGreaterThan(0);
      // Root workers attach with parentNodeId null; crew children name a lead.
      // Queen is never manufactured as a hierarchy node.
      for (const node of nodes) {
        expect(node.parentNodeId.availability).toBe("present");
        expect(node.organizationalRole.availability).toBe("present");
        if (node.organizationalRole.availability === "present") {
          expect(["worker", "lead-worker"]).toContain(
            node.organizationalRole.value,
          );
        }
      }
      const hasWorker = nodes.some(
        (node) =>
          node.organizationalRole.availability === "present" &&
          node.organizationalRole.value === "worker",
      );
      expect(hasWorker).toBe(true);
    }
  });

  test("acceptance row 02: reviewer is an assignment kind, never a hierarchy tier", () => {
    for (const scenario of ["direct", "flat", "full-hive"] as const) {
      const nodes = entitiesByKind(
        projectHierarchyEntities(SCENARIO_BUILDERS[scenario]()),
        HIERARCHY_ENTITY_KINDS.node,
      ).map(parseNode);
      const reviewers = nodes.filter(
        (node) =>
          node.assignmentKind.availability === "present" &&
          node.assignmentKind.value === "reviewer",
      );
      expect(reviewers.length).toBeGreaterThan(0);
      for (const reviewer of reviewers) {
        expect(reviewer.organizationalRole.availability).toBe("present");
        if (reviewer.organizationalRole.availability === "present") {
          // Reviewer duty never promotes the node into a special tier.
          expect(reviewer.organizationalRole.value).toBe("worker");
        }
        expect(reviewer.organizationalRole).not.toEqual({
          availability: "present",
          value: "reviewer",
        });
      }
    }
  });

  test("SessionLocator is absent from every hierarchy-node entity", () => {
    for (const scenario of GOLDEN_SCENARIOS) {
      const nodes = entitiesByKind(
        projectHierarchyEntities(SCENARIO_BUILDERS[scenario]()),
        HIERARCHY_ENTITY_KINDS.node,
      );
      for (const entity of nodes) {
        expect(entity.projection).not.toHaveProperty("sessionLocator");
        const json = JSON.stringify(entity.projection);
        expect(json.includes("sessionLocator")).toBe(false);
        expect(json.includes("sessionId")).toBe(false);
        const parsed = parseNode(entity);
        if (parsed.binding.availability === "present") {
          expect(parsed.binding.value).toEqual({
            nodeId: parsed.binding.value.nodeId,
            agentId: parsed.binding.value.agentId,
            generation: parsed.binding.value.generation,
          });
          expect(Object.keys(parsed.binding.value).sort()).toEqual(
            ["agentId", "generation", "nodeId"].sort(),
          );
        }
      }
    }
  });

  test("partial: run present with topology/budget/reviews withheld stays absent on each branch", () => {
    // Mutation target: these three branches fire when the store has a Run but
    // not yet TopologyDecision, RunBudget, or Review rows. Fabricating present
    // values here is the U1 silent-relabel defect class.
    const entities = projectHierarchyEntities(SCENARIO_BUILDERS.partial());
    const run = parseRun(soleKind(entities, HIERARCHY_ENTITY_KINDS.run));
    expect(run.root.availability).toBe("present");
    expect(run.phase.availability).toBe("present");
    expect(run.topologyKind).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: "no TopologyDecision supplied for this run",
    });
    expect(run.topologySource).toEqual({
      availability: "present",
      value: "hierarchy",
    });

    const budget = HierarchyBudgetProjectionSchema.parse(
      soleKind(entities, HIERARCHY_ENTITY_KINDS.budget).projection,
    );
    expect(budget.limits).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: "no RunBudget supplied",
    });

    const reviews = HierarchyReviewProjectionSchema.parse(
      soleKind(entities, HIERARCHY_ENTITY_KINDS.review).projection,
    );
    expect(reviews.reviews).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: "no Review records supplied",
    });
  });

  test("every consumed field has present fixtures and all-absent coverage", () => {
    const present = projectHierarchyEntities(SCENARIO_BUILDERS.direct());
    const run = parseRun(soleKind(present, HIERARCHY_ENTITY_KINDS.run));
    expect(run.phase.availability).toBe("present");
    expect(run.lifecycle.availability).toBe("present");
    expect(run.root.availability).toBe("present");
    expect(run.topologyKind.availability).toBe("present");

    const budget = HierarchyBudgetProjectionSchema.parse(
      soleKind(present, HIERARCHY_ENTITY_KINDS.budget).projection,
    );
    expect(budget.limits.availability).toBe("present");

    const reviews = HierarchyReviewProjectionSchema.parse(
      soleKind(present, HIERARCHY_ENTITY_KINDS.review).projection,
    );
    expect(reviews.reviews.availability).toBe("present");

    const node = parseNode(soleKind(present, HIERARCHY_ENTITY_KINDS.node));
    expect(node.assignmentKind.availability).toBe("present");
    expect(node.binding.availability).toBe("present");

    const stranded = HierarchyStrandedManifestProjectionSchema.parse(
      projectStrandedManifestEntity(FIXTURE_STRANDED_ITEMS).projection,
    );
    expect(stranded.items).toEqual({
      availability: "present",
      value: [...FIXTURE_STRANDED_ITEMS],
    });

    // all-absent: every field the rail consumes is availability:absent
    const absent = projectHierarchyEntities(SCENARIO_BUILDERS["all-absent"]());
    const absentRun = parseRun(soleKind(absent, HIERARCHY_ENTITY_KINDS.run));
    for (const field of [
      absentRun.root,
      absentRun.phase,
      absentRun.lifecycle,
      absentRun.topologyKind,
      absentRun.topologySource,
    ] as const) {
      expect(field.availability).toBe("absent");
    }
    const absentBudget = HierarchyBudgetProjectionSchema.parse(
      soleKind(absent, HIERARCHY_ENTITY_KINDS.budget).projection,
    );
    expect(absentBudget.limits.availability).toBe("absent");
    const absentReviews = HierarchyReviewProjectionSchema.parse(
      soleKind(absent, HIERARCHY_ENTITY_KINDS.review).projection,
    );
    expect(absentReviews.reviews.availability).toBe("absent");
    const absentStranded = HierarchyStrandedManifestProjectionSchema.parse(
      projectStrandedManifestEntity(null).projection,
    );
    expect(absentStranded.items).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: UNSUPPLIED_SOURCE_DETAILS.strandedManifests,
    });
  });

  test("the board renders the stored tasks in store order", () => {
    const board = parseTask(SCENARIO_BUILDERS["full-hive"]());
    expect(board.schemaVersion).toBe(3);
    // entityRevision tracks the newest stored task, so an update moves the row.
    expect(board.entityRevision).toBe("2");
    // Store order is id order, which on UUIDv7 task ids is creation order:
    // the board sorts oldest-first with no ordering field of its own.
    expect(board.tasks).toEqual({
      availability: "present",
      value: [
        {
          taskId: "task_018f4f5e-0000-7000-8000-0000000000a1",
          revision: "2",
          state: "completed",
          ownerNodeId: "node_018f4f5e-0000-7000-8000-000000000104",
          assigneeNodeId: "node_018f4f5e-0000-7000-8000-000000000105",
          parentTaskId: null,
          dependsOn: [],
          branch: "hive/david",
          blockers: [],
          evidence: [],
        },
        {
          taskId: "task_018f4f5e-0000-7000-8000-0000000000a2",
          revision: "1",
          state: "in-progress",
          ownerNodeId: "node_018f4f5e-0000-7000-8000-000000000104",
          assigneeNodeId: "node_018f4f5e-0000-7000-8000-000000000106",
          parentTaskId: null,
          dependsOn: ["task_018f4f5e-0000-7000-8000-0000000000a1"],
          branch: "hive/emma",
          blockers: [],
          evidence: [],
        },
      ],
    });
  });

  test("a read task source with no tasks is present and empty, not absent", () => {
    const measured = parseTask(SCENARIO_BUILDERS.flat());
    expect(measured.tasks).toEqual({ availability: "present", value: [] });

    const unread = parseTask(SCENARIO_BUILDERS.direct());
    expect(unread.tasks).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: UNSUPPLIED_SOURCE_DETAILS.tasks,
    });
  });

  test("each incident variant renders from a real source record", () => {
    const populated = parseIncident(SCENARIO_BUILDERS["full-hive"]());
    if (populated.runDecision.availability !== "present") {
      throw new Error("full-hive supplies run-control decisions");
    }
    expect(populated.runDecision.value).toEqual([
      {
        idempotencyKey: "run-pause-once",
        intentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        outcome: { status: "accepted" },
        observedRevision: "3",
      },
      {
        idempotencyKey: "run-pause-again",
        intentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        outcome: { status: "rejected", failureCode: "lifecycle-invalid" },
        observedRevision: "3",
      },
    ]);

    const recovered = parseIncident(SCENARIO_BUILDERS["ownership-transfer"]());
    if (recovered.recovery.availability !== "present") {
      throw new Error("the ownership-transfer scenario supplies a transfer");
    }
    expect(recovered.recovery.value).toEqual([
      {
        transferId: "transfer_018f4f5e-0000-7000-8000-000000000801",
        reason: "owner-bindings-unbound",
        lostOwnerNodeId: expect.stringMatching(/^node_/),
        successorNodeId: expect.stringMatching(/^node_/),
        hierarchyRevision: "5",
      },
    ]);
  });

  test("absence reasons stay distinct: unmeasured is not source-absent", () => {
    // Mutation target: give the breaker an `unmeasured` reason, or give an
    // unsupplied variant `source-absent`, and this fails. Collapsing them
    // tells a reader to wait for a record that will never be written.
    const incident = parseIncident(SCENARIO_BUILDERS.direct());
    expect(incident.breaker).toEqual({
      availability: "absent",
      reason: "source-absent",
      detail: BREAKER_SOURCE_ABSENT,
    });
    expect(incident.runDecision).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: UNSUPPLIED_SOURCE_DETAILS.runDecisions,
    });
    expect(incident.recovery).toEqual({
      availability: "absent",
      reason: "unmeasured",
      detail: UNSUPPLIED_SOURCE_DETAILS.transfers,
    });
    // A measured-empty variant is a third answer again: the source was read.
    const measured = parseIncident(SCENARIO_BUILDERS.flat());
    expect(measured.runDecision).toEqual({
      availability: "present",
      value: [],
    });

    // Three answers, three shapes. Every absence reason the schema admits has
    // a producer here, so neither can be quietly folded into the other.
    const answers = new Set([
      incident.breaker.reason,
      incident.runDecision.availability === "absent"
        ? incident.runDecision.reason
        : "present",
      measured.runDecision.availability,
    ]);
    expect(answers).toEqual(
      new Set(["source-absent", "unmeasured", "present"]),
    );
    expect(new Set(ABSENCE_REASONS)).toEqual(
      new Set(["unmeasured", "source-absent"]),
    );
  });

  test("lead-loss keeps terminated lead visible and crew parented under it", () => {
    const nodes = entitiesByKind(
      projectHierarchyEntities(SCENARIO_BUILDERS["lead-loss"]()),
      HIERARCHY_ENTITY_KINDS.node,
    ).map(parseNode);
    const lead = nodes.find(
      (node) =>
        node.organizationalRole.availability === "present" &&
        node.organizationalRole.value === "lead-worker",
    );
    expect(lead).toBeDefined();
    if (lead === undefined) throw new Error("expected terminated lead");
    expect(lead.lifecycle).toEqual({
      availability: "present",
      value: "terminated",
    });
    const crew = nodes.filter(
      (node) =>
        node.parentNodeId.availability === "present" &&
        node.parentNodeId.value === lead.nodeId,
    );
    expect(crew.length).toBeGreaterThan(0);
  });

  test("ownership-transfer reparents crew under the replacement lead", () => {
    const nodes = entitiesByKind(
      projectHierarchyEntities(SCENARIO_BUILDERS["ownership-transfer"]()),
      HIERARCHY_ENTITY_KINDS.node,
    ).map(parseNode);
    const activeLeads = nodes.filter(
      (node) =>
        node.organizationalRole.availability === "present" &&
        node.organizationalRole.value === "lead-worker" &&
        node.lifecycle.availability === "present" &&
        node.lifecycle.value === "active",
    );
    expect(activeLeads).toHaveLength(1);
    const replacement = requireOne(activeLeads, "active lead");
    const crew = nodes.filter(
      (node) =>
        node.ownerNodeId.availability === "present" &&
        node.ownerNodeId.value === replacement.nodeId,
    );
    expect(crew.length).toBeGreaterThan(0);
  });

  test("the projector stays pure: no store, no db, no IO", async () => {
    const source = await Bun.file(
      join(
        import.meta.dir,
        "../../src/daemon/status-service/status-hierarchy-projection.ts",
      ),
    ).text();
    // Comments may name the store seam; imports and IO must not appear.
    expect(/from\s+["'].*hierarchy-store/.test(source)).toBe(false);
    expect(/from\s+["']\.\/db/.test(source)).toBe(false);
    expect(source.includes("node:fs")).toBe(false);
    expect(source.includes("node:http")).toBe(false);
  });
});
