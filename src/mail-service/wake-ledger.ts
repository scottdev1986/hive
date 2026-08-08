import { canonicalOrchestratorName } from "../schemas/agent";
import type { MailDisposition, MailLane } from "../schemas/mail";
import {
  deriveWakeId,
  type FrontendWakeReport,
  MAIL_CONTROL_CLAIM_SLO_SECONDS,
  MAIL_FRONTEND_SILENT_BREACH_SECONDS,
  MAIL_INCIDENT_SECONDS,
  MAIL_WAKE_BACKOFF_BASE_SECONDS,
  MAIL_WAKE_BACKOFF_MAX_SECONDS,
  MAIL_WAKE_MAX_ATTEMPTS,
  type MailDeliveryState,
  type MailEvidenceKind,
  type MailReadyEvent,
  type MailStatusState,
  type MailSubscribeRequest,
} from "../schemas/mail-wake";
import type { MailDeliveryRow, MailWakeRow, MailWakeStore } from "./wake-store";

export const MAIL_EVIDENCE_MISSING = "MAIL_EVIDENCE_MISSING";

/** The delivery state machine and wake scheduler. Two rules shape everything here. A transition is only written from the row that proves it, so the projection can never claim a delivery that did not happen. And the mailbox stays authoritative: this ledger observes publishes, polls, leases and settlements — it never moves a body and never decides who may read one. */

export class MailWakeAclError extends Error {
  readonly code = "MAIL_WAKE_ACL";

  constructor(subject: string, recipient: string) {
    super(
      `MAIL_WAKE_ACL: ${subject} may not subscribe to ${recipient}'s mailbox`,
    );
    this.name = "MailWakeAclError";
  }
}

export class MailEvidenceError extends Error {
  constructor(
    readonly itemId: string,
    readonly state: MailDeliveryState,
    detail: string,
  ) {
    super(`${MAIL_EVIDENCE_MISSING}: ${state} for ${itemId}: ${detail}`);
    this.name = "MailEvidenceError";
  }
}

export type MailLatency = Readonly<{
  itemId: string;
  lane: MailLane | null;
  publishedAt: string;
  frontendNotifiedMs: number | null;
  requestAcceptedMs: number | null;
  turnObservedMs: number | null;
  claimedMs: number | null;
  settledMs: number | null;
}>;

export type MailSloBreachKind =
  | "no-live-frontend"
  | "control-claim-slo"
  | "mail-incident";

export type MailSloBreach = Readonly<{
  kind: MailSloBreachKind;
  itemId: string;
  recipient: string;
  lane: MailLane | null;
  ageSeconds: number;
  thresholdSeconds: number;
  detail: string;
  destinations: readonly ["workspace-attention", "queen-feed"];
}>;

const EXTERNAL_DESTINATIONS = [
  "workspace-attention",
  "queen-feed",
] as const satisfies MailSloBreach["destinations"];

export type WakeSchedule =
  | Readonly<{ kind: "submit"; wake: MailWakeRow; priority: 2 | 4 }>
  | Readonly<{ kind: "defer"; wake: MailWakeRow; reason: "turn-active" }>
  | Readonly<{ kind: "wait"; wake: MailWakeRow; readyAt: string }>
  | Readonly<{ kind: "idle" }>;

const PREREQUISITES: Partial<
  Record<MailDeliveryState, readonly MailDeliveryState[]>
> = {
  frontend_notified: ["published"],
  wake_queued: ["frontend_notified"],
  vendor_request_accepted: ["wake_queued"],
  turn_observed: ["vendor_request_accepted"],
  mail_presented: ["published"],
  mail_claimed: ["mail_presented"],
  completed: ["mail_claimed"],
  deferred: ["mail_claimed"],
  rejected: ["mail_claimed"],
  retrying: ["wake_queued"],
};

const seconds = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / 1_000;

const plusSeconds = (at: string, delta: number): string =>
  new Date(Date.parse(at) + delta * 1_000).toISOString();

