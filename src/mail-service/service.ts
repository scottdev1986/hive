import type { z } from "zod";
import { definedFields } from "../shared/defined-fields";
import { logAlertDeliveryFailure } from "../daemon/observability/daemon-log";
import { ORCHESTRATOR_NAME } from "../schemas/agent";
import {
  MAIL_BODY_MAX_BYTES,
  MAIL_CONTROL_LANE_CAPACITY,
  MAIL_LEASE_SECONDS,
  MAIL_MAX_ATTEMPTS,
  MAIL_SLO_BREACH_SECONDS,
  type MailClaimReceipt,
  MailClaimReceiptSchema,
  MailClaimRequestSchema,
  type MailCompleteReceipt,
  MailCompleteReceiptSchema,
  MailCompleteRequestSchema,
  type MailItem,
  type MailLane,
  MailLaneSchema,
  type MailLease,
  MailPollRequestSchema,
  type MailPollResult,
  MailPollResultSchema,
  type MailPublishReceipt,
  MailPublishRequestSchema,
  MailStatusRequestSchema,
  type MailStatusResult,
  MailStatusResultSchema,
} from "../schemas/mail";
import {
  MailControlBusyError,
  type MailRelease,
  type MailStore,
} from "./store";

/** What the daemon knows about a name a sender addressed. `canonical` is the name mail is actually filed under, which is not always the one the sender typed — the root answers to two. Every other case is a reason the mailbox cannot accept work, kept distinct so the refusal can say which. */
export type MailRecipientState =
  | { readonly kind: "live"; readonly canonical: string }
  | { readonly kind: "absent" }
  | { readonly kind: "terminal"; readonly status: string }
  | { readonly kind: "unbound" };

/** Resolves an addressed name against live daemon state. Injected rather than read here so this module owns no agent-registry or hierarchy queries, and so the cutover is wiring rather than rewriting. It is consulted at the boundary, before any transaction opens — never from inside one, where a caller-supplied function would be running with the write lock. */
export type MailRecipientResolver = (named: string) => MailRecipientState;

/** How the daemon's own components publish. They are fixed senders rather than agents, so they carry no capability and choose no lane: the sender's name decides both, one level up. */
export type SystemMailPublish = (
  from: string,
  to: string,
  body: string,
  options?: {
    idempotencyKey?: string;
    conditionId?: string;
    condition?: string;
  },
) => Promise<void>;

/** Told after a publish commits that a recipient has mail waiting. It carries a count and an id, never the body — the mailbox stays the only way a body moves, so being notified grants no read the caller did not already have. Optional because the broker's contract does not depend on anyone listening: mail that nobody was woken for is still durably accepted. */
export type MailReadyNotifier = (
  input: Readonly<{
    recipient: string;
    lane: MailLane;
    publishedItemId: string;
    brokerSeq: number;
    oldestItemId: string;
    backlogCount: number;
    at: string;
  }>,
) => void;

export interface MailBrokerDeps {
  readonly store: MailStore;
  readonly recipients: MailRecipientResolver;
  readonly notifyReady?: MailReadyNotifier;
  /** Checks delivery evidence after identity fencing but before a lease is written. */
  readonly beforeClaim?: (itemId: string, recipient: string) => void;
  readonly beforeComplete?: (itemId: string, recipient: string) => void;
  /** When a recipient last reached a safe point, or null if it never has. Injected rather than queried, for the same reason `recipients` is: deciding a queue is degraded needs to know whether the agent has had a chance to read, but that is the daemon's fact about an agent's lifecycle, not the mailbox's. Reading the agents table from here would make this a service that reaches back into the registry instead of a boundary. Optional only because the operations do not need it — `sweep` does, and it refuses rather than proceeding without one. An absent reader would make every mailbox look like one that never reached a safe point, so the SLO half would report nothing while appearing to run. */
  readonly safePointAt?: (recipient: string) => string | null;
  /** Live mailbox incarnation of a subject, used to scope standing-condition acks. */
  readonly liveGeneration?: (subject: string) => number | null;
}

export interface MailServiceConfig {
  readonly maxAttempts: number;
  readonly sloBreachSeconds: number;
}

const DEFAULT_MAIL_SERVICE_CONFIG: MailServiceConfig = {
  maxAttempts: MAIL_MAX_ATTEMPTS,
  sloBreachSeconds: MAIL_SLO_BREACH_SECONDS,
};

