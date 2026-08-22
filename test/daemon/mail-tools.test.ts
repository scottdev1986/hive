import { describe, expect, test } from "bun:test";
import type {
  Action,
  Capability,
} from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  MailRulingRequiredError,
  MailSubjectUnboundError,
  type MailToolDeps,
  MailTools,
} from "../../src/mail-service/mail-tools";
import {
  MailGenerationMismatchError,
  type MailRecipientState,
  MailService,
} from "../../src/mail-service/service";
import {
  MailControlBusyError,
  MailItemNotClaimableError,
  MailStore,
} from "../../src/mail-service/store";
import {
  MailEvidenceError,
  MailWakeLedger,
} from "../../src/mail-service/wake-ledger";
import { MailWakeStore } from "../../src/mail-service/wake-store";
import { required } from "../required";
import type { JsonObject } from "../../src/shared/json";

const T0 = new Date("2026-08-01T12:00:00.000Z");

const capability = (subject: string): Capability => ({
  id: `cap_${subject}`,
  subject,
  role: "writer",
  epoch: 1,
  issuedAt: T0.toISOString(),
  expiresAt: new Date(T0.getTime() + 3_600_000).toISOString(),
  revokedAt: null,
});

type AuthorizeCall = Readonly<{
  subject: string;
  tool: string;
  action: Action;
  named: string | undefined;
}>;

const rig = (
  options: {
    generations?: Record<string, number>;
    denyOn?: (call: AuthorizeCall) => boolean;
    requireRulingRecord?: (itemId: string) => Promise<boolean>;
  } = {},
) => {
  const calls: AuthorizeCall[] = [];
  const generations = options.generations ?? {
    queen: 1,
    ada: 4,
    worker: 1,
    user: 1,
    owner: 1,
  };
  const db = new HiveDatabase(":memory:");
  const store = new MailStore(db);
  const wake = new MailWakeLedger(new MailWakeStore(db));
  const live = new Set(["ada", "bo", "queen", "worker", "user", "owner"]);
  const recipients = (named: string): MailRecipientState => {
    const canonical = named === "orchestrator" ? "queen" : named;
    return live.has(canonical)
      ? { kind: "live", canonical }
      : { kind: "absent" };
  };
  // The delivery-evidence hooks the tool boundary used to assemble for itself.
  // They belong to the service now, so the rig supplies them the way the daemon
  // does — without them these tests would exercise a claim that checks nothing.
  const service = new MailService({
    store,
    recipients,
    notifyReady: (ready) => wake.publishReady(ready),
    beforeClaim: (itemId, recipient) =>
      wake.requirePresented(itemId, recipient),
    beforeComplete: (itemId, recipient) =>
      wake.requireClaimed(itemId, recipient),
  });
  const deps: MailToolDeps = {
    service,
    wake,
    recipients,
    authorizeTool: (cap, tool, action, named) => {
      const call = { subject: cap.subject, tool, action, named };
      calls.push(call);
      if (options.denyOn?.(call) === true) {
        throw new Error(`capability.forbidden-action: ${tool}`);
      }
    },
    liveGeneration: (subject) =>
      generations[subject === "orchestrator" ? "queen" : subject] ?? null,
    now: () => T0,
    requireRulingRecord: options.requireRulingRecord,
  };
  return { store, wake, calls, tools: new MailTools(deps) };
};

const publishControl = (tools: MailTools, overrides: JsonObject = {}) =>
  tools.publish(capability("queen"), {
    from: "queen",
    to: "ada",
    lane: "control",
    topic: "handoff",
    body: "take ownership",
    idempotencyKey: "queen-1",
    ...overrides,
  });

// SAFETY: MailTools.publish owns a structured mail result containing itemId.
const itemIdOf = (result: ReturnType<MailTools["publish"]>): string =>
  (result.structuredContent.mail as { itemId: string }).itemId;

