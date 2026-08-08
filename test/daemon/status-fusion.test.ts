import { describe, expect, test } from "bun:test";
import {
  fuseAgentStatus,
  STATUS_DIMENSIONS,
  steadyStateUnknowns,
  workspaceStatusDimensions,
} from "../../src/daemon/status-service/fusion";
import type { WorkspaceEventV2 } from "../../src/schemas/status-envelope";

const AT = "2026-07-16T12:00:00.000Z";
const event = (
  index: number,
  kind: string,
  sourceKind: WorkspaceEventV2["source"]["kind"],
  data: Record<string, unknown>,
  observedAt = AT,
  confidence: WorkspaceEventV2["source"]["confidence"] = "high",
): WorkspaceEventV2 => ({
  schemaVersion: 2,
  eventId: `evt_018f1e90-7b5a-7cc0-8000-${String(index).padStart(12, "0")}`,
  seq: String(index),
  entity:
    sourceKind === "sessiond"
      ? { kind: "session", id: "session-fixture", generation: 1 }
      : { kind: "agent", id: "agent-fixture" },
  entityRevision: String(index),
  occurredAt: observedAt,
  kind,
  source: {
    kind: sourceKind,
    id: `${sourceKind}-fixture`,
    observedAt,
    confidence,
  },
  data:
    sourceKind === "sessiond" ? { agentId: "agent-fixture", ...data } : data,
});

const identity = {
  agentId: "agent-fixture",
  incarnationGeneration: 1,
} as const;