const backoffSeconds = (attempts: number): number =>
  Math.min(
    MAIL_WAKE_BACKOFF_MAX_SECONDS,
    MAIL_WAKE_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1),
  );

/** Told the recipient's mail state whenever it changes. The daemon measures this dimension for every vendor — the broker knows what it accepted, leased and settled regardless of what a provider reports — so publishing it is what keeps `mail` from reading as unmeasured on a surface that has no business being uncertain about it. */
export type MailStatusSink = (
  recipient: string,
  state: MailStatusState,
  at: string,
) => void;

/** Told that a wake ran out of attempts and nobody will be woken for that item. The ledger raises the fact and does not act on it: it observes deliveries and never moves a body, so who is told and over which lane belongs to the daemon. */
export type MailWakeExhaustedSink = (
  input: Readonly<{
    wakeId: string;
    recipient: string;
    lane: MailLane;
    oldestItemId: string;
    attempts: number;
    at: string;
  }>,
) => void;

export type MailWakeDeliverable = (itemId: string) => boolean;

export class MailWakeLedger {
  constructor(
    private readonly store: MailWakeStore,
    private readonly publishStatus: MailStatusSink = () => undefined,
    private readonly announceExhausted: MailWakeExhaustedSink = () => undefined,
    private readonly isDeliverable: MailWakeDeliverable = () => true,
  ) {}

