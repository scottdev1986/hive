import { createHash } from "node:crypto";
import { z } from "zod";
import { MailLaneSchema } from "./mail";
import { Rfc3339UtcMillisecondsSchema } from "./primitives";

/** The wake contract between the daemon's mailbox and a recipient's frontend. Nothing here carries a message body. The mailbox stays the only channel that can move one, so a frontend that learns "you have mail" still has to poll through the recipient's own capability to read it. That is what keeps the existing ACL intact: the notification says a count and an id, never content. */

/** How long a live frontend has to acknowledge before the wake is unobserved. */
export const MAIL_FRONTEND_SILENT_BREACH_SECONDS = 60;
/** How long a control item may sit unclaimed before the delay is an alert. */
export const MAIL_CONTROL_CLAIM_SLO_SECONDS = 30;
export const MAIL_INCIDENT_SECONDS = 600;
/** Wake attempts before the item is quarantined instead of retried forever. */
export const MAIL_WAKE_MAX_ATTEMPTS = 5;
/** Total wakes one unclaimed item may cost a recipient, whatever arrives behind it. Nothing a sender does resets this. Attempts alone cannot be the circuit breaker. An announcement names the lane's oldest available item, so mail arriving behind an item nobody claims renews that item's budget without changing what the wake says — and a recipient that is silently failing would be interrupted once per publish forever, always about the same item, always with the same prompt. This bounds the interruptions to one stuck item and resets only when the item does, because the wake id is derived from it. */
export const MAIL_WAKE_MAX_DISPATCHES = MAIL_WAKE_MAX_ATTEMPTS * 4;
export const MAIL_WAKE_BACKOFF_BASE_SECONDS = 2;
export const MAIL_WAKE_BACKOFF_MAX_SECONDS = 120;

export const MailReadyEventSchema = z.strictObject({
  kind: z.literal("mail-ready"),
  schemaVersion: z.literal(1),
  recipient: z.string().min(1),
  lane: MailLaneSchema,
  oldestItemId: z.string().min(1),
  backlogCount: z.number().int().min(1),
  brokerSeq: z.number().int().min(1),
  cursor: z.number().int().min(1),
  at: Rfc3339UtcMillisecondsSchema,
});
export type MailReadyEvent = z.infer<typeof MailReadyEventSchema>;

export type MailReadyNotice = Omit<
  MailReadyEvent,
  "kind" | "schemaVersion" | "at"
> & { readonly wakeId: string };

export const MailReadyResponseSchema = z.strictObject({
  recipient: z.string().min(1),
  events: z.array(MailReadyEventSchema),
});

export const MailSubscribeRequestSchema = z.strictObject({
  kind: z.literal("mail-subscribe"),
  schemaVersion: z.literal(1),
  recipient: z.string().min(1),
  /** Where to resume. Absent means "from now"; 0 means "everything retained". Only the notification's own cursor works here. Resuming on the mailbox sequence cannot see a second announcement about a sequence already acknowledged, so offering it as an alternative would offer a way to keep the hole this closed. */
  sinceCursor: z.number().int().min(0).nullable().default(null),
});
export type MailSubscribeRequest = z.infer<typeof MailSubscribeRequestSchema>;

export const MailReadyAckSchema = z.strictObject({
  kind: z.literal("mail-ready-ack"),
  schemaVersion: z.literal(1),
  recipient: z.string().min(1),
  /** Identifies the exact notification the frontend received. Mailbox sequence
   * cannot do this: a later notification may legitimately name an older item. */
  cursor: z.number().int().min(1),
  brokerSeq: z.number().int().min(1),
  at: Rfc3339UtcMillisecondsSchema,
});

/** The wake's identity, derived rather than minted. Both sides compute it from the same three facts, so a duplicated mail-ready produces the same id on the daemon and in the frontend with no round trip and no counter that can drift. Idempotency stops being a protocol agreement and becomes arithmetic. */
export function deriveWakeId(
  recipient: string,
  lane: z.infer<typeof MailLaneSchema>,
  oldestItemId: string,
): string {
  return createHash("sha256")
    .update([recipient, lane, oldestItemId].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

export const FrontendWakeReportSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("wake-queued"),
    schemaVersion: z.literal(1),
    wakeId: z.string().min(1),
    recipient: z.string().min(1),
    lane: MailLaneSchema,
    oldestItemId: z.string().min(1),
    at: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({
    kind: z.literal("wake-request-accepted"),
    schemaVersion: z.literal(1),
    wakeId: z.string().min(1),
    clientInputId: z.string().min(1),
    at: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({
    kind: z.literal("wake-turn-observed"),
    schemaVersion: z.literal(1),
    wakeId: z.string().min(1),
    clientInputId: z.string().min(1),
    vendorSessionId: z.string().min(1),
    eventSequence: z.number().int().min(1),
    turnId: z.string().min(1),
    /** What the turn event itself echoed back, when the vendor echoes anything. Null is unknown correlation, not a denial — a vendor that omits the field has said nothing about whose submission this turn belongs to. A value that disagrees is a denial, and the ledger refuses it. */
    turnClientInputId: z.string().min(1).nullable(),
    at: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({
    kind: z.literal("wake-delivery-unknown"),
    schemaVersion: z.literal(1),
    wakeId: z.string().min(1),
    clientInputId: z.string().min(1),
    at: Rfc3339UtcMillisecondsSchema,
  }),
  z.strictObject({
    kind: z.literal("wake-failed"),
    schemaVersion: z.literal(1),
    wakeId: z.string().min(1),
    reason: z.string().min(1).max(280),
    at: Rfc3339UtcMillisecondsSchema,
  }),
]);
export type FrontendWakeReport = z.infer<typeof FrontendWakeReportSchema>;

/** Every state a mail item can be observed in on its way to a model. The order is the happy path. `delivery_unknown` is deliberately not on it: it belongs to a user submission whose acknowledgement was lost, and it is never retried automatically because a duplicated user prompt is its own kind of interference. */
export const MAIL_DELIVERY_STATES = [
  "published",
  "frontend_notified",
  "wake_queued",
  "vendor_request_accepted",
  "turn_observed",
  "mail_presented",
  "mail_claimed",
  "completed",
  "deferred",
  "rejected",
  "retrying",
  "dead_lettered",
  "delivery_unknown",
] as const;
export const MailDeliveryStateSchema = z.enum(MAIL_DELIVERY_STATES);
export type MailDeliveryState = z.infer<typeof MailDeliveryStateSchema>;

/** The broker or protocol row that has to exist for a transition to be written. */
export const MAIL_EVIDENCE_KINDS = [
  "broker-publish-receipt",
  "frontend-ack",
  "wake-row",
  "protocol-response",
  "turn-lifecycle-event",
  "poll-response",
  "broker-lease",
  "broker-settlement",
  "broker-dead-letter",
  "wake-policy-exhausted",
  "ambiguous-submit",
] as const;
export const MailEvidenceKindSchema = z.enum(MAIL_EVIDENCE_KINDS);
export type MailEvidenceKind = z.infer<typeof MailEvidenceKindSchema>;

/** The mail dimension of an agent's status; absent stays absent, never "none". */
export const MAIL_STATUS_STATES = [
  "none",
  "waiting",
  "waking",
  "claimed",
  "retrying",
  "dead_lettered",
] as const;
export const MailStatusStateSchema = z.enum(MAIL_STATUS_STATES);
export type MailStatusState = z.infer<typeof MailStatusStateSchema>;
