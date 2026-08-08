// GET /workspace-snapshot exposes the StatusStore snapshot directly so the
// Workspace reads the same schema-versioned projection as daemon consumers.

import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { StatusService } from "../../src/daemon/status-service/status-projection-service";
import { StatusStore } from "../../src/daemon/status/status-store";
import { WorkspaceSnapshotV2Schema } from "../../src/schemas/status-envelope";

function harness() {
  const db = new HiveDatabase(":memory:");
  const status = new StatusStore(db, "workspace-snapshot-fixture");
  status.appendObservationAudit({
    reader: "user",
    readerRole: "user",
    subjectAgentId: "agent-snapshot",
    subjectGeneration: 2,
    rowCount: 3,
    reason: "workspace snapshot endpoint integration",
    observedAt: "2026-08-09T12:00:00.000Z",
  });
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    statusService: StatusService.fromStore(db, status),
    spawner: {
      spawn: async () => {
        throw new Error("no spawn");
      },
    },
    repoRoot: "/tmp/hive-workspace-snapshot-endpoint",
  });
  return { daemon, db };
}

describe("GET /workspace-snapshot", () => {
  test("returns a real non-empty StatusStore snapshot in WorkspaceSnapshotV2", async () => {
    const { daemon, db } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await daemon.fetch(
      new Request("http://hive/workspace-snapshot", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const snapshot = WorkspaceSnapshotV2Schema.parse(await response.json());
    expect(snapshot.instanceId).toBe("workspace-snapshot-fixture");
    expect(snapshot.seq).toBe("1");
    expect(snapshot.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", id: "agent-snapshot" }),
      ]),
    );
    await daemon.stop();
    db.close();
  });

  test("requires authentication and preserves status-reader access", async () => {
    const { daemon, db } = harness();
    expect(
      (await daemon.fetch(new Request("http://hive/workspace-snapshot")))
        .status,
    ).toBe(401);

    const { token } = daemon.capabilities.mint("agent", "writer");
    const response = await daemon.fetch(
      new Request("http://hive/workspace-snapshot", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(
      WorkspaceSnapshotV2Schema.parse(await response.json()).entities,
    ).not.toHaveLength(0);
    await daemon.stop();
    db.close();
  });

  test("does not expose a write method", async () => {
    const { daemon, db } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await daemon.fetch(
      new Request("http://hive/workspace-snapshot", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(404);
    await daemon.stop();
    db.close();
  });
});
