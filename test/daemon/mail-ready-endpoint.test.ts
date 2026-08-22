import { describe, expect, test } from "bun:test";
import { MailReadyClient } from "../../src/cli/agent-ui/mail-ready-client";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import {
  fuseAgentStatus,
  steadyStateUnknowns,
} from "../../src/daemon/status-service/fusion";
import {
  hiveMailClaim,
  hiveMailComplete,
  hiveMailPublish,
  type MailBrokerDeps,
} from "../../src/mail-service/service";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import { MAIL_MAX_ATTEMPTS } from "../../src/schemas/mail";
import {
  deriveWakeId,
  MailReadyResponseSchema,
} from "../../src/schemas/mail-wake";

/**
 * The transport half of the mail-ready contract.
 *
 * The interesting property is not that a frontend can read its own
 * notifications — it is that it cannot read anyone else's, and that asking is
 * refused rather than answered with something plausible.
 */

const AT = "2026-08-02T12:00:00.000Z";

const agent = (name: string): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "P6",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  contextPct: null,
  createdAt: AT,
  lastEventAt: AT,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

const harness = () => {
  const db = new HiveDatabase(":memory:");
  db.insertAgent(agent("ada"));
  db.insertAgent(agent("bo"));
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      async spawn() {
        return agent("spawned");
      },
    },
    repoRoot: "/tmp/hive-mail-ready-test",
  });
  return { daemon, db };
};

const call = (
  daemon: HiveDaemon,
  token: string,
  path: string,
  init: RequestInit = {},
) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return daemon.fetch(new Request(`http://hive${path}`, { ...init, headers }));
};

const tokenFor = (daemon: HiveDaemon, name: string) =>
  daemon.capabilities.mint(name, "reader", { epoch: 0 }).token;

/**
 * Publishes one control item and announces it, returning the item's id.
 *
 * It goes through the mailbox rather than announcing an invented id, because
 * the endpoint answers from the item table: an announcement whose item was
 * never published is one the mailbox cannot offer, and replaying it would wake
 * an agent for a message that does not exist.
 */
const announce = (
  daemon: HiveDaemon,
  recipient: string,
  seq: number,
): string => {
  const receipt = daemon.mail.publish({
    recipient,
    sender: "queen",
    lane: "control",
    topic: `handoff-${seq}`,
    recipientGeneration: null,
    body: "take ownership",
    idempotencyKey: `queen-${recipient}-${seq}`,
    ttlSeconds: null,
    expiresAt: null,
    now: AT,
    controlLaneCapacity: 64,
  });
  daemon.mailWake.publishReady({
    recipient,
    lane: "control",
    oldestItemId: receipt.itemId,
    backlogCount: 1,
    brokerSeq: receipt.seq,
    publishedItemId: receipt.itemId,
    at: AT,
  });
  return receipt.itemId;
};

