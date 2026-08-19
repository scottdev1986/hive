import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  hiveMailClaim,
  hiveMailComplete,
  hiveMailPoll,
  hiveMailPublish,
  hiveMailStatus,
  type MailActor,
  type MailBrokerDeps,
  MailForeignSubjectError,
  MailGenerationMismatchError,
  MailPayloadRejectedError,
  MailRecipientRefusedError,
  type MailRecipientState,
  MailService,
  MailWorkLaneGenerationError,
  sweepMailDeadlines,
} from "../../src/mail-service/service";
import {
  MailControlLaneFullError,
  MailIdempotencyConflictError,
  MailItemNotClaimableError,
  MailLeaseNotHeldError,
  MailStore,
} from "../../src/mail-service/store";
import {
  MAIL_BODY_MAX_BYTES,
  MAIL_CONTROL_LANE_CAPACITY,
  MAIL_DEFERRAL_SECONDS,
  MAIL_LEASE_SECONDS,
  MAIL_MAX_ATTEMPTS,
  MAIL_REASON_MAX_LENGTH,
  MAIL_WORK_DIGEST_MAX,
} from "../../src/schemas/mail";
import { required } from "../required";

const T0 = new Date("2026-08-01T12:00:00.000Z");
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

const QUEEN: MailActor = { subject: "queen", agentGeneration: 1 };
const WORKER: MailActor = { subject: "worker", agentGeneration: 1 };
const ADA: MailActor = { subject: "ada", agentGeneration: 4 };

const LIVE = new Set(["ada", "bo", "queen", "worker"]);
const OPERATOR_MAIL_POLICY = {
  maxAttempts: 1,
  sloBreachSeconds: 10,
};

const resolver = (
  overrides: Record<string, MailRecipientState> = {},
): ((named: string) => MailRecipientState) => {
  return (named) => {
    const override = overrides[named];
    if (override !== undefined) return override;
    if (named === "orchestrator") return { kind: "live", canonical: "queen" };
    return LIVE.has(named)
      ? { kind: "live", canonical: named }
      : { kind: "absent" };
  };
};

const store = (
  overrides: Record<string, MailRecipientState> = {},
): MailBrokerDeps => ({
  store: new MailStore(new HiveDatabase(":memory:")),
  recipients: resolver(overrides),
});

const control = (overrides: Record<string, unknown> = {}) => ({
  from: "queen",
  to: "ada",
  lane: "control",
  topic: "handoff",
  body: "take ownership",
  idempotencyKey: "queen-1",
  ...overrides,
});

const work = (overrides: Record<string, unknown> = {}) => ({
  from: "worker",
  to: "ada",
  lane: "work",
  topic: "progress",
  body: "10%",
  idempotencyKey: "worker-1",
  ...overrides,
});

/** Claims and lets the lease lapse, the way a handler that dies would. */
const claimThenCrash = (
  mail: MailBrokerDeps,
  itemId: string,
  handlerId: string,
  second: number,
): void => {
  hiveMailClaim(mail, ADA, { recipient: "ada", itemId, handlerId }, at(second));
  sweepMailDeadlines(mail.store, at(second + MAIL_LEASE_SECONDS + 1));
};

describe("schema initialisation", () => {
  test("the DDL executes on a fresh database and is idempotent", () => {
    const db = new HiveDatabase(":memory:");
    expect(() => new MailStore(db)).not.toThrow();
    expect(() => new MailStore(db)).not.toThrow();
    const tables = db.database
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mail_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      "mail_dead_letters",
      "mail_events",
      "mail_items",
      "mail_leases",
      "mail_sequences",
    ]);
  });
});

describe("live lease renewal", () => {
  test("a turn heartbeat extends only its live leases without spending attempts", () => {
    const deps = store();
    const service = new MailService(deps);
    const receipt = service.publish(QUEEN, control(), T0);
    service.claim(
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "turn-1" },
      at(1),
    );

    const renewed = service.renewLiveLeases(ADA, at(100));

    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.leaseUntil).toBe(at(220).toISOString());
    expect(required(deps.store.getItem(receipt.itemId)).attempts).toBe(1);
    expect(
      deps.store.listEvents(receipt.itemId).map((event) => event.kind),
    ).toEqual(["published", "claimed", "lease-renewed"]);
  });

  test("a heartbeat never revives an expired lease", () => {
    const deps = store();
    const service = new MailService(deps);
    const receipt = service.publish(QUEEN, control(), T0);
    service.claim(
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "turn-1" },
      at(1),
    );

    expect(service.renewLiveLeases(ADA, at(122))).toEqual([]);
    expect(required(deps.store.getItem(receipt.itemId)).attempts).toBe(1);
    expect(
      deps.store.listEvents(receipt.itemId).map((event) => event.kind),
    ).toEqual(["published", "claimed"]);
  });
});

describe("operator mail policy reaches every service branch", () => {
  test("the configured SLO reports mail after the configured wait", async () => {
    const deps = {
      ...store(),
      safePointAt: () => at(1).toISOString(),
    };
    const configured = new MailService(deps, OPERATOR_MAIL_POLICY);
    configured.publish(QUEEN, control(), T0);

    await configured.sweep(at(11));

    expect(
      configured.poll(QUEEN, { recipient: "queen" }, at(12)).workDigest[0]
        ?.topic,
    ).toBe("mail-latency");
  });

  test("claim uses the configured attempt limit when releasing an expired lease", () => {
    const deps = store();
    const configured = new MailService(deps, OPERATOR_MAIL_POLICY);
    const receipt = configured.publish(QUEEN, control(), T0);
    configured.claim(
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "first" },
      T0,
    );

    expect(() =>
      configured.claim(
        ADA,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "second" },
        at(MAIL_LEASE_SECONDS + 1),
      ),
    ).toThrow(MailItemNotClaimableError);
  });

  test("completion uses the configured attempt limit for a deferral", () => {
    const deps = store();
    const configured = new MailService(deps, OPERATOR_MAIL_POLICY);
    const receipt = configured.publish(QUEEN, control(), T0);
    configured.claim(
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "handler" },
      T0,
    );

    configured.complete(
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "handler",
        disposition: "deferred",
      },
      at(1),
    );

    expect(deps.store.getItem(receipt.itemId)).toBeNull();
    expect(deps.store.listDeadLetters("ada")[0]?.reason).toBe(
      "attempts-exhausted",
    );
  });

  test("deadline sweep uses the configured attempt limit", () => {
    const deps = store();
    const configured = new MailService(deps, OPERATOR_MAIL_POLICY);
    const receipt = configured.publish(QUEEN, control(), T0);
    configured.claim(
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "handler" },
      T0,
    );

    expect(configured.sweepDeadlines(at(MAIL_LEASE_SECONDS + 1))).toEqual([
      {
        itemId: receipt.itemId,
        outcome: "dead-lettered",
        reason: "attempts-exhausted",
      },
    ]);
  });

  test("live lease renewal forwards the configured attempt limit", () => {
    const deps = store();
    const configured = new MailService(deps, OPERATOR_MAIL_POLICY);
    const receipt = configured.publish(QUEEN, control(), T0);
    configured.claim(
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "handler" },
      T0,
    );
    const claim = deps.store.claim.bind(deps.store);
    const observed: number[] = [];
    deps.store.claim = (input) => {
      observed.push(input.maxAttempts);
      return claim(input);
    };

    configured.renewLiveLeases(ADA, at(1));

    expect(observed).toEqual([1]);
  });
});