describe("capability checks at the boundary", () => {
  test("every tool authorises before it touches the store", async () => {
    const { tools, calls } = rig();
    const itemId = itemIdOf(publishControl(tools));
    tools.poll(capability("ada"), { recipient: "ada" });
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    });
    await tools.complete(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
      disposition: "completed",
    });
    tools.status(capability("ada"), { recipient: "ada" });
    expect(calls.map((call) => [call.tool, call.action])).toEqual([
      ["hive_mail_publish", "message:send"],
      ["hive_mail_poll", "inbox:read"],
      ["hive_mail_claim", "message:read"],
      ["hive_mail_complete", "message:ack"],
      ["hive_mail_status", "inbox:read"],
    ]);
  });

  test("the named subject is forwarded so the capability layer can refuse it", () => {
    const { tools, calls } = rig();
    publishControl(tools, { to: "bo" });
    tools.poll(capability("ada"), { recipient: "ada" });
    expect(calls.map((call) => call.named)).toEqual(["queen", "ada"]);
  });

  test("a refusal from the capability layer stops the write", () => {
    const { tools, store } = rig({
      denyOn: (call) => call.tool === "hive_mail_publish",
    });
    expect(() => publishControl(tools)).toThrow("capability.forbidden-action");
    expect(store.countByState("ada", "control", "available")).toBe(0);
    expect(store.itemIdForKey("queen", "queen-1")).toBeNull();
  });

  test("a subject with no live binding gets no generation and no mailbox", () => {
    const { tools, store } = rig({ generations: { queen: 1 } });
    const itemId = itemIdOf(publishControl(tools));
    expect(() => tools.poll(capability("ada"), { recipient: "ada" })).toThrow(
      MailSubjectUnboundError,
    );
    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId,
        handlerId: "h1",
      }),
    ).toThrow(MailSubjectUnboundError);
    expect(required(store.getItem(itemId)).state).toBe("available");
  });

  test("the generation comes from the live binding, never from the request", () => {
    const { tools } = rig({ generations: { queen: 1, ada: 4 } });
    const itemId = itemIdOf(
      publishControl(tools, { addressedGeneration: 4, idempotencyKey: "q-4" }),
    );
    // A request that tries to name its own generation is refused as an unknown
    // field before anything reads it.
    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId,
        handlerId: "h1",
        agentGeneration: 9,
      }),
    ).toThrow("MAIL_PAYLOAD_REJECTED");
    tools.poll(capability("ada"), { recipient: "ada" });
    const claimed = tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    });
    // SAFETY: MailTools.claim owns the structured mail result and supplies ownerGeneration.
    expect(
      (claimed.structuredContent.mail as { ownerGeneration: number })
        .ownerGeneration,
    ).toBe(4);
  });

  /**
   * The refusal is also the repair: an item addressed to a generation that has
   * been replaced can never be handled, so the claim that refuses it quarantines
   * it in the same call. Without that, the item stays at the head of a lane that
   * offers one control item at a time and nothing behind it is ever offered.
   *
   * The mismatch arrives through the race the claim-side quarantine exists
   * for: the pin matched when the publish was accepted, and the recipient's
   * incarnation advanced before the claim.
   */
  test("a mismatched item at the head does not block the one behind it", () => {
    const generations = { queen: 1, ada: 4 };
    const { tools, store } = rig({ generations });
    const stuck = itemIdOf(
      publishControl(tools, { addressedGeneration: 4, idempotencyKey: "q-4" }),
    );
    const behind = itemIdOf(
      publishControl(tools, { topic: "second", idempotencyKey: "q-5" }),
    );
    // SAFETY: MailTools.poll owns the structured control-lane result contract.
    const offered = () =>
      (
        tools.poll(capability("ada"), { recipient: "ada" }).structuredContent
          .mail as { control: { itemId: string } | null }
      ).control?.itemId ?? null;
    expect(offered()).toBe(stuck);
    generations.ada = 5;

    // The refusal has to say it cleared the item. A recipient told only that it
    // may not handle the head of a one-at-a-time lane concludes the lane is
    // stuck, and stops rather than polling again.
    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId: stuck,
        handlerId: "h1",
      }),
    ).toThrow("quarantined");

    expect(store.getItem(stuck)).toBeNull();
    expect(offered()).toBe(behind);
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId: behind,
      handlerId: "h2",
    });
  });

  test("a superseded generation cannot take mail addressed to its predecessor", () => {
    const generations = { queen: 1, ada: 4 };
    const { tools, store } = rig({ generations });
    const itemId = itemIdOf(
      publishControl(tools, { addressedGeneration: 4, idempotencyKey: "q-4" }),
    );
    generations.ada = 5;
    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId,
        handlerId: "h1",
      }),
    ).toThrow(MailGenerationMismatchError);
    expect(store.getItem(itemId)).toBeNull();
    expect(required(store.listDeadLetters("ada")[0]).reason).toBe(
      "expired-task-generation",
    );
  });
});