  /** Emits this recipient's mail state after something moved it. Called at the end of every transition rather than by each one, so a new transition cannot forget to report and leave the surface stale. A failure to publish is logged, never thrown: a status update that could roll back a proven delivery would be worse than a status update that was missed. */
  private announceStatus(recipient: string, at: string): void {
    const state = this.mailStatus(recipient);
    if (state === null) return;
    try {
      this.publishStatus(recipient, state, at);
    } catch (error) {
      console.error(
        `Hive could not publish the mail status for ${recipient}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  /** Files the notification a committed publish earns, and the `published` row. The event carries a count and an id. It never carries the body, so a frontend that receives one still has to poll through the recipient's own mailbox capability to learn what the message says. */
  publishReady(
    input: Readonly<{
      recipient: string;
      lane: MailLane;
      oldestItemId: string;
      backlogCount: number;
      brokerSeq: number;
      publishedItemId: string;
      at: string;
    }>,
  ): MailReadyEvent {
    const event = this.store.transaction(() => {
      const ready = this.store.recordReady({
        kind: "mail-ready",
        schemaVersion: 1,
        recipient: input.recipient,
        lane: input.lane,
        oldestItemId: input.oldestItemId,
        backlogCount: input.backlogCount,
        brokerSeq: input.brokerSeq,
        at: input.at,
      });
      if (this.store.deliveryChain(input.publishedItemId).length === 0) {
        this.store.appendDelivery({
          itemId: input.publishedItemId,
          recipient: input.recipient,
          lane: input.lane,
          state: "published",
          evidenceKind: "broker-publish-receipt",
          evidenceRef: `seq:${input.brokerSeq}`,
          at: input.at,
        });
      }
      return ready;
    });
    this.announceStatus(input.recipient, input.at);
    return event;
  }

  /** Writes the `published` row a committed publish earned but never got. The broker's mailbox is authoritative for the fact of publication: an item a poll can offer was published, and its sequence number is the receipt. The notification path that should have filed this row is best-effort by design, so a mailbox item without one is a reachable state — this is the repair, not a second way to publish. It writes only when the chain still lacks the row and returns null otherwise, so a caller can tell a repair from a no-op. */
  repairPublished(
    input: Readonly<{
      itemId: string;
      recipient: string;
      lane: MailLane;
      brokerSeq: number;
      at: string;
    }>,
  ): MailDeliveryRow | null {
    const chain = this.store.deliveryChain(input.itemId);
    if (chain.some((row) => row.state === "published")) return null;
    const written = this.store.appendDelivery({
      itemId: input.itemId,
      recipient: input.recipient,
      lane: input.lane,
      state: "published",
      evidenceKind: "broker-publish-receipt",
      evidenceRef: `seq:${input.brokerSeq}`,
      at: input.at,
    });
    this.announceStatus(input.recipient, input.at);
    return written;
  }

  /** Replays what a recipient's frontend missed, then hands back the cursor. The subject is the authenticated peer, not a field the caller chose, so a frontend cannot watch a mailbox it could not already read. Refusing is not the same as returning nothing: an empty result means an empty mailbox. */
  subscribe(
    subject: string,
    request: MailSubscribeRequest,
  ): readonly MailReadyEvent[] {
    const recipient = this.authorize(subject, request.recipient);
    if (request.sinceCursor === null) return [];
    return this.store.readySince(recipient, request.sinceCursor);
  }

  acknowledge(
    subject: string,
    ack: Readonly<{
      recipient: string;
      cursor: number;
      brokerSeq: number;
      at: string;
    }>,
  ): readonly MailDeliveryRow[] {
    const recipient = this.authorize(subject, ack.recipient);
    const event = this.store.readyAt(recipient, ack.cursor);
    if (event === null || event.brokerSeq !== ack.brokerSeq) {
      throw new MailEvidenceError(
        `cursor:${ack.cursor}`,
        "frontend_notified",
        "the acknowledgement does not match a retained mail-ready event",
      );
    }
    this.store.recordAck(recipient, ack.brokerSeq, ack.at);
    const chain = this.store.deliveryChain(event.oldestItemId);
    const already = chain.find((row) => row.state === "frontend_notified");
    if (already !== undefined) return [already];
    // The notice is a fact about the frontend, not a claim that nothing else
    // has happened. A poll can write mail_presented on a parallel branch from
    // published; looking at the latest open state then skipped this row, and
    // the wake-queued report that followed died for want of a prerequisite
    // the ack had already accepted.
    if (!chain.some((row) => row.state === "published")) return [];
    return [
      this.write({
        itemId: event.oldestItemId,
        recipient,
        state: "frontend_notified",
        evidenceKind: "frontend-ack",
        evidenceRef: `cursor:${ack.cursor}`,
        at: ack.at,
      }),
    ];
  }

  /** Opens the wake row for a waiting item, or returns the one already open. Keyed on the item rather than on the notification, so however many times a frontend is told about the same waiting message it still owes exactly one wake. The id is derived from the same three facts on both sides, so the daemon and the frontend name the same wake without exchanging anything. */
  queueWake(
    input: Readonly<{
      recipient: string;
      lane: MailLane;
      oldestItemId: string;
      at: string;
    }>,
  ): MailWakeRow {
    const existing = this.store.wakeByItem(input.oldestItemId);
    if (existing !== null) return existing;
    if (!this.isAutoRetryable(input.oldestItemId)) {
      throw new MailEvidenceError(
        input.oldestItemId,
        "wake_queued",
        "a delivery-unknown submission is never woken automatically",
      );
    }
    const row: MailWakeRow = {
      wakeId: deriveWakeId(input.recipient, input.lane, input.oldestItemId),
      recipient: input.recipient,
      lane: input.lane,
      oldestItemId: input.oldestItemId,
      state: "queued",
      attempts: 0,
      nextAttemptAt: null,
      clientInputId: null,
      turnEventId: null,
      createdAt: input.at,
      updatedAt: input.at,
    };
    // One transaction for both. The row and the transition it is evidence for have to arrive together: a row that commits alone survives the failure of its own transition, and every later report finds that orphan and looks for a wake_queued nobody wrote — which strands the item for good rather than failing the one report that went wrong.
    return this.store.transaction(() => {
      const wake = this.store.insertWake(row);
      this.write({
        itemId: input.oldestItemId,
        recipient: input.recipient,
        state: "wake_queued",
        evidenceKind: "wake-row",
        evidenceRef: wake.wakeId,
        at: input.at,
      });
      return wake;
    });
  }

  nextWake(
    recipient: string,
    context: Readonly<{ turnActive: boolean; now: string }>,
  ): WakeSchedule {
    const ready = this.store
      .pendingWakes(recipient, context.now)
      .filter((wake) => this.retireIfStale(wake, context))
      .sort(this.byPriority);
    const first = ready[0];
    if (first !== undefined) {
      if (context.turnActive) {
        return { kind: "defer", wake: first, reason: "turn-active" };
      }
      return {
        kind: "submit",
        wake: first,
        priority: first.lane === "control" ? 2 : 4,
      };
    }
    const waiting = this.store
      .openWakes(recipient)
      .filter((wake) => this.retireIfStale(wake, context))
      .sort(this.byPriority);
    const next = waiting[0];
    if (next?.nextAttemptAt != null) {
      return { kind: "wait", wake: next, readyAt: next.nextAttemptAt };
    }
    return { kind: "idle" };
  }

  applyWakeReport(report: FrontendWakeReport): MailDeliveryRow {
    const wake = this.store.wake(report.wakeId);
    if (wake === null) {
      throw new MailEvidenceError(
        report.wakeId,
        "wake_queued",
        "no wake row for that id",
      );
    }
    switch (report.kind) {
      case "wake-queued":
        return this.requireLatest(wake.oldestItemId, "wake_queued");
      case "wake-request-accepted": {
        return this.store.transaction(() => {
          const existing = this.store
            .deliveryChain(wake.oldestItemId)
            .find(
              (row) =>
                row.state === "vendor_request_accepted" &&
                row.evidenceRef === report.clientInputId,
            );
          if (existing !== undefined) return existing;
          this.store.updateWake(
            wake.wakeId,
            { state: "requested", clientInputId: report.clientInputId },
            report.at,
          );
          return this.write({
            itemId: wake.oldestItemId,
            recipient: wake.recipient,
            state: "vendor_request_accepted",
            evidenceKind: "protocol-response",
            evidenceRef: report.clientInputId,
            at: report.at,
          });
        });
      }
      case "wake-turn-observed": {
        const turnEventId = `${report.vendorSessionId}#${report.eventSequence}`;
        if (report.turnId === report.clientInputId) {
          throw new MailEvidenceError(
            wake.oldestItemId,
            "turn_observed",
            "the request acknowledgement is not a turn lifecycle event",
          );
        }
        // Null means the vendor said nothing about whose submission this turn belongs to, which is unknown rather than a denial. A value that disagrees is a denial: that turn is somebody else's.
        if (
          report.turnClientInputId !== null &&
          report.turnClientInputId !== report.clientInputId
        ) {
          throw new MailEvidenceError(
            wake.oldestItemId,
            "turn_observed",
            `turn belongs to ${report.turnClientInputId}`,
          );
        }
        const evidenceRef = `${turnEventId}:${report.turnId}`;
        return this.store.transaction(() => {
          const existing = this.store
            .deliveryChain(wake.oldestItemId)
            .find(
              (row) =>
                row.state === "turn_observed" &&
                row.evidenceRef === evidenceRef,
            );
          if (existing !== undefined) return existing;
          this.store.updateWake(
            wake.wakeId,
            { state: "observed", turnEventId },
            report.at,
          );
          return this.write({
            itemId: wake.oldestItemId,
            recipient: wake.recipient,
            state: "turn_observed",
            evidenceKind: "turn-lifecycle-event",
            evidenceRef,
            at: report.at,
          });
        });
      }
      case "wake-delivery-unknown":
        return this.retry(
          wake,
          `delivery-unknown:${report.clientInputId}`,
          report.at,
        );
      case "wake-failed":
        return this.retry(wake, `failed:${report.reason}`, report.at);
    }
  }