/** The authenticated caller. Both halves are load-bearing. The subject decides which mailbox the call may touch, and the generation decides whether this incarnation is still the one an envelope was addressed to — an agent that was respawned is a different consumer even though it answers to the same name. This is the subject and generation the request's own capability carries; the hierarchy binding keeps a separate epoch with a separate writer, and nothing here joins the two. */
export type MailActor = Readonly<{
  subject: string;
  agentGeneration: number;
}>;

export const MAIL_SYSTEM_SENDER = "hive-mail";

/** The lane and topic each of the daemon's own senders publishes on. The daemon's senders are fixed names rather than agents, so their lane comes from what kind of sender they are, not from each call site deciding again. Alerts and progress ride the work lane, where repeated updates from the same sender merge instead of stacking up; only what an agent must act on rides the control lane. A sender that is not named here fails loudly rather than defaulting to a lane nobody chose. */
export const SYSTEM_MAIL_ROUTES: Readonly<
  Record<string, Readonly<{ lane: MailLane; topic: string }>>
> = {
  "hive-approvals": { lane: "work", topic: "approvals" },
  "hive-control": { lane: "control", topic: "control" },
  "hive-effort": { lane: "work", topic: "effort" },
  "hive-escalation": { lane: "control", topic: "escalation" },
  "hive-handoff": { lane: "work", topic: "handoff" },
  [MAIL_SYSTEM_SENDER]: { lane: "control", topic: "mail" },
  "hive-mail-latency": { lane: "work", topic: "mail-latency" },
  "hive-main-health": { lane: "control", topic: "main-health" },
  "hive-lifecycle": { lane: "work", topic: "lifecycle" },
  "hive-quota": { lane: "work", topic: "quota" },
  "hive-resources": { lane: "work", topic: "resources" },
};

/** The mailbox's operation surface, holding its dependencies once. The dependencies used to be assembled at each call site instead, and the three assemblies had drifted: only the tool boundary passed `beforeClaim` and `beforeComplete`, so whether a claim or a settlement checked delivery evidence depended on which assembly the call happened to arrive through. Holding them in one place is what makes that divergence unrepresentable — there is no second assembly left to disagree with this one. The operations keep taking `now` from the caller rather than reading a clock, so a test and the daemon drive time the same way. */
export class MailService {
  constructor(
    private readonly deps: MailBrokerDeps,
    private readonly config: MailServiceConfig = DEFAULT_MAIL_SERVICE_CONFIG,
  ) {}

  get store(): MailStore {
    return this.deps.store;
  }

  publish(actor: MailActor, request: unknown, now: Date): MailPublishReceipt {
    return hiveMailPublish(this.deps, actor, request, now);
  }

  poll(actor: MailActor, request: unknown, now: Date): MailPollResult {
    return hiveMailPoll(this.deps, actor, request, now);
  }

  claim(actor: MailActor, request: unknown, now: Date): MailClaimReceipt {
    return hiveMailClaim(
      this.deps,
      actor,
      request,
      now,
      this.config.maxAttempts,
    );
  }

  complete(actor: MailActor, request: unknown, now: Date): MailCompleteReceipt {
    return hiveMailComplete(
      this.deps,
      actor,
      request,
      now,
      this.config.maxAttempts,
    );
  }

  status(actor: MailActor, request: unknown, now: Date): MailStatusResult {
    return hiveMailStatus(this.deps, actor, request, now);
  }

  /** Publishes one of the daemon's own messages. A caller with no idempotency key gets a fresh one. Its send never deduplicated before, and inventing a stable key here would start silently discarding messages that are meant to be distinct. */
  async publishSystem(
    from: string,
    to: string,
    body: string,
    options: {
      idempotencyKey?: string;
      conditionId?: string;
      condition?: string;
    } = {},
  ): Promise<void> {
    const route = SYSTEM_MAIL_ROUTES[from];
    if (route === undefined) {
      throw new Error(`no mail lane is defined for the sender ${from}`);
    }
    this.publish(
      { subject: from, agentGeneration: 0 },
      {
        from,
        to,
        body,
        lane: route.lane,
        topic: route.topic,
        idempotencyKey:
          options.idempotencyKey ?? `${from}:${Bun.randomUUIDv7()}`,
        ...definedFields({
          conditionId: options.conditionId,
          condition: options.condition,
        }),
      },
      new Date(),
    );
  }