describe("hive_mail_publish", () => {
  test("a retry of the same idempotency key returns the original receipt", () => {
    const mail = store();
    const first = hiveMailPublish(mail, QUEEN, control(), T0);
    const retry = hiveMailPublish(mail, QUEEN, control(), at(1));
    expect(retry).toEqual(first);
    expect(first.outcome).toBe("published");
    expect(mail.store.countByState("ada", "control", "available")).toBe(1);
  });

  test("a replay after later merges returns what its own publish was told", () => {
    const mail = store();
    const first = hiveMailPublish(mail, WORKER, work(), T0);
    const second = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "20%" }),
      at(1),
    );
    hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-3", body: "30%" }),
      at(2),
    );
    expect(required(mail.store.getItem(first.itemId)).mergedCount).toBe(2);
    // Each key replays the count its own accept reported, not the item's.
    expect(hiveMailPublish(mail, WORKER, work(), at(3))).toEqual(first);
    expect(first.mergedCount).toBe(0);
    expect(
      hiveMailPublish(
        mail,
        WORKER,
        work({ idempotencyKey: "worker-2", body: "20%" }),
        at(4),
      ),
    ).toEqual(second);
    expect(second.mergedCount).toBe(1);
  });

  test("a replay after its item was absorbed still returns the original receipt", () => {
    const mail = store();
    const first = hiveMailPublish(mail, WORKER, work(), T0);
    const merged = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "20%" }),
      at(1),
    );
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: first.itemId, handlerId: "h1" },
      at(2),
    );
    const successor = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-3", body: "90%" }),
      at(3),
    );
    sweepMailDeadlines(mail.store, at(MAIL_LEASE_SECONDS + 10));
    // The item those two keys were accepted into no longer exists.
    expect(mail.store.getItem(first.itemId)).toBeNull();
    expect(successor.itemId).not.toBe(first.itemId);
    expect(hiveMailPublish(mail, WORKER, work(), at(400))).toEqual(first);
    expect(
      hiveMailPublish(
        mail,
        WORKER,
        work({ idempotencyKey: "worker-2", body: "20%" }),
        at(401),
      ),
    ).toEqual(merged);
  });

  test("the work lane refuses an addressed generation instead of mis-delivering it", () => {
    const mail = store();
    expect(() =>
      hiveMailPublish(mail, WORKER, work({ addressedGeneration: 1 }), T0),
    ).toThrow(MailWorkLaneGenerationError);
    expect(mail.store.countByState("ada", "work", "available")).toBe(0);
    expect(mail.store.itemIdForKey("worker", "worker-1")).toBeNull();
  });

  test("coalesced work rows carry no generation for a fold to cross", () => {
    const mail = store();
    const first = hiveMailPublish(mail, WORKER, work(), T0);
    hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "20%" }),
      at(1),
    );
    expect(
      required(mail.store.getItem(first.itemId)).recipientGeneration,
    ).toBeNull();
    expect(required(mail.store.getItem(first.itemId)).mergedCount).toBe(1);
  });

  test("the fingerprint digests its fields in the canonical order", () => {
    const mail = store();
    const receipt = hiveMailPublish(
      mail,
      QUEEN,
      control({ addressedGeneration: 3, ttlSeconds: 600 }),
      T0,
    );
    // Derived from the contract's order — recipient, lane, topic, addressed
    // generation, body, normalised ttl — not copied from this implementation.
    // A reordering keeps every field yet changes this digest, which is the one
    // thing the field-by-field conflict tests cannot see.
    expect(required(mail.store.listEvents(receipt.itemId)[0]).fingerprint).toBe(
      "5bc1cd31bb10b3c337545494271fd80e2dc14b1ac1832b000023572571199f9d",
    );
  });

  test("a key reused for different content is refused, not silently swallowed", () => {
    const mail = store();
    const first = hiveMailPublish(mail, QUEEN, control(), T0);
    expect(() =>
      hiveMailPublish(mail, QUEEN, control({ body: "something else" }), at(1)),
    ).toThrow(MailIdempotencyConflictError);
    expect(required(mail.store.getItem(first.itemId)).body).toBe(
      "take ownership",
    );
    expect(mail.store.countByState("ada", "control", "available")).toBe(1);
  });

  test.each([
    ["a different recipient", { to: "bo" }],
    ["a different lane", { lane: "work" }],
    ["a different topic", { topic: "other" }],
    ["a different addressed generation", { addressedGeneration: 9 }],
    ["a different ttl", { ttlSeconds: 3_600 }],
  ])("the same key with %s is refused", (_label, override) => {
    const mail = store();
    hiveMailPublish(mail, QUEEN, control(), T0);
    expect(() =>
      hiveMailPublish(mail, QUEEN, control(override), at(1)),
    ).toThrow(MailIdempotencyConflictError);
  });

  test("a retry of a ttl envelope replays rather than conflicting on its deadline", () => {
    const mail = store();
    const first = hiveMailPublish(
      mail,
      QUEEN,
      control({ ttlSeconds: 600 }),
      T0,
    );
    // The retry lands later, so the deadline it would compute differs. Only the
    // requested lifetime identifies the envelope, so this is still a replay.
    const retry = hiveMailPublish(
      mail,
      QUEEN,
      control({ ttlSeconds: 600 }),
      at(90),
    );
    expect(retry).toEqual(first);
    expect(required(mail.store.getItem(first.itemId)).expiresAt).toBe(
      at(600).toISOString(),
    );
  });

  test("two senders may reuse the same key without colliding", () => {
    const mail = store();
    const one = hiveMailPublish(mail, QUEEN, control(), T0);
    const two = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "queen-1" }),
      at(1),
    );
    expect(two.itemId).not.toBe(one.itemId);
    expect(two.outcome).toBe("published");
  });

  test("a settled key still resolves to the id its sender was given", () => {
    const mail = store();
    const first = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: first.itemId, handlerId: "h1" },
      at(1),
    );
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: first.itemId,
        handlerId: "h1",
        disposition: "completed",
      },
      at(2),
    );
    expect(mail.store.getItem(first.itemId)).toBeNull();
    expect(hiveMailPublish(mail, QUEEN, control(), at(3))).toEqual(first);
    expect(mail.store.countByState("ada", "control", "available")).toBe(0);
  });

  test("a coalesced key is recorded, so its retry does not merge twice", () => {
    const mail = store();
    hiveMailPublish(mail, WORKER, work(), T0);
    const merged = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "20%" }),
      at(1),
    );
    expect(merged.outcome).toBe("coalesced");
    const retry = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "20%" }),
      at(2),
    );
    expect(retry).toEqual(merged);
    expect(required(mail.store.getItem(merged.itemId)).mergedCount).toBe(1);
  });

  test("a sender may not publish under another agent's name", () => {
    const mail = store();
    expect(() => hiveMailPublish(mail, WORKER, control(), T0)).toThrow(
      MailForeignSubjectError,
    );
    expect(mail.store.countByState("ada", "control", "available")).toBe(0);
  });
});

