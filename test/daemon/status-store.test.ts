import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { verifyWorkspaceSnapshot } from "../../src/daemon/status-service/events";
import {
  StatusAssignmentMismatchError,
  StatusRequestConflictError,
  StatusStore,
} from "../../src/daemon/status/status-store";
import { HIERARCHY_ENTITY_KINDS } from "../../src/schemas/hierarchy-projection";
import {
  HiveUpdateStatusAdvertisedSchema,
  HiveUpdateStatusInputSchema,
} from "../../src/schemas/status-envelope";
import { required } from "../required";

const AT = "2026-07-16T12:00:00.000Z";
const REQUEST = "req_018f1e90-7b5a-7cc0-8000-000000000001";

describe("StatusStore", () => {
  test("increments flat Assignment generations and rejects closed or spoofed bindings", () => {
    const store = new StatusStore(
      new HiveDatabase(":memory:"),
      "instance-fixture",
    );
    const first = store.openAssignment("agent-fixture", AT);
    expect(first.assignmentGeneration).toBe("1");
    store.closeAssignment("agent-fixture", "2026-07-16T12:01:00.000Z");
    expect(() =>
      store.appendAgentReport(
        {
          subject: "maya",
          agentId: "agent-fixture",
          incarnationGeneration: 7,
          role: "writer",
          capabilityEpoch: 0,
          toolSessionId: null,
        },
        {
          requestId: REQUEST,
          assignmentId: first.assignmentId,
          assignmentGeneration: first.assignmentGeneration,
          phase: "testing",
          summary: "Testing",
          blocker: null,
          evidenceRefs: [],
          freshForSeconds: 120,
        },
        new Date(AT),
      ),
    ).toThrow(StatusAssignmentMismatchError);

    const second = store.openAssignment(
      "agent-fixture",
      "2026-07-16T12:02:00.000Z",
    );
    expect(second.assignmentGeneration).toBe("2");
    expect(() =>
      store.appendAgentReport(
        {
          subject: "maya",
          agentId: "agent-fixture",
          incarnationGeneration: 7,
          role: "writer",
          capabilityEpoch: 0,
          toolSessionId: null,
        },
        {
          requestId: REQUEST,
          assignmentId: second.assignmentId,
          assignmentGeneration: "1",
          phase: "testing",
          summary: "Spoofed generation",
          blocker: null,
          evidenceRefs: [],
          freshForSeconds: 120,
        },
        new Date(AT),
      ),
    ).toThrow(StatusAssignmentMismatchError);
  });

  test("appends immutable reports and retries only identical request digests", () => {
    const store = new StatusStore(
      new HiveDatabase(":memory:"),
      "instance-fixture",
    );
    const assignment = store.openAssignment("agent-fixture", AT);
    const actor = {
      subject: "maya",
      agentId: "agent-fixture",
      incarnationGeneration: 7,
      role: "reader" as const,
      capabilityEpoch: 4,
      toolSessionId: "tool-fixture",
    };
    const input = {
      requestId: REQUEST,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete" as const,
      progress: 100,
      summary: "Implementation is complete",
      blocker: null,
      evidenceRefs: ["test:status"],
      freshForSeconds: 120,
    };
    const first = store.appendAgentReport(actor, input, new Date(AT));
    expect(store.appendAgentReport(actor, input, new Date(AT))).toEqual(first);
    expect(store.listEvents()).toHaveLength(1);
    expect(() =>
      store.appendAgentReport(
        actor,
        {
          ...input,
          summary: "Different retry body",
        },
        new Date(AT),
      ),
    ).toThrow(StatusRequestConflictError);

    const report = required(store.listEvents()[0]);
    expect(report.data.binding).toEqual({
      agentId: "agent-fixture",
      incarnationGeneration: 7,
      role: "reader",
      instanceId: "instance-fixture",
      capabilityEpoch: 4,
      issuer: "hive-daemon",
      session: "tool-fixture",
    });
    expect(
      HiveUpdateStatusInputSchema.safeParse({
        ...input,
        taskState: "complete",
        approval: "approved",
        landState: "landed",
      }).success,
    ).toBeFalse();

    // MCP requires a top-level object, while the store uses a discriminated
    // union. They must keep declaring and accepting the same states.
    const advertised = Object.keys(
      HiveUpdateStatusAdvertisedSchema.shape,
    ).sort();
    expect(HiveUpdateStatusInputSchema.options).toHaveLength(6);
    for (const branch of HiveUpdateStatusInputSchema.options) {
      expect(Object.keys(branch.shape).sort()).toEqual(advertised);
    }

    const nonBlockedWithBlocker = {
      ...input,
      blocker: "not a blocked report",
    };
    expect(
      HiveUpdateStatusInputSchema.safeParse(nonBlockedWithBlocker).success,
    ).toBeFalse();
    expect(
      HiveUpdateStatusAdvertisedSchema.safeParse(nonBlockedWithBlocker).success,
    ).toBeFalse();
    const { blocker: _blocker, ...nonBlockedWithoutBlocker } = input;
    expect(
      HiveUpdateStatusInputSchema.safeParse(nonBlockedWithoutBlocker).success,
    ).toBeTrue();
    const blockedWithoutBlocker = {
      ...input,
      phase: "blocked" as const,
      blocker: null,
    };
    expect(
      HiveUpdateStatusInputSchema.safeParse(blockedWithoutBlocker).success,
    ).toBeFalse();
    expect(
      HiveUpdateStatusAdvertisedSchema.safeParse(blockedWithoutBlocker).success,
    ).toBeFalse();
    const blockedWithBlocker = {
      ...input,
      phase: "blocked" as const,
      blocker: "waiting on review",
    };
    expect(
      HiveUpdateStatusInputSchema.safeParse(blockedWithBlocker).success,
    ).toBeTrue();
    expect(
      HiveUpdateStatusAdvertisedSchema.safeParse(blockedWithBlocker).success,
    ).toBeTrue();
  });

  test("a live agent keeps one open Assignment across a complete report; only close rejects it", () => {
    const store = new StatusStore(
      new HiveDatabase(":memory:"),
      "instance-fixture",
    );
    const assignment = store.openAssignment("agent-fixture", AT);
    const actor = {
      subject: "maya",
      agentId: "agent-fixture",
      incarnationGeneration: 7,
      role: "writer" as const,
      capabilityEpoch: 0,
      toolSessionId: null,
    };
    const report = (
      requestId: string,
      ids: { assignmentId: string; assignmentGeneration: string },
      phase: "complete" | "implementing",
      summary: string,
    ) =>
      store.appendAgentReport(
        actor,
        {
          requestId,
          assignmentId: ids.assignmentId,
          assignmentGeneration: ids.assignmentGeneration,
          phase,
          summary,
          blocker: null,
          evidenceRefs: [],
          freshForSeconds: 120,
        },
        new Date(AT),
      );

    expect(
      report(
        "req_018f1e90-7b5a-7cc0-8000-000000000011",
        assignment,
        "complete",
        "First story done",
      ).eventId,
    ).toMatch(/^evt_/);
    expect(store.currentAssignment("agent-fixture")).toEqual(assignment);
    expect(
      report(
        "req_018f1e90-7b5a-7cc0-8000-000000000012",
        assignment,
        "implementing",
        "Reused on the next story",
      ).eventId,
    ).toMatch(/^evt_/);

    store.closeAssignment("agent-fixture", "2026-07-16T12:01:00.000Z");
    expect(() =>
      report(
        "req_018f1e90-7b5a-7cc0-8000-000000000013",
        assignment,
        "implementing",
        "After kill",
      ),
    ).toThrow(StatusAssignmentMismatchError);

    const successor = store.openAssignment(
      "agent-fixture",
      "2026-07-16T12:02:00.000Z",
    );
    expect(successor.assignmentGeneration).toBe("2");
    expect(() =>
      report(
        "req_018f1e90-7b5a-7cc0-8000-000000000014",
        assignment,
        "implementing",
        "Predecessor spoof",
      ),
    ).toThrow(StatusAssignmentMismatchError);
    expect(
      report(
        "req_018f1e90-7b5a-7cc0-8000-000000000015",
        successor,
        "implementing",
        "Successor reports",
      ).eventId,
    ).toMatch(/^evt_/);
  });

  test("builds verifiable snapshots and redacted terminal-content audit events", async () => {
    const store = new StatusStore(
      new HiveDatabase(":memory:"),
      "instance-fixture",
    );
    store.appendObservationAudit({
      reader: "maya",
      readerRole: "writer",
      subjectAgentId: "agent-fixture",
      subjectGeneration: 1,
      rowCount: 3,
      reason: "capability:fixture",
      observedAt: AT,
    });
    const audit = required(store.listEvents()[0]);
    expect(audit.data).toEqual({
      reader: "maya",
      subject: "agent-fixture",
      sessionGeneration: 1,
      rowCount: 3,
      reason: "capability:fixture",
    });
    expect(JSON.stringify(audit)).not.toContain("terminal secret");
    const snapshot = await store.fetchSnapshot();
    expect(verifyWorkspaceSnapshot(snapshot, "0")).toEqual(snapshot);
    expect(snapshot.entities[0]?.projection).toMatchObject({
      workflowState: { kind: "reserved" },
    });
  });

  test("keeps live projection work bounded while retaining the complete audit stream", () => {
    const store = new StatusStore(
      new HiveDatabase(":memory:"),
      "instance-fixture",
    );
    for (let index = 0; index < 100; index += 1) {
      const observedAt = new Date(Date.parse(AT) + index).toISOString();
      store.appendSourceEvent({
        entity: { kind: "agent", id: "agent-fixture" },
        occurredAt: observedAt,
        kind: "status.turn",
        source: {
          kind: "provider-protocol",
          id: "codex:run:session",
          observedAt,
          confidence: "authoritative",
        },
        data: { agentId: "agent-fixture", value: "working" },
      });
    }

    expect(store.listEventsForAgent("agent-fixture")).toHaveLength(100);
    expect(store.currentProjectionForAgent("agent-fixture")).toMatchObject({
      revision: "100",
      events: [{ data: { value: "working" } }],
    });
  });

  test("migrates the legacy event table into indexed streams and projections", () => {
    const db = new HiveDatabase(":memory:");
    db.database.exec(`
      CREATE TABLE status_workspace_events (
        eventId TEXT PRIMARY KEY,
        seq TEXT NOT NULL UNIQUE,
        entityKey TEXT NOT NULL,
        entityRevision TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    const legacyEvent = {
      schemaVersion: 2 as const,
      eventId: "evt_018f1e90-7b5a-7cc0-8000-000000000701",
      seq: "1",
      entity: { kind: "agent", id: "agent-fixture" },
      entityRevision: "1",
      occurredAt: AT,
      kind: "status.turn",
      source: {
        kind: "provider-protocol" as const,
        id: "codex:run:session",
        observedAt: AT,
        confidence: "authoritative" as const,
      },
      data: {
        agentId: "agent-fixture",
        providerSequence: 7,
        value: "working",
      },
    };
    db.database
      .query(`
        INSERT INTO status_workspace_events (
          eventId, seq, entityKey, entityRevision, payload
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        legacyEvent.eventId,
        legacyEvent.seq,
        "agent:agent-fixture",
        legacyEvent.entityRevision,
        JSON.stringify(legacyEvent),
      );

    const store = new StatusStore(db, "instance-fixture");

    expect(store.listEventsForAgent("agent-fixture")).toEqual([legacyEvent]);
    expect(store.currentProjectionForAgent("agent-fixture")).toMatchObject({
      revision: "1",
      events: [{ data: { value: "working" } }],
    });
    expect(
      store.acceptProviderReport({
        sourceId: "codex:run:session",
        providerSequence: 7,
        projection: '{"turn":"working"}',
        events: [],
      }),
    ).toEqual({ kind: "duplicate" });
    const plan = db.database
      .query(`
        EXPLAIN QUERY PLAN
        SELECT payload FROM status_workspace_events
        WHERE subjectAgentId = ? ORDER BY seqKey
      `)
      .all("agent-fixture") as Array<{ detail: string }>;
    expect(
      plan.some((row) =>
        row.detail.includes("status_workspace_events_agent_seq"),
      ),
    ).toBeTrue();
    db.close();
  });
});

describe("the snapshot carries the hierarchy the store holds", () => {
  const runId = "run_018f4f5e-0000-7000-8000-000000000001";
  const nodeId = "node_018f4f5e-0000-7000-8000-000000000001";
  const digest = `sha256:${"a".repeat(64)}`;
  const ref = { revision: "1", digest };

  function seedRun(db: HiveDatabase): void {
    const hierarchy = new HierarchyStore(db);
    hierarchy.putRun(
      {
        runId,
        revision: "1",
        repo: "hive",
        instanceId: "instance-fixture",
        approvedSpec: null,
        currentPlan: ref,
        topology: ref,
        phase: "P1",
        g1: { state: "pending" },
        g2: { state: "pending" },
        baseSha: "f".repeat(40),
        budget: ref,
        runEpoch: 0,
        lifecycle: "active",
      },
      null,
    );
    hierarchy.putNode(
      {
        nodeId,
        runId,
        parentNodeId: null,
        ownerNodeId: null,
        organizationalRole: "worker",
        assignmentKind: "author",
        taskScope: [],
        capacityCharge: 1,
        lifecycle: "active",
        revision: "1",
      },
      null,
    );
    const limit = { hard: 4, soft: 2, reserved: 2, used: 1 };
    hierarchy.putRunBudget(
      {
        runId,
        revision: "1",
        digest,
        createdAt: "2026-07-30T12:00:00.000Z",
        lifecycle: "proposed",
        limits: {
          activeSessions: limit,
          totalSpawns: limit,
          perLeadCrew: limit,
          reviewerPool: limit,
          vendorQuota: limit,
          tokens: limit,
          costCents: limit,
          wallTimeMs: limit,
          ci: limit,
          wakeBudget: limit,
          messageBudget: limit,
        },
        anomalyThresholds: { spendPerHour: 100 },
      },
      0,
    );
  }

  test("a seeded run reaches the snapshot as hierarchy entities", async () => {
    const db = new HiveDatabase(":memory:");
    const store = new StatusStore(db, "instance-fixture");
    seedRun(db);

    const snapshot = await store.fetchSnapshot();

    expect(
      snapshot.entities.find(
        (entity) => entity.kind === HIERARCHY_ENTITY_KINDS.run,
      ),
    ).toMatchObject({ id: runId, entityRevision: "1" });
    expect(
      snapshot.entities.find(
        (entity) => entity.kind === HIERARCHY_ENTITY_KINDS.node,
      ),
    ).toMatchObject({ id: nodeId });
    // The budget is a source the projector consumes: a seam that dropped it
    // would render "no RunBudget supplied" over a run that has one.
    expect(
      snapshot.entities.find(
        (entity) => entity.kind === HIERARCHY_ENTITY_KINDS.budget,
      )?.projection.limits,
    ).toMatchObject({ availability: "present" });
    // The content digest must cover the hierarchy rows too, not just agents.
    expect(verifyWorkspaceSnapshot(snapshot, "0")).toEqual(snapshot);
  });

  test("a repo with no run asserts no topology, but still answers about stranded work", async () => {
    const db = new HiveDatabase(":memory:");
    const store = new StatusStore(db, "instance-fixture");

    const before = await store.fetchSnapshot();
    // Nothing run-keyed is invented for a repo that has no Run…
    expect(
      before.entities.filter(
        (entity) => entity.kind !== HIERARCHY_ENTITY_KINDS.strandedManifest,
      ),
    ).toEqual([]);
    // …but the agent-keyed row is read anyway, because stranded work does not
    // wait for a run to exist before it happens.
    expect(before.entities).toHaveLength(1);

    // Positive control: the same reader does find run-keyed entities once a
    // run exists, so the empty answer above is an empty world, not a blind read.
    seedRun(db);
    const after = await store.fetchSnapshot();
    expect(
      after.entities.filter(
        (entity) => entity.kind === HIERARCHY_ENTITY_KINDS.run,
      ),
    ).toHaveLength(1);
  });
});
