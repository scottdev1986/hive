import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import { HiveDaemon } from "../../src/daemon/server";
import type { Run } from "../../src/schemas/hierarchy-run";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-run-control-endpoint-");
process.env.HIVE_HOME = home;

const runId = "run_018f4f5e-0000-7000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const ref = { revision: "1", digest };

function harness(): HiveDaemon {
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db: new HiveDatabase(":memory:"),
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-run-control-noop",
  });
  const store = new HierarchyStore(daemon.db);
  const run: Run = {
    runId,
    revision: "1",
    repo: "hive",
    instanceId: "instance-fixture",
    spec: ref,
    currentPlan: ref,
    topology: ref,
    phase: "P1",
    baseSha: "f".repeat(40),
    budget: ref,
    runEpoch: 0,
    lifecycle: "active",
  };
  store.putRun(run, null);
  return daemon;
}

const post = <T>(daemon: HiveDaemon, token: string, body: T) =>
  daemon.fetch(
    new Request("http://hive/run-control", {
      method: "POST",
      headers: new Headers({
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify(body),
    }),
  );

const pause = {
  schemaVersion: 1,
  intentId: "intent-pause",
  expected: { kind: "revision-and-epoch", revision: "1", epoch: "0" },
  idempotencyKey: "key-pause",
  body: { operation: "run-pause", runId },
};

describe("POST /run-control", () => {
  test("the user pauses a run and gets the post-state back", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");

    const response = await post(daemon, token, pause);

    expect(response.status).toEqual(200);
    expect(await response.json()).toMatchObject({
      intentId: "intent-pause",
      outcome: { status: "accepted" },
      postStateToken: { kind: "revision-and-epoch", revision: "2", epoch: "1" },
      observedPostState: { lifecycle: "paused" },
    });
    await daemon.stop();
  });

  test("no agent role may move the run", async () => {
    const daemon = harness();
    for (const [subject, role] of [
      ["maya", "writer"],
      ["viewer", "reader"],
      ["orchestrator", "orchestrator"],
    ] as const) {
      const { token } = daemon.capabilities.mint(subject, role);
      const response = await post(daemon, token, pause);
      expect([role, response.status]).toEqual([role, 403]);
    }
    expect(new HierarchyStore(daemon.db).getRun(runId)?.lifecycle).toEqual(
      "active",
    );
    await daemon.stop();
  });

  test("an intent that is not a typed operation never reaches the store", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");

    for (const body of [
      { ...pause, body: { operation: "run-yolo", runId } },
      { ...pause, expected: { kind: "revision", revision: "1", epoch: "0" } },
      // Half a fence is no fence: run control takes only the two-token form.
      { ...pause, expected: { kind: "revision", revision: "1" } },
      { ...pause, expected: { kind: "epoch", epoch: "0" } },
      { ...pause, body: { operation: "run-pause" } },
      {},
    ]) {
      expect((await post(daemon, token, body)).status).toEqual(400);
    }
    expect(new HierarchyStore(daemon.db).getRun(runId)?.revision).toEqual("1");
    await daemon.stop();
  });

  test("a retried request gets the first decision, not a second pause", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");

    const first = await (await post(daemon, token, pause)).json();
    const retry = await (await post(daemon, token, pause)).json();

    expect(retry).toEqual(first);
    expect(new HierarchyStore(daemon.db).getFences(runId)?.runEpoch).toEqual(1);
    await daemon.stop();
  });

  test("an intent naming an unknown run is a 404, not an invented run", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");

    const response = await post(daemon, token, {
      ...pause,
      body: {
        operation: "run-pause",
        runId: "run_018f4f5e-0000-7000-8000-0000000000ff",
      },
    });

    expect(response.status).toEqual(404);
    await daemon.stop();
  });
});
