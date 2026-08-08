import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  QUEEN_PIN,
  QueenCompactReloadSchema,
} from "../../src/daemon/queen-provider-service/queen-pin";
import { HiveDaemon } from "../../src/daemon/server";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-queen-compact-reload-");
process.env.HIVE_HOME = home;

function harness(): HiveDaemon {
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db: new HiveDatabase(":memory:"),
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-queen-compact-reload",
  });
}

const get = (daemon: HiveDaemon, token: string | null): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return daemon.fetch(
    new Request("http://hive/queen/compact-reload", { headers }),
  );
};

describe("GET /queen/compact-reload", () => {
  test("the queen receives the pin and a board projection", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("queen", "orchestrator");
    const response = await get(daemon, token);
    expect(response.status).toBe(200);
    const body = QueenCompactReloadSchema.parse(await response.json());
    expect(body.pin).toBe(QUEEN_PIN);
    expect(body.text).toContain(QUEEN_PIN);
    expect(body.text).toContain("Hive compact:");
    expect(body.text).toContain("## Live board");
    await daemon.stop();
  });

  test("a worker is refused", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("maya", "writer");
    expect((await get(daemon, token)).status).toBe(403);
    await daemon.stop();
  });

  test("no credential, no answer", async () => {
    const daemon = harness();
    expect((await get(daemon, null)).status).toBe(401);
    await daemon.stop();
  });
});
