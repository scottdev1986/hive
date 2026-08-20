import { z } from "zod";
import { Rfc3339UtcMillisecondsSchema } from "./primitives";

/** The largest envelope body the broker will accept. */
export const MAIL_BODY_MAX_BYTES = 256 * 1_024;
export const MAIL_TOPIC_MAX_LENGTH = 64;
export const MAIL_REASON_MAX_LENGTH = 280;
export const MAIL_HANDLER_ID_MAX_LENGTH = 128;
export const MAIL_CONTROL_LANE_CAPACITY = 64;
export const MAIL_MAX_ATTEMPTS = 5;
export const MAIL_WORK_DIGEST_MAX = 32;
export const MAIL_LEASE_SECONDS = 120;
export const MAIL_DEFERRAL_SECONDS = 120;
export const MAIL_RETRY_AFTER_MAX_SECONDS = 60 * 60;
export const MAIL_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
export const MAIL_CONDITION_ID_MAX_LENGTH = 128;
export const MAIL_CONDITION_MAX_BYTES = 4_096;

export const MailLaneSchema = z.enum(["control", "work"]);
export type MailLane = z.infer<typeof MailLaneSchema>;

export const MailDispositionSchema = z.enum([
  "completed",
  "deferred",
  "rejected",
]);
export type MailDisposition = z.infer<typeof MailDispositionSchema>;

export const MailItemStateSchema = z.enum(["available", "leased"]);

export const MailEventKindSchema = z.enum([
  "published",
  "coalesced",
  "restated",
  "claimed",
  "lease-renewed",
  "lease-expired",
  "completed",
  "deferred",
  "rejected",
  "dead-lettered",
  // The one-time move of the pre-mailbox `messages` table. Distinct from `published` so an item that was never published through the broker can be told apart from one that was.
  "migrated",
]);
export type MailEventKind = z.infer<typeof MailEventKindSchema>;

const isoTimestamp = Rfc3339UtcMillisecondsSchema;

export const MailItemSchema = z.strictObject({
  itemId: z.string(),
  recipient: z.string(),
  sender: z.string(),
  lane: MailLaneSchema,
  topic: z.string(),
  body: z.string(),
  seq: z.number().int(),
  state: MailItemStateSchema,
  mergedCount: z.number().int(),
  attempts: z.number().int(),
  recipientGeneration: z.number().int().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  expiresAt: isoTimestamp.nullable(),
  notBefore: isoTimestamp.nullable(),
});
export type MailItem = z.infer<typeof MailItemSchema>;

export const MailEventSchema = z.strictObject({
  eventId: z.string(),
  itemId: z.string(),
  kind: MailEventKindSchema,
  actor: z.string(),
  actorGeneration: z.number().int().nullable(),
  idempotencyKey: z.string().nullable(),
  fingerprint: z.string().nullable(),
  at: isoTimestamp,
  detailJson: z.string(),
});
export type MailEvent = z.infer<typeof MailEventSchema>;

export const MailDeadLetterSchema = z.strictObject({
  itemId: z.string(),
  recipient: z.string(),
  reason: z.string(),
  quarantinedAt: isoTimestamp,
  item: MailItemSchema,
});
export type MailDeadLetter = z.infer<typeof MailDeadLetterSchema>;

export const MailLeaseSchema = z.strictObject({
  itemId: z.string(),
  owner: z.string(),
  ownerGeneration: z.number().int(),
  handlerId: z.string(),
  claimedAt: isoTimestamp,
  leaseUntil: isoTimestamp,
});
export type MailLease = z.infer<typeof MailLeaseSchema>;

const TopicSchema = z
  .string()
  .min(1)
  .max(MAIL_TOPIC_MAX_LENGTH)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "a topic is lowercase alphanumerics with . _ -",
  );

/** How long a control message may wait, past an observed safe point, before the mailbox says so. Long enough that an agent working through a unit of work is not reported for it. */
export const MAIL_SLO_BREACH_SECONDS = 600;