  clearStandingCondition(
    sender: string,
    recipient: string,
    conditionId: string,
  ): void {
    this.store.clearStandingCondition(recipient, sender, conditionId);
  }

  announceWaiting(
    recipient: string,
    cause: Readonly<{ itemId: string; lane: MailLane; seq: number }>,
    now: Date,
  ): void {
    announceMailWaiting(this.deps, recipient, cause, now);
  }

  /** Whether the mailbox would still hand over the item an announcement names. A mail-ready row records what a lane could offer when it was written, and a frontend wakes its agent from whatever a replay hands it. `claim` answers from the item table instead, so an announcement that outlived its item wakes an agent for something it can no longer lease — the poll it is told to make comes back empty and the claim is refused. A leased item is withheld for the same reason: whoever holds the lease already has it. This lives here because it is the mailbox's own invariant, and anything that narrates what a mailbox still holds has to ask it rather than assume. */
  stillOffers(itemId: string): boolean {
    return this.deps.store.getItem(itemId)?.state === "available";
  }

  unsettledFor(agent: string): MailItem[] {
    const now = new Date().toISOString();
    return [
      ...this.deps.store.listAvailable(agent, "control", 0, 100, now),
      ...this.deps.store.listAvailable(agent, "work", 0, 100, now),
    ].sort((left, right) => left.seq - right.seq);
  }

  queenBootMailboxFor(agent: string) {
    const now = new Date().toISOString();
    const leases = this.deps.store.listLeases(agent);
    const leased = leases.flatMap((lease) => {
      const item = this.deps.store.getItem(lease.itemId);
      return item === null ? [] : [{ item, lease }];
    });
    const control = [
      ...this.deps.store
        .listAvailable(agent, "control", 0, 10_000, now)
        .map((item) => ({ item, lease: null })),
      ...leased.filter(({ item }) => item.lane === "control"),
    ]
      .sort((left, right) => left.item.seq - right.item.seq)
      .map(({ item, lease }) => ({
        itemId: item.itemId,
        sender: item.sender,
        topic: item.topic,
        attempts: item.attempts,
        lease:
          lease === null
            ? null
            : { handlerId: lease.handlerId, leaseUntil: lease.leaseUntil },
        bodyBytes: Buffer.byteLength(item.body, "utf8"),
        bodyDigest: `sha256:${new Bun.CryptoHasher("sha256").update(item.body).digest("hex")}`,
      }));
    const workItems = [
      ...this.deps.store.listAvailable(agent, "work", 0, 10_000, now),
      ...leased
        .filter(({ item }) => item.lane === "work")
        .map(({ item }) => item),
    ];
    return {
      counts: {
        controlAvailable: this.deps.store.countByState(
          agent,
          "control",
          "available",
        ),
        controlLeased: this.deps.store.countByState(agent, "control", "leased"),
        workAvailable: this.deps.store.countByState(agent, "work", "available"),
        workLeased: this.deps.store.countByState(agent, "work", "leased"),
        deadLettered: this.deps.store.listDeadLetters(agent).length,
      },
      control,
      work: workItems
        .sort((left, right) => left.seq - right.seq)
        .map((item) => ({
          itemId: item.itemId,
          sender: item.sender,
          topic: item.topic,
          bodyBytes: Buffer.byteLength(item.body, "utf8"),
          bodyDigest: `sha256:${new Bun.CryptoHasher("sha256").update(item.body).digest("hex")}`,
        })),
    };
  }

  /** Announces a lane whose oldest item is offerable again after a lapsed lease. A requeue follows the item's publish announcement, so it needs a fresh broker sequence. Reusing the publish sequence would collide with both the earlier ready row and clients' acknowledged sequence watermark. The lane's offer rule still decides what is named, so a lane that is busy again by the time the sweep runs announces nothing, exactly as a publish would. */
  announceRequeued(itemId: string, now: Date): void {
    const item = this.deps.store.getItem(itemId);
    if (item === null) return;
    this.announceWaiting(
      item.recipient,
      {
        itemId: item.itemId,
        lane: item.lane,
        seq: this.deps.store.nextSeq(item.recipient),
      },
      now,
    );
  }