describe("recipient validation happens before any mail write", () => {
  test.each([
    ["a name nobody is bound to", { kind: "absent" as const }],
    ["a dead agent", { kind: "terminal" as const, status: "dead" }],
    ["a finished agent", { kind: "terminal" as const, status: "done" }],
    ["a failed agent", { kind: "terminal" as const, status: "failed" }],
    ["an agent with no hierarchy binding", { kind: "unbound" as const }],
  ])("%s is refused and nothing is written", (_label, state) => {
    const mail = store({ ada: state });
    expect(() => hiveMailPublish(mail, QUEEN, control(), T0)).toThrow(
      MailRecipientRefusedError,
    );
    expect(mail.store.countByState("ada", "control", "available")).toBe(0);
    expect(mail.store.itemIdForKey("queen", "queen-1")).toBeNull();
    expect(mail.store.listDeadLetters("ada")).toEqual([]);
  });

  test("the refusal names which state stopped it", () => {
    const mail = store({ ada: { kind: "terminal", status: "done" } });
    expect(() => hiveMailPublish(mail, QUEEN, control(), T0)).toThrow(
      /MAIL_RECIPIENT_REFUSED: ada .*terminal: done/,
    );
  });

  test("the root's two names file into one mailbox", () => {
    const mail = store();
    const root: MailActor = { subject: "orchestrator", agentGeneration: 1 };
    const receipt = hiveMailPublish(
      mail,
      WORKER,
      work({ to: "orchestrator", from: "worker" }),
      T0,
    );
    expect(required(mail.store.getItem(receipt.itemId)).recipient).toBe(
      "queen",
    );
    // The root reads under the name it happens to be addressed by, and finds
    // the same mailbox rather than an empty one.
    expect(
      hiveMailPoll(mail, root, { recipient: "orchestrator" }, at(1)).workDigest,
    ).toHaveLength(1);
    expect(
      hiveMailPoll(
        mail,
        { subject: "queen", agentGeneration: 1 },
        { recipient: "queen" },
        at(2),
      ).workDigest,
    ).toHaveLength(1);
  });

  test("the root may read its own mailbox under either spelling", () => {
    const mail = store();
    const root: MailActor = { subject: "orchestrator", agentGeneration: 1 };
    hiveMailPublish(mail, WORKER, work({ to: "queen", from: "worker" }), T0);
    // Capability says one name, request says the other, in both directions.
    expect(
      hiveMailPoll(mail, root, { recipient: "queen" }, at(1)).workDigest,
    ).toHaveLength(1);
    expect(
      hiveMailPoll(mail, QUEEN, { recipient: "orchestrator" }, at(2))
        .workDigest,
    ).toHaveLength(1);
  });

  test("a publisher's two names are one publisher", () => {
    const mail = store();
    const root: MailActor = { subject: "orchestrator", agentGeneration: 1 };
    const first = hiveMailPublish(
      mail,
      QUEEN,
      work({ from: "queen", idempotencyKey: "root-1" }),
      T0,
    );
    expect(required(mail.store.getItem(first.itemId)).sender).toBe("queen");
    // Published under the other spelling: the same publisher, so this merges
    // rather than opening a second stream on the same topic.
    const merged = hiveMailPublish(
      mail,
      root,
      work({ from: "orchestrator", idempotencyKey: "root-2", body: "20%" }),
      at(1),
    );
    expect(merged.itemId).toBe(first.itemId);
    expect(merged.outcome).toBe("coalesced");
    expect(mail.store.countByState("ada", "work", "available")).toBe(1);
  });

  test.each([
    ["claim", "orchestrator", "queen"],
    ["claim", "queen", "orchestrator"],
    ["complete", "orchestrator", "queen"],
    ["complete", "queen", "orchestrator"],
    ["status", "orchestrator", "queen"],
    ["status", "queen", "orchestrator"],
  ])(
    "%s works when the capability says %s and the request says %s",
    (tool, subject, named) => {
      const mail = store();
      const actor: MailActor = { subject, agentGeneration: 1 };
      const receipt = hiveMailPublish(
        mail,
        WORKER,
        work({ to: "queen", from: "worker" }),
        T0,
      );
      if (tool === "status") {
        expect(
          hiveMailStatus(mail, actor, { recipient: named }, at(1)).lanes.work
            .available,
        ).toBe(1);
        return;
      }
      const claimed = hiveMailClaim(
        mail,
        actor,
        { recipient: named, itemId: receipt.itemId, handlerId: "h1" },
        at(1),
      );
      expect(claimed.itemId).toBe(receipt.itemId);
      if (tool === "complete") {
        expect(
          hiveMailComplete(
            mail,
            actor,
            {
              recipient: named,
              itemId: receipt.itemId,
              handlerId: "h1",
              disposition: "completed",
            },
            at(2),
          ).replayed,
        ).toBe(false);
        expect(mail.store.getItem(receipt.itemId)).toBeNull();
      }
    },
  );

  test("an agent still may not act on a mailbox that is not its own", () => {
    const mail = store();
    const root: MailActor = { subject: "orchestrator", agentGeneration: 1 };
    expect(() => hiveMailPoll(mail, root, { recipient: "ada" }, T0)).toThrow(
      MailForeignSubjectError,
    );
  });
});