describe("tool results", () => {
  test("each result carries the value for a model and for a program", () => {
    const { tools } = rig();
    const result = publishControl(tools);
    // SAFETY: MailTools.publish owns a structured mail result containing itemId.
    const structured = result.structuredContent.mail as { itemId: string };
    expect(structured.itemId).toStartWith("mit_");
    expect(JSON.parse(required(result.content[0]).text)).toEqual(structured);
  });

  test("a poll result is the bounded shape, not the raw mailbox", () => {
    const { tools } = rig();
    publishControl(tools);
    tools.publish(capability("worker"), {
      from: "worker",
      to: "ada",
      lane: "work",
      topic: "progress",
      body: "10%",
      idempotencyKey: "w-1",
    });
    // SAFETY: MailTools.poll owns this bounded structured mailbox contract.
    const polled = tools.poll(capability("ada"), { recipient: "ada" })
      .structuredContent.mail as {
      control: { itemId: string } | null;
      workDigest: JsonObject[];
      backlog: Record<string, number>;
      cursor: number | null;
    };
    expect(polled.control).not.toBeNull();
    expect(polled.workDigest).toHaveLength(1);
    expect(Object.keys(required(polled.workDigest[0]))).not.toContain("body");
    expect(polled.backlog.controlAvailable).toBe(1);
  });

  test("the five tools carry a publish through to a settlement", async () => {
    const { tools, store, wake } = rig();
    const itemId = itemIdOf(publishControl(tools));
    // SAFETY: MailTools.poll owns the structured control-lane result contract.
    const offered = tools.poll(capability("ada"), { recipient: "ada" })
      .structuredContent.mail as { control: { itemId: string } };
    expect(offered.control.itemId).toBe(itemId);
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    });
    // SAFETY: MailTools.complete owns the structured settlement result contract.
    const settled = (
      await tools.complete(capability("ada"), {
        recipient: "ada",
        itemId,
        handlerId: "h1",
        disposition: "completed",
      })
    ).structuredContent.mail as { replayed: boolean };
    expect(settled.replayed).toBe(false);
    expect(store.getItem(itemId)).toBeNull();
    expect(wake.deliveryChain(itemId).map((row) => row.state)).toEqual([
      "published",
      "mail_presented",
      "mail_claimed",
      "completed",
    ]);
    // SAFETY: MailTools.status owns the structured lane-status result contract.
    const status = tools.status(capability("ada"), { recipient: "ada" })
      .structuredContent.mail as { lanes: { control: { available: number } } };
    expect(status.lanes.control.available).toBe(0);
  });

  test("the root alias writes every evidence row under the canonical mailbox", async () => {
    const { tools, wake } = rig();
    const itemId = itemIdOf(
      tools.publish(capability("ada"), {
        from: "ada",
        to: "queen",
        lane: "control",
        topic: "reply",
        body: "finished",
        idempotencyKey: "ada-reply-1",
      }),
    );
    tools.poll(capability("orchestrator"), { recipient: "orchestrator" });
    tools.claim(capability("orchestrator"), {
      recipient: "orchestrator",
      itemId,
      handlerId: "root-handler",
    });
    await tools.complete(capability("orchestrator"), {
      recipient: "orchestrator",
      itemId,
      handlerId: "root-handler",
      disposition: "completed",
    });

    expect(wake.deliveryChain(itemId).map((row) => row.recipient)).toEqual([
      "queen",
      "queen",
      "queen",
      "queen",
    ]);
  });

  test("a claim the store refuses surfaces as the store's typed error", () => {
    const { tools } = rig();
    const itemId = itemIdOf(publishControl(tools));
    tools.poll(capability("ada"), { recipient: "ada" });
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    });
    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId,
        handlerId: "h2",
      }),
    ).toThrow(MailItemNotClaimableError);
  });

  test("a second control claim names the held item and its settlement remedy", () => {
    const { tools } = rig();
    const heldItemId = itemIdOf(publishControl(tools));
    const blockedItemId = itemIdOf(
      publishControl(tools, { idempotencyKey: "queen-2" }),
    );
    tools.poll(capability("ada"), { recipient: "ada" });
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId: heldItemId,
      handlerId: "h1",
    });

    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId: blockedItemId,
        handlerId: "h2",
      }),
    ).toThrow(MailControlBusyError);
    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId: blockedItemId,
        handlerId: "h2",
      }),
    ).toThrow(`Fix: settle item ${heldItemId} first`);
  });

  test("a claim of the current offer records presentation from the mailbox", () => {
    const { tools, store, wake } = rig();
    const itemId = itemIdOf(publishControl(tools));

    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    });
    expect(required(store.getItem(itemId)).state).toBe("leased");
    expect(wake.deliveryChain(itemId).map((row) => row.state)).toEqual([
      "published",
      "mail_presented",
      "mail_claimed",
    ]);
  });
});