describe("status fusion", () => {
  test("applies field authority, field freshness, and descriptive-report conflicts", () => {
    const now = new Date("2026-07-16T12:00:12.000Z");
    const status = fuseAgentStatus(
      [
        event(1, "status.session", "sessiond", { value: "live" }),
        event(2, "status.health", "sessiond", { value: "healthy" }),
        event(3, "status.turn", "provider-hook", { value: "working" }),
        event(4, "status.turn", "provider-app-server", {
          value: "awaiting_approval",
        }),
        event(
          5,
          "agent.status-reported",
          "agent-report",
          {
            authenticated: true,
            assignmentId: "asg_fixture",
            assignmentGeneration: "1",
            phase: "complete",
            progress: 100,
            summary: "Tests are green",
            blocker: null,
            evidenceRefs: [],
            freshUntil: "2026-07-16T12:02:00.000Z",
          },
          "2026-07-16T12:00:10.000Z",
          "authoritative",
        ),
      ],
      identity,
      now,
    );

    expect(status.sessionState).toMatchObject({
      value: "live",
      freshness: "stale",
    });
    expect(status.healthState).toMatchObject({
      value: "delayed",
      freshness: "stale",
    });
    expect(status.turnState).toMatchObject({
      value: "awaiting_approval",
      source: { kind: "provider-app-server" },
    });
    expect(status.workflowState).toEqual({ kind: "reserved" });
    expect(status.conflicts).toContain(
      "report=complete conflicts with provider lifecycle=awaiting_approval",
    );
  });

  test("expires reports and provider lifecycle without inventing idle or death", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.health", "sessiond", { value: "healthy" }),
        event(2, "status.turn", "provider-hook", { value: "working" }),
        event(
          3,
          "agent.status-reported",
          "agent-report",
          {
            authenticated: true,
            assignmentId: "asg_fixture",
            assignmentGeneration: "1",
            phase: "testing",
            progress: 80,
            summary: "Running tests",
            blocker: null,
            evidenceRefs: [],
            freshUntil: "2026-07-16T12:00:20.000Z",
          },
          AT,
          "authoritative",
        ),
      ],
      identity,
      new Date("2026-07-16T12:00:31.000Z"),
    );

    expect(status.report?.freshness).toBe("stale");
    expect(status.turnState).toMatchObject({
      value: "working",
      freshness: "stale",
    });
    expect(status.healthState).toMatchObject({
      value: "unknown",
      freshness: "unknown",
    });
  });

  test("a source superseding its own turn history is progression, not conflict", () => {
    const status = fuseAgentStatus(
      [
        event(
          1,
          "status.turn",
          "provider-hook",
          { value: "working" },
          "2026-07-16T12:00:00.000Z",
        ),
        event(
          2,
          "status.turn",
          "provider-hook",
          { value: "idle" },
          "2026-07-16T12:00:05.000Z",
        ),
        event(
          3,
          "status.turn",
          "provider-hook",
          { value: "working" },
          "2026-07-16T12:00:10.000Z",
        ),
      ],
      identity,
      new Date("2026-07-16T12:00:11.000Z"),
    );
    expect(status.turnState).toMatchObject({ value: "working" });
    expect(status.conflicts).toEqual([]);
  });

  test("two sources currently disagreeing on the turn still conflict", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.turn", "provider-hook", { value: "idle" }),
        event(2, "status.turn", "provider-app-server", { value: "working" }),
      ],
      identity,
      new Date(AT),
    );
    expect(status.turnState).toMatchObject({ value: "working" });
    expect(status.conflicts).toEqual([
      "turnState: provider-hook=idle conflicts with provider-app-server=working",
    ]);
  });

  test("falls back to labeled low-confidence telemetry when hooks are missing", () => {
    const status = fuseAgentStatus(
      [
        event(
          1,
          "status.turn",
          "provider-telemetry",
          { value: "working" },
          AT,
          "low",
        ),
      ],
      identity,
      new Date(AT),
    );
    expect(status.turnState).toMatchObject({
      value: "working",
      source: { kind: "provider-telemetry" },
      confidence: "low",
    });
  });

  test("ignores sources without authority over provider lifecycle or terminal health", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.turn", "user", { value: "done" }, AT, "authoritative"),
        event(
          2,
          "status.health",
          "agent-report",
          { value: "healthy" },
          AT,
          "authoritative",
        ),
      ],
      identity,
      new Date(AT),
    );
    expect(status.turnState).toBeNull();
    expect(status.healthState).toBeNull();
  });

  test("uses positive session exit evidence only when provider lifecycle is absent", () => {
    const status = fuseAgentStatus(
      [
        event(
          1,
          "status.turn",
          "sessiond",
          { value: "done" },
          AT,
          "authoritative",
        ),
      ],
      identity,
      new Date(AT),
    );
    expect(status.turnState).toMatchObject({
      value: "done",
      source: { kind: "sessiond" },
    });
  });

  test("derives attention only from unresolved typed attention events", () => {
    const raised = event(2, "status.attention", "provider-hook", {
      value: "approval",
      resolved: false,
    });
    const ignoredHint = event(
      1,
      "terminal.hint",
      "provider-telemetry",
      {
        attention: "failure",
        text: "APPROVED",
      },
      AT,
      "low",
    );
    expect(
      fuseAgentStatus([ignoredHint, raised], identity, new Date(AT)).attention
        ?.value,
    ).toBe("approval");
    const resolved = event(
      3,
      "status.attention-resolved",
      "user",
      {
        causeEventId: raised.eventId,
      },
      AT,
      "authoritative",
    );
    expect(
      fuseAgentStatus([ignoredHint, raised, resolved], identity, new Date(AT))
        .attention,
    ).toBeNull();
  });

  test("never converts an agent report into task, gate, approval, or land authority", () => {
    const status = fuseAgentStatus(
      [
        event(
          1,
          "agent.status-reported",
          "agent-report",
          {
            authenticated: true,
            assignmentId: "asg_fixture",
            assignmentGeneration: "1",
            phase: "complete",
            summary: "I approve and landed this",
            blocker: null,
            evidenceRefs: [],
            freshUntil: "2026-07-16T12:02:00.000Z",
            taskState: "complete",
            gateState: "approved",
            landState: "landed",
          },
          AT,
          "authoritative",
        ),
      ],
      identity,
      new Date(AT),
    );
    expect(status.report?.phase).toBe("complete");
    expect(status.workflowState).toEqual({ kind: "reserved" });
    expect(status.attention).toBeNull();
  });
});