  /** Tells the orchestrator that a recipient has mail nothing will wake them for. The notice is only composed while the mailbox would still hand the item over. A settled item has left the table and a leased one is already being handled, so for either the body's "a poll will return it" would be false — the wake outlived the item it was for, and there is nothing to report. While the item still offers, this reports a lost notification rather than a lost message, which is why the body carries enough to act on without a follow-up query. An undelivered wake reported as mail would generate a wake of its own, so a report whose own wake expires must not produce a second report: that is a chain with no end, and each link takes a control slot offered one at a time. Escalating only for items this path did not send is what stops it. The cost is that a report whose wake is never delivered is announced once and then only discoverable by polling — acceptable because the `dead_lettered` row is already durable, and a chain would bury the original under notices about it. */
  reportUndeliveredWake(
    exhausted: Readonly<{
      wakeId: string;
      recipient: string;
      lane: MailLane;
      oldestItemId: string;
      attempts: number;
    }>,
  ): void {
    if (!this.stillOffers(exhausted.oldestItemId)) return;
    const item = this.deps.store.getItem(exhausted.oldestItemId);
    if (item?.sender === MAIL_SYSTEM_SENDER) return;
    const body =
      `Undelivered wake: ${exhausted.recipient} has a ${exhausted.lane} item ` +
      `nothing will wake them for. Item ${exhausted.oldestItemId}, ` +
      `${exhausted.attempts} attempts, wake dead_lettered. The item is still ` +
      `in the mailbox and a poll will return it.`;
    void this.publishSystem(MAIL_SYSTEM_SENDER, ORCHESTRATOR_NAME, body, {
      idempotencyKey: `wake-exhausted:${exhausted.wakeId}`,
    }).catch(() => undefined);
  }

  /** The mailbox's own maintenance: retire what has run out of time, then say so. Both halves report rather than deliver. A queue that is not moving is a congestion signal for the root to act on, not a reason to interrupt the agent it is about — so this publishes one message and never touches a terminal. Rate limiting is the idempotency the mailbox already has, not a timer of its own. The SLO key names the breach window by the arrival time of the message that opened it, which does not move while that message waits: every pass re-publishes the same key and the broker returns the original receipt. A second alert means a genuinely new window, not a second sweep. */
  async sweep(now: Date): Promise<void> {
    for (const release of this.sweepDeadlines(now)) {
      // A lapsed lease puts the item back on the lane, and nothing else says so: the handler that held it is not told it lost it, and no publish follows to announce it. Without this the item is offerable and silent, waiting for somebody to poll on a hunch.
      if (release.outcome === "redelivered") {
        this.announceRequeued(release.itemId, now);
        continue;
      }
      if (release.outcome !== "dead-lettered") continue;
      await this.publishSystem(
        MAIL_SYSTEM_SENDER,
        ORCHESTRATOR_NAME,
        `Mail dead-lettered: ${release.itemId} (${release.reason}). It is in ` +
          "the dead-letter queue and will not be delivered; hive_mail_status " +
          "names the mailbox it left.",
        { idempotencyKey: `mail-dlq:${release.itemId}` },
      ).catch(logAlertDeliveryFailure);
    }
    // Refused, not skipped. Reading no safe point looks exactly like an agent that never reached one, so a sweep without this reader would report no breaches while appearing to have checked for them.
    const safePointAt = this.deps.safePointAt;
    if (safePointAt === undefined) {
      throw new Error(
        "mail sweep requires safePointAt: without it no latency breach can be " +
          "distinguished from an agent that has not had a chance to read",
      );
    }
    for (const stale of this.deps.store.staleControlMail(
      now.toISOString(),
      this.config.sloBreachSeconds,
    )) {
      const safePoint = safePointAt(stale.recipient);
      if (safePoint === null || safePoint <= stale.waitingSince) continue;
      // The body names the window, never how long it has been open. An elapsed time would change on every pass, and the same key carrying changed content is a conflict the broker refuses — turning the rate limit into a silently dropped alert.
      await this.publishSystem(
        "hive-mail-latency",
        ORCHESTRATOR_NAME,
        `Safe-point latency degraded for ${stale.recipient}: its oldest ` +
          `control message has been waiting since ${stale.waitingSince}, and ` +
          "the agent has reached a safe point since it arrived without " +
          "reading it. The message is durable and unread, not lost.",
        {
          idempotencyKey: `mail-slo:${stale.recipient}:${stale.waitingSince}`,
        },
      ).catch(logAlertDeliveryFailure);
    }
  }

