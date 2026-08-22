// GET /routing/inspect: the Task Router screen's read-only preview. Same
// audience as /routing/policy (user-only — this previews the routing
// that governs spend), and its response freezes RouteInspectionSchema, so
// the HTTP layer gets its own proof independent of the HiveRouter unit tests.
import { describe, expect, spyOn, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { machineModelControlDatabase } from "../../src/daemon/routing-service/instance-settings";
import { RoutingPolicyStore } from "../../src/daemon/routing-policy-store";
import { HiveDaemon } from "../../src/daemon/server";
import { RouteInspectionSchema } from "../../src/schemas/routing-inspection";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-routing-inspect-endpoint-");
process.env.HIVE_HOME = home;

/**
 * The policy is machine-wide state, so each harness gets its OWN machine home:
 * without one the daemon would read the real ~/.hive, and with a shared one
 * these tests would leak routes into each other. `policyDb` is the same
 * database the daemon's inspector resolves, so seeding through it is what the
 * endpoint actually reads.
 */
function harness() {
  process.env.HIVE_DEFAULT_HOME = tempRoot("hive-routing-inspect-machine-");
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-routing-inspect-noop",
  });
  return { daemon, db, policyDb: machineModelControlDatabase(db).database };
}

const request = (
  daemon: HiveDaemon,
  token: string | null,
  category: string | null,
): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  const url =
    category === null
      ? "http://hive/routing/inspect"
      : `http://hive/routing/inspect?category=${encodeURIComponent(category)}`;
  return daemon.fetch(new Request(url, { method: "GET", headers }));
};

describe("GET /routing/inspect", () => {
  test("no credential, no answer", async () => {
    const { daemon } = harness();
    expect((await request(daemon, null, "default")).status).toEqual(401);
    await daemon.stop();
  });

  test("only the user may read — the same audience as /routing/policy", async () => {
    const { daemon } = harness();
    for (const [subject, role] of [
      ["maya", "writer"],
      ["viewer", "reader"],
      ["orchestrator", "orchestrator"],
    ] as const) {
      const { token } = daemon.capabilities.mint(subject, role);
      const response = await request(daemon, token, "default");
      expect([role, response.status]).toEqual([role, 403]);
    }
    const { token } = daemon.capabilities.mint("user", "user");
    expect((await request(daemon, token, "default")).status).toEqual(200);
    await daemon.stop();
  });

  test("an unknown category is a 400, never a guessed route", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    for (const category of ["bogus", "", null]) {
      const response = await request(daemon, token, category);
      expect(response.status).toEqual(400);
    }
    await daemon.stop();
  });

  test("the response is exactly RouteInspectionSchema — the wire contract frozen for the Task Router screen", async () => {
    const { daemon, policyDb } = harness();
    const store = new RoutingPolicyStore(policyDb);
    store.apply(
      {
        op: "set-route",
        expectedRevision: 0,
        scope: "global",
        route: {
          mode: "user-weighted",
          candidates: [
            {
              provider: "claude",
              model: "claude-fable-5",
              effort: { mode: "provider-controlled" },
              weight: 60,
            },
            {
              provider: "codex",
              model: "gpt-5.6-sol",
              effort: { mode: "provider-controlled" },
              weight: 40,
            },
          ],
        },
      },
      "user",
    );
    // set-route upserts the model rows but the provider master switch is a
    // separate consent: enable both, or the default policy gate refuses them.
    for (const [provider, revision] of [
      ["claude", 1],
      ["codex", 2],
    ] as const) {
      store.apply(
        {
          op: "set-provider",
          expectedRevision: revision,
          provider,
          state: "enabled",
        },
        "user",
      );
    }
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await request(daemon, token, "default");
    expect(response.status).toEqual(200);
    const body = await response.json();
    const parsed = RouteInspectionSchema.parse(body);
    expect(parsed.schemaVersion).toEqual(1);
    expect(parsed.category).toEqual("default");
    expect(parsed.scope).toEqual("global");
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.refusal).toBeNull();
    await daemon.stop();
  });

  test("an unconfigured category returns the never-configured refusal, not a 500", async () => {
    const { daemon } = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await request(daemon, token, "default");
    expect(response.status).toEqual(200);
    const parsed = RouteInspectionSchema.parse(await response.json());
    expect(parsed.refusal).toEqual({
      kind: "never-configured",
      detail: expect.stringContaining("category default has no route"),
    });
    await daemon.stop();
  });
});

test("stop() closes the machine policy connection this daemon opened", async () => {
  const { daemon } = harness();
  const { token } = daemon.capabilities.mint("user", "user");
  // Force the lazy resolution so the daemon owns a machine connection.
  expect((await request(daemon, token, "default")).status).toEqual(200);

  // The harness passes its own db in, so the daemon does not own that one and
  // holds no episodic store or mutation coordinator: the machine policy
  // connection is the only HiveDatabase stop() has to close.
  const closed = spyOn(HiveDatabase.prototype, "close");
  try {
    await daemon.stop();
    expect(closed).toHaveBeenCalledTimes(1);
  } finally {
    closed.mockRestore();
  }
});