describe("payload validation happens before the transaction", () => {
  test("an oversized body is refused and nothing is written", () => {
    const mail = store();
    expect(() =>
      hiveMailPublish(
        mail,
        QUEEN,
        control({ body: "x".repeat(MAIL_BODY_MAX_BYTES + 1) }),
        T0,
      ),
    ).toThrow(MailPayloadRejectedError);
    expect(mail.store.countByState("ada", "control", "available")).toBe(0);
    expect(mail.store.itemIdForKey("queen", "queen-1")).toBeNull();
  });

  test.each([
    ["an unknown lane", { lane: "sideways" }],
    ["an empty body", { body: "" }],
    ["a malformed topic", { topic: "Progress Report!" }],
    ["an over-long topic", { topic: "t".repeat(65) }],
    ["a missing idempotency key", { idempotencyKey: "" }],
    ["a negative ttl", { ttlSeconds: -1 }],
    ["a fractional generation", { addressedGeneration: 1.5 }],
    ["an unknown field", { urgent: true }],
  ])("%s is refused before any write", (_label, override) => {
    const mail = store();
    expect(() => hiveMailPublish(mail, QUEEN, control(override), T0)).toThrow(
      MailPayloadRejectedError,
    );
    expect(mail.store.itemIdForKey("queen", "queen-1")).toBeNull();
  });

  test("a body at exactly the limit is accepted", () => {
    const mail = store();
    const body = "x".repeat(MAIL_BODY_MAX_BYTES);
    const receipt = hiveMailPublish(mail, QUEEN, control({ body }), T0);
    expect(required(mail.store.getItem(receipt.itemId)).body).toBe(body);
  });

  // The reason annotates a settlement and is read back by nobody, so an
  // over-long one is trimmed rather than made to fail the settlement itself and
  // leave the lane held by a handler that has finished with it.
  test("an over-long settlement reason is trimmed, and the item still settles", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    const settled = hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "rejected",
        reason: "r".repeat(281),
      },
      at(2),
    );
    expect(settled.reason).toBe("r".repeat(MAIL_REASON_MAX_LENGTH));
    expect(mail.store.getItem(receipt.itemId)).toBeNull();
  });
});

describe("sequence allocation", () => {
  test("settling and republishing does not reuse a sequence", () => {
    const mail = store();
    const first = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: first.itemId, handlerId: "h1" },
      at(1),
    );
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: first.itemId,
        handlerId: "h1",
        disposition: "completed",
      },
      at(2),
    );
    expect(mail.store.getItem(first.itemId)).toBeNull();
    const second = hiveMailPublish(
      mail,
      QUEEN,
      control({ idempotencyKey: "queen-2" }),
      at(3),
    );
    expect(second.seq).toBeGreaterThan(first.seq);
  });

  test("a cursor held across a full drain still pages forward", () => {
    const mail = store();
    for (let index = 1; index <= 3; index += 1) {
      hiveMailPublish(
        mail,
        WORKER,
        work({ idempotencyKey: `w-${index}`, topic: `stage.${index}` }),
        at(index),
      );
    }
    const before = hiveMailPoll(mail, ADA, { recipient: "ada" }, at(10));
    for (const entry of before.workDigest) {
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: entry.itemId, handlerId: "drain" },
        at(11),
      );
      hiveMailComplete(
        mail,
        ADA,
        {
          recipient: "ada",
          itemId: entry.itemId,
          handlerId: "drain",
          disposition: "completed",
        },
        at(12),
      );
    }
    expect(mail.store.countByState("ada", "work", "available")).toBe(0);
    const after = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "w-late", topic: "stage.late" }),
      at(20),
    );
    const paged = hiveMailPoll(
      mail,
      ADA,
      { recipient: "ada", cursor: before.cursor },
      at(21),
    );
    expect(paged.workDigest.map((entry) => entry.itemId)).toEqual([
      after.itemId,
    ]);
  });
});