const MailPublishFields = {
  from: z.string().min(1),
  to: z.string().min(1),
  lane: MailLaneSchema,
  topic: TopicSchema.default("general"),
  body: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
  /**
   * Identity the sender asserts about the standing fact this envelope reports.
   * Pair with `condition`. The mailbox uses this pair, not the body bytes, to
   * decide whether an already-adjudicated fact should interrupt again.
   */
  conditionId: z
    .string()
    .min(1)
    .max(MAIL_CONDITION_ID_MAX_LENGTH)
    .regex(
      /^[a-z0-9][a-z0-9._:-]*$/,
      "a condition id is lowercase alphanumerics with . _ : -",
    )
    .nullable()
    .default(null),
  /** Decision-relevant snapshot for `conditionId`. Incidental detail belongs in the body. */
  condition: z
    .string()
    .min(1)
    .max(MAIL_CONDITION_MAX_BYTES)
    .nullable()
    .default(null),
} as const;

const requirePairedCondition = (
  value: { conditionId: string | null; condition: string | null },
  context: z.RefinementCtx,
): void => {
  if ((value.conditionId === null) !== (value.condition === null)) {
    context.addIssue({
      code: "custom",
      message: "conditionId and condition must be sent together",
    });
  }
};

export const MailPublishRequestSchema = z
  .strictObject({
    ...MailPublishFields,
    /** The recipient incarnation this envelope is for; control lane only. Null — the default — means any generation and is the right stamp for almost everything: a generation can advance between publish and claim, so a pinned value races the recipient's restarts. A pin the daemon can already see is stale is refused at publish rather than accepted and quarantined at claim. */
    addressedGeneration: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null)
      .describe(
        "The recipient mailbox incarnation, not the sender's assignment or hierarchy generation. Omit for normal delivery to any live incarnation.",
      ),
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAIL_TTL_MAX_SECONDS)
      .nullable()
      .default(null),
  })
  .superRefine(requirePairedCondition);

/** Agent mail follows names across restarts. Only root callers receive the
 * exceptional generation-pinning field in their advertised tool contract. */
export const AgentMailPublishRequestSchema = z
  .strictObject({
    ...MailPublishFields,
    ttlSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAIL_TTL_MAX_SECONDS)
      .nullable()
      .default(null),
  })
  .superRefine(requirePairedCondition);

export const MailPollRequestSchema = z.strictObject({
  recipient: z.string().min(1),
  cursor: z.number().int().nonnegative().nullable().default(null),
  workDigestLimit: z
    .number()
    .int()
    .min(0)
    .max(MAIL_WORK_DIGEST_MAX)
    .default(MAIL_WORK_DIGEST_MAX),
});

export const MailClaimRequestSchema = z.strictObject({
  recipient: z.string().min(1),
  itemId: z.string().min(1),
  handlerId: z.string().min(1).max(MAIL_HANDLER_ID_MAX_LENGTH),
});

const MailCompleteRequestShape = {
  recipient: z.string().min(1),
  itemId: z.string().min(1),
  handlerId: z.string().min(1).max(MAIL_HANDLER_ID_MAX_LENGTH),
  reason: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .transform((value) =>
      value === null ? null : value.slice(0, MAIL_REASON_MAX_LENGTH),
    ),
} as const;

export const MailCompleteRequestSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    ...MailCompleteRequestShape,
    disposition: z.literal("completed"),
  }),
  z.strictObject({
    ...MailCompleteRequestShape,
    disposition: z.literal("rejected"),
  }),
  z.strictObject({
    ...MailCompleteRequestShape,
    disposition: z.literal("deferred"),
    retryAfterSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAIL_RETRY_AFTER_MAX_SECONDS)
      .default(MAIL_DEFERRAL_SECONDS),
  }),
]);

export const MailStatusRequestSchema = z.strictObject({
  recipient: z.string().min(1),
});

