import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { definedFields } from "../../src/shared/defined-fields";
import {
  QueenProviderProjectionSchema,
  SetLiveQueenProviderConflictSchema,
  SetLiveQueenProviderResponseSchema,
} from "../../src/schemas/queen-provider";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-queen-provider-");
process.env.HIVE_HOME = home;

const ALL_AVAILABLE = {
  claude: { available: true },
  codex: { available: true },
  grok: { available: true },
  kimi: { available: true },
  opencode: { available: true },
} as const;

function harness(): HiveDaemon {
  return new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db: new HiveDatabase(":memory:"),
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-queen-provider-noop",
    queenVendorAvailability: () => ALL_AVAILABLE,
  });
}

const request = (
  daemon: HiveDaemon,
  token: string | null,
  method: "GET" | "POST",
  path = "/queen-provider",
  body?: unknown,
): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return daemon.fetch(
    new Request(`http://hive${path}`, {
      method,
      headers,
      ...definedFields({
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    }),
  );
};

describe("GET /queen-provider", () => {
  test("a fresh daemon has no health because no queen provider was ever observed", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await request(daemon, token, "GET");
    expect(response.status).toEqual(200);
    const projection = QueenProviderProjectionSchema.parse(
      await response.json(),
    );
    expect(projection.liveProvider).toBeNull();
    expect(projection.health).toBeNull();
    expect(projection.change).toEqual({
      state: "idle",
      revision: "0",
      failure: null,
    });
    expect(projection.vendors).toEqual(ALL_AVAILABLE);
    await daemon.stop();
  });

  test("no credential, no answer", async () => {
    const daemon = harness();
    expect((await request(daemon, null, "GET")).status).toEqual(401);
    await daemon.stop();
  });
});

describe("POST /queen-provider (setLiveQueenProvider)", () => {
  test("the user's CAS is accepted with a receipt and pending readback", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await request(daemon, token, "POST", "/queen-provider", {
      provider: "grok",
      expectedRevision: "0",
    });
    expect(response.status).toEqual(200);
    const parsed = SetLiveQueenProviderResponseSchema.parse(
      await response.json(),
    );
    expect(parsed.receipt.revision).toEqual("1");
    // No grok has been OBSERVED running, so the readback is pending with no
    // live provider — never a pretend "grok is your queen now".
    expect(parsed.projection.change.state).toEqual("pending");
    expect(parsed.projection.liveProvider).toBeNull();
    await daemon.stop();
  });

  test("a stale revision is a clean 409 carrying the outrunning projection", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    await request(daemon, token, "POST", "/queen-provider", {
      provider: "grok",
      expectedRevision: "0",
    });
    const response = await request(daemon, token, "POST", "/queen-provider", {
      provider: "kimi",
      expectedRevision: "0",
    });
    expect(response.status).toEqual(409);
    const conflict = SetLiveQueenProviderConflictSchema.parse(
      await response.json(),
    );
    expect(conflict.currentRevision).toEqual("1");
    expect(conflict.projection.change).toMatchObject({
      state: "pending",
      revision: "1",
    });
    await daemon.stop();
  });

  test("no agent role may write: the queen cannot choose her own successor", async () => {
    const daemon = harness();
    for (const [subject, role] of [
      ["maya", "writer"],
      ["viewer", "reader"],
      ["orchestrator", "orchestrator"],
    ] as const) {
      const { token } = daemon.capabilities.mint(subject, role);
      const response = await request(daemon, token, "POST", "/queen-provider", {
        provider: "grok",
        expectedRevision: "0",
      });
      expect([role, response.status]).toEqual([role, 403]);
    }
    const { token } = daemon.capabilities.mint("user", "user");
    const projection = QueenProviderProjectionSchema.parse(
      await (await request(daemon, token, "GET")).json(),
    );
    expect(projection.change).toMatchObject({ state: "idle", revision: "0" });
    await daemon.stop();
  });

  test("an unknown provider or malformed body is refused whole", async () => {
    const daemon = harness();
    const { token } = daemon.capabilities.mint("user", "user");
    for (const body of [
      { provider: "cursor", expectedRevision: "0" },
      { provider: "grok" },
      { provider: "grok", expectedRevision: 0 },
      {},
      null,
    ]) {
      expect(
        (await request(daemon, token, "POST", "/queen-provider", body)).status,
      ).toEqual(400);
    }
    await daemon.stop();
  });
});

// The supervisor's internal surfaces moved with the succession seam: the
// steer, begin, and launch-failure behavior that used to live here is covered
// by test/daemon/succession-endpoint.test.ts against the new endpoints.