describe("the mail-ready endpoint", () => {
  test("a frontend resumes its own mailbox from a broker sequence", async () => {
    const { daemon } = harness();
    announce(daemon, "ada", 1);
    announce(daemon, "ada", 2);
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready?sinceCursor=1",
    );
    expect(response.status).toBe(200);
    const body = MailReadyResponseSchema.parse(await response.json());
    expect(body.recipient).toBe("ada");
    expect(body.events.map((each) => each.brokerSeq)).toEqual([2]);
  });

  test("the real client accepts the real endpoint response", async () => {
    const { daemon } = harness();
    const itemId = announce(daemon, "ada", 1);
    const token = tokenFor(daemon, "ada");
    const client = new MailReadyClient({
      port: 4242,
      recipient: "ada",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return daemon.fetch(new Request(input, { ...init, headers }));
      },
    });

    const notices = await client.poll();

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      recipient: "ada",
      oldestItemId: itemId,
    });
  });

  test("the reply carries no message body", async () => {
    const { daemon } = harness();
    announce(daemon, "ada", 1);
    const body = await (
      await call(daemon, tokenFor(daemon, "ada"), "/mail-ready?sinceCursor=0")
    ).text();
    expect(body).not.toContain("body");
    expect(body).toContain("oldestItemId");
  });

  test("asking for another subject's mailbox is refused, not answered", async () => {
    const { daemon } = harness();
    announce(daemon, "ada", 1);
    const foreignItem = announce(daemon, "bo", 1);
    const ada = tokenFor(daemon, "ada");
    // Positive control: the reader works, so the refusal below is the ACL and
    // not an endpoint that returns nothing to everyone.
    const own = await call(daemon, ada, "/mail-ready?sinceCursor=0");
    // SAFETY: The test owns this value and its fields.
    expect(((await own.json()) as { events: unknown[] }).events).toHaveLength(
      1,
    );
    const foreign = await call(
      daemon,
      ada,
      "/mail-ready?recipient=bo&sinceCursor=0",
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).not.toContain(foreignItem);
  });

  test("an unauthenticated caller learns nothing", async () => {
    const { daemon } = harness();
    const itemId = announce(daemon, "ada", 1);
    const response = await daemon.fetch(
      new Request("http://hive/mail-ready?sinceCursor=0"),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(itemId);
  });

  test("an acknowledgement is what writes frontend_notified", async () => {
    const { daemon } = harness();
    const itemId = announce(daemon, "ada", 1);
    expect(daemon.mailWake.deliveryState(itemId)).toBe("published");
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready/ack",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "mail-ready-ack",
          schemaVersion: 1,
          recipient: "ada",
          cursor: 1,
          brokerSeq: 1,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: [itemId] });
    expect(daemon.mailWake.deliveryState(itemId)).toBe("frontend_notified");
  });

  test("acknowledging for someone else is refused and changes nothing", async () => {
    const { daemon } = harness();
    const itemId = announce(daemon, "bo", 1);
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready/ack",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "mail-ready-ack",
          schemaVersion: 1,
          recipient: "bo",
          cursor: 1,
          brokerSeq: 1,
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(daemon.mailWake.deliveryState(itemId)).toBe("published");
  });

  test("a frontend wake report writes only the transition it proves", async () => {
    const { daemon } = harness();
    const itemId = announce(daemon, "ada", 1);
    const token = tokenFor(daemon, "ada");
    await call(daemon, token, "/mail-ready/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "mail-ready-ack",
        schemaVersion: 1,
        recipient: "ada",
        cursor: 1,
        brokerSeq: 1,
      }),
    });
    const wakeId = deriveWakeId("ada", "control", itemId);
    const queued = await call(daemon, token, "/mail-wake/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "wake-queued",
        schemaVersion: 1,
        wakeId,
        recipient: "ada",
        lane: "control",
        oldestItemId: itemId,
        at: "2026-08-02T12:00:02.000Z",
      }),
    });
    expect(queued.status).toBe(200);
    expect(
      daemon.mailWake.deliveryChain(itemId).map((row) => row.state),
    ).toEqual(["published", "frontend_notified", "wake_queued"]);

    const accepted = await call(daemon, token, "/mail-wake/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "wake-request-accepted",
        schemaVersion: 1,
        wakeId,
        clientInputId: "input-ada-1",
        at: "2026-08-02T12:00:03.000Z",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(daemon.mailWake.deliveryState(itemId)).toBe(
      "vendor_request_accepted",
    );
  });

  test("a frontend cannot report another recipient's wake", async () => {
    const { daemon } = harness();
    const itemId = announce(daemon, "bo", 1);
    const wakeId = deriveWakeId("bo", "control", itemId);
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-wake/report",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "wake-queued",
          schemaVersion: 1,
          wakeId,
          recipient: "bo",
          lane: "control",
          oldestItemId: itemId,
          at: "2026-08-02T12:00:02.000Z",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(daemon.mailWake.deliveryState(itemId)).toBe("published");
  });

  test("a malformed cursor is refused rather than treated as zero", async () => {
    const { daemon } = harness();
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready?sinceCursor=-4",
    );
    expect(response.status).toBe(400);
  });

  test("the root's two names resolve to one mailbox", async () => {
    const { daemon } = harness();
    announce(daemon, ORCHESTRATOR_NAME, 1);
    const response = await call(
      daemon,
      tokenFor(daemon, ORCHESTRATOR_NAME),
      "/mail-ready?sinceCursor=0",
    );
    expect(response.status).toBe(200);
    expect(
      // SAFETY: The test owns this value and its fields.
      ((await response.json()) as { events: unknown[] }).events,
    ).toHaveLength(1);
  });
});