export const MailPublishReceiptSchema = z.strictObject({
  itemId: z.string(),
  lane: MailLaneSchema,
  topic: z.string(),
  outcome: z.enum(["published", "coalesced", "restated"]),
  seq: z.number().int(),
  mergedCount: z.number().int(),
  acceptedAt: isoTimestamp,
});
export type MailPublishReceipt = z.infer<typeof MailPublishReceiptSchema>;

/** One line per pending work item: enough to decide whether to claim it, and deliberately not the payload. A poll that inlined bodies would make an agent's attention budget a function of how noisy its senders were. */
export const MailWorkDigestEntrySchema = z.strictObject({
  itemId: z.string(),
  sender: z.string(),
  topic: z.string(),
  mergedCount: z.number().int(),
  seq: z.number().int(),
  bodyBytes: z.number().int(),
  updatedAt: isoTimestamp,
});

/** The attention budget of one safe point, as a value. The digest bound is on the schema rather than only in the query, so a future caller that forgets to pass a limit fails here instead of handing an agent an unbounded batch. */
export const MailPollResultSchema = z.strictObject({
  recipient: z.string(),
  control: z
    .strictObject({
      itemId: z.string(),
      sender: z.string(),
      topic: z.string(),
      addressedGeneration: z.number().int().nullable(),
      seq: z.number().int(),
      attempts: z.number().int(),
      body: z.string(),
    })
    .nullable(),
  workDigest: z.array(MailWorkDigestEntrySchema).max(MAIL_WORK_DIGEST_MAX),
  cursor: z.number().int().nullable(),
  backlog: z.strictObject({
    controlAvailable: z.number().int(),
    controlLeased: z.number().int(),
    workAvailable: z.number().int(),
    workLeased: z.number().int(),
    deadLettered: z.number().int(),
  }),
});
export type MailPollResult = z.infer<typeof MailPollResultSchema>;

export const MailClaimReceiptSchema = z.strictObject({
  itemId: z.string(),
  handlerId: z.string(),
  ownerGeneration: z.number().int(),
  attempt: z.number().int(),
  leaseUntil: isoTimestamp,
  lane: MailLaneSchema,
  topic: z.string(),
  sender: z.string(),
  body: z.string(),
});
export type MailClaimReceipt = z.infer<typeof MailClaimReceiptSchema>;

export const MailCompleteReceiptSchema = z.strictObject({
  itemId: z.string(),
  disposition: MailDispositionSchema,
  reason: z.string().nullable(),
  attempt: z.number().int(),
  settledAt: isoTimestamp,
  replayed: z.boolean(),
});
export type MailCompleteReceipt = z.infer<typeof MailCompleteReceiptSchema>;

const MailLaneStatusSchema = z.strictObject({
  available: z.number().int(),
  leased: z.number().int(),
  leasedExpired: z.number().int(),
});

export const MailStatusResultSchema = z.strictObject({
  recipient: z.string(),
  observedAt: isoTimestamp,
  lanes: z.strictObject({
    control: MailLaneStatusSchema,
    work: MailLaneStatusSchema,
  }),
  oldestAvailable: z
    .strictObject({
      itemId: z.string(),
      lane: MailLaneSchema,
      topic: z.string(),
      ageSeconds: z.number().int(),
    })
    .nullable(),
  leases: z.array(
    z.strictObject({
      itemId: z.string(),
      handlerId: z.string(),
      ownerGeneration: z.number().int(),
      leaseUntil: isoTimestamp,
      expired: z.boolean(),
    }),
  ),
  deadLetters: z.strictObject({
    total: z.number().int(),
    byReason: z.record(z.string(), z.number().int()),
    recent: z.array(
      z.strictObject({
        itemId: z.string(),
        reason: z.string(),
        quarantinedAt: isoTimestamp,
      }),
    ),
  }),
});
export type MailStatusResult = z.infer<typeof MailStatusResultSchema>;
