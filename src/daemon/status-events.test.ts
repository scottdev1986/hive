import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { WorkspaceEventV2Schema, type WorkspaceEventV2 } from "../schemas/status-envelope";
import type { SessionEvent } from "./session-host/contract";
import {
  FakeSessionStatusSourceAdapter,
  InvalidWorkspaceSnapshotError,
  ResumableStatusSubscription,
  canonicalJson,
  emptyStatusProjection,
  reconcileStatusSnapshot,
  reduceStatusEvent,
  verifyWorkspaceSnapshot,
  type WorkspaceStatusEventSource,
  type WorkspaceStatusSourceEvent,
} from "./status-events";

const corpus = JSON.parse(readFileSync(resolve(
  import.meta.dir,
  "../../workspace/Tests/WorkspaceCoreTests/Fixtures/reducer-parity-corpus.json",
), "utf8")) as {
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
  const entities = [{
    kind: "agent",
    id: "agent-fixture",
    entityRevision: seq,
    projection: { kind: "status.turn", data: { value: "working" } },
  }];
  return {
    schemaVersion: 2 as const,
    instanceId: "instance-fixture",
    seq,
    entities,
    createdAt: "2026-07-16T12:00:00.000Z",
    contentSha256: createHash("sha256").update(canonicalJson(entities)).digest("hex"),
  };
};

describe("status event reduction", () => {
  test("matches every prefix in the shared Bun/Swift corpus", () => {
    for (const scenario of corpus.scenarios) {
      let state = emptyStatusProjection();
      scenario.events.forEach((value, index) => {
        state = reduceStatusEvent(state, WorkspaceEventV2Schema.parse(value));
        expect(canonicalJson(state), `${scenario.name} prefix ${index + 1}`)
          .toBe(canonicalJson(scenario.prefixes[index]));
      });
    }
  });

  test("rejects digest mismatch and regressed snapshot high-water", () => {
    expect(() => verifyWorkspaceSnapshot({ ...snapshot("2"), contentSha256: "0".repeat(64) }, "1"))
      .toThrow(InvalidWorkspaceSnapshotError);
    expect(() => verifyWorkspaceSnapshot(snapshot("1"), "2"))
      .toThrow("high-water regressed");
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

  test("pauses on a gap, snapshots, then resumes at snapshot seq + 1", async () => {
    const calls: string[] = [];
    const source: WorkspaceStatusEventSource = {
      async *subscribe(afterSeq) {
        calls.push(afterSeq);
        if (afterSeq === "0") yield event("2");
        if (afterSeq === "2") yield event("3");
      },
      async fetchSnapshot() {
        return snapshot("2");
      },
    };
    const subscription = new ResumableStatusSubscription(source);
    await subscription.run(() => {});
    expect(calls).toEqual(["0", "2"]);
    expect(subscription.current).toMatchObject({ highWaterSeq: "3", paused: false });
  });

  test("keeps the unlanded sessiond broker behind the typed adapter seam", () => {
    const { schemaVersion: _, eventId: __, seq: ___, entityRevision: ____, ...adapted } = event("1");
    const adapter = new FakeSessionStatusSourceAdapter(() => adapted);
    const sessionEvent: SessionEvent = {
      schemaVersion: 1,
      eventId: "evt_018f1e90-7b5a-7cc0-8000-000000000099",
      eventSeq: "1",
      locator: {
        schemaVersion: 1,
        instanceId: "instance-fixture",
        subject: { kind: "agent", agentId: "agent-fixture" },
        generation: 1,
        sessionId: "ses_018f1e90-7b5a-7cc0-8000-000000000098",
        hostKind: "sessiond",
        engineBuildId: "engine-fixture",
      },
      kind: "session.heartbeat",
      revision: "1",
      occurredAt: "2026-07-16T12:00:00.000Z",
      data: {},
    };
    expect(adapter.adapt(sessionEvent)).toBe(adapted as WorkspaceStatusSourceEvent);
  });
});