describe("the mail dimension is measured, not guessed", () => {
  const mailStatusOf = (daemon: HiveDaemon, agentId: string) =>
    fuseAgentStatus(
      daemon.status.listEventsForAgent(agentId),
      { agentId, incarnationGeneration: null },
      new Date(),
    );

  test("a publish puts the recipient's mail state into the status stream", () => {
    const { daemon } = harness();
    announce(daemon, "ada", 1);
    const status = mailStatusOf(daemon, "agent-ada");
    expect(status.mailState?.value).toBe("waiting");
    // Measured, so it is not one of the blanks a release has to close.
    expect(status.absences.mail).toBeUndefined();
    expect(steadyStateUnknowns(status)).not.toContain("mail");
  });

  test("the state follows the item through to settlement", () => {
    const { daemon } = harness();
    // Distinct timestamps: two readings of the same clock tie in fusion, and a
    // real transition never happens at the same instant as the one before it.
    const later = (seconds: number) =>
      new Date(Date.parse(AT) + seconds * 1_000).toISOString();
    const itemId = announce(daemon, "ada", 1);
    daemon.mailWake.acknowledge("ada", {
      recipient: "ada",
      cursor: 1,
      brokerSeq: 1,
      at: later(1),
    });
    daemon.mailWake.queueWake({
      recipient: "ada",
      lane: "control",
      oldestItemId: itemId,
      at: later(2),
    });
    expect(mailStatusOf(daemon, "agent-ada").mailState?.value).toBe("waking");
    daemon.mailWake.recordPresented({
      itemId,
      recipient: "ada",
      pollResponseRef: "poll-1",
      at: later(3),
    });
    daemon.mailWake.recordClaimed({
      itemId,
      recipient: "ada",
      handlerId: "ada-1",
      at: later(4),
    });
    expect(mailStatusOf(daemon, "agent-ada").mailState?.value).toBe("claimed");
    daemon.mailWake.recordSettled({
      itemId,
      recipient: "ada",
      disposition: "completed",
      at: later(5),
    });
    expect(mailStatusOf(daemon, "agent-ada").mailState?.value).toBe("none");
  });

  test("a recipient nobody is bound to reports nothing rather than inventing", () => {
    const { daemon } = harness();
    announce(daemon, "nobody", 1);
    expect(daemon.status.listEventsForAgent("agent-nobody")).toEqual([]);
  });
});

/**
 * A mail-ready row records what a lane could offer when it was written, and the
 * frontend wakes the agent from whatever the endpoint replays. `hive_mail_claim`
 * answers from the item table instead, so an announcement that outlives its item
 * is a wake for something the agent can no longer lease.
 */
