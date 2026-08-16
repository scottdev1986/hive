import { isOrchestratorName } from "../schemas/agent";
import type { Action, Capability } from "../schemas/authority";
import type { MailLane } from "../schemas/mail";
import { systemClock } from "../shared/clock";
import { toolResult } from "../shared/mcp-tool-result";
import type { MailActor, MailRecipientResolver, MailService } from "./service";
import { MailEvidenceError, type MailWakeLedger } from "./wake-ledger";

/** The live incarnation generation bound to a subject right now, or null when nothing is bound to that name. This is the capability layer's answer, not the hierarchy binding's. Hive keeps two generation counters with two different writers, and they agree until they do not; the broker fences on exactly one of them, and this is where that one is read. */
export type MailLiveGenerationLookup = (subject: string) => number | null;

export interface MailToolDeps {
  /** The mailbox itself. It arrives already built rather than assembled here, so the tool boundary and the daemon's own senders act through one instance. */
  service: MailService;
  wake: Pick<
    MailWakeLedger,
    | "recordPresented"
    | "recordClaimed"
    | "recordSettled"
    | "repairPublished"
    | "deliveryChain"
  >;
  /** Resolves an addressed name to the mailbox it files under, or refuses it. */
  recipients: MailRecipientResolver;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  liveGeneration: MailLiveGenerationLookup;
  now?: () => Date;
  /** True when repo memory already cites this itemId. Absent, the complete path does not look at memory. */
  requireRulingRecord?: (itemId: string) => Promise<boolean>;
}

export class MailSubjectUnboundError extends Error {
  readonly code = "MAIL_SUBJECT_UNBOUND";

  constructor(subject: string) {
    super(
      `MAIL_SUBJECT_UNBOUND: no live agent is bound to ${subject}, so no ` +
        "generation can be authenticated for its mailbox",
    );
    this.name = "MailSubjectUnboundError";
  }
}

export class MailRulingRequiredError extends Error {
  readonly code = "MAIL_RULING_REQUIRED";

  constructor(itemId: string) {
    super(
      `MAIL_RULING_REQUIRED: owner control item ${itemId} cannot be completed until a repo memory article cites that itemId in evidence or body. memory_write the ruling first.`,
    );
    this.name = "MailRulingRequiredError";
  }
}

export class MailGenerationRefusedError extends Error {
  readonly code = "MAIL_GENERATION_REFUSED";

  constructor(recipient: string, addressed: number, live: number) {
    super(
      `MAIL_GENERATION_REFUSED: ${recipient} is at generation ${live}, not ` +
        `${addressed}. The publish was refused rather than accepted and ` +
        "quarantined on claim; re-send with addressedGeneration null (any " +
        "generation) or the recipient's current one.",
    );
    this.name = "MailGenerationRefusedError";
  }
}

/** The tool-boundary half of the mailbox: authenticate, then call the broker. The generation an operation runs under is resolved here, from the live binding, and never taken from the request body — a caller that could name its own generation could hand itself a message addressed to the incarnation it replaced. The store binds whatever value arrives inside its own writes, so a mistake here is caught twice rather than trusted once. Nothing in this file registers anything; `registerMailTools` does that, and this owns no mail state of its own — it authenticates and delegates. */
export class MailTools {
  private readonly now: () => Date;

  constructor(private readonly deps: MailToolDeps) {
    this.now = deps.now ?? systemClock;
  }

  publish(capability: Capability, request: unknown) {
    // `from` is a claim about identity, so it is checked against the bound subject rather than trusted; the broker refuses the mismatch again.
    this.deps.authorizeTool(
      capability,
      "hive_mail_publish",
      "message:send",
      namedField(request, "from"),
    );
    this.refuseDoomedGeneration(request);
    return toolResult(
      this.deps.service.publish(this.actor(capability), request, this.now()),
      "mail",
    );
  }