describe("control lane", () => {
  test("holds strict sequence and offers one item at a time", () => {
    const mail = store();
    const first = hiveMailPublish(mail, QUEEN, control(), T0);
    const second = hiveMailPublish(
      mail,
      QUEEN,
      control({ idempotencyKey: "queen-2", body: "then report" }),
      at(1),
    );
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(
      required(hiveMailPoll(mail, ADA, { recipient: "ada" }, at(2)).control)
        .itemId,
    ).toBe(first.itemId);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: first.itemId, handlerId: "h1" },
      at(3),
    );
    const leased = hiveMailPoll(mail, ADA, { recipient: "ada" }, at(4));
    expect(leased.control).toBeNull();
    expect(leased.backlog.controlAvailable).toBe(1);
    expect(leased.backlog.controlLeased).toBe(1);
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: first.itemId,
        handlerId: "h1",
        disposition: "completed",
      },
      at(5),
    );
    expect(
      required(hiveMailPoll(mail, ADA, { recipient: "ada" }, at(6)).control)
        .itemId,
    ).toBe(second.itemId);
  });

  test("the database refuses a second leased control item for one recipient", () => {
    const mail = store();
    const first = hiveMailPublish(mail, QUEEN, control(), T0);
    const second = hiveMailPublish(
      mail,
      QUEEN,
      control({ idempotencyKey: "queen-2" }),
      at(1),
    );
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: first.itemId, handlerId: "h1" },
      at(2),
    );
    expect(() =>
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: second.itemId, handlerId: "h2" },
        at(3),
      ),
    ).toThrow();
    expect(required(mail.store.getItem(second.itemId)).state).toBe("available");
    expect(required(mail.store.getItem(second.itemId)).attempts).toBe(0);
  });

  test("refuses the publish that would exceed capacity, and evicts nothing", () => {
    const mail = store();
    const accepted: string[] = [];
    for (let index = 0; index < MAIL_CONTROL_LANE_CAPACITY; index += 1) {
      accepted.push(
        hiveMailPublish(
          mail,
          QUEEN,
          control({ idempotencyKey: `queen-${index}` }),
          at(index),
        ).itemId,
      );
    }
    expect(() =>
      hiveMailPublish(
        mail,
        QUEEN,
        control({ idempotencyKey: "queen-overflow" }),
        at(999),
      ),
    ).toThrow(MailControlLaneFullError);
    expect(mail.store.countByState("ada", "control", "available")).toBe(
      MAIL_CONTROL_LANE_CAPACITY,
    );
    for (const itemId of accepted) {
      expect(required(mail.store.getItem(itemId)).state).toBe("available");
    }
    expect(mail.store.itemIdForKey("queen", "queen-overflow")).toBeNull();
    expect(mail.store.listDeadLetters("ada")).toEqual([]);
  });

  test("an item already being worked does not count against the queue cap", () => {
    const mail = store();
    const ids: string[] = [];
    for (let index = 0; index < MAIL_CONTROL_LANE_CAPACITY; index += 1) {
      ids.push(
        hiveMailPublish(
          mail,
          QUEEN,
          control({ idempotencyKey: `queen-${index}` }),
          at(index),
        ).itemId,
      );
    }
    // One leased plus 63 waiting is 64 unsettled but only 63 queued, and the
    // cap bounds what is waiting to be read.
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: required(ids[0]), handlerId: "h1" },
      at(500),
    );
    expect(mail.store.countByState("ada", "control", "leased")).toBe(1);
    expect(mail.store.countByState("ada", "control", "available")).toBe(
      MAIL_CONTROL_LANE_CAPACITY - 1,
    );
    expect(
      hiveMailPublish(
        mail,
        QUEEN,
        control({ idempotencyKey: "queen-next" }),
        at(501),
      ).outcome,
    ).toBe("published");
    expect(() =>
      hiveMailPublish(
        mail,
        QUEEN,
        control({ idempotencyKey: "queen-over" }),
        at(502),
      ),
    ).toThrow(MailControlLaneFullError);
  });

  test("capacity is per recipient and frees as items settle", () => {
    const mail = store();
    const ids: string[] = [];
    for (let index = 0; index < MAIL_CONTROL_LANE_CAPACITY; index += 1) {
      ids.push(
        hiveMailPublish(
          mail,
          QUEEN,
          control({ idempotencyKey: `queen-${index}` }),
          at(index),
        ).itemId,
      );
    }
    expect(
      hiveMailPublish(
        mail,
        QUEEN,
        control({ to: "bo", idempotencyKey: "queen-bo" }),
        at(500),
      ).outcome,
    ).toBe("published");
    const head = required(ids[0]);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: head, handlerId: "h1" },
      at(600),
    );
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: head,
        handlerId: "h1",
        disposition: "completed",
      },
      at(601),
    );
    expect(
      hiveMailPublish(
        mail,
        QUEEN,
        control({ idempotencyKey: "queen-next" }),
        at(602),
      ).outcome,
    ).toBe("published");
  });
});

describe("work lane", () => {
  test("1,000 progress updates collapse into one counted digest entry", () => {
    const mail = store();
    const instruction = hiveMailPublish(mail, QUEEN, control(), T0);
    for (let index = 1; index <= 1_000; index += 1) {
      hiveMailPublish(
        mail,
        WORKER,
        work({ idempotencyKey: `worker-${index}`, body: `${index}/1000` }),
        at(index),
      );
    }
    const poll = hiveMailPoll(mail, ADA, { recipient: "ada" }, at(1_001));
    expect(poll.workDigest).toHaveLength(1);
    expect(required(poll.workDigest[0]).mergedCount).toBe(999);
    expect(mail.store.countByState("ada", "work", "available")).toBe(1);
    expect(
      required(mail.store.getItem(required(poll.workDigest[0]).itemId)).body,
    ).toBe("1000/1000");
    expect(required(poll.control).itemId).toBe(instruction.itemId);
    expect(poll.backlog.controlAvailable).toBe(1);
  });

  test("the digest reports headers and sizes, never bodies", () => {
    const mail = store();
    hiveMailPublish(mail, WORKER, work({ body: "a".repeat(500) }), T0);
    const entry = required(
      hiveMailPoll(mail, ADA, { recipient: "ada" }, at(1)).workDigest[0],
    );
    expect(Object.keys(entry).sort()).toEqual([
      "bodyBytes",
      "itemId",
      "mergedCount",
      "sender",
      "seq",
      "topic",
      "updatedAt",
    ]);
    expect(entry.bodyBytes).toBe(500);
  });

  test("coalescing partitions by recipient, sender and topic", () => {
    const mail = store();
    hiveMailPublish(mail, WORKER, work(), T0);
    hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", topic: "other" }),
      at(1),
    );
    hiveMailPublish(
      mail,
      QUEEN,
      work({ from: "queen", idempotencyKey: "queen-w" }),
      at(2),
    );
    hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-3", to: "bo" }),
      at(3),
    );
    expect(mail.store.countByState("ada", "work", "available")).toBe(3);
    expect(mail.store.countByState("bo", "work", "available")).toBe(1);
  });

  test("the digest is bounded and the cursor pages past it", () => {
    const mail = store();
    for (let index = 1; index <= MAIL_WORK_DIGEST_MAX + 4; index += 1) {
      hiveMailPublish(
        mail,
        WORKER,
        work({ idempotencyKey: `worker-${index}`, topic: `stage.${index}` }),
        at(index),
      );
    }
    const first = hiveMailPoll(mail, ADA, { recipient: "ada" }, at(500));
    expect(first.workDigest).toHaveLength(MAIL_WORK_DIGEST_MAX);
    expect(first.backlog.workAvailable).toBe(MAIL_WORK_DIGEST_MAX + 4);
    const second = hiveMailPoll(
      mail,
      ADA,
      { recipient: "ada", cursor: first.cursor },
      at(501),
    );
    expect(second.workDigest).toHaveLength(4);
    expect(
      second.workDigest.every((entry) => entry.seq > required(first.cursor)),
    ).toBe(true);
  });

  test("a leased item is never rewritten under its handler", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, WORKER, work(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    const later = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "90%" }),
      at(2),
    );
    expect(later.itemId).not.toBe(receipt.itemId);
    expect(later.outcome).toBe("published");
    expect(required(mail.store.getItem(receipt.itemId)).body).toBe("10%");
  });

  test("a lapsed lease whose topic gained a newer update is absorbed, not stranded", () => {
    const mail = store();
    const first = hiveMailPublish(mail, WORKER, work({ body: "10%" }), T0);
    // W1 already stands for several updates before it is ever leased, so the
    // survivor's count can distinguish "+1" from "+ everything W1 represented".
    for (const index of [1, 2, 3]) {
      hiveMailPublish(
        mail,
        WORKER,
        work({ idempotencyKey: `worker-pre-${index}`, body: `${index}0%` }),
        at(index),
      );
    }
    expect(required(mail.store.getItem(first.itemId)).mergedCount).toBe(3);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: first.itemId, handlerId: "h1" },
      at(4),
    );
    const second = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-2", body: "90%" }),
      at(5),
    );
    // Also strand an unrelated lease, so a sweep that aborted here would be
    // visible as the other item never coming back.
    const other = hiveMailPublish(
      mail,
      WORKER,
      work({ idempotencyKey: "worker-3", topic: "other", body: "x" }),
      at(6),
    );
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: other.itemId, handlerId: "h2" },
      at(7),
    );
    expect(() =>
      sweepMailDeadlines(mail.store, at(MAIL_LEASE_SECONDS + 10)),
    ).not.toThrow();
    expect(mail.store.getItem(first.itemId)).toBeNull();
    const survivor = required(mail.store.getItem(second.itemId));
    expect(survivor.state).toBe("available");
    expect(survivor.body).toBe("90%");
    // Everything W1 stood for, plus W1 itself — not merely one more.
    expect(survivor.mergedCount).toBe(4);
    expect(required(mail.store.getItem(other.itemId)).state).toBe("available");
    expect(mail.store.countByState("ada", "work", "available")).toBe(2);
  });
});