  sweepDeadlines(now: Date): MailRelease[] {
    return sweepMailDeadlines(this.deps.store, now, this.config.maxAttempts);
  }

  /** Keeps work owned by a live provider turn from expiring underneath it. An
   * already-expired lease is left for normal redelivery; a heartbeat may extend
   * ownership, never reacquire it or spend another attempt. */
  renewLiveLeases(actor: MailActor, now: Date): MailLease[] {
    const at = now.toISOString();
    const leaseUntil = plusSeconds(now, MAIL_LEASE_SECONDS);
    return this.deps.store
      .listLeases(actor.subject)
      .filter(
        (lease) =>
          lease.ownerGeneration === actor.agentGeneration &&
          lease.leaseUntil > at,
      )
      .map((lease) =>
        this.deps.store.claim({
          itemId: lease.itemId,
          recipient: actor.subject,
          ownerGeneration: actor.agentGeneration,
          handlerId: lease.handlerId,
          leaseUntil,
          now: at,
          maxAttempts: this.config.maxAttempts,
        }),
      );
  }
}

export class MailPayloadRejectedError extends Error {
  readonly code = "MAIL_PAYLOAD_REJECTED";

  constructor(detail: string) {
    super(`MAIL_PAYLOAD_REJECTED: ${detail}`);
    this.name = "MailPayloadRejectedError";
  }
}

export class MailForeignSubjectError extends Error {
  readonly code = "MAIL_FOREIGN_SUBJECT";

  constructor(subject: string, named: string) {
    super(
      `MAIL_FOREIGN_SUBJECT: ${subject} may not act on the mailbox of ${named}`,
    );
    this.name = "MailForeignSubjectError";
  }
}

export class MailRecipientRefusedError extends Error {
  readonly code = "MAIL_RECIPIENT_REFUSED";

  constructor(
    readonly named: string,
    readonly state: MailRecipientState,
  ) {
    super(
      `MAIL_RECIPIENT_REFUSED: ${named} cannot receive mail (${
        state.kind === "terminal"
          ? `${state.kind}: ${state.status}`
          : state.kind
      })`,
    );
    this.name = "MailRecipientRefusedError";
  }
}

export class MailWorkLaneGenerationError extends Error {
  readonly code = "MAIL_WORK_LANE_GENERATION";

  constructor() {
    super(
      "MAIL_WORK_LANE_GENERATION: the work lane does not address a generation. " +
        "Its updates merge by recipient, sender and topic, so an addressed one " +
        "would be folded into an envelope pinned to a different incarnation. " +
        "Send generation-bound instructions on the control lane.",
    );
    this.name = "MailWorkLaneGenerationError";
  }
}

export class MailGenerationMismatchError extends Error {
  readonly code = "MAIL_GENERATION_MISMATCH";

  // The refusal says what the claim did as well as what it refused. Without that, a recipient told only that it may not handle the item at the head of a one-at-a-time lane reads its whole control lane as bricked, when the claim it just made is what cleared it.
  constructor(itemId: string, addressed: number, claimant: number) {
    super(
      `MAIL_GENERATION_MISMATCH: ${itemId} was addressed to generation ` +
        `${addressed} and cannot be handled by generation ${claimant}. ` +
        "It has been quarantined, so the lane now offers whatever was behind it.",
    );
    this.name = "MailGenerationMismatchError";
  }
}

const parseRequest = <T extends z.ZodTypeAny>(
  schema: T,
  request: unknown,
): z.infer<T> => {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    throw new MailPayloadRejectedError(
      parsed.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
        )
        .join("; "),
    );
  }
  return parsed.data;
};

const canonicalName = (deps: MailBrokerDeps, named: string): string => {
  const state = deps.recipients(named);
  return state.kind === "live" ? state.canonical : named;
};

const actingAs = (
  deps: MailBrokerDeps,
  actor: MailActor,
  named: string,
): string => {
  const asked = canonicalName(deps, named);
  if (asked !== canonicalName(deps, actor.subject)) {
    throw new MailForeignSubjectError(actor.subject, named);
  }
  return asked;
};

