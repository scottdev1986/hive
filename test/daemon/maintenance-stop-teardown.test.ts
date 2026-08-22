import { afterEach, describe, expect, test } from "bun:test";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { tempRoot } from "../temp-root";

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by maintenance-stop teardown tests");
  }
}

describe("HiveDaemon.stop with a wedged maintenance drain", () => {
  const previousHome = process.env.HIVE_HOME;
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = previousHome;
  });

  test("teardown still completes and the named refusal still reaches the caller", async () => {
    const home = tempRoot("hive-maint-stop-home-");
    process.env.HIVE_HOME = home;
    const repoRoot = tempRoot("hive-maint-stop-repo-");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: new UnusedSpawner(),
      repoRoot,
      port: 0,
      daemonLog: () => undefined,
      maintenanceDrainTimeoutMs: 40,
      refreshModelControl: async () => {
        markStarted();
        await gate;
      },
    });
    daemon.start();
    try {
      expect(daemon.listeningPort).not.toBeNull();
      await started;
      await expect(daemon.stop()).rejects.toThrow(
        'Hive refused shutdown because maintenance drain "model-control refresh" did not finish',
      );
      expect(daemon.listeningPort).toBeNull();
      expect(daemon.server).toBeNull();
      expect(() => daemon.db.listAgents()).toThrow(/closed database/i);
    } finally {
      release();
    }
  });
});