  /** Authenticates a frontend report, then writes only the row that report proves. */
  acceptWakeReport(
    subject: string,
    report: FrontendWakeReport,
  ): MailDeliveryRow {
    if (report.kind === "wake-queued") {
      const recipient = this.authorize(subject, report.recipient);
      this.queueWake({
        recipient,
        lane: report.lane,
        oldestItemId: report.oldestItemId,
        at: report.at,
      });
    } else {
      const wake = this.store.wake(report.wakeId);
      if (wake !== null) this.authorize(subject, wake.recipient);
    }
    return this.applyWakeReport(report);
  }

  recordWakeIgnored(oldestItemId: string, at: string): MailDeliveryRow {
    const wake = this.store.wakeByItem(oldestItemId);
    if (wake === null) {
      throw new MailEvidenceError(
        oldestItemId,
        "retrying",
        "no wake row for that item",
      );
    }
    return this.retry(wake, "ignored", at);
  }

  recordPresented(
    input: Readonly<{
      itemId: string;
      recipient: string;
      pollResponseRef: string;
      at: string;
    }>,
  ): MailDeliveryRow {
    return this.write({
      itemId: input.itemId,
      recipient: input.recipient,
      state: "mail_presented",
      evidenceKind: "poll-response",
      evidenceRef: input.pollResponseRef,
      at: input.at,
    });
  }