  poll(capability: Capability, request: unknown) {
    this.deps.authorizeTool(
      capability,
      "hive_mail_poll",
      "inbox:read",
      namedField(request, "recipient"),
    );
    const at = this.now();
    const mail = this.deps.service.poll(this.actor(capability), request, at);
    const result = toolResult(mail, "mail");
    if (mail.control !== null) {
      this.present(
        mail.recipient,
        "control",
        mail.control.itemId,
        mail.control.seq,
        `hive_mail_poll:seq:${mail.control.seq}:attempt:${mail.control.attempts}`,
        at,
      );
    }
    // Every entry the digest returned, for the same reason the control offer is recorded: `hive_mail_claim` refuses an item this recipient was not shown, so a digest that presented without recording it would leave the body it advertised unreachable. The reference says digest, because a digest entry is the header rather than the body.
    for (const entry of mail.workDigest) {
      this.present(
        mail.recipient,
        "work",
        entry.itemId,
        entry.seq,
        `hive_mail_poll:digest:seq:${entry.seq}:merged:${entry.mergedCount}`,
        at,
      );
    }
    return result;
  }

  claim(capability: Capability, request: unknown) {
    this.deps.authorizeTool(
      capability,
      "hive_mail_claim",
      "message:read",
      namedField(request, "recipient"),
    );
    const at = this.now();
    const actor = this.actor(capability);
    this.presentCurrentOffer(capability, request, at);
    const mail = this.deps.service.claim(actor, request, at);
    this.deps.wake.recordClaimed({
      itemId: mail.itemId,
      recipient: this.canonicalRecipient(capability),
      handlerId: mail.handlerId,
      at: at.toISOString(),
    });
    return toolResult(mail, "mail");
  }

  async complete(capability: Capability, request: unknown) {
    this.deps.authorizeTool(
      capability,
      "hive_mail_complete",
      "message:ack",
      namedField(request, "recipient"),
    );
    await this.requireOwnerRuling(capability, request);
    const at = this.now();
    const mail = this.deps.service.complete(
      this.actor(capability),
      request,
      at,
    );
    this.deps.wake.recordSettled({
      itemId: mail.itemId,
      recipient: this.canonicalRecipient(capability),
      disposition: mail.disposition,
      at: mail.settledAt,
    });
    return toolResult(mail, "mail");
  }

  status(capability: Capability, request: unknown) {
    this.deps.authorizeTool(
      capability,
      "hive_mail_status",
      "inbox:read",
      namedField(request, "recipient"),
    );
    return toolResult(
      this.deps.service.status(this.actor(capability), request, this.now()),
      "mail",
    );
  }

  /** Completing an owner or user control message to queen is accepting a ruling. Deferred and rejected skip this: they did not accept it. Agent-to-queen mail is not a user ruling. */
  private async requireOwnerRuling(
    capability: Capability,
    request: unknown,
  ): Promise<void> {
    if (this.deps.requireRulingRecord === undefined) return;
    if (namedField(request, "disposition") !== "completed") return;
    const itemId = namedField(request, "itemId");
    if (itemId === undefined) return;
    const item = this.deps.service.store.getItem(itemId);
    if (item === null) return;
    if (item.lane !== "control") return;
    if (item.sender !== "user" && item.sender !== "owner") return;
    if (!isOrchestratorName(this.canonicalRecipient(capability))) return;
    if (!isOrchestratorName(item.recipient)) return;
    const cited = await this.deps.requireRulingRecord(itemId);
    if (!cited) throw new MailRulingRequiredError(itemId);
  }

  /** The subject and generation this call runs as. A capability that names an agent with no live binding gets no generation rather than a default one: zero is a real generation, and handing it out as "we could not tell" would let an unbound caller claim mail addressed to the first incarnation. */
  private actor(capability: Capability): MailActor {
    const generation = this.deps.liveGeneration(capability.subject);
    if (generation === null) {
      throw new MailSubjectUnboundError(capability.subject);
    }
    return { subject: capability.subject, agentGeneration: generation };
  }

  private canonicalRecipient(capability: Capability): string {
    const recipient = this.deps.recipients(capability.subject);
    return recipient.kind === "live" ? recipient.canonical : capability.subject;
  }

