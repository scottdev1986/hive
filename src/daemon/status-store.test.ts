import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "./db";
import { verifyWorkspaceSnapshot } from "./status-events";
import {
  StatusAssignmentMismatchError,
  StatusRequestConflictError,
  StatusStore,
} from "./status-store";

const AT = "2026-07-16T12:00:00.000Z";
const REQUEST = "req_018f1e90-7b5a-7cc0-8000-000000000001";

describe("StatusStore", () => {
  test("increments flat Assignment generations and rejects closed or spoofed bindings", () => {
    const store = new StatusStore(new HiveDatabase(":memory:"), "instance-fixture");
    const first = store.openAssignment("agent-fixture", AT);
    expect(first.assignmentGeneration).toBe("1");
    store.closeAssignment("agent-fixture", "2026-07-16T12:01:00.000Z");
    expect(() => store.appendAgentReport({
      subject: "maya",
      agentId: "agent-fixture",
      role: "writer",
      capabilityEpoch: 0,
      toolSessionId: null,
    }, {
      requestId: REQUEST,
      assignmentId: first.assignmentId,
      assignmentGeneration: first.assignmentGeneration,
      phase: "testing",
      summary: "Testing",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 120,
    }, new Date(AT))).toThrow(StatusAssignmentMismatchError);

    const second = store.openAssignment("agent-fixture", "2026-07-16T12:02:00.000Z");
    expect(second.assignmentGeneration).toBe("2");
    expect(() => store.appendAgentReport({
      subject: "maya",
      agentId: "agent-fixture",
      role: "writer",
      capabilityEpoch: 0,
      toolSessionId: null,
    }, {
      requestId: REQUEST,
      assignmentId: second.assignmentId,
      assignmentGeneration: "1",
      phase: "testing",
      summary: "Spoofed generation",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 120,
    }, new Date(AT))).toThrow(StatusAssignmentMismatchError);
  });

  test("appends immutable reports and retries only identical request digests", () => {
    const store = new StatusStore(new HiveDatabase(":memory:"), "instance-fixture");
    const assignment = store.openAssignment("agent-fixture", AT);
    const actor = {
      subject: "maya",
      agentId: "agent-fixture",
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
    expect(() => store.appendAgentReport(actor, {
      ...input,
      summary: "Different retry body",
    }, new Date(AT))).toThrow(StatusRequestConflictError);

    const report = store.listEvents()[0]!;
    expect(report.data.binding).toEqual({
      agentId: "agent-fixture",
      role: "reader",
      instanceId: "instance-fixture",
      capabilityEpoch: 4,
      issuer: "hive-daemon",
      session: "tool-fixture",
    });
    expect(report.data).not.toHaveProperty("taskState");
    expect(report.data).not.toHaveProperty("approval");
    expect(report.data).not.toHaveProperty("landState");
  });

  test("builds verifiable snapshots and redacted terminal-content audit events", async () => {
    const store = new StatusStore(new HiveDatabase(":memory:"), "instance-fixture");
    store.appendObservationAudit({
      reader: "maya",
      readerRole: "writer",
      subjectAgentId: "agent-fixture",
      subjectGeneration: 1,
      rowCount: 3,
      reason: "capability:fixture",
      observedAt: AT,
    });
    const audit = store.listEvents()[0]!;
    expect(audit.data).toEqual({
      reader: "maya",
      subject: "agent-fixture",
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
});