describe("the work lane", () => {
  const publishWork = (tools: MailTools, overrides: JsonObject = {}) =>
    tools.publish(capability("worker"), {
      from: "worker",
      to: "ada",
      lane: "work",
      topic: "progress",
      body: "the digest never carries this",
      idempotencyKey: "w-1",
      ...overrides,
    });

  test("a digest entry can be claimed and read by the recipient it was shown to", async () => {
    const { tools, wake } = rig();
    const itemId = itemIdOf(publishWork(tools));
    // SAFETY: MailTools.poll owns the structured work-digest result contract.
    const polled = tools.poll(capability("ada"), { recipient: "ada" })
      .structuredContent.mail as { workDigest: { itemId: string }[] };
    expect(polled.workDigest.map((entry) => entry.itemId)).toEqual([itemId]);

    // SAFETY: MailTools.claim owns the structured claimed-mail result contract.
    const claimed = tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    }).structuredContent.mail as { body: string };
    expect(claimed.body).toBe("the digest never carries this");
    await tools.complete(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
      disposition: "completed",
    });
    expect(wake.deliveryChain(itemId).map((row) => row.state)).toEqual([
      "published",
      "mail_presented",
      "mail_claimed",
      "completed",
    ]);
  });

  test("an entry the digest did not show is still refused", () => {
    const { tools, store } = rig();
    publishWork(tools, { topic: "first", idempotencyKey: "w-first" });
    const unseen = itemIdOf(
      publishWork(tools, { topic: "second", idempotencyKey: "w-second" }),
    );
    // The bound is what makes this a control rather than a coincidence: the
    // poll returns one entry, and the one it withheld stays unclaimable.
    // SAFETY: MailTools.poll owns the structured work-digest result contract.
    const polled = tools.poll(capability("ada"), {
      recipient: "ada",
      workDigestLimit: 1,
    }).structuredContent.mail as { workDigest: { itemId: string }[] };
    expect(polled.workDigest).toHaveLength(1);
    expect(polled.workDigest.map((entry) => entry.itemId)).not.toContain(
      unseen,
    );

    expect(() =>
      tools.claim(capability("ada"), {
        recipient: "ada",
        itemId: unseen,
        handlerId: "h1",
      }),
    ).toThrow("MAIL_EVIDENCE_MISSING");
    expect(required(store.getItem(unseen)).state).toBe("available");
  });
});