describe("orthogonal dimensions", () => {
  test("projects six evidence-backed dimensions onto the Workspace wire", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.runtime", "provider-protocol", { value: "ready" }),
        event(2, "status.turn", "provider-protocol", { value: "working" }),
        event(3, "status.input", "sessiond", { value: "editing" }),
        event(4, "status.mail", "provider-protocol", { value: "waiting" }),
        event(5, "status.health", "sessiond", { value: "disconnected" }),
        event(6, "status.attention", "user", { value: "action" }),
      ],
      identity,
      new Date(AT),
    );

    expect(workspaceStatusDimensions(status)).toMatchObject({
      schemaVersion: 1,
      revision: "6",
      runtime: { kind: "observed", field: { value: "ready" } },
      turn: { kind: "observed", field: { value: "working" } },
      input: { kind: "observed", field: { value: "editing" } },
      mail: { kind: "observed", field: { value: "waiting" } },
      health: { kind: "observed", field: { value: "disconnected" } },
      attention: { kind: "observed", field: { value: "action" } },
    });
  });

  test("projects a reason for every dimension without evidence", () => {
    const projection = workspaceStatusDimensions(
      fuseAgentStatus([], identity, new Date(AT)),
    );

    for (const dimension of [
      projection.runtime,
      projection.turn,
      projection.input,
      projection.mail,
      projection.health,
      projection.attention,
    ]) {
      expect(dimension).toEqual({
        kind: "absent",
        reason: { kind: "unmeasured" },
      });
    }
  });

  test("an agent at a turn boundary with mail waiting is not idle", () => {
    // The repro: a vendor that emits no turn lifecycle at all was rendered
    // "idle" while its agent was mid-mission with queued work. Absent evidence
    // has to read as unknown, because "idle" is a claim about the provider that
    // nothing here measured.
    const status = fuseAgentStatus(
      [
        event(1, "status.session", "sessiond", { value: "live" }),
        event(2, "status.runtime", "provider-protocol", { value: "ready" }),
        event(3, "status.mail", "provider-protocol", { value: "waiting" }),
      ],
      identity,
      new Date(AT),
    );
    expect(status.turnState).toBeNull();
    expect(status.runtimeState?.value).toBe("ready");
    expect(status.mailState?.value).toBe("waiting");
  });

  test("runtime, turn, input and mail coexist as separate facts", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.runtime", "provider-protocol", { value: "ready" }),
        event(2, "status.turn", "provider-protocol", { value: "working" }),
        event(3, "status.input", "sessiond", { value: "editing" }),
        event(4, "status.mail", "provider-protocol", { value: "waiting" }),
      ],
      identity,
      new Date(AT),
    );
    expect([
      status.runtimeState?.value,
      status.turnState?.value,
      status.inputState?.value,
      status.mailState?.value,
    ]).toEqual(["ready", "working", "editing", "waiting"]);
    expect(status.conflicts).toEqual([]);
  });

  test("provider-protocol and the app-server alias rank equally", () => {
    const later = "2026-07-16T12:00:05.000Z";
    const status = fuseAgentStatus(
      [
        event(1, "status.turn", "provider-app-server", { value: "working" }),
        event(2, "status.turn", "provider-protocol", { value: "idle" }, later),
      ],
      identity,
      new Date(later),
    );
    // Same rank, so the newer observation wins and the older one is reported as
    // a conflict rather than silently outranked.
    expect(status.turnState?.value).toBe("idle");
    expect(status.turnState?.source.kind).toBe("provider-protocol");
    expect(status.conflicts).toHaveLength(1);
  });

  test("protocol lifecycle outranks a provider hook", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.turn", "provider-hook", { value: "idle" }),
        event(2, "status.turn", "provider-protocol", { value: "working" }),
      ],
      identity,
      new Date(AT),
    );
    expect(status.turnState?.value).toBe("working");
  });

  test("a blank dimension nobody wired is a countable release blocker", () => {
    const status = fuseAgentStatus([], identity, new Date(AT));
    expect(status.absences.turn).toEqual({ kind: "unmeasured" });
    expect(steadyStateUnknowns(status)).toEqual([...STATUS_DIMENSIONS]);
  });

  test("a proven vendor gap is a cited fact, not an unknown", () => {
    const status = fuseAgentStatus([], identity, new Date(AT), {
      turn: { citation: "docs/evidence/kimi/acp-0.31.1-no-turn-lifecycle.md" },
    });
    expect(status.absences.turn).toEqual({
      kind: "vendor-does-not-report",
      citation: "docs/evidence/kimi/acp-0.31.1-no-turn-lifecycle.md",
    });
    expect(steadyStateUnknowns(status)).not.toContain("turn");
  });

  test("a dropped transport explains its own silence", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.runtime", "provider-protocol", {
          value: "disconnected",
        }),
      ],
      identity,
      new Date(AT),
    );
    expect(status.absences.turn).toEqual({ kind: "disconnected", since: AT });
    expect(steadyStateUnknowns(status)).not.toContain("turn");
  });

  test("a dimension that spoke once and went quiet is stale, not silent", () => {
    // The event's value is outside the vocabulary, so no field survives — but
    // the source did speak, and "stale since" is a different fact from
    // "never measured".
    const status = fuseAgentStatus(
      [event(1, "status.turn", "provider-protocol", { value: "banana" })],
      identity,
      new Date(AT),
    );
    expect(status.absences.turn).toEqual({
      kind: "stale-since",
      observedAt: AT,
    });
  });

  test("a proven gap outranks a coincidental disconnect", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.runtime", "provider-protocol", {
          value: "disconnected",
        }),
      ],
      identity,
      new Date(AT),
      { turn: { citation: "docs/evidence/vendor/no-turn-lifecycle.md" } },
    );
    expect(status.absences.turn?.kind).toBe("vendor-does-not-report");
  });

  test("a measured dimension records no absence at all", () => {
    const status = fuseAgentStatus(
      [event(1, "status.mail", "provider-protocol", { value: "waiting" })],
      identity,
      new Date(AT),
    );
    expect(status.absences.mail).toBeUndefined();
    expect(steadyStateUnknowns(status)).not.toContain("mail");
  });

  test("a value outside the vocabulary is dropped rather than defaulted", () => {
    const status = fuseAgentStatus(
      [
        event(1, "status.mail", "provider-protocol", { value: "delivered" }),
        event(2, "status.runtime", "provider-protocol", { value: 0 }),
      ],
      identity,
      new Date(AT),
    );
    expect(status.mailState).toBeNull();
    expect(status.runtimeState).toBeNull();
  });
});