describe("leases", () => {
  test("a crash after claim redelivers on expiry and settles idempotently", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    claimThenCrash(mail, receipt.itemId, "handler-a", 1);
    const offered = hiveMailPoll(
      mail,
      ADA,
      { recipient: "ada" },
      at(MAIL_LEASE_SECONDS + 5),
    );
    expect(required(offered.control).itemId).toBe(receipt.itemId);
    expect(required(offered.control).attempts).toBe(1);
    const second = hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "handler-b" },
      at(MAIL_LEASE_SECONDS + 6),
    );
    expect(second.attempt).toBe(2);
    const settled = hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "handler-b",
        disposition: "completed",
      },
      at(MAIL_LEASE_SECONDS + 7),
    );
    const replay = hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "handler-b",
        disposition: "completed",
      },
      at(MAIL_LEASE_SECONDS + 8),
    );
    expect(settled.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.attempt).toBe(settled.attempt);
    expect(mail.store.getItem(receipt.itemId)).toBeNull();
  });

  test("a lease that lapsed cannot settle work another claimant now owns", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    claimThenCrash(mail, receipt.itemId, "handler-a", 1);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "handler-b" },
      at(MAIL_LEASE_SECONDS + 5),
    );
    expect(() =>
      hiveMailComplete(
        mail,
        ADA,
        {
          recipient: "ada",
          itemId: receipt.itemId,
          handlerId: "handler-a",
          disposition: "completed",
        },
        at(MAIL_LEASE_SECONDS + 6),
      ),
    ).toThrow(MailLeaseNotHeldError);
    expect(required(mail.store.getItem(receipt.itemId)).state).toBe("leased");
    expect(required(mail.store.getLease(receipt.itemId)).handlerId).toBe(
      "handler-b",
    );
  });

  test("a lapsed lease cannot settle even before anything sweeps it", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "handler-a" },
      at(1),
    );
    expect(() =>
      hiveMailComplete(
        mail,
        ADA,
        {
          recipient: "ada",
          itemId: receipt.itemId,
          handlerId: "handler-a",
          disposition: "completed",
        },
        at(MAIL_LEASE_SECONDS + 5),
      ),
    ).toThrow(MailLeaseNotHeldError);
  });

  test("a duplicate claim is refused and spends no attempt", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    expect(() =>
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h2" },
        at(2),
      ),
    ).toThrow(MailItemNotClaimableError);
    expect(required(mail.store.getItem(receipt.itemId)).attempts).toBe(1);
    expect(required(mail.store.getLease(receipt.itemId)).handlerId).toBe("h1");
  });

  test("settled work cannot be claimed again", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "completed",
      },
      at(2),
    );
    expect(() =>
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h2" },
        at(3),
      ),
    ).toThrow(MailItemNotClaimableError);
  });

  test("a non-owner cannot settle another handler's live lease", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "owner" },
      at(1),
    );
    expect(() =>
      hiveMailComplete(
        mail,
        ADA,
        {
          recipient: "ada",
          itemId: receipt.itemId,
          handlerId: "impostor",
          disposition: "completed",
        },
        at(2),
      ),
    ).toThrow(MailLeaseNotHeldError);
    expect(required(mail.store.getItem(receipt.itemId)).state).toBe("leased");
  });

  test("a settlement from a different generation than the lease is refused", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    expect(() =>
      hiveMailComplete(
        mail,
        { subject: "ada", agentGeneration: 5 },
        {
          recipient: "ada",
          itemId: receipt.itemId,
          handlerId: "h1",
          disposition: "completed",
        },
        at(2),
      ),
    ).toThrow(MailLeaseNotHeldError);
    expect(required(mail.store.getItem(receipt.itemId)).state).toBe("leased");
  });
});

describe("deferral", () => {
  test("a deferred item is held back until its retry window passes", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    const deferred = hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "deferred",
        reason: "waiting on a lock",
      },
      at(2),
    );
    expect(deferred.reason).toBe("waiting on a lock");
    expect(required(mail.store.getItem(receipt.itemId)).state).toBe(
      "available",
    );
    expect(hiveMailPoll(mail, ADA, { recipient: "ada" }, at(3)).control).toBe(
      null,
    );
    expect(() =>
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h2" },
        at(3),
      ),
    ).toThrow(MailItemNotClaimableError);
    const ready = at(MAIL_DEFERRAL_SECONDS + 5);
    expect(
      required(hiveMailPoll(mail, ADA, { recipient: "ada" }, ready).control)
        .itemId,
    ).toBe(receipt.itemId);
    expect(
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h2" },
        ready,
      ).attempt,
    ).toBe(2);
  });

  test("a caller may name its own retry window", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "deferred",
        retryAfterSeconds: 10,
      },
      at(2),
    );
    expect(hiveMailPoll(mail, ADA, { recipient: "ada" }, at(5)).control).toBe(
      null,
    );
    expect(
      hiveMailPoll(mail, ADA, { recipient: "ada" }, at(20)).control,
    ).not.toBeNull();
  });

  test("a deferral replays instead of spending a second attempt", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    const first = hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "deferred",
      },
      at(2),
    );
    const replay = hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "deferred",
      },
      at(3),
    );
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(required(mail.store.getItem(receipt.itemId)).attempts).toBe(1);
  });
});