describe("honest refusals", () => {
  test("an over-long completion reason is truncated, not refused", async () => {
    const { tools } = rig();
    const itemId = itemIdOf(publishControl(tools));
    tools.poll(capability("ada"), { recipient: "ada" });
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId,
      handlerId: "h1",
    });
    // SAFETY: MailTools.complete owns the structured settlement result contract.
    const settled = (
      await tools.complete(capability("ada"), {
        recipient: "ada",
        itemId,
        handlerId: "h1",
        disposition: "rejected",
        reason: "x".repeat(400),
      })
    ).structuredContent.mail as { reason: string | null };
    expect(settled.reason).toBe("x".repeat(280));
  });

  test("a zero work digest limit means no digest, not a rejected poll", () => {
    const { tools } = rig();
    publishControl(tools);
    tools.publish(capability("worker"), {
      from: "worker",
      to: "ada",
      lane: "work",
      topic: "progress",
      body: "10%",
      idempotencyKey: "w-1",
    });
    // SAFETY: MailTools.poll owns this bounded structured mailbox contract.
    const polled = tools.poll(capability("ada"), {
      recipient: "ada",
      workDigestLimit: 0,
    }).structuredContent.mail as {
      control: unknown;
      workDigest: unknown[];
      backlog: { workAvailable: number };
    };
    expect(polled.workDigest).toEqual([]);
    expect(polled.control).not.toBeNull();
    // The digest was declined, not emptied: the backlog still reports the item.
    expect(polled.backlog.workAvailable).toBe(1);
  });
});