  /** Refuses a publish already known to be undeliverable. A non-null addressedGeneration is a claim about the recipient's live incarnation. When the daemon can see that claim is already false, accepting the envelope would hand the sender a durable receipt for a message the first claim will quarantine — a success that means failure. Refusing here tells the sender while it can still re-send. A recipient whose generation cannot be looked up is accepted as before: an absent field is unknown, and unknown is not false. */
  private refuseDoomedGeneration(request: unknown): void {
    // Only the control lane addresses a generation at all; a work-lane envelope carrying one is the broker's own refusal, not this one.
    if (namedField(request, "lane") !== "control") return;
    const addressed = generationField(request, "addressedGeneration");
    if (addressed === undefined) return;
    const named = namedField(request, "to");
    if (named === undefined) return;
    const resolved = this.deps.recipients(named);
    if (resolved.kind !== "live") return;
    const live = this.deps.liveGeneration(resolved.canonical);
    if (live === null || live === addressed) return;
    throw new MailGenerationRefusedError(resolved.canonical, addressed, live);
  }

  /** A live mailbox head is itself the presentation. hive_mail_claim used to refuse unless hive_mail_poll had already written mail_presented, so a wake that named the item (or a model that claimed the current offer first) died two seconds before the poll landed. Only the lane's current head is treated as shown — a digest-withheld sibling stays unclaimable. */
  private presentCurrentOffer(
    capability: Capability,
    request: unknown,
    at: Date,
  ): void {
    const itemId = namedField(request, "itemId");
    if (itemId === undefined) return;
    const recipient = this.canonicalRecipient(capability);
    const item = this.deps.service.store.getItem(itemId);
    if (item === null || item.recipient !== recipient) return;
    const head = this.deps.service.store
      .listAvailable(recipient, item.lane, 0, 1, at.toISOString())
      .at(0);
    if (head?.itemId !== itemId) return;
    if (
      this.deps.wake
        .deliveryChain(itemId)
        .some((row) => row.state === "mail_presented")
    ) {
      return;
    }
    this.present(
      recipient,
      item.lane,
      item.itemId,
      item.seq,
      `hive_mail_claim:seq:${item.seq}`,
      at,
    );
  }

  /** Records one offered item's presentation, repairing the one break that is safe to repair. The publish notification path is best-effort, so an offered item can be missing the `published` row its presentation requires. The broker's offer is itself the publish receipt, so the row is rewritten from the sequence number the poll is already holding and the presentation is retried. Any other failure — and a repair that still fails — is logged and skipped rather than thrown: evidence bookkeeping must never make the mailbox itself unreadable, but it must never fail silently either, so every skip leaves a line naming the item. */
  private present(
    recipient: string,
    lane: MailLane,
    itemId: string,
    brokerSeq: number,
    pollResponseRef: string,
    at: Date,
  ): void {
    const input = { itemId, recipient, pollResponseRef, at: at.toISOString() };
    try {
      this.deps.wake.recordPresented(input);
      return;
    } catch (error) {
      if (!isMissingPublication(error)) throw error;
    }
    try {
      this.deps.wake.repairPublished({
        itemId,
        recipient,
        lane,
        brokerSeq,
        at: at.toISOString(),
      });
      this.deps.wake.recordPresented(input);
      console.error(
        `Hive mail repaired the missing published row for ${itemId} ` +
          `(${recipient}, broker seq ${brokerSeq}) before presenting it`,
      );
    } catch (error) {
      if (!(error instanceof MailEvidenceError)) throw error;
      console.error(
        `Hive mail skipped presentation evidence for ${itemId} ` +
          `(${recipient}): ${error.message}`,
      );
    }
  }
}

/** The one refusal a poll may repair: presentation refused because the item's delivery chain lacks the `published` row. Anything else the evidence layer raises is a condition nobody diagnosed, and it must surface rather than be swallowed here. */
const isMissingPublication = (error: unknown): error is MailEvidenceError =>
  error instanceof MailEvidenceError && error.state === "mail_presented";

/** The subject a request names, for the capability layer to compare against the bound one. A field of the wrong type reads as absent rather than being coerced: the broker parses the request properly a moment later, and a name invented here to fill a gap would be a name nobody asked for. */
function namedField(request: unknown, field: string): string | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const value = (request as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/** The numeric field a request names, for the doomed-generation check. Same discipline as namedField: a value of the wrong type reads as absent, and the broker's schema parse is what properly refuses it a moment later. */
function generationField(request: unknown, field: string): number | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const value = (request as Record<string, unknown>)[field];
  return typeof value === "number" ? value : undefined;
}