describe("an observation that carries no value", () => {
  const now = new Date("2026-07-16T12:00:12.000Z");
  const refused = event(1, "status.turn", "provider-hook", {}, AT, "low");

  test("proves the dimension was heard from without deciding it", () => {
    const status = fuseAgentStatus([refused], identity, now);
    expect(status.turnState).toBeNull();
    expect(status.absences.turn).toEqual({
      kind: "stale-since",
      observedAt: AT,
    });
  });

  test("separates an agent nothing can be attributed to from a silent one", () => {
    const heard = fuseAgentStatus([refused], identity, now);
    const silent = fuseAgentStatus([], identity, now);
    expect(silent.absences.turn).toEqual({ kind: "unmeasured" });
    expect(heard.turnState).toBeNull();
    expect(silent.turnState).toBeNull();
    expect(steadyStateUnknowns(heard)).not.toContain("turn");
    expect(steadyStateUnknowns(silent)).toContain("turn");
  });

  test("never outranks a value another source did prove", () => {
    const status = fuseAgentStatus(
      [refused, event(2, "status.turn", "provider-hook", { value: "working" })],
      identity,
      now,
    );
    expect(status.turnState?.value).toBe("working");
    expect(status.conflicts).toEqual([]);
  });
});

describe("the runtime source alias", () => {
  test("reads both names for the one source they rank as", () => {
    const now = new Date("2026-07-16T12:00:02.000Z");
    const status = fuseAgentStatus(
      [event(1, "status.runtime", "provider-app-server", { value: "ready" })],
      identity,
      now,
    );
    // Dropping the older name would have reported a measured runtime as
    // though nobody had ever looked at it.
    expect(status.runtimeState?.value).toBe("ready");
    expect(status.absences.runtime).toBeUndefined();
    expect(steadyStateUnknowns(status)).not.toContain("runtime");
  });
});