describe("dead letters", () => {
  test("bounded attempts quarantine a poison item while unrelated mail continues", () => {
    const mail = store();
    const poison = hiveMailPublish(mail, QUEEN, control(), T0);
    const healthy = hiveMailPublish(mail, WORKER, work(), at(1));
    let second = 2;
    for (let attempt = 1; attempt <= MAIL_MAX_ATTEMPTS; attempt += 1) {
      claimThenCrash(mail, poison.itemId, `crasher-${attempt}`, second);
      second += MAIL_LEASE_SECONDS + 2;
    }
    const letter = required(mail.store.listDeadLetters("ada")[0]);
    expect(letter.reason).toBe("attempts-exhausted");
    expect(letter.item.attempts).toBe(MAIL_MAX_ATTEMPTS);
    expect(letter.item.itemId).toBe(poison.itemId);
    expect(letter.item.sender).toBe("queen");
    expect(mail.store.getItem(poison.itemId)).toBeNull();
    expect(
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: healthy.itemId, handlerId: "healthy" },
        at(second),
      ).itemId,
    ).toBe(healthy.itemId);
  });

  test("the dead letter journal names the key its sender still holds", () => {
    const mail = store();
    const poison = hiveMailPublish(mail, QUEEN, control(), T0);
    let second = 1;
    for (let attempt = 1; attempt <= MAIL_MAX_ATTEMPTS; attempt += 1) {
      claimThenCrash(mail, poison.itemId, `crasher-${attempt}`, second);
      second += MAIL_LEASE_SECONDS + 2;
    }
    const quarantine = required(
      mail.store
        .listEvents(poison.itemId)
        .find((e) => e.kind === "dead-lettered"),
    );
    expect(JSON.parse(quarantine.detailJson)).toMatchObject({
      reason: "attempts-exhausted",
      sender: "queen",
      idempotencyKey: "queen-1",
    });
  });

  test("a message addressed to a superseded generation is refused and quarantined", () => {
    const mail = store();
    const stale = hiveMailPublish(
      mail,
      QUEEN,
      control({ addressedGeneration: 3 }),
      T0,
    );
    const current = hiveMailPublish(
      mail,
      QUEEN,
      control({ idempotencyKey: "queen-2", addressedGeneration: 4 }),
      at(1),
    );
    expect(() =>
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: stale.itemId, handlerId: "h1" },
        at(2),
      ),
    ).toThrow(MailGenerationMismatchError);
    const letter = required(mail.store.listDeadLetters("ada")[0]);
    expect(letter.reason).toBe("expired-task-generation");
    expect(letter.item.recipientGeneration).toBe(3);
    expect(mail.store.getItem(stale.itemId)).toBeNull();
    expect(
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: current.itemId, handlerId: "h2" },
        at(3),
      ).ownerGeneration,
    ).toBe(4);
  });

  test("an unaddressed message may be claimed by any generation", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    expect(
      hiveMailClaim(
        mail,
        { subject: "ada", agentGeneration: 9 },
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
        at(1),
      ).ownerGeneration,
    ).toBe(9);
    expect(mail.store.listDeadLetters("ada")).toEqual([]);
  });

  test("a rejected item is quarantined with the handler's reason", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    hiveMailComplete(
      mail,
      ADA,
      {
        recipient: "ada",
        itemId: receipt.itemId,
        handlerId: "h1",
        disposition: "rejected",
        reason: "not mine to do",
      },
      at(2),
    );
    const letter = required(mail.store.listDeadLetters("ada")[0]);
    expect(letter.reason).toBe("rejected: not mine to do");
    expect(mail.store.getItem(receipt.itemId)).toBeNull();
  });

  test("an item whose TTL passes is quarantined rather than delivered", () => {
    const mail = store();
    const expiring = hiveMailPublish(
      mail,
      QUEEN,
      control({ ttlSeconds: 60 }),
      T0,
    );
    const durable = hiveMailPublish(
      mail,
      QUEEN,
      control({ idempotencyKey: "queen-2" }),
      at(1),
    );
    sweepMailDeadlines(mail.store, at(120));
    expect(mail.store.getItem(expiring.itemId)).toBeNull();
    expect(required(mail.store.listDeadLetters("ada")[0]).reason).toBe(
      "ttl-expired",
    );
    expect(
      required(hiveMailPoll(mail, ADA, { recipient: "ada" }, at(121)).control)
        .itemId,
    ).toBe(durable.itemId);
  });

  test("a TTL that lapses while leased releases the lease before quarantine", () => {
    const mail = store();
    const receipt = hiveMailPublish(
      mail,
      QUEEN,
      control({ ttlSeconds: 60 }),
      T0,
    );
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    sweepMailDeadlines(mail.store, at(MAIL_LEASE_SECONDS + 5));
    expect(mail.store.getItem(receipt.itemId)).toBeNull();
    expect(mail.store.getLease(receipt.itemId)).toBeNull();
    expect(required(mail.store.listDeadLetters("ada")[0]).reason).toBe(
      "ttl-expired",
    );
  });
});

describe("hive_mail_status", () => {
  test("reports counts, age, lease expiry and DLQ summary without changing them", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailPublish(mail, WORKER, work(), at(1));
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(2),
    );
    const status = hiveMailStatus(
      mail,
      ADA,
      { recipient: "ada" },
      at(MAIL_LEASE_SECONDS + 60),
    );
    expect(status.lanes.control).toEqual({
      available: 0,
      leased: 1,
      leasedExpired: 1,
    });
    expect(status.lanes.work).toEqual({
      available: 1,
      leased: 0,
      leasedExpired: 0,
    });
    expect(required(status.leases[0]).expired).toBe(true);
    expect(required(status.oldestAvailable).topic).toBe("progress");
    expect(status.deadLetters.total).toBe(0);
    // The read reported a lapsed lease; it must not have swept it.
    expect(required(mail.store.getItem(receipt.itemId)).state).toBe("leased");
    expect(mail.store.getLease(receipt.itemId)).not.toBeNull();
  });

  test("mail left unpolled stays durable and visible, and the next poll returns it", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    const later = at(7 * 24 * 60 * 60);
    const status = hiveMailStatus(mail, ADA, { recipient: "ada" }, later);
    expect(status.lanes.control.available).toBe(1);
    expect(required(status.oldestAvailable).ageSeconds).toBe(7 * 24 * 60 * 60);
    expect(
      required(hiveMailPoll(mail, ADA, { recipient: "ada" }, later).control)
        .itemId,
    ).toBe(receipt.itemId);
  });

  test("summarises dead letters by reason", () => {
    const mail = store();
    for (const index of [0, 1, 2]) {
      hiveMailPublish(
        mail,
        WORKER,
        work({
          idempotencyKey: `w-${index}`,
          topic: `stage.${index}`,
          ttlSeconds: 60,
        }),
        T0,
      );
    }
    sweepMailDeadlines(mail.store, at(200));
    const status = hiveMailStatus(mail, ADA, { recipient: "ada" }, at(201));
    expect(status.deadLetters.total).toBe(3);
    expect(status.deadLetters.byReason).toEqual({ "ttl-expired": 3 });
    expect(status.deadLetters.recent).toHaveLength(3);
  });

  test("refuses to report on another agent's mailbox", () => {
    const mail = store();
    expect(() =>
      hiveMailStatus(mail, WORKER, { recipient: "ada" }, T0),
    ).toThrow(MailForeignSubjectError);
  });
});