  /** Refuses a lease unless this recipient's own poll already offered the item. */
  requirePresented(itemId: string, recipient: string): void {
    this.requireState(itemId, recipient, "mail_presented");
  }

  /** The broker granted the lease. Claim is evidence the agent acted on a body it had already been shown; it is not the operation that carried the body. A claim with no presentation behind it would be a delivery nobody can point at, so it is refused. */
  recordClaimed(
    input: Readonly<{
      itemId: string;
      recipient: string;
      handlerId: string;
      at: string;
    }>,
  ): MailDeliveryRow {
    return this.write({
      itemId: input.itemId,
      recipient: input.recipient,
      state: "mail_claimed",
      evidenceKind: "broker-lease",
      evidenceRef: input.handlerId,
      at: input.at,
    });
  }

  /** Refuses settlement unless this recipient already owns a proven lease. */
  requireClaimed(itemId: string, recipient: string): void {
    this.requireState(itemId, recipient, "mail_claimed");
  }

  recordSettled(
    input: Readonly<{
      itemId: string;
      recipient: string;
      disposition: MailDisposition;
      at: string;
    }>,
  ): MailDeliveryRow {
    const settled = this.write({
      itemId: input.itemId,
      recipient: input.recipient,
      state: input.disposition,
      evidenceKind: "broker-settlement",
      evidenceRef: input.disposition,
      at: input.at,
    });
    const wake = this.store.wakeByItem(input.itemId);
    if (wake !== null) {
      this.store.updateWake(
        wake.wakeId,
        { state: "settled", nextAttemptAt: null },
        input.at,
      );
    }
    return settled;
  }

  /** A user submission whose acknowledgement was lost in transport. Hive cannot tell "never accepted" from "accepted, receipt lost", and a protocol without an idempotency key cannot make a replay safe. Duplicated agent work is interference too, so this is where automation stops and the user decides. */
  recordDeliveryUnknown(
    input: Readonly<{
      clientInputId: string;
      recipient: string;
      reason: string;
      at: string;
    }>,
  ): MailDeliveryRow {
    const written = this.store.appendDelivery({
      itemId: input.clientInputId,
      recipient: input.recipient,
      lane: null,
      state: "delivery_unknown",
      evidenceKind: "ambiguous-submit",
      evidenceRef: input.reason,
      at: input.at,
    });
    this.announceStatus(input.recipient, input.at);
    return written;
  }

  isAutoRetryable(itemId: string): boolean {
    return !this.store
      .deliveryChain(itemId)
      .some((row) => row.state === "delivery_unknown");
  }