describe("an announcement the mailbox has outlived", () => {
  const publish = (daemon: HiveDaemon, recipient: string, topic: string) => {
    const receipt = daemon.mail.publish({
      recipient,
      sender: "queen",
      lane: "control",
      topic,
      recipientGeneration: null,
      body: "take ownership",
      idempotencyKey: `queen-${recipient}-${topic}`,
      ttlSeconds: null,
      expiresAt: null,
      now: AT,
      controlLaneCapacity: 64,
    });
    daemon.mailWake.publishReady({
      recipient,
      lane: "control",
      oldestItemId: receipt.itemId,
      backlogCount: 1,
      brokerSeq: receipt.seq,
      publishedItemId: receipt.itemId,
      at: AT,
    });
    return receipt.itemId;
  };

  const settle = (daemon: HiveDaemon, recipient: string, itemId: string) => {
    daemon.mail.claim({
      itemId,
      recipient,
      ownerGeneration: 0,
      handlerId: "h1",
      leaseUntil: "2026-08-02T12:02:00.000Z",
      now: AT,
      maxAttempts: MAIL_MAX_ATTEMPTS,
    });
    daemon.mail.settle({
      itemId,
      recipient,
      ownerGeneration: 0,
      handlerId: "h1",
      disposition: "completed",
      reason: null,
      retryAt: AT,
      now: AT,
      maxAttempts: 5,
    });
  };

  const replayed = async (daemon: HiveDaemon): Promise<string[]> => {
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready?sinceCursor=0",
    );
    // SAFETY: The test owns this value and its fields.
    const body = (await response.json()) as {
      events: { oldestItemId: string }[];
    };
    return body.events.map((event) => event.oldestItemId);
  };

  test("a waiting item is still announced", async () => {
    const { daemon } = harness();
    const itemId = publish(daemon, "ada", "waiting");
    expect(await replayed(daemon)).toEqual([itemId]);
  });

  test("a settled item is not announced again", async () => {
    const { daemon } = harness();
    const itemId = publish(daemon, "ada", "settled");
    settle(daemon, "ada", itemId);
    expect(await replayed(daemon)).toEqual([]);
  });

  test("settling one item leaves the next one announced", async () => {
    const { daemon } = harness();
    const first = publish(daemon, "ada", "first");
    settle(daemon, "ada", first);
    const second = publish(daemon, "ada", "second");
    expect(await replayed(daemon)).toEqual([second]);
  });
});

/**
 * The live shape of the stale announcement, driven through the broker rather
 * than imitated: a publish announces the OLDEST item its lane can offer, not
 * the one just published. So a second message arriving while the first still
 * waits files an announcement naming the FIRST. Settle that first item and the
 * announcement outlives it, one item behind the mailbox.
 */
describe("an announcement one item behind the mailbox", () => {
  const brokerFor = (daemon: HiveDaemon): MailBrokerDeps => ({
    store: daemon.mail,
    recipients: (named) => ({ kind: "live", canonical: named }),
    notifyReady: (ready) => {
      daemon.mailWake.publishReady(ready);
    },
  });

  const send = (daemon: HiveDaemon, topic: string): string =>
    hiveMailPublish(
      brokerFor(daemon),
      { subject: "queen", agentGeneration: 0 },
      {
        from: "queen",
        to: "ada",
        lane: "control",
        topic,
        body: "take ownership",
        idempotencyKey: `queen-${topic}`,
      },
      new Date(AT),
    ).itemId;

  test("the settled item is not replayed and the waiting one is", async () => {
    const { daemon } = harness();
    const broker = brokerFor(daemon);
    const ada = { subject: "ada", agentGeneration: 0 };
    const first = send(daemon, "first");
    // Published while `first` still waits, so its announcement names `first`.
    const second = send(daemon, "second");

    hiveMailClaim(
      broker,
      ada,
      { recipient: "ada", itemId: first, handlerId: "h1" },
      new Date(AT),
    );
    hiveMailComplete(
      broker,
      ada,
      {
        recipient: "ada",
        itemId: first,
        handlerId: "h1",
        disposition: "completed",
      },
      new Date(AT),
    );

    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready?sinceCursor=0",
    );
    const named = // SAFETY: The test owns this value and its fields.
      (
        (await response.json()) as { events: { oldestItemId: string }[] }
      ).events.map((event) => event.oldestItemId);
    expect(named).not.toContain(first);
    expect(named).toContain(second);
  });
});

describe("the retired resume point", () => {
  test("a caller still naming the mailbox sequence is refused, not ignored", async () => {
    const { daemon } = harness();
    announce(daemon, "ada", 1);
    const response = await call(
      daemon,
      tokenFor(daemon, "ada"),
      "/mail-ready?sinceBrokerSeq=0",
    );
    // Silently ignoring it would look like the old resume still works while
    // quietly replaying nothing, which is the failure mode this whole cursor
    // exists to remove.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("cursor");
  });
});
