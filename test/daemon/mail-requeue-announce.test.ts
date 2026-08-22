import { describe, expect, test } from "bun:test";
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

const home = tempRoot("hive-requeue-announce-");
process.env.HIVE_HOME = home;

const CLAIMED_AT = "2026-08-02T12:00:00.000Z";
const LEASE_UNTIL = "2026-08-02T12:02:00.000Z";
/** After the lease has lapsed, which is when the sweep finds it. */
const SWEPT_AT = new Date("2026-08-02T12:05:00.000Z");

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
    repoRoot: "/tmp/hive-requeue-announce-noop",
  });

/** One control item, claimed by a handler whose lease then lapses. */
function abandonedClaim(daemon: HiveDaemon) {
  const receipt = hiveMailPublish(
    {
      store: daemon.mail,
      recipients: (named) => ({ kind: "live", canonical: named }),
      notifyReady: (ready) => daemon.mailWake.publishReady(ready),
    },
    { subject: "queen", agentGeneration: 0 },
    {
      from: "queen",
      to: "maya",
      lane: "control",
      topic: "control",
      body: "do the thing",
      idempotencyKey: "queen:1",
      ttlSeconds: null,
      addressedGeneration: null,
    },
    new Date(CLAIMED_AT),
  );
  daemon.mail.claim({
    itemId: receipt.itemId,
    recipient: "maya",
    ownerGeneration: 0,
    handlerId: "handler-that-goes-quiet",
    leaseUntil: LEASE_UNTIL,
    now: CLAIMED_AT,
    maxAttempts: MAIL_MAX_ATTEMPTS,
  });
  return { itemId: receipt.itemId, seq: receipt.seq };
}

const announcements = (daemon: HiveDaemon): number =>
  daemon.mailWake.subscribe("maya", {
    kind: "mail-subscribe",
    schemaVersion: 1,
    recipient: "maya",
    sinceCursor: 0,
  }).length;

/**
 * A lapsed lease is the one way an item becomes offerable with nobody sending
 * anything. Nothing else on that path speaks: the handler is not told it lost
 * the lease, and no publish follows to announce what is waiting again.
 */
describe("an item returned by a lapsed lease is announced", () => {
  test("the sweep announces the lane it just made offerable", async () => {
    const daemon = rig();
    abandonedClaim(daemon);
    const before = announcements(daemon);

    await daemon.mailService.sweep(SWEPT_AT);

    expect(announcements(daemon)).toBeGreaterThan(before);
  });

  test("the announcement names the item that came back", async () => {
    const daemon = rig();
    const original = abandonedClaim(daemon);

    await daemon.mailService.sweep(SWEPT_AT);

    const latest = daemon.mailWake
      .subscribe("maya", {
        kind: "mail-subscribe",
        schemaVersion: 1,
        recipient: "maya",
        sinceCursor: 0,
      })
      .at(-1);
    expect(latest?.oldestItemId).toBe(original.itemId);
    expect(latest?.lane).toBe("control");
    expect(latest?.brokerSeq).toBeGreaterThan(original.seq);
  });

  test("a lease still running is left alone", async () => {
    const daemon = rig();
    abandonedClaim(daemon);
    const before = announcements(daemon);

    // Before the lease lapses, so the sweep has nothing to return.
    await daemon.mailService.sweep(new Date("2026-08-02T12:01:00.000Z"));

    expect(announcements(daemon)).toBe(before);
  });
});
