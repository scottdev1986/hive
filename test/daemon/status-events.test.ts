import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  emptyStatusProjection,
  InvalidWorkspaceSnapshotError,
  reconcileStatusSnapshot,
  reduceStatusEvent,
  verifyWorkspaceSnapshot,
} from "../../src/daemon/status-service/events";
import {
  type WorkspaceEventV2,
  WorkspaceEventV2Schema,
} from "../../src/schemas/status-envelope";

// SAFETY: The test owns this value and its fields.
const corpus = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "../../workspace/Tests/WorkspaceCoreTests/Fixtures/reducer-parity-corpus.json",
    ),
    "utf8",
  ),
) as {
  scenarios: Array<{ name: string; events: unknown[]; prefixes: unknown[] }>;
};

const event = (seq: string, revision = seq): WorkspaceEventV2 => ({
  schemaVersion: 2,
  eventId: `evt_018f1e90-7b5a-7cc0-8000-${seq.padStart(12, "0")}`,
  seq,
  entity: { kind: "agent", id: "agent-fixture" },
  entityRevision: revision,
  occurredAt: "2026-07-16T12:00:00.000Z",
  kind: "status.turn",
  source: {
    kind: "provider-hook",
    id: "hook-fixture",
    observedAt: "2026-07-16T12:00:00.000Z",
    confidence: "high",
  },
  data: { value: "working" },
});

const snapshot = (seq: string) => {
  const entities = [
    {
      kind: "agent",
      id: "agent-fixture",
      entityRevision: seq,
      projection: { kind: "status.turn", data: { value: "working" } },
    },
  ];
  return {
    schemaVersion: 2 as const,
    instanceId: "instance-fixture",
    seq,
    entities,
    createdAt: "2026-07-16T12:00:00.000Z",
    contentSha256: createHash("sha256")
      .update(canonicalJson(entities))
      .digest("hex"),
  };
};

describe("status event reduction", () => {
  test("matches every prefix in the shared Bun/Swift corpus", () => {
    for (const scenario of corpus.scenarios) {
      let state = emptyStatusProjection();
      scenario.events.forEach((value, index) => {
        state = reduceStatusEvent(state, WorkspaceEventV2Schema.parse(value));
        expect(
          canonicalJson(state),
          `${scenario.name} prefix ${index + 1}`,
        ).toBe(canonicalJson(scenario.prefixes[index]));
      });
    }
  });

  test("rejects digest mismatch and regressed snapshot high-water", () => {
    expect(() =>
      verifyWorkspaceSnapshot(
        { ...snapshot("2"), contentSha256: "0".repeat(64) },
        "1",
      ),
    ).toThrow(InvalidWorkspaceSnapshotError);
    expect(() => verifyWorkspaceSnapshot(snapshot("1"), "2")).toThrow(
      "high-water regressed",
    );
  });

  test("replaces a paused projection with a verified snapshot", () => {
    const paused = reduceStatusEvent(emptyStatusProjection(), event("2"));
    expect(paused.recovery).toBe("SNAPSHOT_REQUIRED");
    expect(reconcileStatusSnapshot(paused, snapshot("2"))).toMatchObject({
      highWaterSeq: "2",
      paused: false,
      recovery: null,
      corruption: null,
    });
  });
});