/** The name mail is filed under, or a refusal. A mailbox nobody is bound to, or one whose agent has finished, cannot be given work: accepting it would hand the sender a durable receipt for a message that has nowhere to go and no one to settle it. */
const requireLiveRecipient = (deps: MailBrokerDeps, named: string): string => {
  const state = deps.recipients(named);
  if (state.kind !== "live") throw new MailRecipientRefusedError(named, state);
  return state.canonical;
};

const plusSeconds = (now: Date, seconds: number): string =>
  new Date(now.getTime() + seconds * 1_000).toISOString();

const ageSeconds = (from: string, now: Date): number =>
  Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 1_000));

/** Accepts an envelope, or says no. Shape, size and topic are settled before the store is touched, so an oversized or malformed publish never opens a transaction. Everything that does open one — the item, its journal entry, and the idempotency key that identifies it — commits together, and this returns only after that commit, so a sender holding a receipt is holding a durable fact. */
export function hiveMailPublish(
  deps: MailBrokerDeps,
  actor: MailActor,
  request: unknown,
  now: Date,
): MailPublishReceipt {
  const input = parseRequest(MailPublishRequestSchema, request);
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  if (bodyBytes > MAIL_BODY_MAX_BYTES) {
    throw new MailPayloadRejectedError(
      `body is ${bodyBytes} bytes; the limit is ${MAIL_BODY_MAX_BYTES}`,
    );
  }
  if (input.lane === "work" && input.addressedGeneration !== null) {
    throw new MailWorkLaneGenerationError();
  }
  const sender = actingAs(deps, actor, input.from);
  const recipient = requireLiveRecipient(deps, input.to);
  const receipt = deps.store.publish({
    recipient,
    sender,
    lane: input.lane,
    topic: input.topic,
    recipientGeneration: input.addressedGeneration,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    ttlSeconds: input.ttlSeconds,
    expiresAt:
      input.ttlSeconds === null ? null : plusSeconds(now, input.ttlSeconds),
    now: now.toISOString(),
    controlLaneCapacity: MAIL_CONTROL_LANE_CAPACITY,
    conditionId: input.conditionId,
    condition: input.condition,
    recipientLiveGeneration: deps.liveGeneration?.(recipient) ?? null,
  });
  if (receipt.outcome !== "restated") {
    announceMailWaiting(deps, recipient, receipt, now);
  }
  return receipt;
}

