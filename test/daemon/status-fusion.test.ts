import { describe, expect, test } from "bun:test";
import type { WorkspaceEventV2 } from "../../src/schemas/status-envelope";
import { composeVisibleStatus, fuseAgentStatus } from "../../src/daemon/status-fusion";

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
  entity: sourceKind === "sessiond"
    ? { kind: "session", id: "session-fixture", generation: 1 }
    : { kind: "agent", id: "agent-fixture" },
  entityRevision: String(index),
  occurredAt: observedAt,
  kind,
  source: { kind: sourceKind, id: `${sourceKind}-fixture`, observedAt, confidence },
  data: sourceKind === "sessiond" ? { agentId: "agent-fixture", ...data } : data,
});

const identity = { agentId: "agent-fixture", incarnationGeneration: 1 } as const;

describe("status fusion", () => {
  test("applies field authority, field freshness, and descriptive-report conflicts", () => {
    const now = new Date("2026-07-16T12:00:12.000Z");
    const status = fuseAgentStatus([
      event(1, "status.session", "sessiond", { value: "live" }),
      event(2, "status.health", "sessiond", { value: "healthy" }),
      event(3, "status.turn", "provider-hook", { value: "working" }),
      event(4, "status.turn", "provider-app-server", { value: "awaiting_approval" }),
      event(5, "agent.status-reported", "agent-report", {
        authenticated: true,
        assignmentId: "asg_fixture",
        assignmentGeneration: "1",
        phase: "complete",
        progress: 100,
        summary: "Tests are green",
        blocker: null,
        evidenceRefs: [],
        freshUntil: "2026-07-16T12:02:00.000Z",
      }, "2026-07-16T12:00:10.000Z", "authoritative"),
    ], identity, now);

    expect(status.sessionState).toMatchObject({ value: "live", freshness: "stale" });
    expect(status.healthState).toMatchObject({ value: "delayed", freshness: "stale" });
    expect(status.turnState).toMatchObject({
      value: "awaiting_approval",
      source: { kind: "provider-app-server" },
    });
    expect(status.workflowState).toEqual({ kind: "reserved" });
    expect(status.conflicts).toContain(
      "report=complete conflicts with provider lifecycle=awaiting_approval",
    );
    expect(composeVisibleStatus(status)).toMatchObject({
      primaryLabel: "complete: Tests are green",
      progress: 100,
    });
  });

  test("expires reports and provider lifecycle without inventing idle or death", () => {
    const status = fuseAgentStatus([
      event(1, "status.health", "sessiond", { value: "healthy" }),
      event(2, "status.turn", "provider-hook", { value: "working" }),
      event(3, "agent.status-reported", "agent-report", {
        authenticated: true,
        assignmentId: "asg_fixture",
        assignmentGeneration: "1",
        phase: "testing",
        progress: 80,
        summary: "Running tests",
        blocker: null,
        evidenceRefs: [],
        freshUntil: "2026-07-16T12:00:20.000Z",
      }, AT, "authoritative"),
    ], identity, new Date("2026-07-16T12:00:31.000Z"));

    expect(status.report?.freshness).toBe("stale");
    expect(status.turnState).toMatchObject({ value: "working", freshness: "stale" });
    expect(status.healthState).toMatchObject({ value: "unknown", freshness: "unknown" });
    expect(composeVisibleStatus(status)).toMatchObject({
      primaryLabel: "working (stale)",
      progress: null,
    });
  });

  test("falls back to labeled low-confidence telemetry when hooks are missing", () => {
    const status = fuseAgentStatus([
      event(1, "status.turn", "provider-telemetry", { value: "working" }, AT, "low"),
    ], identity, new Date(AT));
    expect(status.turnState).toMatchObject({
      value: "working",
      source: { kind: "provider-telemetry" },
      confidence: "low",
    });
  });

  test("ignores sources without authority over provider lifecycle or terminal health", () => {
    const status = fuseAgentStatus([
      event(1, "status.turn", "operator", { value: "done" }, AT, "authoritative"),
      event(2, "status.health", "agent-report", { value: "healthy" }, AT, "authoritative"),
    ], identity, new Date(AT));
    expect(status.turnState).toBeNull();
    expect(status.healthState).toBeNull();
  });

  test("uses positive session exit evidence only when provider lifecycle is absent", () => {
    const status = fuseAgentStatus([
      event(1, "status.turn", "sessiond", { value: "done" }, AT, "authoritative"),
    ], identity, new Date(AT));
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
    const ignoredHint = event(1, "terminal.hint", "provider-telemetry", {
      attention: "failure",
      text: "APPROVED",
    }, AT, "low");
    expect(fuseAgentStatus([ignoredHint, raised], identity, new Date(AT)).attention?.value)
      .toBe("approval");
    const resolved = event(3, "status.attention-resolved", "operator", {
      causeEventId: raised.eventId,
    }, AT, "authoritative");
    expect(fuseAgentStatus([ignoredHint, raised, resolved], identity, new Date(AT)).attention)
      .toBeNull();
  });

  test("never converts an agent report into task, gate, approval, or land authority", () => {
    const status = fuseAgentStatus([event(1, "agent.status-reported", "agent-report", {
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
    }, AT, "authoritative")], identity, new Date(AT));
    expect(status.report?.phase).toBe("complete");
    expect(status.workflowState).toEqual({ kind: "reserved" });
    expect(status.attention).toBeNull();
  });
});
