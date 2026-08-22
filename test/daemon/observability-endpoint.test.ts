import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { ObservabilityEventSchema } from "../../src/schemas/observability";
import { actingAs } from "../support/daemon-test-support";

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by observability endpoint tests");
  }
}

function report(subject: string) {
  return {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    occurredAt: "2026-08-11T12:00:00.000Z",
    severity: "error" as const,
    source: "background" as const,
    operation: "mail-ready-poll",
    reason: "daemon returned 503",
    subject,
    agentId: null,
    provider: "codex" as const,
    providerRunId: "018f1e90-7b5a-7cc0-8000-000000000901",
    vendorSessionId: "codex-session-1",
    toolName: null,
    callId: "poll-9",
  };
}

describe("observability endpoints", () => {
  test("agents report only themselves and user audit reads durable events", async () => {
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      db,
      daemonLog: () => {},
      repoRoot: "/tmp/hive-observability-endpoint-test",
      spawner: new UnusedSpawner(),
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    });
    try {
      const clay = actingAs(daemon, "clay", "writer");
      const event = report("clay");
      const first = await clay("http://hive/observability/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      expect(first.status).toBe(200);
      expect(
        ObservabilityEventSchema.parse((await first.json()).event).eventId,
      ).toBe(event.eventId);

      const retry = await clay("http://hive/observability/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      expect(retry.status).toBe(200);

      const foreign = await clay("http://hive/observability/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report("maya")),
      });
      expect(foreign.status).toBe(403);

      const user = actingAs(daemon, "local-user", "user");
      const response = await user(
        "http://hive/observability/errors?session=codex-session-1&limit=10",
      );
      expect(response.status).toBe(200);
      // SAFETY: The test owns this value and its fields.
      const body = (await response.json()) as { events: unknown[] };
      expect(body.events).toHaveLength(1);
      expect(ObservabilityEventSchema.parse(body.events[0])).toMatchObject({
        eventId: event.eventId,
        subject: "clay",
        operation: "mail-ready-poll",
        reason: "daemon returned 503",
      });
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