  deliveryState(itemId: string): MailDeliveryState | null {
    return this.store.latestDelivery(itemId)?.state ?? null;
  }

  deliveryChain(itemId: string): readonly MailDeliveryRow[] {
    return this.store.deliveryChain(itemId);
  }

  /** Latency for one item, measured only from broker and protocol rows. Nothing here reads a provider hook timestamp or a context percentage, so the measurement is identical for a vendor that reports neither. */
  latency(itemId: string): MailLatency | null {
    const chain = this.store.deliveryChain(itemId);
    const published = chain.find((row) => row.state === "published");
    if (published === undefined) return null;
    const firstAt = (state: MailDeliveryState): number | null => {
      const row = chain.find((entry) => entry.state === state);
      return row === undefined
        ? null
        : Math.round(seconds(published.at, row.at) * 1_000);
    };
    const settlement = chain.find((row) =>
      ["completed", "deferred", "rejected"].includes(row.state),
    );
    return {
      itemId,
      lane: published.lane,
      publishedAt: published.at,
      frontendNotifiedMs: firstAt("frontend_notified"),
      requestAcceptedMs: firstAt("vendor_request_accepted"),
      turnObservedMs: firstAt("turn_observed"),
      claimedMs: firstAt("mail_claimed"),
      settledMs:
        settlement === undefined
          ? null
          : Math.round(seconds(published.at, settlement.at) * 1_000),
    };
  }

  sloBreaches(recipient: string, now: string): readonly MailSloBreach[] {
    const breaches: MailSloBreach[] = [];
    for (const open of this.store.openDeliveries(recipient)) {
      const chain = this.store.deliveryChain(open.itemId);
      const published = chain.find((row) => row.state === "published");
      if (published === undefined) continue;
      const age = seconds(published.at, now);
      const notified = chain.some((row) => row.state === "frontend_notified");
      const claimed = chain.some((row) => row.state === "mail_claimed");
      const breach = (
        kind: MailSloBreachKind,
        thresholdSeconds: number,
        detail: string,
      ): void => {
        breaches.push({
          kind,
          itemId: open.itemId,
          recipient,
          lane: published.lane,
          ageSeconds: age,
          thresholdSeconds,
          detail,
          destinations: EXTERNAL_DESTINATIONS,
        });
      };
      if (age >= MAIL_INCIDENT_SECONDS) {
        breach("mail-incident", MAIL_INCIDENT_SECONDS, "mail unclaimed");
      }
      if (!notified && age >= MAIL_FRONTEND_SILENT_BREACH_SECONDS) {
        breach(
          "no-live-frontend",
          MAIL_FRONTEND_SILENT_BREACH_SECONDS,
          "no frontend acknowledged the mail-ready event",
        );
      }
      if (
        published.lane === "control" &&
        !claimed &&
        age >= MAIL_CONTROL_CLAIM_SLO_SECONDS
      ) {
        breach(
          "control-claim-slo",
          MAIL_CONTROL_CLAIM_SLO_SECONDS,
          "control item not claimed",
        );
      }
    }
    return breaches;
  }

  /** The mail dimension of this recipient's status. Null means the ledger has never seen this recipient, which renders as unknown. "none" is a measured emptiness and is not the same answer. */
  mailStatus(recipient: string): MailStatusState | null {
    if (!this.store.hasDeliveries(recipient)) return null;
    const open = this.store.openDeliveries(recipient);
    const wakes = this.store.openWakes(recipient);
    if (this.store.hasState(recipient, "dead_lettered")) return "dead_lettered";
    if (open.length === 0) return "none";
    if (open.some((row) => row.state === "mail_claimed")) return "claimed";
    if (open.some((row) => row.state === "retrying")) return "retrying";
    if (wakes.length > 0) return "waking";
    return "waiting";
  }

  private byPriority = (left: MailWakeRow, right: MailWakeRow): number => {
    const lane = (wake: MailWakeRow): number =>
      wake.lane === "control" ? 0 : 1;
    return (
      lane(left) - lane(right) ||
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.wakeId.localeCompare(right.wakeId)
    );
  };

