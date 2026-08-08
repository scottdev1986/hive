import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type {
  Spawner,
  SpawnRequest,
} from "../../src/daemon/spawn/spawn-service";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import { MAIL_CONTROL_LANE_CAPACITY } from "../../src/schemas/mail";
import {
  deriveWakeId,
  MAIL_WAKE_MAX_ATTEMPTS,
} from "../../src/schemas/mail-wake";
import { drainMailbox, mailbox } from "../mail-test-support";
import { tempRoot } from "../temp-root";

const home = tempRoot("hive-wake-escalation-");
process.env.HIVE_HOME = home;

const AT = "2026-08-02T12:00:00.000Z";

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
    repoRoot: "/tmp/hive-wake-escalation-noop",
  });

/** Publishes one control item and drives its wake to the policy ceiling. */
function exhaustWakeFor(
  daemon: HiveDaemon,
  sender: string,
  idempotencyKey: string,
  beforeAttempts?: () => void,
): void {
  const receipt = daemon.mail.publish({
    recipient: ORCHESTRATOR_NAME,
    sender,
    lane: "control",
    topic: "mail",
    recipientGeneration: null,
    body: "something to be woken for",
    idempotencyKey,
    ttlSeconds: null,
    expiresAt: null,
    now: AT,
    controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
  });
  const ready = daemon.mailWake.publishReady({
    recipient: ORCHESTRATOR_NAME,
    lane: "control",
    oldestItemId: receipt.itemId,
    backlogCount: 1,
    brokerSeq: receipt.seq,
    publishedItemId: receipt.itemId,
    at: AT,
  });
  daemon.mailWake.acknowledge(ORCHESTRATOR_NAME, {
    recipient: ORCHESTRATOR_NAME,
    cursor: ready.cursor,
    brokerSeq: receipt.seq,
    at: AT,
  });
  daemon.mailWake.acceptWakeReport(ORCHESTRATOR_NAME, {
    kind: "wake-queued",
    schemaVersion: 1,
    wakeId: deriveWakeId(ORCHESTRATOR_NAME, "control", receipt.itemId),
    recipient: ORCHESTRATOR_NAME,
    lane: "control",
    oldestItemId: receipt.itemId,
    at: AT,
  });
  beforeAttempts?.();
  for (let attempt = 1; attempt <= MAIL_WAKE_MAX_ATTEMPTS; attempt += 1) {
    daemon.mailWake.recordWakeIgnored(receipt.itemId, AT);
  }
}

/** What the mailbox now holds that the mail system sent about itself. */
const reports = (daemon: HiveDaemon): number =>
  mailbox(daemon.mail, ORCHESTRATOR_NAME).filter(
    (item) => item.sender === "hive-mail",
  ).length;

describe("an exhausted wake reports once and does not report about itself", () => {
  test("an ordinary item's exhausted wake produces one report", () => {
    const daemon = rig();
    const before = reports(daemon);

    exhaustWakeFor(daemon, "maya", "maya:1");

    expect(reports(daemon) - before).toBe(1);
  });

  /**
   * The chain this breaks: a report about an undelivered wake is itself control
   * mail, so its own wake can expire and report again, without end.
   */
  test("a report's own exhausted wake produces no further report", () => {
    const daemon = rig();
    exhaustWakeFor(daemon, "hive-mail", "hive-mail:1");

    // The item published above is the only mail-system item present; exhausting
    // its wake must not have added a second one about it.
    expect(reports(daemon)).toBe(1);
  });

  /**
   * The item was claimed and settled while its wake was still retrying, so the
   * mailbox no longer holds it and there is nothing for a notice to be about.
   */
  test("a settled item's exhausted wake produces no report", () => {
    const daemon = rig();

    exhaustWakeFor(daemon, "maya", "maya:settled", () =>
      drainMailbox(daemon.mail, ORCHESTRATOR_NAME),
    );

    expect(reports(daemon)).toBe(0);
  });

  test("revisiting an exhausted wake does not report twice", () => {
    const daemon = rig();
    exhaustWakeFor(daemon, "maya", "maya:1");
    const afterFirst = reports(daemon);

    // The sweep comes back to a wake already past its ceiling.
    daemon.mailWake.recordWakeIgnored(
      mailbox(daemon.mail, ORCHESTRATOR_NAME).filter(
        (item) => item.sender === "maya",
      )[0]?.itemId ?? "missing",
      AT,
    );

    expect(reports(daemon)).toBe(afterFirst);
  });

  test("a dead-lettered wake for a later-settled item does not replay", () => {
    const daemon = rig();
    exhaustWakeFor(daemon, "maya", "maya:dead-lettered");
    const itemId = mailbox(daemon.mail, ORCHESTRATOR_NAME).find(
      (item) => item.sender === "maya",
    )?.itemId;
    expect(itemId).toBeDefined();
    drainMailbox(daemon.mail, ORCHESTRATOR_NAME);

    expect(
      daemon.mailWake.nextWake(ORCHESTRATOR_NAME, {
        turnActive: false,
        now: AT,
      }),
    ).toEqual({ kind: "idle" });
  });
});
