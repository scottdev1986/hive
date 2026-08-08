import { describe, expect, test } from "bun:test";
import type { WorkspaceEventV2 } from "../../src/schemas/status-envelope";
import { StatusDerivedProjectionService } from "../../src/daemon/status-service/status-derived-projection-service";

function event(sequence: number): WorkspaceEventV2 {
  const value = String(sequence);
  return {
    schemaVersion: 2,
    eventId: `evt_018f1e90-7b5a-7cc0-8000-${value.padStart(12, "0")}`,
    seq: value,
    entity: { kind: "agent", id: "agent-maya" },
    entityRevision: value,
    occurredAt: "2026-08-11T12:00:00.000Z",
    kind: "status.turn",
    source: {
      kind: "provider-protocol",
      id: "codex:run:session",
      observedAt: "2026-08-11T12:00:00.000Z",
      confidence: "authoritative",
    },
    data: { value: "working" },
  };
}

describe("StatusDerivedProjectionService", () => {
  test("moves derived writes off the caller stack and drains them in order", async () => {
    const projected: string[] = [];
    const service = new StatusDerivedProjectionService({
      project: (value) => projected.push(value.seq),
    });

    service.enqueue(event(1));
    service.enqueue(event(2));
    expect(projected).toEqual([]);
    await service.flush();
    expect(projected).toEqual(["1", "2"]);
    await service.stop();
  });

  test("bounds overload and reports discarded derived events", async () => {
    const projected: string[] = [];
    const drops: number[] = [];
    const service = new StatusDerivedProjectionService({
      capacity: 2,
      project: (value) => projected.push(value.seq),
      onDrop: (count) => drops.push(count),
    });

    service.enqueue(event(1));
    service.enqueue(event(2));
    service.enqueue(event(3));
    await service.stop();

    expect(projected).toEqual(["2", "3"]);
    expect(drops).toEqual([1]);
  });
});