describe("capability binding", () => {
  test("poll refuses a caller acting on another subject's mailbox", () => {
    const mail = store();
    expect(() => hiveMailPoll(mail, WORKER, { recipient: "ada" }, T0)).toThrow(
      MailForeignSubjectError,
    );
  });

  test("claim refuses a caller acting on another subject's mailbox", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    expect(() =>
      hiveMailClaim(
        mail,
        WORKER,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
        at(1),
      ),
    ).toThrow(MailForeignSubjectError);
  });

  test("complete refuses a caller acting on another subject's mailbox", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control(), T0);
    hiveMailClaim(
      mail,
      ADA,
      { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
      at(1),
    );
    expect(() =>
      hiveMailComplete(
        mail,
        WORKER,
        {
          recipient: "ada",
          itemId: receipt.itemId,
          handlerId: "h1",
          disposition: "completed",
        },
        at(2),
      ),
    ).toThrow(MailForeignSubjectError);
    expect(required(mail.store.getItem(receipt.itemId)).state).toBe("leased");
  });

  test("a claim on an item addressed to a different recipient is refused", () => {
    const mail = store();
    const receipt = hiveMailPublish(mail, QUEEN, control({ to: "bo" }), T0);
    expect(() =>
      hiveMailClaim(
        mail,
        ADA,
        { recipient: "ada", itemId: receipt.itemId, handlerId: "h1" },
        at(1),
      ),
    ).toThrow(MailForeignSubjectError);
  });
});

describe("what the daemon's own senders may occupy", () => {
  test("routine notices never take the control lane's one offer slot", () => {
    const deps = store();
    // An approvals resolution reports that something was granted; the agent
    // learns it by retrying, not by handling the notice. Routed to control it
    // held the single offer slot, and a queen instruction sat behind a stack of
    // notices nobody needed to act on — 22 minutes, measured, behind a grant
    // that had already been consumed.
    for (const index of [1, 2, 3]) {
      hiveMailPublish(
        deps,
        { subject: "worker", agentGeneration: 1 },
        work({
          from: "worker",
          topic: "approvals",
          body: `re-arm granted (${index})`,
          idempotencyKey: `approvals-${index}`,
        }),
        at(index),
      );
    }
    hiveMailPublish(deps, QUEEN, control({ body: "your next mission" }), at(9));

    const polled = hiveMailPoll(deps, ADA, { recipient: "ada" }, at(10));
    // The instruction is offered first try, with the notices alongside it as a
    // digest rather than in front of it.
    expect(polled.control?.body).toBe("your next mission");
    expect(polled.backlog.controlAvailable).toBe(1);
  });

  test("the same notices on the control lane are what bury it", () => {
    const deps = store();
    // The negative control for the row above: identical traffic, wrong lane.
    // Without this the test could pass because the poll works, not because the
    // routing changed.
    for (const index of [1, 2, 3]) {
      hiveMailPublish(
        deps,
        { subject: "queen", agentGeneration: 1 },
        control({
          topic: "approvals",
          body: `re-arm granted (${index})`,
          idempotencyKey: `approvals-${index}`,
        }),
        at(index),
      );
    }
    hiveMailPublish(
      deps,
      QUEEN,
      control({ body: "your next mission", idempotencyKey: "queen-mission" }),
      at(9),
    );

    const polled = hiveMailPoll(deps, ADA, { recipient: "ada" }, at(10));
    expect(polled.control?.body).toBe("re-arm granted (1)");
    expect(polled.backlog.controlAvailable).toBe(4);
  });
});

describe("diagnostics must not become the congestion they report", () => {
  test("repeated latency readings collapse to one current row", () => {
    const deps = store();
    // On the control lane this produced one item per aged mailbox per sweep,
    // faster than one-at-a-time settling could clear them: notices about queue
    // depth adding queue depth. Coalescing is the shape a re-derived reading
    // wants — the newest is the only one worth reading.
    for (const index of [1, 2, 3, 4, 5]) {
      hiveMailPublish(
        deps,
        { subject: "worker", agentGeneration: 1 },
        work({
          from: "worker",
          topic: "mail-latency",
          body: `oldest control message waiting since t${index}`,
          idempotencyKey: `mail-slo-${index}`,
        }),
        at(index),
      );
    }
    hiveMailPublish(deps, QUEEN, control({ body: "your next mission" }), at(9));

    const polled = hiveMailPoll(deps, ADA, { recipient: "ada" }, at(10));
    expect(polled.control?.body).toBe("your next mission");
    expect(polled.workDigest).toHaveLength(1);
    expect(required(polled.workDigest[0]).mergedCount).toBe(4);
    expect(polled.backlog.controlAvailable).toBe(1);
  });

  test("a dead letter is not something a later notice may merge away", () => {
    const deps = store();
    // The one case where one-at-a-time is the point: the message is gone and
    // nobody will ever be told again, so a second dead letter absorbing the
    // first would erase it permanently. Two publishes, two offers.
    for (const index of [1, 2]) {
      hiveMailPublish(
        deps,
        QUEEN,
        control({
          topic: "mail",
          body: `Mail dead-lettered: mit_${index}`,
          idempotencyKey: `mail-dlq-${index}`,
        }),
        at(index),
      );
    }
    expect(
      hiveMailPoll(deps, ADA, { recipient: "ada" }, at(3)).backlog
        .controlAvailable,
    ).toBe(2);
  });
});