describe("an item whose published row never landed", () => {
  /**
   * The 2026-08-03 wedge, reproduced: the broker committed the item (it is in
   * the mailbox, poll can offer it) but the ledger's `published` row never
   * landed, because the notification path is best-effort. Before the fix this
   * made `hive_mail_poll` throw after computing its result, bricking the whole
   * mailbox behind one row.
   */
  const publishChainless = (
    store: MailStore,
    overrides: Partial<{
      lane: "control" | "work";
      topic: string;
      body: string;
      idempotencyKey: string;
    }> = {},
  ) =>
    store.publish({
      recipient: "ada",
      sender: "queen",
      lane: overrides.lane ?? "control",
      topic: overrides.topic ?? "handoff",
      recipientGeneration: null,
      body: overrides.body ?? "take ownership",
      idempotencyKey: overrides.idempotencyKey ?? "wedged-1",
      ttlSeconds: null,
      expiresAt: null,
      now: T0.toISOString(),
      controlLaneCapacity: 64,
    });

  // SAFETY: MailTools.poll owns the structured control-lane result contract.
  const polledControl = (tools: MailTools) =>
    tools.poll(capability("ada"), { recipient: "ada" }).structuredContent
      .mail as { control: { itemId: string } | null };

  test("a mailbox holding one unpresentable item still polls, and the item claims", async () => {
    const { store, wake, tools } = rig();
    const wedged = publishChainless(store);
    expect(wake.deliveryChain(wedged.itemId)).toEqual([]);
    // Positive control against the earlier-guard trap: a healthy item in the
    // same mailbox proves the fixture's auth, binding and publish path all
    // work, so only the missing row can be under test.
    const healthy = itemIdOf(
      publishControl(tools, { topic: "second", idempotencyKey: "healthy-1" }),
    );

    const polled = polledControl(tools);
    expect(polled.control?.itemId).toBe(wedged.itemId);

    // The poll repaired the chain from the broker receipt it was holding, so
    // the item claims and settles instead of wedging the lane.
    expect(wake.deliveryChain(wedged.itemId).map((row) => row.state)).toEqual([
      "published",
      "mail_presented",
    ]);
    expect(required(wake.deliveryChain(wedged.itemId)[0]).evidenceRef).toBe(
      `seq:${wedged.seq}`,
    );
    tools.claim(capability("ada"), {
      recipient: "ada",
      itemId: wedged.itemId,
      handlerId: "h1",
    });
    await tools.complete(capability("ada"), {
      recipient: "ada",
      itemId: wedged.itemId,
      handlerId: "h1",
      disposition: "completed",
    });

    // And the item behind the wedge is reached once the wedge is settled.
    expect(polledControl(tools).control?.itemId).toBe(healthy);
  });

  test("a chainless digest entry is repaired while the rest of the digest survives", () => {
    const { store, wake, tools } = rig();
    const wedged = publishChainless(store, {
      lane: "work",
      topic: "progress",
      body: "50%",
      idempotencyKey: "wedged-work-1",
    });
    const healthy = itemIdOf(
      tools.publish(capability("worker"), {
        from: "worker",
        to: "ada",
        lane: "work",
        topic: "status",
        body: "ok",
        idempotencyKey: "healthy-work-1",
      }),
    );

    // SAFETY: MailTools.poll owns the structured work-digest result contract.
    const polled = tools.poll(capability("ada"), { recipient: "ada" })
      .structuredContent.mail as { workDigest: { itemId: string }[] };
    expect(polled.workDigest.map((entry) => entry.itemId)).toEqual([
      wedged.itemId,
      healthy,
    ]);
    expect(wake.deliveryChain(wedged.itemId).map((row) => row.state)).toEqual([
      "published",
      "mail_presented",
    ]);
    // SAFETY: MailTools.claim owns the structured claimed-mail result contract.
    const claimed = tools.claim(capability("ada"), {
      recipient: "ada",
      itemId: wedged.itemId,
      handlerId: "h1",
    }).structuredContent.mail as { body: string };
    expect(claimed.body).toBe("50%");
  });

  /**
   * Queen's constraint: only the diagnosed missing-published condition may be
   * swallowed. An unexpected failure in the evidence layer must still surface.
   * This guard passes on the broken tree too — its job is to fail if the
   * catch is ever broadened into a catch-all.
   */
  test("an evidence failure that is not the wedge still aborts the poll", () => {
    const { store, wake, tools } = rig();
    publishChainless(store);
    wake.recordPresented = () => {
      throw new Error("database is on fire");
    };
    expect(() => tools.poll(capability("ada"), { recipient: "ada" })).toThrow(
      "database is on fire",
    );
  });

  test("an unrepairable item is skipped observably, and the poll still returns", () => {
    const { store, wake, tools } = rig();
    const wedged = publishChainless(store);
    // The repair itself is refused, so presentation can never be recorded for
    // this item. The poll must still deliver the mailbox, and the skip must
    // leave a line naming the item.
    wake.repairPublished = () => {
      throw new MailEvidenceError(
        wedged.itemId,
        "published",
        "repair refused for the test",
      );
    };
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const polled = polledControl(tools);
      expect(polled.control?.itemId).toBe(wedged.itemId);
    } finally {
      console.error = original;
    }
    expect(
      errors.some((line) =>
        line.includes(
          `skipped presentation evidence for ${wedged.itemId} (ada)`,
        ),
      ),
    ).toBe(true);
    expect(wake.deliveryChain(wedged.itemId)).toEqual([]);
  });
});

describe("a publish pinned to a doomed generation", () => {
  // The recipient ada is live at generation 4 in every rig below.
  test("a stale pin is refused at publish, not accepted and quarantined at claim", () => {
    const { tools, store } = rig();
    expect(() =>
      publishControl(tools, {
        addressedGeneration: 3,
        idempotencyKey: "stale-1",
      }),
    ).toThrow("MAIL_GENERATION_REFUSED: ada is at generation 4, not 3");
    // Nothing was accepted: no item, and the idempotency key names nothing.
    expect(store.countByState("ada", "control", "available")).toBe(0);
    expect(store.itemIdForKey("queen", "stale-1")).toBeNull();
  });

  test("a pin matching the live generation is accepted", () => {
    const { tools, store } = rig();
    const itemId = itemIdOf(
      publishControl(tools, {
        addressedGeneration: 4,
        idempotencyKey: "current-1",
      }),
    );
    expect(required(store.getItem(itemId)).state).toBe("available");
  });

  test("a recipient whose generation is unknown is accepted as before", () => {
    // bo is live but has no generation binding in this rig, so there is no
    // fact to refuse with; unknown is not false.
    const { tools, store } = rig();
    const itemId = itemIdOf(
      publishControl(tools, {
        to: "bo",
        addressedGeneration: 2,
        idempotencyKey: "unknown-1",
      }),
    );
    expect(required(store.getItem(itemId)).state).toBe("available");
  });

  /**
   * Guard order: the work lane refuses any generation pin of its own, and the
   * doomed-generation check must not jump ahead of it. Passes on the broken
   * tree too — its job is to fail if the lane skip is ever dropped.
   */
  test("a work-lane pin still gets the work lane's own refusal", () => {
    const { tools } = rig();
    expect(() =>
      tools.publish(capability("queen"), {
        from: "queen",
        to: "ada",
        lane: "work",
        topic: "progress",
        body: "10%",
        idempotencyKey: "work-1",
        addressedGeneration: 3,
      }),
    ).toThrow("MAIL_WORK_LANE_GENERATION");
  });
});

