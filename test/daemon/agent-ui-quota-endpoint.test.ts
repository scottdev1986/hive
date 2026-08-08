import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { actingAs } from "../support/daemon-test-support";

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<never> {
    throw new Error("not exercised by quota endpoint tests");
  }
}

describe("agent UI quota endpoint", () => {
  test("uses the pane credential without entering the root MCP succession gate", async () => {
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      db,
      daemonLog: () => {},
      repoRoot: "/tmp/hive-agent-ui-quota-endpoint-test",
      spawner: new UnusedSpawner(),
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    });
    try {
      const queen = actingAs(daemon, "queen", "orchestrator");
      const response = await queen("http://hive/agent-ui/quota");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ quotas: [] });

      const anonymous = await daemon.fetch(
        new Request("http://hive/agent-ui/quota", {
          headers: { Host: "127.0.0.1" },
        }),
      );
      expect(anonymous.status).toBe(401);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