  private retireIfStale(
    wake: MailWakeRow,
    context: Readonly<{ now: string }>,
  ): boolean {
    if (this.isDeliverable(wake.oldestItemId)) return true;
    this.store.updateWake(
      wake.wakeId,
      { state: "settled", nextAttemptAt: null },
      context.now,
    );
    return false;
  }

  private authorize(subject: string, recipient: string): string {
    const canonicalSubject = canonicalOrchestratorName(subject);
    const canonicalRecipient = canonicalOrchestratorName(recipient);
    if (canonicalSubject !== canonicalRecipient) {
      throw new MailWakeAclError(subject, recipient);
    }
    return canonicalRecipient;
  }

  private retry(
    wake: MailWakeRow,
    reason: string,
    at: string,
  ): MailDeliveryRow {
    const attempts = wake.attempts + 1;
    if (attempts >= MAIL_WAKE_MAX_ATTEMPTS) {
      this.store.updateWake(
        wake.wakeId,
        { state: "dead_lettered", attempts, nextAttemptAt: null },
        at,
      );
      const row = this.write({
        itemId: wake.oldestItemId,
        recipient: wake.recipient,
        state: "dead_lettered",
        evidenceKind: "wake-policy-exhausted",
        evidenceRef: `attempts:${attempts}`,
        at,
      });
      // Raised after the row, so the evidence outlives a failed announcement. The item is still in the mailbox and still readable by a poll; what has stopped is anything telling its recipient to go and look.
      this.announceExhausted({
        wakeId: wake.wakeId,
        recipient: wake.recipient,
        lane: wake.lane,
        oldestItemId: wake.oldestItemId,
        attempts,
        at,
      });
      return row;
    }
    this.store.updateWake(
      wake.wakeId,
      {
        state: "queued",
        attempts,
        nextAttemptAt: plusSeconds(at, backoffSeconds(attempts)),
        clientInputId: null,
        turnEventId: null,
      },
      at,
    );
    return this.write({
      itemId: wake.oldestItemId,
      recipient: wake.recipient,
      state: "retrying",
      evidenceKind: "wake-row",
      evidenceRef: `${wake.wakeId}:${reason}`,
      at,
    });
  }

  private requireLatest(
    itemId: string,
    state: MailDeliveryState,
  ): MailDeliveryRow {
    const chain = this.store.deliveryChain(itemId);
    const row = [...chain].reverse().find((entry) => entry.state === state);
    if (row === undefined) {
      throw new MailEvidenceError(itemId, state, "no such transition recorded");
    }
    return row;
  }

  private requireState(
    itemId: string,
    recipient: string,
    state: MailDeliveryState,
  ): void {
    const present = this.store
      .deliveryChain(itemId)
      .some((row) => row.recipient === recipient && row.state === state);
    if (!present) {
      throw new MailEvidenceError(
        itemId,
        state,
        `no ${state} row for recipient`,
      );
    }
  }

  private write(
    entry: Readonly<{
      itemId: string;
      recipient: string;
      state: MailDeliveryState;
      evidenceKind: MailEvidenceKind;
      evidenceRef: string;
      at: string;
    }>,
  ): MailDeliveryRow {
    const chain = this.store.deliveryChain(entry.itemId);
    const required = PREREQUISITES[entry.state];
    if (required !== undefined) {
      const satisfied = required.some((state) =>
        chain.some((row) => row.state === state),
      );
      if (!satisfied) {
        throw new MailEvidenceError(
          entry.itemId,
          entry.state,
          `requires one of ${required.join(", ")}`,
        );
      }
    }
    const written = this.store.appendDelivery({
      ...entry,
      lane: chain[0]?.lane ?? null,
    });
    this.announceStatus(entry.recipient, entry.at);
    return written;
  }
}