describe("registration", () => {
  test("this module registers nothing on any server", async () => {
    const source = await Bun.file(
      new URL("../../src/mail-service/mail-tools.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("registerTool");
    expect(source).not.toContain("McpServer");
  });
});

describe("owner control complete requires a memory citation", () => {
  const publishOwnerControl = (tools: MailTools, overrides: JsonObject = {}) =>
    tools.publish(capability("user"), {
      from: "user",
      to: "queen",
      lane: "control",
      topic: "ruling",
      body: "wait on first boot",
      idempotencyKey: "user-ruling-1",
      ...overrides,
    });

  const claimQueen = (tools: MailTools, itemId: string) => {
    tools.poll(capability("queen"), { recipient: "queen" });
    tools.claim(capability("queen"), {
      recipient: "queen",
      itemId,
      handlerId: "queen-h1",
    });
  };

  test("completed is refused until repo memory cites the itemId", async () => {
    const cited = new Set<string>();
    const { tools, store } = rig({
      requireRulingRecord: async (itemId) => cited.has(itemId),
    });
    const itemId = itemIdOf(publishOwnerControl(tools));
    claimQueen(tools, itemId);

    await expect(
      tools.complete(capability("queen"), {
        recipient: "queen",
        itemId,
        handlerId: "queen-h1",
        disposition: "completed",
      }),
    ).rejects.toThrow(MailRulingRequiredError);
    expect(store.getItem(itemId)?.state).toBe("leased");

    cited.add(itemId);
    const settled = await tools.complete(capability("queen"), {
      recipient: "queen",
      itemId,
      handlerId: "queen-h1",
      disposition: "completed",
    });
    // SAFETY: MailTools.complete owns the structured settlement result contract.
    expect(
      (settled.structuredContent.mail as { disposition: string }).disposition,
    ).toBe("completed");
    expect(store.getItem(itemId)).toBeNull();
  });

  test("deferred does not need a citation", async () => {
    const { tools } = rig({
      requireRulingRecord: async () => false,
    });
    const itemId = itemIdOf(publishOwnerControl(tools));
    claimQueen(tools, itemId);
    const settled = await tools.complete(capability("queen"), {
      recipient: "queen",
      itemId,
      handlerId: "queen-h1",
      disposition: "deferred",
    });
    // SAFETY: MailTools.complete owns the structured settlement result contract.
    expect(
      (settled.structuredContent.mail as { disposition: string }).disposition,
    ).toBe("deferred");
  });

  test("agent-to-queen control does not need a citation", async () => {
    const { tools } = rig({
      requireRulingRecord: async () => false,
    });
    const itemId = itemIdOf(
      tools.publish(capability("ada"), {
        from: "ada",
        to: "queen",
        lane: "control",
        topic: "reply",
        body: "finished",
        idempotencyKey: "ada-reply-ruling",
      }),
    );
    claimQueen(tools, itemId);
    await tools.complete(capability("queen"), {
      recipient: "queen",
      itemId,
      handlerId: "queen-h1",
      disposition: "completed",
    });
  });
});
