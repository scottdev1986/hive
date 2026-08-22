// GET /routing/escalations: the measured wrong-model claims, read by the
// `hive routing` audit table from the daemon that owns the store. User-only
// — same audience as /routing/policy, because the escalation record is
// spend-governance evidence.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { EscalationSchema } from "../../src/schemas/escalation";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-routing-escalations-endpoint-");
process.env.HIVE_HOME = home;

function harness() {
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      spawn: async () => {
        throw new Error("no spawns in this test");
      },
    },
    repoRoot: "/tmp/hive-routing-escalations-noop",
  });
  return { daemon, db };
}

const request = (
  daemon: HiveDaemon,
  token: string | null,
): Promise<Response> => {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return daemon.fetch(
    new Request("http://hive/routing/escalations", { method: "GET", headers }),
  );
};

describe("GET /routing/escalations", () => {
  test("no credential, no answer", async () => {
    const { daemon } = harness();
    expect((await request(daemon, null)).status).toEqual(401);
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
      expect([role, (await request(daemon, token)).status]).toEqual([
        role,
        403,
      ]);
    }
    const { token } = daemon.capabilities.mint("user", "user");
    expect((await request(daemon, token)).status).toEqual(200);
    await daemon.stop();
  });

  test("the response is the stored escalation record, oldest first", async () => {
    const { daemon, db } = harness();
    for (const [agentName, model] of [
      ["maya", "gpt-5-codex"],
      ["reuben", "claude-fable-5"],
    ] as const) {
      db.insertEscalation({
        id: `esc-${agentName}`,
        agentId: `agent-${agentName}`,
        agentName,
        model,
        category: "simple_coding",
        reason: "capability wall",
        createdAt: "2026-08-09T12:00:00.000Z",
      });
    }
    const { token } = daemon.capabilities.mint("user", "user");
    const response = await request(daemon, token);
    expect(response.status).toEqual(200);
    const escalations = z.array(EscalationSchema).parse(await response.json());
    expect(escalations.map((entry) => entry.agentName)).toEqual([
      "maya",
      "reuben",
    ]);
    await daemon.stop();
  });
});