/** Announces whatever that lane would now offer, after something made it offerable — a publish that committed, or a lapsed lease that put an item back. The lane's own offer rule decides what to announce, so the notification can never name an item a poll would withhold. That is also why a busy control lane announces nothing: the agent is already holding one instruction, and a second wake would only ask it to interrupt itself. The cause is only ever an id, a lane and a sequence for correlation. It is deliberately not a publish receipt: a requeued item was made offerable by nobody sending anything, and a signature that demanded a receipt would leave that case with no way to announce and no way to say why. A failure here is swallowed on purpose. Whatever caused this is already durable, and turning a missed notification into a failed publish would lose the message to protect the wake. */
export function announceMailWaiting(
  deps: MailBrokerDeps,
  recipient: string,
  cause: Readonly<{ itemId: string; lane: MailLane; seq: number }>,
  now: Date,
): void {
  const notify = deps.notifyReady;
  if (notify === undefined) return;
  const at = now.toISOString();
  try {
    const oldest = deps.store.listAvailable(recipient, cause.lane, 0, 1, at);
    const waiting = oldest.at(0);
    if (waiting === undefined) return;
    notify({
      recipient,
      lane: cause.lane,
      publishedItemId: cause.itemId,
      brokerSeq: cause.seq,
      oldestItemId: waiting.itemId,
      backlogCount: deps.store.countByState(recipient, cause.lane, "available"),
      at,
    });
  } catch (error) {
    console.error(
      `Hive published mail for ${recipient} but could not raise its mail-ready event: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

/** Hands the recipient one attention item and a bounded index of everything else. The control offer is at most one because a control item is meant to be acted on before the agent resumes; the work half is a digest of headers, so a thousand queued updates cost the same to read as one. Nothing here writes: a diagnostic read that repaired what it measured would make the mailbox's health depend on who looked at it. */
export function hiveMailPoll(
  deps: MailBrokerDeps,
  actor: MailActor,
  request: unknown,
  now: Date,
): MailPollResult {
  const input = parseRequest(MailPollRequestSchema, request);
  const recipient = actingAs(deps, actor, input.recipient);
  const at = now.toISOString();
  const control = deps.store
    .listAvailable(recipient, "control", 0, 1, at)
    .at(0);
  const work = deps.store.listAvailable(
    recipient,
    "work",
    input.cursor ?? 0,
    input.workDigestLimit,
    at,
  );
  const workDigest = work.map((item) => ({
    itemId: item.itemId,
    sender: item.sender,
    topic: item.topic,
    mergedCount: item.mergedCount,
    seq: item.seq,
    bodyBytes: Buffer.byteLength(item.body, "utf8"),
    updatedAt: item.updatedAt,
  }));
  return MailPollResultSchema.parse({
    recipient,
    control:
      control === undefined
        ? null
        : {
            itemId: control.itemId,
            sender: control.sender,
            topic: control.topic,
            addressedGeneration: control.recipientGeneration,
            seq: control.seq,
            attempts: control.attempts,
            body: control.body,
          },
    workDigest,
    cursor: workDigest.at(-1)?.seq ?? null,
    backlog: {
      controlAvailable: deps.store.countByState(
        recipient,
        "control",
        "available",
      ),
      controlLeased: deps.store.countByState(recipient, "control", "leased"),
      workAvailable: deps.store.countByState(recipient, "work", "available"),
      workLeased: deps.store.countByState(recipient, "work", "leased"),
      deadLettered: deps.store.listDeadLetters(recipient).length,
    },
  });
}

/** Leases one item to this incarnation and handler. A message addressed to a generation that has since been replaced can never be handled, so it is quarantined here rather than left to be re-offered at every poll. The claim itself refuses the mismatch a second time inside its write. */
export function hiveMailClaim(
  deps: MailBrokerDeps,
  actor: MailActor,
  request: unknown,
  now: Date,
  maxAttempts = MAIL_MAX_ATTEMPTS,
): MailClaimReceipt {
  const input = parseRequest(MailClaimRequestSchema, request);
  const recipient = actingAs(deps, actor, input.recipient);
  const at = now.toISOString();
  const item = deps.store.getItem(input.itemId);
  if (item !== null && item.recipient !== recipient) {
    throw new MailForeignSubjectError(actor.subject, item.recipient);
  }
  if (
    item !== null &&
    item.recipientGeneration !== null &&
    item.recipientGeneration !== actor.agentGeneration
  ) {
    deps.store.quarantine(item.itemId, "expired-task-generation", at);
    throw new MailGenerationMismatchError(
      item.itemId,
      item.recipientGeneration,
      actor.agentGeneration,
    );
  }
  if (item?.lane === "control") {
    const held = deps.store.controlLeaseOtherThan(recipient, item.itemId);
    if (held !== null && held.leaseUntil > at) {
      throw new MailControlBusyError(item.itemId, held.itemId);
    }
  }
  deps.beforeClaim?.(input.itemId, recipient);
  const lease = deps.store.claim({
    itemId: input.itemId,
    recipient,
    ownerGeneration: actor.agentGeneration,
    handlerId: input.handlerId,
    leaseUntil: plusSeconds(now, MAIL_LEASE_SECONDS),
    now: at,
    maxAttempts,
  });
  const claimed = deps.store.getItem(input.itemId);
  if (claimed === null) {
    throw new Error(`mail item ${input.itemId} does not exist`);
  }
  return MailClaimReceiptSchema.parse({
    itemId: claimed.itemId,
    handlerId: lease.handlerId,
    ownerGeneration: lease.ownerGeneration,
    attempt: claimed.attempts,
    leaseUntil: lease.leaseUntil,
    lane: claimed.lane,
    topic: claimed.topic,
    sender: claimed.sender,
    body: claimed.body,
  });
}

/** Settles a claimed item, once. The same call repeated after a lost response returns the settlement already recorded instead of taking a second attempt off the item, and a handler whose lease lapsed while it worked is refused rather than allowed to settle work another claimant now owns. */
export function hiveMailComplete(
  deps: MailBrokerDeps,
  actor: MailActor,
  request: unknown,
  now: Date,
  maxAttempts = MAIL_MAX_ATTEMPTS,
): MailCompleteReceipt {
  const input = parseRequest(MailCompleteRequestSchema, request);
  const recipient = actingAs(deps, actor, input.recipient);
  deps.beforeComplete?.(input.itemId, recipient);
  const settled = deps.store.settle({
    itemId: input.itemId,
    recipient,
    ownerGeneration: actor.agentGeneration,
    handlerId: input.handlerId,
    disposition: input.disposition,
    reason: input.reason,
    retryAt:
      input.disposition === "deferred"
        ? plusSeconds(now, input.retryAfterSeconds)
        : null,
    now: now.toISOString(),
    maxAttempts,
  });
  // Settling frees the lane, which can make an older message offerable that no publish will ever announce again — it arrived while the lane was busy and was deliberately withheld then. Without this the second instruction in a burst waits for a third to arrive before anybody is woken for it.
  announceNextWaiting(deps, recipient, now);
  return MailCompleteReceiptSchema.parse(settled);
}

function announceNextWaiting(
  deps: MailBrokerDeps,
  recipient: string,
  now: Date,
): void {
  const notify = deps.notifyReady;
  if (notify === undefined) return;
  const at = now.toISOString();
  for (const lane of MailLaneSchema.options) {
    try {
      const waiting = deps.store.listAvailable(recipient, lane, 0, 1, at).at(0);
      if (waiting === undefined) continue;
      notify({
        recipient,
        lane,
        publishedItemId: waiting.itemId,
        brokerSeq: waiting.seq,
        oldestItemId: waiting.itemId,
        backlogCount: deps.store.countByState(recipient, lane, "available"),
        at,
      });
    } catch (error) {
      console.error(
        `Hive settled mail for ${recipient} but could not raise the next mail-ready event: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
}

/** Reports the mailbox without changing it. A lapsed lease is reported as expired rather than swept, because the sweep is the daemon's job and a status call that quietly performed it would hide how long recovery actually took. */
export function hiveMailStatus(
  deps: MailBrokerDeps,
  actor: MailActor,
  request: unknown,
  now: Date,
): MailStatusResult {
  const input = parseRequest(MailStatusRequestSchema, request);
  const recipient = actingAs(deps, actor, input.recipient);
  const at = now.toISOString();
  const leases = deps.store.listLeases(recipient).map((lease) => ({
    itemId: lease.itemId,
    handlerId: lease.handlerId,
    ownerGeneration: lease.ownerGeneration,
    leaseUntil: lease.leaseUntil,
    expired: lease.leaseUntil <= at,
  }));
  const laneStatus = (lane: MailLane) => ({
    available: deps.store.countByState(recipient, lane, "available"),
    leased: deps.store.countByState(recipient, lane, "leased"),
    leasedExpired: leases.filter(
      (lease) =>
        lease.expired && deps.store.getItem(lease.itemId)?.lane === lane,
    ).length,
  });
  const oldest = deps.store.oldestAvailable(recipient);
  const deadLetters = deps.store.listDeadLetters(recipient);
  const byReason: Record<string, number> = {};
  for (const letter of deadLetters) {
    byReason[letter.reason] = (byReason[letter.reason] ?? 0) + 1;
  }
  return MailStatusResultSchema.parse({
    recipient,
    observedAt: at,
    lanes: { control: laneStatus("control"), work: laneStatus("work") },
    oldestAvailable:
      oldest === null
        ? null
        : {
            itemId: oldest.itemId,
            lane: oldest.lane,
            topic: oldest.topic,
            ageSeconds: ageSeconds(oldest.createdAt, now),
          },
    leases,
    deadLetters: {
      total: deadLetters.length,
      byReason,
      recent: deadLetters.slice(-5).map((letter) => ({
        itemId: letter.itemId,
        reason: letter.reason,
        quarantinedAt: letter.quarantinedAt,
      })),
    },
  });
}

/** Applies the deadlines that have passed, for every mailbox. The cutover wires this to the daemon's existing sweep cadence. It is a separate entry point rather than something a read does on the way past, which is what keeps `hive_mail_poll` and `hive_mail_status` read-only. */
export function sweepMailDeadlines(
  store: MailStore,
  now: Date,
  maxAttempts = MAIL_MAX_ATTEMPTS,
): MailRelease[] {
  const at = now.toISOString();
  return [
    ...store.sweepExpiredLeases(at, maxAttempts),
    ...store.sweepExpiredItems(at),
  ];
}
