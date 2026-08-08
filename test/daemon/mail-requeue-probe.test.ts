import { expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { hiveMailPublish } from "../../src/mail-service/service";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { MAIL_MAX_ATTEMPTS } from "../../src/schemas/mail";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-requeue-probe-");
process.env.HIVE_HOME = home;

class StubSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("this harness spawns nothing");
  }

  hierarchyRecipientBindingState(): "legacy" {
    return "legacy";
  }
}

const rig = (): HiveDaemon =>
  new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db: new HiveDatabase(":memory:"),
    spawner: new StubSpawner(),
    repoRoot: "/tmp/hive-requeue-probe-noop",
  });

const announcements = (daemon: HiveDaemon) =>
  daemon.mailWake.subscribe("maya", {
    kind: "mail-subscribe",
    schemaVersion: 1,
    recipient: "maya",
    sinceCursor: 0,
  });

// Production path: the publish itself announces through the broker, so a
// ready row keyed (recipient, brokerSeq, oldestItemId) already exists before
// the lease lapses. The requeue announce needs a later seq for the same itemId.
test("requeue announce survives the publish that already announced the same item", async () => {
  const daemon = rig();
  const deps = {
    store: daemon.mail,
    recipients: (named: string) =>
      ({ kind: "live", canonical: named }) as const,
    notifyReady: (ready: Parameters<typeof daemon.mailWake.publishReady>[0]) =>
      daemon.mailWake.publishReady(ready),
  };
  const receipt = hiveMailPublish(
    deps,
    { subject: "queen", agentGeneration: 0 },
    {
      from: "queen",
      to: "maya",
      body: "do the thing",
      lane: "control",
      topic: "control",
      idempotencyKey: "queen:1",
      ttlSeconds: null,
      addressedGeneration: null,
    },
    new Date("2026-08-02T12:00:00.000Z"),
  );
  const afterPublish = announcements(daemon);
  daemon.mail.claim({
    itemId: receipt.itemId,
    recipient: "maya",
    ownerGeneration: 0,
    handlerId: "handler-that-goes-quiet",
    leaseUntil: "2026-08-02T12:02:00.000Z",
    now: "2026-08-02T12:00:00.000Z",
    maxAttempts: MAIL_MAX_ATTEMPTS,
  });

  await daemon.mailService.sweep(new Date("2026-08-02T12:05:00.000Z"));

  const afterSweep = announcements(daemon);
  console.log(
    `probe: afterPublish=${afterPublish.length} cursors=[${afterPublish.map((e) => e.cursor)}] ` +
      `afterSweep=${afterSweep.length} cursors=[${afterSweep.map((e) => e.cursor)}]`,
  );
  expect(afterSweep.length).toBeGreaterThan(afterPublish.length);
});
