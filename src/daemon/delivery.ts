import { getAgentAdapter } from "../adapters/providers/provider-registry";
import {
  type AgentMessage,
  AgentMessageSchema,
  type AgentRecord,
  type ControlIntent,
  canonicalOrchestratorName,
  isOrchestratorName,
  type MessagePriority,
  ORCHESTRATOR_NAME,
  type OrchestratorMessageEnvelope,
  orchestratorRecipientNames,
  type ProviderRun,
} from "../schemas";
import { isComposerLeased } from "./composer-lease";
import {
  buildNormalMessageBatchProjection,
  MESSAGE_BATCH_MAX_MESSAGES,
} from "./context-projection";
import type { HiveDatabase } from "./db";
import type { ComposedMemoryDelta, WakeDeltaProvider } from "./memory-delta";
import {
  detectMemoryTrigger,
  type MemoryTriggerExecutor,
  memoryTriggerAuthority,
} from "./memory-triggers";
import {
  createOrchestratorEnvelope,
  formatOrchestratorWake,
  orchestratorSessionKey,
} from "./orchestrator-lifecycle";
import type { PaneProcessState } from "./resources";
import type { InputReceipt } from "./session-host/contract";
import { requireSessiondAgentLocator } from "./session-host/hive-terminal-host";
import {
  encodeSubmittedText,
  type SessiondAgentInput,
  type SessiondInjectResult,
} from "./session-host/sessiond-agent-input";

/** Senders to probe for idempotency: root aliases during the rename window. */
function idempotencySenders(from: string): readonly string[] {
  return isOrchestratorName(from) ? orchestratorRecipientNames() : [from];
}

function agentSessionLockKey(agent: AgentRecord): string {
  const locator = agent.sessionLocator;
  if (locator === undefined) return `agent:${agent.id}`;
  return [
    locator.instanceId,
    locator.subject.kind === "root" ? "root" : locator.subject.agentId,
    locator.generation,
    locator.sessionId,
  ].join(":");
}

export interface SessionSender {
  sendSessionMessage(
    recipient: AgentRecord,
    text: string,
    options: { messageId: string; interrupt?: boolean },
    // biome-ignore lint/suspicious/noConfusingVoidType: Implementations may intentionally return no receipt.
  ): Promise<InputReceipt | void>;
}

/**
 * Why a root wake did not land, or that it did.
 *
 * Not a bare `boolean`: the deliverer knows precisely which gate refused —
 * a changed foreground, an input claim held by someone else, a host that is
 * not running — and one bit would throw all of it away one call before the
 * row that exists to record it. A refusal must carry its reason; a delivery
 * has none to carry, so the shape makes that unrepresentable.
 */
export type RootDeliveryOutcome =
  | { delivered: true }
  | { delivered: false; reason: string };

export interface RootProtocolDeliverer {
  isLive(): boolean;
  deliverMessage(
    content: string,
    meta: Record<string, string>,
  ): Promise<RootDeliveryOutcome>;
}

export interface SendOptions {
  priority?: MessagePriority;
  intent?: ControlIntent;
  idempotencyKey?: string;
  deadlineMs?: number;
}

/**
 * What "queued" means for THIS recipient right now — measured, not implied.
 *
 * A sender reading state "queued" can take it as "will arrive shortly" and
 * be wrong: a normal message to a busy recipient mid-turn is delivered only
 * at its next turn boundary, and a deep agent's next boundary routinely
 * falls AFTER the work the message was trying to steer. The note rides the
 * send result so the sender learns the recipient's real state at the only
 * moment it can still act, not from a post-mortem.
 */
export function queuedDeliveryNote(
  message: AgentMessage,
  recipient: AgentRecord | null,
): string | undefined {
  if (message.state !== "queued") return undefined;
  // Root recipient (queen) has no agent row. Say what queued means for the
  // root and where the wake's failure cause is recorded.
  if (recipient === null && isOrchestratorName(message.to)) {
    return (
      "NOT received: queen was not woken. The daemon injects a wake " +
      "envelope into the root session on every send and on the root's turn " +
      "boundaries; if this stays queued, the message row's deliveryDiagnostic " +
      "records why the last wake attempt did not deliver. Do not re-send — " +
      "the message is durable and retried."
    );
  }
  if (recipient === null) return undefined;
  // A critical control left queued has already raised its own loud alert
  // through the restart-failure path.
  if (message.priority === "critical") return undefined;
  const name = recipient.name;
  if (message.priority === "urgent") {
    return (
      `NOT stopped: ${name}'s terminal turn has not been cancelled; Hive has ` +
      "no provider-native cancel surface in terminal-first mode."
    );
  }
  switch (recipient.status) {
    case "dead":
    case "failed":
    case "done":
      return `NOT received: ${name} is ${recipient.status}, so this message will never be delivered.`;
    case "spawning":
      return `NOT received yet: ${name} is still spawning; the message is delivered when its session starts.`;
    case "idle":
      // The sessiond viewer wire delivers to an idle sessiond-hosted agent;
      // the wake loop retries every maintenance tick. Say what actually
      // happens and where the cause of a stuck row is recorded.
      if (recipient.sessionLocator?.hostKind === "sessiond") {
        return (
          `NOT received yet: ${name} is idle in a sessiond-hosted terminal; the daemon ` +
          "injects queued mail over the viewer wire on its next maintenance tick (the idle " +
          "wake) and at any turn boundary. If it stays queued, the message row's " +
          "deliveryDiagnostic records why the last attempt did not deliver " +
          "(e.g. a human holds the input claim — never stolen). " +
          "Treat it as unheard until a turn confirms it."
        );
      }
      return (
        `NOT received: the paste into ${name}'s pane was never submitted (no turn started), ` +
        `so the message stays queued and the daemon retries it on its next maintenance tick ` +
        `(the idle wake), as well as at any turn boundary ${name} reaches. ` +
        "Treat it as unheard until a turn confirms it."
      );
    case "awaiting-approval":
      return (
        `NOT received yet: ${name} is blocked on a pending approval and hears nothing until it resolves; ` +
        "the message is delivered at the next turn boundary after that."
      );
    default:
      // working, control-paused, stuck: mid-turn shapes.
      return message.priority === "steer"
        ? reportsTurnEvents(recipient.tool)
          ? `NOT received yet: ${name} is mid-turn; steer traffic is injected without cancellation ` +
            "at its next tool call, then confirmed by the following tool boundary."
          : `NOT received yet: ${name}'s ${recipient.tool} session exposes no non-destructive ` +
            "mid-turn injection boundary, so steer degrades to normal and arrives when the current turn ends."
        : `NOT received yet: ${name} is mid-turn, and a normal message is delivered only when the ` +
            "current turn ends — for a deep task that can be after the work this message means to " +
            "steer has already shipped. Use priority=steer for non-destructive mid-turn guidance, or critical " +
            "to stop the verified provider run and revoke write authority.";
  }
}

export interface CriticalControlRuntime {
  apply(agent: AgentRecord, message: AgentMessage): Promise<void>;
}

/**
 * How long a busy agent gets to acknowledge an urgent control, measured from the
 * moment it was injected rather than sent.
 *
 * The budget must cover an agent that is merely working: acknowledgement
 * waits on the in-flight tool call finishing, and a working agent routinely
 * exceeds a minute. Three minutes clears that with margin while still
 * catching an agent that has genuinely stopped listening.
 */
const DEFAULT_URGENT_DEADLINE_MS = 180_000;
const DEFAULT_CRITICAL_DEADLINE_MS = 10_000;

/**
 * How long a handed-over message may go unconfirmed before Hive says so out loud.
 *
 * A message injected into a busy TUI is submitted at the recipient's next tool
 * boundary — measured, one sat in the composer for over two minutes while the
 * model reasoned, which is normal and not a fault. So this has to clear a long
 * reasoning phase without crying wolf. Five minutes without the recipient
 * reaching a single turn boundary means the message is genuinely still waiting,
 * and that is worth one line to the orchestrator — unless the recipient is
 * demonstrably mid-turn and alive (see stalledReason), because a deep builder
 * routinely spends far longer than this inside one healthy turn.
 */
const DELIVERY_CONFIRM_DEADLINE_MS = 5 * 60_000;

/**
 * How long an OPEN turn may go without a single sign of life before "busy"
 * stops being an excuse. Every tool call refreshes the agent's lastEventAt
 * (the tool-boundary tick), so this gap is only ever the length of one
 * in-flight call — and one legitimate call can run a full test suite. Thirty
 * minutes clears any suite this repo has seen while still surfacing a wedged
 * process within the half hour rather than hours later. Deaf-from-birth
 * agents never open a turn at all and are alerted at the five-minute
 * deadline, not this one.
 */
const OPEN_TURN_SILENCE_CAP_MS = 30 * 60_000;

/**
 * How long an idle recipient gets to start a turn before we conclude its TUI
 * never took the paste. A real submission produced a turn-start in 71ms in the
 * field; five seconds is that with room for a loaded machine, and it is only
 * ever paid in full when delivery actually failed.
 */
const SUBMIT_CONFIRM_MS = 5_000;
const SUBMIT_POLL_MS = 100;

/**
 * How long a message may sit queued behind a recorded delivery failure before
 * the orchestrator is told. A non-delivery that only ever reaches a
 * /dev/null stderr stays silent for hours: the row carries its diagnostic
 * and nobody reads it. Five minutes is long enough that ordinary
 * turn-boundary waiting never trips it and short enough
 * that a wedged recipient is a visible event rather than an archaeology
 * exercise.
 */
const STUCK_DELIVERY_MS = 5 * 60_000;

export function reportsTurnEvents(tool: AgentRecord["tool"]): boolean {
  return getAgentAdapter(tool).communication.turnBoundaryEvents;
}

export class MessageDelivery {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: HiveDatabase,
    private readonly sessions: SessionSender,
    private readonly controls?: CriticalControlRuntime,
    private readonly rootProtocol?: RootProtocolDeliverer,
    private readonly timing: {
      sleep?: (ms: number) => Promise<void>;
      submitConfirmMs?: number;
    } = {},
    /** What the OS says about the recipient's pane processes — a measurement,
     * consulted before any inference from silence. Absent (tests, embedded
     * daemons), triage falls back to the silence cap alone. */
    private readonly processState?: (
      agent: AgentRecord,
    ) => Promise<PaneProcessState | "unknown">,
    private readonly composerActive: (
      recipient: string,
    ) => boolean = isComposerLeased,
    /** Daemon→idle-sessiond-agent input over the neutral viewer wire.
     * Absent → sessiond recipients stay durably queued. */
    private readonly sessiondInput?: SessiondAgentInput,
    /** Wake-delta memory injection: when present, a delivered message
     * carries the bounded memory delta since the recipient's high-water
     * mark, so recall is summoned on every wake over the send lane — no
     * vendor hook required (Grok has none). Absent (embedded daemons,
     * tests), delivery proceeds without a delta. */
    private readonly wakeDelta?: WakeDeltaProvider,
    /** Trigger protocol: queen/operator trigger words ("recall:",
     * "note this:", "document this:") execute at the daemon and their
     * labeled result replaces the delivered body — user-turn invocation
     * outranks ambient context. Agent senders carry no trigger authority;
     * their trigger-shaped text is delivered verbatim. Absent (embedded
     * daemons, tests), delivery proceeds without trigger execution. */
    private readonly memoryTriggers?: MemoryTriggerExecutor,
    /** Durable warning sink: trigger and wake-delta failures persist here
     * in addition to the console. */
    private readonly log?: (line: string) => void,
  ) {}

  private sleep(ms: number): Promise<void> {
    return (this.timing.sleep ?? ((value: number) => Bun.sleep(value)))(ms);
  }

  async send(
    from: string,
    to: string,
    body: string,
    options: SendOptions = {},
  ): Promise<AgentMessage> {
    // Preferred root address is queen; "orchestrator" (any case) is a synonym.
    // Canonicalize both ends before provenance and storage so worker-instruction
    // status and history share one root identity. Idempotency still probes every
    // root alias so a pre-rename from=orchestrator row satisfies post-upgrade
    // retries that store as queen.
    const sendersForIdempotency = idempotencySenders(from);
    from = canonicalOrchestratorName(from);
    to = canonicalOrchestratorName(to);
    if (options.idempotencyKey !== undefined) {
      const existing = this.db.findMessageByIdempotencyAmongSenders(
        sendersForIdempotency,
        options.idempotencyKey,
      );
      if (existing !== null) return existing;
    }
    const recipient =
      to === ORCHESTRATOR_NAME ? null : this.db.getAgentByName(to);
    if (
      to !== ORCHESTRATOR_NAME &&
      recipient === null &&
      !this.db.isAgentNameReserved(to)
    ) {
      throw new Error(`Recipient agent not found: ${to}`);
    }
    if (recipient !== null) {
      this.requireLiveRecipient(to);
    }
    const activeRun =
      recipient?.sessionLocator?.hostKind === "sessiond"
        ? this.db.getActiveProviderRunByTerminal(recipient.sessionLocator)
        : null;
    let priority = options.priority ?? "normal";
    const intent = options.intent ?? "instruction";
    if (["pause", "stop", "cancel", "restrict-writes"].includes(intent)) {
      priority = "critical";
    }
    if (priority === "urgent") {
      throw new Error(
        `Urgent delivery is unavailable in terminal-first mode for ${to}; use steer for guidance or critical pause/stop`,
      );
    }
    const now = new Date();
    let capabilityEpoch =
      priority === "critical" && recipient !== null
        ? recipient.capabilityEpoch + 1
        : null;
    const deadlineMs =
      options.deadlineMs ??
      (priority === "critical" ? DEFAULT_CRITICAL_DEADLINE_MS : null);
    let currentRecipient = recipient;
    let message: AgentMessage;
    try {
      message = this.db.transaction(() => {
        if (priority === "critical" && recipient !== null) {
          currentRecipient = this.db.revokeAgentCapabilities(
            to,
            now.toISOString(),
          );
          capabilityEpoch =
            currentRecipient?.capabilityEpoch ?? capabilityEpoch;
        }
        const value = AgentMessageSchema.parse({
          id: crypto.randomUUID(),
          from,
          to,
          body,
          createdAt: now.toISOString(),
          deliveredAt: null,
          priority,
          intent,
          state: "queued",
          deadlineAt:
            deadlineMs === null
              ? null
              : new Date(now.getTime() + deadlineMs).toISOString(),
          sequence: this.db.nextMessageSequence(to),
          idempotencyKey: options.idempotencyKey ?? null,
          capabilityEpoch,
        });
        return this.db.insertMessage(value);
      });
    } catch (error) {
      const existing =
        options.idempotencyKey === undefined
          ? null
          : this.db.findMessageByIdempotencyAmongSenders(
              sendersForIdempotency,
              options.idempotencyKey,
            );
      if (existing !== null) return existing;
      throw error;
    }
    if (to === ORCHESTRATOR_NAME) {
      await this.wakeOrchestrator().catch(() => undefined);
      return this.getStoredMessage(message.id);
    }

    if (priority === "critical") {
      if (currentRecipient === null || this.controls === undefined) {
        return this.getStoredMessage(message.id);
      }
      return this.withSessionLock(
        agentSessionLockKey(currentRecipient),
        async () => {
          return this.deliverCritical(
            this.getStoredMessage(message.id),
            this.requireLiveRecipient(to),
          );
        },
      );
    }

    if (recipient === null) {
      return message;
    }

    const openingTurn =
      activeRun !== null &&
      !this.db.hasMessageAttemptForProviderRun(activeRun.runId);
    if (recipient.status !== "idle" && !openingTurn) {
      return message;
    }

    return this.withSessionLock(agentSessionLockKey(recipient), async () => {
      const current = this.getStoredMessage(message.id);
      if (current.deliveredAt !== null || this.composerActive(to)) {
        return current;
      }

      // The recipient can die between the pre-insert check and this lock. The
      // message row is already durable, so leave it queued rather than failing
      // a send whose persistence already succeeded.
      if (!this.isDeliverable(this.db.getAgentByName(to))) {
        return current;
      }
      const currentRecipient = this.db.getAgentByName(to);
      const currentRun =
        currentRecipient?.sessionLocator?.hostKind === "sessiond"
          ? this.db.getActiveProviderRunByTerminal(
              currentRecipient.sessionLocator,
            )
          : null;
      const canOpenTurn =
        currentRun !== null &&
        !this.db.hasMessageAttemptForProviderRun(currentRun.runId);
      if (
        !this.isDeliverable(currentRecipient) ||
        (currentRecipient.status !== "idle" && !canOpenTurn)
      ) {
        return current;
      }
      if (currentRun !== null && this.isBatchableNormal(current)) {
        const normal = this.db
          .getUndeliveredMessages(to)
          .filter((candidate) => this.isBatchableNormal(candidate))
          .slice(0, MESSAGE_BATCH_MAX_MESSAGES);
        if (normal.length > 0) {
          await this.deliverNormalBatch(normal, currentRecipient, currentRun);
          return this.getStoredMessage(current.id);
        }
      }
      return this.deliver(current, currentRecipient);
    });
  }

  private isDeliverable(
    recipient: AgentRecord | null,
  ): recipient is AgentRecord {
    return (
      recipient !== null &&
      recipient.status !== "dead" &&
      recipient.status !== "done" &&
      recipient.status !== "failed"
    );
  }

  private isBatchableNormal(message: AgentMessage): boolean {
    return (
      message.priority === "normal" &&
      !(
        this.memoryTriggers !== undefined &&
        memoryTriggerAuthority(message.from) !== null &&
        detectMemoryTrigger(message.body) !== null
      )
    );
  }

  async flushQueued(agentName: string): Promise<AgentMessage[]> {
    if (isOrchestratorName(agentName)) {
      return this.wakeOrchestrator();
    }
    if (this.composerActive(agentName)) return [];
    const recipient = this.db.getAgentByName(agentName);
    if (
      recipient === null ||
      recipient.status === "dead" ||
      recipient.status === "done" ||
      recipient.status === "failed"
    ) {
      return [];
    }

    return this.withSessionLock(agentSessionLockKey(recipient), async () => {
      const currentRecipient = this.db.getAgentByName(agentName);
      if (
        !this.isDeliverable(currentRecipient) ||
        this.composerActive(agentName)
      ) {
        return [];
      }
      const queuedMessages = this.db.getUndeliveredMessages(agentName);
      const hasCritical = queuedMessages.some(
        (message) => message.priority === "critical",
      );
      const openingRun =
        currentRecipient.sessionLocator?.hostKind === "sessiond"
          ? this.db.getActiveProviderRunByTerminal(
              currentRecipient.sessionLocator,
            )
          : null;
      const canOpenTurn =
        openingRun !== null &&
        !this.db.hasMessageAttemptForProviderRun(openingRun.runId);
      if (!hasCritical && currentRecipient.status !== "idle" && !canOpenTurn) {
        return [];
      }

      const delivered: AgentMessage[] = [];
      for (let index = 0; index < queuedMessages.length; index += 1) {
        const queued = queuedMessages[index];
        if (queued === undefined) continue;
        try {
          const message = this.db.getMessage(queued.id);
          if (message === null || message.deliveredAt !== null) {
            continue;
          }
          if (this.composerActive(agentName)) break;
          const latestRecipient = this.db.getAgentByName(agentName);
          if (!this.isDeliverable(latestRecipient)) break;
          if (message.priority === "critical") {
            const result = await this.deliverCritical(message, latestRecipient);
            if (result.deliveredAt !== null) delivered.push(result);
            continue;
          }
          if (latestRecipient.status !== "idle" && !canOpenTurn) {
            continue;
          }
          // Rows created by older builds stay queued: terminal-first Hive has
          // no evidence that an urgent turn cancellation occurred.
          if (message.priority === "urgent") continue;
          if (this.isBatchableNormal(message)) {
            const normal: AgentMessage[] = [];
            for (
              let offset = index;
              offset < queuedMessages.length &&
              normal.length < MESSAGE_BATCH_MAX_MESSAGES;
              offset += 1
            ) {
              const candidate = queuedMessages[offset];
              if (candidate === undefined) break;
              const stored = this.db.getMessage(candidate.id);
              if (
                stored === null ||
                stored.deliveredAt !== null ||
                !this.isBatchableNormal(stored)
              )
                break;
              normal.push(stored);
            }
            const activeRun =
              latestRecipient.sessionLocator?.hostKind === "sessiond"
                ? this.db.getActiveProviderRunByTerminal(
                    latestRecipient.sessionLocator,
                  )
                : null;
            if (normal.length > 0 && activeRun !== null) {
              const results = await this.deliverNormalBatch(
                normal,
                latestRecipient,
                activeRun,
              );
              delivered.push(...results);
              index += normal.length - 1;
              if (canOpenTurn) break;
              continue;
            }
          }
          // deliver() can honestly decline (sessiond recipients);
          // only a message whose delivery actually landed counts.
          const result = await this.deliver(message, latestRecipient);
          if (result.deliveredAt !== null) delivered.push(result);
          if (canOpenTurn) break;
        } catch (error) {
          // A failed pane must not prevent later queued messages from
          // delivery, but a systemic terminal connection failure
          // dropping the whole queue must not be invisible either.
          console.error(
            `Hive failed to flush queued message ${queued.id} to ${agentName}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
      }
      return delivered;
    });
  }

  /** Urgent rows remain queued; terminal-first has no cancel proof. */
  async flushUrgent(_agentName: string): Promise<AgentMessage[]> {
    return [];
  }

  /** Deliver non-destructive guidance at a vendor-reported tool boundary. */
  async flushSteer(agentName: string): Promise<AgentMessage[]> {
    if (this.composerActive(agentName)) return [];
    const recipient = this.db.getAgentByName(agentName);
    if (!this.isDeliverable(recipient) || !reportsTurnEvents(recipient.tool))
      return [];
    const queued = this.db
      .getUndeliveredMessages(agentName)
      .filter((message) => message.priority === "steer");
    if (queued.length === 0) return [];
    return this.withSessionLock(agentSessionLockKey(recipient), async () => {
      const currentRecipient = this.db.getAgentByName(agentName);
      if (
        !this.isDeliverable(currentRecipient) ||
        this.composerActive(agentName)
      ) {
        return [];
      }
      const delivered: AgentMessage[] = [];
      for (const pending of queued) {
        const message = this.db.getMessage(pending.id);
        if (message === null || message.deliveredAt !== null) continue;
        if (this.composerActive(agentName)) break;
        try {
          // The TUI queues for the next model step, which is the mid-turn
          // surface this priority promises.
          const result = await this.deliver(message, currentRecipient);
          if (result.deliveredAt !== null) delivered.push(result);
        } catch (error) {
          console.error(
            `Hive failed to inject steer message ${message.id} to ${agentName} at a tool boundary: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
      }
      return delivered;
    });
  }

  /** The boundary after injection is receipt on Claude/Codex's hook surface. */
  confirmSteerAtToolBoundary(agentName: string, boundaryAt: string): number {
    let confirmed = 0;
    for (const message of this.db.listInjectedUnapplied()) {
      if (
        message.to === agentName &&
        message.priority === "steer" &&
        message.injectedAt !== null &&
        message.injectedAt < boundaryAt
      ) {
        this.db.transitionMessage(message.id, "applied", boundaryAt);
        confirmed += 1;
      }
    }
    return confirmed;
  }

  /**
   * Wake every live idle agent that still has mail waiting.
   *
   * Redelivery must not hang off the recipient's own activity. flushQueued
   * fires on the recipient's session-start/turn-end hook and flushSteer at a
   * tool boundary — all things a WORKING agent does. An agent that has
   * finished its task makes no more tool calls and reaches no more turn
   * boundaries, so a message enqueued while it was busy would be retried by
   * nothing once it went quiet — and the agent an orchestrator most needs to
   * redirect (the one with free capacity) would be the one it cannot reach.
   * Grok drives no lifecycle hooks at all, so none of those triggers ever
   * fires for it.
   *
   * The daemon already knows both halves — this agent is idle, this message
   * is queued — so it does the waking itself, on the maintenance tick. Each
   * vendor is woken through its terminal session, the same paste-and-submit
   * path flushQueued uses.
   */
  async wakeIdleRecipients(): Promise<AgentMessage[]> {
    const woken: AgentMessage[] = [];
    for (const agent of this.db.listAgents()) {
      const queued = this.db.getUndeliveredMessages(agent.name);
      if (queued.length === 0) continue;
      if (
        agent.status !== "idle" &&
        !queued.some((message) => message.priority === "critical")
      )
        continue;
      woken.push(...(await this.flushQueued(agent.name)));
    }
    // The root has no agents row, so the loop above skips it: without this
    // sweep, a root wake that failed at send time would be retried by nothing
    // until the next send or queen turn boundary happened to come along. A
    // failed wake self-heals on the next maintenance tick.
    if (
      orchestratorRecipientNames().some(
        (name) => this.db.getUndeliveredMessages(name).length > 0,
      )
    ) {
      woken.push(...(await this.wakeOrchestrator()));
    }
    return woken;
  }

  async inbox(agentName: string): Promise<AgentMessage[]> {
    // The pull path must hold the same per-session lane as every push path
    // (send/flushQueued/deliver): a push that has read a row as undelivered
    // but not yet pasted it must finish before a poll can claim that row, or
    // the agent receives the payload twice — once pushed, once pulled.
    const recipient = this.db.getAgentByName(agentName);
    const claim = () => {
      const deliveredAt = new Date().toISOString();
      // Handing a row to a poller proves injection and nothing more, exactly as
      // on the push path (see markInjected). Do not mark a normal message
      // "applied" here: the only evidence is that the row was FETCHED, and
      // "applied" with injectedAt still null is a state the lifecycle cannot
      // otherwise produce — one that also hides the row from
      // listInjectedUnapplied (which requires injectedAt), so it could never
      // be reconciled or alerted on. "applied" is earned in
      // reconcileInjected, on a real turn boundary.
      return this.db
        .claimUndeliveredMessages(agentName, deliveredAt)
        .map((message) =>
          this.requireMessageTransition(message.id, "injected", deliveredAt),
        );
    };
    if (recipient === null) return claim();
    return this.withSessionLock(agentSessionLockKey(recipient), async () =>
      claim(),
    );
  }

  async orchestratorInbox(): Promise<OrchestratorMessageEnvelope[]> {
    return this.withSessionLock(orchestratorSessionKey(), async () => {
      const deliveredAt = new Date().toISOString();
      // Drain preferred and synonym keys so pre-rename messages still surface.
      const claimed = orchestratorRecipientNames().flatMap((name) =>
        this.db.claimUndeliveredMessages(name, deliveredAt),
      );
      // Same rule for the root: a drained row is injected, not applied.
      // reconcileInjected confirms these against `turnBoundaryAt`, the surface
      // that actually records the root's turns. Claiming "applied" here would
      // bypass that confirmation and leave injectedAt null, hiding the row
      // from every reconciliation path.
      return claimed.map((message) => {
        const injected = this.requireMessageTransition(
          message.id,
          "injected",
          message.deliveredAt ?? deliveredAt,
        );
        return createOrchestratorEnvelope(injected);
      });
    });
  }

  readOrchestratorMessage(id: string): AgentMessage | null {
    const message = this.db.getMessage(id);
    return message !== null && isOrchestratorName(message.to) ? message : null;
  }

  async wakeOrchestrator(): Promise<AgentMessage[]> {
    if (this.rootComposerActive()) return [];
    return this.withSessionLock(orchestratorSessionKey(), async () => {
      if (this.rootComposerActive()) return [];
      const delivered: AgentMessage[] = [];
      for (const name of orchestratorRecipientNames()) {
        for (const message of this.db.getUndeliveredMessages(name)) {
          if (this.rootComposerActive()) return delivered;
          // Per-message isolation: one message whose wake throws must not
          // starve every message behind it — a single unisolated failure at
          // the head of this loop delivers the whole queue as zero, and the
          // caller's catch buries it. The failure is recorded on the row
          // instead of thrown past the queue.
          let injected: AgentMessage | null = null;
          try {
            injected = await this.deliverRoot(message);
          } catch (error) {
            this.db.recordMessageDeliveryDiagnostic(
              message.id,
              `root wake failed: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
              new Date().toISOString(),
            );
          }
          if (injected !== null) delivered.push(injected);
        }
      }
      return delivered;
    });
  }

  /** Preferred or synonym lease blocks root injection — Workspace may still
   * write either marker during the rename window. */
  private rootComposerActive(): boolean {
    return orchestratorRecipientNames().some((name) =>
      this.composerActive(name),
    );
  }

  private async deliverRoot(
    message: AgentMessage,
  ): Promise<AgentMessage | null> {
    // Every non-delivery records WHY on the row: between a /dev/null stderr
    // and a blind catch there is no surface left that can say which gate
    // refused.
    if (this.rootComposerActive()) {
      this.db.recordMessageDeliveryDiagnostic(
        message.id,
        "root wake skipped: the root composer is leased (a human is typing)",
        new Date().toISOString(),
      );
      return null;
    }
    if (this.rootProtocol?.isLive() !== true) {
      this.db.recordMessageDeliveryDiagnostic(
        message.id,
        "root wake skipped: no live root delivery protocol",
        new Date().toISOString(),
      );
      return null;
    }
    let outcome: RootDeliveryOutcome;
    try {
      outcome = await this.rootProtocol.deliverMessage(
        formatOrchestratorWake(createOrchestratorEnvelope(message)),
        {
          sender: message.from,
          message_id: message.id,
          sequence: String(message.sequence),
        },
      );
    } catch (error) {
      this.db.recordMessageDeliveryDiagnostic(
        message.id,
        `root wake failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        new Date().toISOString(),
      );
      return null;
    }
    if (!outcome.delivered) {
      this.db.recordMessageDeliveryDiagnostic(
        message.id,
        `root wake declined: ${outcome.reason}`,
        new Date().toISOString(),
      );
      return null;
    }
    const now = new Date().toISOString();
    const injected = this.db.markMessageDelivered(message.id, now);
    if (injected === null) {
      throw new Error(
        `Message disappeared during root delivery: ${message.id}`,
      );
    }
    return this.requireMessageTransition(message.id, "injected", now);
  }

  private async deliverCritical(
    message: AgentMessage,
    recipient: AgentRecord,
  ): Promise<AgentMessage> {
    if (this.controls === undefined) {
      return this.getStoredMessage(message.id);
    }
    try {
      await this.controls.apply(recipient, message);
    } catch (error) {
      const alertedAt = new Date().toISOString();
      this.db.markMessageAlerted(message.id, alertedAt);
      await this.send(
        "hive-control",
        ORCHESTRATOR_NAME,
        `Critical control ${message.id} revoked ${message.to}'s capability epoch but the control action failed: ${
          error instanceof Error ? error.message : "unknown error"
        }. The message remains queued and automatic recovery will not retry this control. The terminal and worktree were preserved; operator attention is required.`,
        { idempotencyKey: `control-restart-failed:${message.id}` },
      ).catch(() => undefined);
      return this.getStoredMessage(message.id);
    }
    return this.markInjected(message);
  }

  /**
   * Execute an authorized memory trigger and return
   * the text that should replace this message's formatted body: the labeled
   * recall results or write confirmation. Null means deliver the body as
   * formatted — no trigger phrase, or a sender without trigger authority
   * (agent trigger-shaped text is verbatim message content, never executed).
   *
   * Failure-isolated like every other memory path: a trigger that throws
   * must never drop or block the message, so the original text goes out with
   * a visible note that the trigger failed.
   */
  private async composeTriggerReplacement(
    message: AgentMessage,
  ): Promise<string | null> {
    if (this.memoryTriggers === undefined) return null;
    try {
      return await this.memoryTriggers.execute(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      const line =
        `Hive memory trigger in message ${message.id} (${message.from} → ${message.to}) ` +
        `failed; delivering the original text: ${detail}`;
      console.error(line);
      this.log?.(line);
      return (
        `${this.formatAgentMessage(message)}\n\n` +
        `⚠️ Hive memory trigger failed (${detail}); ` +
        "the original message is delivered unmodified."
      );
    }
  }

  /**
   * Compose the recipient's wake-delta block. A delta
   * failure must never block message delivery — the plain message goes out
   * and the failure is logged, the same failure-isolation posture as every
   * other memory maintenance path.
   */
  private async composeWakeDelta(
    recipient: AgentRecord,
  ): Promise<ComposedMemoryDelta | null> {
    if (this.wakeDelta === undefined) return null;
    try {
      return await this.wakeDelta.compose(recipient);
    } catch (error) {
      const line = `Hive memory wake-delta for ${recipient.name} failed; delivering without it: ${
        error instanceof Error ? error.message : "unknown error"
      }`;
      console.error(line);
      this.log?.(line);
      return null;
    }
  }

  /** Advance the recipient's high-water mark — called only after the delta
   * actually landed, so a failed delivery never silently skips the changes
   * its delta carried. A failure here is safe: the next wake simply re-shows
   * the same delta. */
  private advanceWakeDelta(
    recipient: AgentRecord,
    delta: ComposedMemoryDelta | null,
  ): void {
    if (delta === null || this.wakeDelta === undefined) return;
    try {
      this.wakeDelta.advance(recipient, delta.advanceTo);
    } catch (error) {
      const line = `Hive could not advance ${recipient.name}'s memory high-water mark: ${
        error instanceof Error ? error.message : "unknown error"
      }`;
      console.error(line);
      this.log?.(line);
    }
  }

  private async deliverNormalBatch(
    messages: readonly AgentMessage[],
    recipient: AgentRecord,
    activeRun: ProviderRun,
  ): Promise<AgentMessage[]> {
    if (this.composerActive(recipient.name)) return [];
    const projection = buildNormalMessageBatchProjection(
      messages,
      activeRun.runId,
    );
    const delta = await this.composeWakeDelta(recipient);
    const text =
      delta === null ? projection.body : `${projection.body}\n\n${delta.block}`;

    if (this.sessiondInput !== undefined) {
      const terminal = requireSessiondAgentLocator(recipient);
      if (this.processState !== undefined) {
        const state = await this.processState(recipient).catch(
          () => "unknown" as const,
        );
        if (state !== "running") {
          const at = new Date().toISOString();
          for (const message of messages) {
            this.db.recordMessageDeliveryDiagnostic(
              message.id,
              `sessiond inject declined: provider foreground state is ${state}`,
              at,
            );
          }
          return [];
        }
      }
      const attempts = messages.map((message) =>
        this.db.beginMessageAttempt({
          attemptId: crypto.randomUUID(),
          messageId: message.id,
          expectedProviderRunId: activeRun.runId,
          terminalGeneration: terminal.generation,
          expectedForeground: {
            pid: activeRun.pid,
            startToken: activeRun.startToken,
            processGroupId: activeRun.foregroundProcessGroupId,
          },
          attemptedAt: new Date().toISOString(),
        }),
      );
      let result: SessiondInjectResult;
      try {
        result = await this.sessiondInput.writeAutomated({
          terminal,
          expectedForeground: {
            providerRunId: activeRun.runId,
            pid: activeRun.pid,
            startToken: activeRun.startToken,
            processGroupId: activeRun.foregroundProcessGroupId,
          },
          bytes: encodeSubmittedText(text),
          idempotencyKey: projection.projectionId,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        const at = new Date().toISOString();
        for (const attempt of attempts) {
          this.db.finishMessageAttempt(attempt.attemptId, {
            outcome: detail.includes("timed out") ? "timeout" : "unknown",
            terminalReceipt: null,
          });
          this.db.recordMessageDeliveryDiagnostic(
            attempt.messageId,
            `sessiond inject failed: ${detail}`,
            at,
          );
        }
        return [];
      }
      if (result.outcome === "declined") {
        const at = new Date().toISOString();
        for (const attempt of attempts) {
          this.db.finishMessageAttempt(attempt.attemptId, {
            outcome: result.reason.includes("foreground-changed")
              ? "foreground-changed"
              : result.reason.startsWith("claim ")
                ? "input-busy"
                : "unknown",
            terminalReceipt: result.receipt ?? null,
          });
          this.db.recordMessageDeliveryDiagnostic(
            attempt.messageId,
            `sessiond inject declined: ${result.reason}`,
            at,
          );
        }
        return [];
      }
      for (const attempt of attempts) {
        this.db.finishMessageAttempt(attempt.attemptId, {
          outcome: "written",
          terminalReceipt: result.receipt,
        });
      }
      const delivered = messages.map((message) => this.markInjected(message));
      this.advanceWakeDelta(recipient, delta);
      if (result.recovery !== undefined) {
        const at = new Date().toISOString();
        for (const message of messages) {
          this.db.recordMessageDeliveryDiagnostic(
            message.id,
            `sessiond inject recovered: ${result.recovery}`,
            at,
          );
        }
      }
      return delivered;
    }

    const boundaryBefore = this.turnBoundaryAt(recipient.name);
    await this.sessions.sendSessionMessage(recipient, text, {
      messageId: projection.projectionId,
    });
    const live = this.db.getAgentByName(recipient.name) ?? recipient;
    if (
      live.status === "idle" &&
      reportsTurnEvents(live.tool) &&
      !(await this.turnStarted(recipient.name, boundaryBefore))
    ) {
      return [];
    }
    const delivered = messages.map((message) => this.markInjected(message));
    this.advanceWakeDelta(recipient, delta);
    return delivered;
  }

  private async deliver(
    message: AgentMessage,
    recipient: AgentRecord,
  ): Promise<AgentMessage> {
    if (this.composerActive(message.to))
      return this.getStoredMessage(message.id);
    // Trigger protocol: an authorized queen/operator
    // trigger executes at the daemon and its labeled result REPLACES the
    // message body — the trigger is a command, not content for the agent.
    const replacement = await this.composeTriggerReplacement(message);
    const base =
      replacement === null ? this.formatAgentMessage(message) : replacement;
    // Wake-delta injection: the delta rides whatever
    // text this delivery sends, visibly labeled as system-injected memory so
    // it can never be mistaken for the sender's words. Composed once per
    // attempt; the high-water mark advances only after the delivery lands.
    const delta = await this.composeWakeDelta(recipient);
    const text = delta === null ? base : `${base}\n\n${delta.block}`;
    // Production input uses the terminal host's viewer wire. A declined claim
    // leaves the durable message queued and records the exact reason.
    if (this.sessiondInput !== undefined) {
      const terminal = requireSessiondAgentLocator(recipient);
      const activeRun = this.db.getActiveProviderRunByTerminal(terminal);
      if (activeRun === null) {
        this.db.recordMessageDeliveryDiagnostic(
          message.id,
          "sessiond inject declined: no active provider run",
          new Date().toISOString(),
        );
        return this.getStoredMessage(message.id);
      }
      if (this.processState !== undefined) {
        const state = await this.processState(recipient).catch(
          () => "unknown" as const,
        );
        if (state !== "running") {
          this.db.recordMessageDeliveryDiagnostic(
            message.id,
            `sessiond inject declined: provider foreground state is ${state}`,
            new Date().toISOString(),
          );
          return this.getStoredMessage(message.id);
        }
      }
      // Every non-delivery on this branch records WHY on the message row:
      // a diagnostic that only reaches a /dev/null stderr leaves silent
      // retries with indistinguishable causes. A row that stays queued must
      // carry its own explanation.
      const attempt = this.db.beginMessageAttempt({
        attemptId: crypto.randomUUID(),
        messageId: message.id,
        expectedProviderRunId: activeRun.runId,
        terminalGeneration: terminal.generation,
        expectedForeground: {
          pid: activeRun.pid,
          startToken: activeRun.startToken,
          processGroupId: activeRun.foregroundProcessGroupId,
        },
        attemptedAt: new Date().toISOString(),
      });
      let result: SessiondInjectResult;
      try {
        result = await this.sessiondInput.writeAutomated({
          terminal,
          expectedForeground: {
            providerRunId: activeRun.runId,
            pid: activeRun.pid,
            startToken: activeRun.startToken,
            processGroupId: activeRun.foregroundProcessGroupId,
          },
          bytes: encodeSubmittedText(text),
          idempotencyKey: attempt.attemptId,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        this.db.finishMessageAttempt(attempt.attemptId, {
          outcome: detail.includes("timed out") ? "timeout" : "unknown",
          terminalReceipt: null,
        });
        console.error(
          `Hive could not inject message ${message.id} into ${message.to}'s terminal ` +
            `(${detail}); leaving it queued.`,
        );
        this.db.recordMessageDeliveryDiagnostic(
          message.id,
          `sessiond inject failed: ${detail}`,
          new Date().toISOString(),
        );
        return this.getStoredMessage(message.id);
      }
      if (result.outcome === "declined") {
        this.db.finishMessageAttempt(attempt.attemptId, {
          outcome: result.reason.includes("foreground-changed")
            ? "foreground-changed"
            : result.reason.startsWith("claim ")
              ? "input-busy"
              : "unknown",
          terminalReceipt: result.receipt ?? null,
        });
        this.db.recordMessageDeliveryDiagnostic(
          message.id,
          `sessiond inject declined: ${result.reason}`,
          new Date().toISOString(),
        );
        return this.getStoredMessage(message.id);
      }
      this.db.finishMessageAttempt(attempt.attemptId, {
        outcome: "written",
        terminalReceipt: result.receipt,
      });
      const injected = this.markInjected(message);
      this.advanceWakeDelta(recipient, delta);
      // A recovery destroyed somebody's unsubmitted draft to get this message
      // through. markInjected clears the row's failure diagnostic, so the audit
      // is written after it — a delivered row carrying its recovery note, which
      // the stuck-delivery reader ignores (it only reads undelivered rows).
      if (result.recovery !== undefined) {
        this.db.recordMessageDeliveryDiagnostic(
          message.id,
          `sessiond inject recovered: ${result.recovery}`,
          new Date().toISOString(),
        );
      }
      return injected;
    }
    const boundaryBefore = this.turnBoundaryAt(message.to);
    await this.sessions.sendSessionMessage(recipient, text, {
      messageId: message.id,
    });

    // An idle TUI that accepts a paste submits it, and the model starts a turn
    // — 71ms, measured in the field. Nothing else makes an idle agent start
    // one. So if no turn begins, the paste did not take: the pane swallowed it
    // (a modal, a permission prompt, a composer that never pressed Enter).
    //
    // Claiming "injected" on that exit code would be a lie: the orchestrator
    // would believe a control had landed while the agent keeps working. A
    // busy TUI is different and is not checked here — it holds the paste in
    // its composer until its next
    // tool call, so there is no new turn to wait for and "injected" is already
    // the honest maximum.
    //
    // A vendor that reports no turn events is the third case, and polling the
    // events table for it would be the mirror-image lie: the boundary can never
    // appear, so every grok paste would be called unsubmitted and left queued —
    // which makes the wake sweep re-paste the same message on every tick.
    // "Injected" is the honest maximum there too; reconcileInjected confirms it
    // against grok's own transcript activity (turnBoundaryAt) or says it never
    // arrived.
    // Re-read rather than trusting the caller's record: a flush loop pastes
    // several messages under one lock, and the first one to submit takes the
    // agent from idle to working. The stale record would have us wait five
    // seconds for a second turn-start that is never coming, and then call a
    // message queued that is sitting correctly in the composer.
    const live = this.db.getAgentByName(message.to) ?? recipient;
    if (live.status === "idle" && reportsTurnEvents(live.tool)) {
      const submitted = await this.turnStarted(message.to, boundaryBefore);
      if (!submitted) {
        console.error(
          `Hive pasted message ${message.id} into ${message.to}'s pane, but ${message.to} never started a turn. ` +
            `The agent did not receive it; leaving the message queued rather than reporting it injected.`,
        );
        this.db.recordMessageDeliveryDiagnostic(
          message.id,
          "terminal input not submitted: no turn started after message injection; " +
            "the message stays queued",
          new Date().toISOString(),
        );
        return this.getStoredMessage(message.id);
      }
    }

    const delivered = this.markInjected(message);
    if (delivered === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
    this.advanceWakeDelta(recipient, delta);
    return delivered;
  }

  /**
   * Wait for proof, from the recipient's own hook stream, that its TUI actually
   * submitted what we pasted. This is the difference between measuring what
   * Hive did and measuring what the agent did.
   */
  private async turnStarted(
    agentName: string,
    before: string | null,
  ): Promise<boolean> {
    const deadline =
      Date.now() + (this.timing.submitConfirmMs ?? SUBMIT_CONFIRM_MS);
    for (;;) {
      const boundary = this.turnBoundaryAt(agentName);
      if (boundary !== null && (before === null || boundary > before)) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await this.sleep(SUBMIT_POLL_MS);
    }
  }

  private formatAgentMessage(message: AgentMessage): string {
    return message.priority === "normal"
      ? `📨 message from ${message.from}: ${message.body}`
      : [
          `⚠️ ${message.priority.toUpperCase()} HIVE CONTROL ${message.id} from ${message.from}: ${message.body}`,
          `Acknowledge this Hive message with agent=${JSON.stringify(message.to)} messageId=${JSON.stringify(message.id)}${
            message.capabilityEpoch === null
              ? ""
              : ` capabilityEpoch=${message.capabilityEpoch}`
          } applied=true.`,
        ].join("\n");
  }

  acknowledge(
    agentName: string,
    messageId: string,
    capabilityEpoch: number | undefined,
    applied: boolean,
  ): AgentMessage {
    const message = this.getStoredMessage(messageId);
    if (message.to !== agentName) {
      throw new Error(`Message ${messageId} is not addressed to ${agentName}`);
    }
    if (message.state === "queued") {
      throw new Error(`Message ${messageId} has not been injected`);
    }
    if (
      message.capabilityEpoch !== null &&
      capabilityEpoch !== message.capabilityEpoch
    ) {
      throw new Error(`Stale capability epoch for message ${messageId}`);
    }
    const now = new Date().toISOString();
    let updated = this.requireMessageTransition(
      messageId,
      "agent-acknowledged",
      now,
    );
    if (applied || message.priority === "critical") {
      updated = this.requireMessageTransition(messageId, "applied", now);
    }
    return updated;
  }

  /**
   * Close the loop on every message we handed over.
   *
   * "Injected" is a promise with a deadline, and it resolves one of two ways.
   * Either the recipient reaches a turn boundary after the injection — which
   * is the moment the TUI actually submits a queued message, so it is real
   * evidence the message reached the model, not an exit code — or the message
   * is still waiting after long enough that someone should be told. It is
   * never silent and never forever: work is either merged or explicitly
   * surfaced, and a message is work.
   *
   * The trap is *where you look for that boundary*. The orchestrator is not a
   * spawned agent and has no agents row, so `agents.lastEventAt` does not
   * exist for it — and root-bound mail is the overwhelming majority, not an
   * edge case. Read the agents table and every root-bound message is
   * unconfirmable by construction: each would surface as never-confirmed and
   * each would be a lie. The root's turns live in the events table;
   * `turnBoundaryAt` reads the right surface per recipient.
   */
  async reconcileInjected(now = new Date().toISOString()): Promise<number> {
    let confirmed = 0;
    // Anchored to the caller's `now`, not the wall clock, so the deadline means
    // the same thing to a test as it does to the daemon.
    const cutoff = new Date(
      Date.parse(now) - DELIVERY_CONFIRM_DEADLINE_MS,
    ).toISOString();
    const stalled: Array<{ message: AgentMessage; reason: string }> = [];

    for (const message of this.db.listInjectedUnapplied()) {
      const injectedAt = message.injectedAt;
      if (injectedAt === null) continue;

      // The recipient took a turn boundary after we injected. That boundary is
      // where the TUI submits whatever it had queued, so the message reached the
      // model — proof from the mechanism rather than from an exit code.
      const boundary = this.turnBoundaryAt(message.to);
      if (boundary !== null && boundary > injectedAt) {
        this.db.transitionMessage(message.id, "applied", now);
        confirmed += 1;
        continue;
      }

      // No boundary since. Give it the deadline — and then distinguish BUSY
      // from DEAF before telling anyone. A recipient mid-turn and alive is
      // not stalled: its TUI holds the paste until the turn's own boundary,
      // and a deep build turn routinely outlives any fixed deadline. A false
      // alarm on the very alert path that reveals genuine deafness trains the
      // one reader it has to ignore it. A busy message stays unalerted
      // (alertAt null), so every later sweep re-judges it and still fires the
      // moment its recipient stops showing signs of life.
      if (injectedAt < cutoff && message.alertAt === null) {
        const reason = await this.stalledReason(message.to, now);
        if (reason !== null) stalled.push({ message, reason });
      }
    }

    // Queued messages get the same triage, because a genuinely deaf recipient
    // never lets a message reach "injected" at all: a vendor that cannot
    // accept input BLOCKS delivery, and a watchdog reading only the injected
    // state is blind to the one case it exists for. Queued-while-busy is
    // routine (ordinary traffic waits for the turn boundary) and stays
    // silent; queued at a recipient that shows no signs of life is the alarm.
    // Root-bound messages are exempt: the root's queue is its inbox, drained
    // by hive_inbox on its own turns — and the root is this alert's audience,
    // so "you have unread mail" would be noise by construction.
    for (const message of this.db.listQueuedMessages()) {
      if (isOrchestratorName(message.to)) continue;
      if (message.createdAt < cutoff && message.alertAt === null) {
        if ((await this.stalledReason(message.to, now, "queued")) === null) {
          continue;
        }
        // The sweep runs on its own timer and can fire in the second between
        // a recipient's turn-end and the flush completing that very delivery
        // — diagnosing a swallowed paste for a message that is mid-paste
        // under the session lock, and sending the orchestrator chasing a
        // loss that never happened. Serialize behind the
        // recipient's delivery lane and re-judge: only a message still
        // queued once any in-flight delivery has finished is stalled.
        const recipient = this.db.getAgentByName(message.to);
        if (recipient !== null) {
          const settled = await this.withSessionLock(
            agentSessionLockKey(recipient),
            async () => this.db.getMessage(message.id),
          );
          if (settled === null || settled.state !== "queued") continue;
        }
        const reason = await this.stalledReason(message.to, now, "queued");
        if (reason !== null) {
          stalled.push({ message, reason: `${reason} (never delivered)` });
        }
      }
    }

    if (stalled.length > 0) {
      // One line, not ninety.
      //
      // Both obvious answers are wrong. Replaying every stalled message into the
      // orchestrator's next turn is a denial of service on the one context that
      // has to stay clear, and most of them are stale anyway. Dropping them is
      // precisely the silent loss the merge-or-surface rule forbids. So we
      // surface the FACT and preserve the DETAIL: the count and each
      // recipient's measured state go in one line, every message stays
      // queryable by id, and none is discarded.
      const reasons = new Map<string, string>();
      for (const { message, reason } of stalled) {
        reasons.set(message.to, reason);
        this.db.markMessageAlerted(message.id, now);
      }
      const detail = [...reasons.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, reason]) => reason)
        .join("; ");
      const alert = await this.send(
        "hive-control",
        ORCHESTRATOR_NAME,
        `${stalled.length} message(s) stuck unconfirmed after ` +
          `${Math.round(DELIVERY_CONFIRM_DEADLINE_MS / 60_000)}m: ` +
          `${detail}. Recipients that are mid-turn and active are never ` +
          "listed — a live turn holds messages until its own boundary. " +
          "Nothing was discarded and every one is still queryable by id.",
        { idempotencyKey: `delivery-unconfirmed:${now.slice(0, 16)}` },
      ).catch(() => undefined);

      // The sweep must never surface its own output. This alert is itself a
      // message to the root, so if it can stall, the next sweep reports it, and
      // *that* report stalls too: a loop with no fixed point, feeding on the
      // one context that must stay clear, and it grows by one message every
      // time the root is quiet. Born already alerted, it can never be surfaced
      // again.
      // Nothing is lost by that — the alert IS the surface, and an alert nobody
      // read is not a new fact, it is the same fact, louder.
      if (alert !== undefined) this.db.markMessageAlerted(alert.id, now);
    }

    return confirmed;
  }

  /**
   * When did this recipient last finish a turn — read from whatever surface
   * actually records it for them?
   *
   * A spawned agent carries `lastEventAt` on its own row. The orchestrator has no
   * row (db.ts is explicit: "not a spawned agent and has no agents-table row"), so
   * asking for one returns null, and null read as "never took a turn" would make
   * every root-bound message permanently unconfirmable. Its turns are in the events
   * table, posted by its own hooks. Same question, different surface: read what
   * the tool measures and hands you.
   */
  private turnBoundaryAt(recipient: string): string | null {
    if (isOrchestratorName(recipient)) {
      // Prefer the newest turn-end across preferred and synonym event keys.
      let newest: string | null = null;
      for (const name of orchestratorRecipientNames()) {
        const at = this.db.latestTurnEndAt(name);
        if (at !== null && (newest === null || at > newest)) newest = at;
      }
      return newest;
    }
    // Not `lastEventAt` — the newest event of any kind. An idle agent
    // emits `notification` events while doing nothing, which would
    // "confirm" an unsubmitted paste from a recipient sitting still. Only a
    // real turn counts.
    const boundary = this.db.latestTurnBoundaryAt(recipient);
    if (boundary !== null) return boundary;
    // Third surface, for the vendor that writes to neither of the first two: a
    // grok agent posts no hook events, so its events table is empty however
    // hard it is working. What it does write is its session transcript, and the
    // telemetry sweep advances lastEventAt only when that transcript shows new
    // activity — model output the agent produced after we handed the message
    // over. That is receipt measured from the agent's own work, which is the
    // only thing this function was ever asking for.
    const agent = this.db.getAgentByName(recipient);
    return agent !== null && !reportsTurnEvents(agent.tool)
      ? agent.lastEventAt
      : null;
  }

  /**
   * Why an unconfirmed message deserves the alert — or null when it does not.
   *
   * "No boundary for five minutes" is one observation with two opposite
   * causes, and they must not share a message. A BUSY recipient is mid-turn:
   * its newest boundary is a `turn-start`, its TUI is holding the paste until
   * the turn closes, and its process keeps proving itself alive (every tool
   * call refreshes the agent row's lastEventAt; the root's events do the same
   * in the events table). That is healthy work and earns silence. A DEAF
   * recipient has nothing to show: no turn events at all (a vendor whose
   * hook stream went silent), or a closed
   * turn it never followed (an idle TUI that swallowed the paste), or a dead
   * process, or an open turn that has gone silent past any legitimate single
   * tool call. Each of those states is named in the alert, so the reader
   * learns what was measured, not merely that a timer expired.
   */
  private async stalledReason(
    recipient: string,
    now: string,
    phase: "injected" | "queued" = "injected",
  ): Promise<string | null> {
    const agent = isOrchestratorName(recipient)
      ? null
      : this.db.getAgentByName(recipient);
    if (
      agent !== null &&
      (agent.status === "dead" || agent.status === "failed")
    ) {
      return `${recipient} is ${agent.status} and will never reach a boundary`;
    }
    // Root events may be keyed under queen (preferred) or orchestrator (synonym).
    const boundary = isOrchestratorName(recipient)
      ? orchestratorRecipientNames().reduce<
          ReturnType<HiveDatabase["latestTurnBoundary"]>
        >((best, name) => {
          const next = this.db.latestTurnBoundary(name);
          if (next === null) return best;
          if (best === null || next.timestamp > best.timestamp) return next;
          return best;
        }, null)
      : this.db.latestTurnBoundary(recipient);
    if (boundary === null) {
      // "No turn events at all" is a diagnosis about a vendor that HAS a hook
      // stream and has gone silent on it. Said about grok, which has none, it
      // is true of every grok agent, healthy or not, and means nothing. Judge
      // that vendor on the surface it does write: the transcript activity the
      // telemetry sweep carries into lastEventAt. Quiet past the open-turn
      // cap is the same
      // finding this alert exists for; anything fresher is an agent working or
      // waiting, not a deaf one.
      if (agent !== null && !reportsTurnEvents(agent.tool)) {
        const silentMs = Date.parse(now) - Date.parse(agent.lastEventAt);
        return silentMs < OPEN_TURN_SILENCE_CAP_MS
          ? null
          : `${recipient} (${agent.tool}) has shown no session activity for ${Math.round(
              silentMs / 60_000,
            )}m — it may be unable to hear`;
      }
      return `${recipient} has emitted no turn events at all — it may be unable to hear`;
    }
    if (boundary.kind === "turn-end") {
      // "Swallowed paste" is a diagnosis about a paste that happened; a queued
      // message was never pasted, and an alert that conflates the two sends
      // the orchestrator hunting a terminal loss that never occurred.
      return phase === "queued"
        ? `${recipient} went idle without receiving it — delivery at its turn boundaries has not landed`
        : `${recipient} is idle yet never submitted it — the paste may have been swallowed`;
    }
    // An open turn. Before inferring anything from silence, ask the OS: a
    // stopped or vanished process is a measured state, provable in one call,
    // and it rings NOW — not after a timeout dressed up as a diagnosis. A
    // failed probe remains unknown (never alarm on a read we could not
    // make); the silence cap below remains the honest last resort for the one
    // wedge the kernel cannot see, a process alive but internally hung.
    if (agent !== null && this.processState !== undefined) {
      const state = await this.processState(agent).catch(
        () => "unknown" as const,
      );
      if (state === "stopped") {
        return `${recipient}'s process is stopped (suspended mid-turn, ps state T) — it cannot hear anything`;
      }
      if (state === "gone") {
        return `${recipient}'s process is gone mid-turn — nothing is left to reach a boundary`;
      }
    }
    const life = isOrchestratorName(recipient)
      ? orchestratorRecipientNames().reduce<string | null>((best, name) => {
          const at = this.db.latestEventAt(name);
          if (at === null) return best;
          return best === null || at > best ? at : best;
        }, null)
      : (agent?.lastEventAt ?? null);
    const quietMs =
      life === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(now) - Date.parse(life);
    if (quietMs < OPEN_TURN_SILENCE_CAP_MS) {
      return null; // Mid-turn and demonstrably alive: busy, not deaf.
    }
    return `${recipient} is mid-turn but has shown no sign of life for ${Math.round(
      quietMs / 60_000,
    )}m`;
  }

  async alertExpiredControls(now = new Date().toISOString()): Promise<number> {
    let count = 0;
    for (const message of this.db.listExpiredUnacknowledged(now)) {
      if (this.db.markMessageAlerted(message.id, now)?.alertAt !== now)
        continue;
      await this.send(
        "hive-control",
        ORCHESTRATOR_NAME,
        `Control ${message.id} for ${message.to} (${message.priority}/${message.intent}) missed its acknowledgement deadline; current state=${message.state}.`,
        { idempotencyKey: `control-deadline:${message.id}` },
      );
      count += 1;
    }
    return count;
  }

  /**
   * One `hive-control → queen` alert per message that has been queued past
   * STUCK_DELIVERY_MS behind a recorded diagnostic while its recipient is
   * still live. This is the loud-failure backstop for silent non-delivery of
   * ANY cause: the cause is whatever the row's diagnostic says, and the alert
   * fires without anybody having to suspect there is something to look for.
   * Idempotent on `deliveryAlertAt` — one alert per message, not one per tick.
   */
  async alertStuckDeliveries(now = new Date().toISOString()): Promise<number> {
    const cutoff = new Date(Date.parse(now) - STUCK_DELIVERY_MS).toISOString();
    let count = 0;
    for (const message of this.db.listBlockedDeliveries(cutoff)) {
      // A dead recipient's undelivered mail is a spawn/kill outcome, already
      // reported through those paths; only a LIVE agent that cannot hear is
      // news.
      const recipient = this.db.getAgentByName(message.to);
      if (recipient === null) continue;
      if (["dead", "done", "failed"].includes(recipient.status)) continue;
      if (
        this.db.markMessageDeliveryAlerted(message.id, now)?.deliveryAlertAt !==
        now
      )
        continue;
      const ageMinutes = Math.round(
        (Date.parse(now) - Date.parse(message.createdAt)) / 60_000,
      );
      await this.send(
        "hive-control",
        ORCHESTRATOR_NAME,
        `Delivery blocked: message ${message.id} from ${message.from} to ${message.to} ` +
          `has been queued ${ageMinutes}m and is not arriving. ` +
          `Last attempt: ${message.deliveryDiagnostic}. ` +
          `${message.to} is live (status=${recipient.status}) and has NOT seen this message.`,
        { idempotencyKey: `delivery-blocked:${message.id}` },
      );
      count += 1;
    }
    return count;
  }

  /**
   * Per-recipient view of the same population the alert reads, for
   * `hive_status`. Reports the oldest blocked message per agent.
   */
  blockedDeliveries(
    now = new Date().toISOString(),
  ): Map<
    string,
    Readonly<{ messageId: string; queuedMinutes: number; diagnostic: string }>
  > {
    const cutoff = new Date(Date.parse(now) - STUCK_DELIVERY_MS).toISOString();
    const blocked = new Map<
      string,
      Readonly<{ messageId: string; queuedMinutes: number; diagnostic: string }>
    >();
    for (const message of this.db.listBlockedDeliveries(cutoff)) {
      if (blocked.has(message.to)) continue; // listBlockedDeliveries is oldest-first.
      blocked.set(message.to, {
        messageId: message.id,
        queuedMinutes: Math.round(
          (Date.parse(now) - Date.parse(message.createdAt)) / 60_000,
        ),
        diagnostic: message.deliveryDiagnostic ?? "unknown",
      });
    }
    return blocked;
  }

  async recoverCriticalControls(): Promise<number> {
    const controls = this.controls;
    if (controls === undefined) return 0;
    let recovered = 0;
    for (const queued of this.db.listQueuedCriticalMessages()) {
      let message = queued;
      let recipient = this.db.getAgentByName(message.to);
      if (recipient === null) continue;
      if (["dead", "done", "failed"].includes(recipient.status)) continue;
      if (!recipient.writeRevoked) {
        recipient = this.db.revokeAgentCapabilities(
          recipient.name,
          new Date().toISOString(),
        );
        if (recipient === null) continue;
        const assigned = this.db.assignMessageCapabilityEpoch(
          message.id,
          recipient.capabilityEpoch,
        );
        if (assigned === null) continue;
        message = assigned;
      }
      try {
        const acted = await this.withSessionLock(
          agentSessionLockKey(recipient),
          async () => {
            // Re-check under the lock: this method runs from both the
            // maintenance tick and the session-start hook, and the queued-state
            // check above happened outside the lock. Without this, two
            // overlapping sweeps both see "queued" and interrupt-and-restart
            // the same agent twice.
            const current = this.db.getMessage(message.id);
            if (current === null || current.state !== "queued") return false;
            const latest = this.db.getAgentByName(message.to);
            if (latest === null) return false;
            await controls.apply(latest, current);
            this.markInjected(current);
            return true;
          },
        );
        if (acted) recovered += 1;
      } catch (error) {
        const alertedAt = new Date().toISOString();
        this.db.markMessageAlerted(message.id, alertedAt);
        await this.send(
          "hive-control",
          ORCHESTRATOR_NAME,
          `Recovery of critical control ${message.id} for ${message.to} failed: ${
            error instanceof Error ? error.message : "unknown error"
          }. Capability remains revoked and the worktree is preserved.`,
          { idempotencyKey: `control-recovery-failed:${message.id}` },
        ).catch(() => undefined);
      }
    }
    return recovered;
  }

  /**
   * Record that a message was handed over — and nothing more than that.
   *
   * Do not mark a normal message "applied" — the strongest claim in the
   * system, meaning the recipient acted on it — on the evidence that the
   * input write did not throw. A busy pane accepts the paste, exit 0, and
   * the TUI then prints "Messages to be submitted after next tool call" and
   * holds the text, unsubmitted, while the model reasons: bytes written to a
   * pane are not a mind that changed.
   *
   * So delivery claims only what it can prove: the message was injected. It
   * becomes "applied" in `reconcileInjected`, when the recipient produces a
   * turn boundary that proves the TUI actually submitted it.
   */
  private markInjected(message: AgentMessage): AgentMessage {
    const now = new Date().toISOString();
    const injected = this.db.markMessageDelivered(message.id, now);
    if (injected === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
    const stored = this.requireMessageTransition(message.id, "injected", now);

    // The acknowledgement clock starts when the agent could first have seen it,
    // not when the sender pressed send: charging a recipient for time its
    // message spent queued can expire a control before it arrives.
    const ackBudgetMs = this.ackBudgetMs(stored);
    if (stored.deadlineAt !== null && ackBudgetMs !== null) {
      const deadline = new Date(
        new Date(now).getTime() + ackBudgetMs,
      ).toISOString();
      return this.db.setMessageDeadline(message.id, deadline) ?? stored;
    }
    return stored;
  }

  private ackBudgetMs(message: AgentMessage): number | null {
    if (message.priority === "urgent") return DEFAULT_URGENT_DEADLINE_MS;
    if (message.priority === "critical") return DEFAULT_CRITICAL_DEADLINE_MS;
    return null;
  }

  private getStoredMessage(id: string): AgentMessage {
    const message = this.db.getMessage(id);
    if (message === null) {
      throw new Error(`Message not found: ${id}`);
    }
    return message;
  }

  private requireMessageTransition(
    id: string,
    state: AgentMessage["state"],
    at: string,
  ): AgentMessage {
    const message = this.db.transitionMessage(id, state, at);
    if (message === null) {
      throw new Error(`Message disappeared during ${state} transition: ${id}`);
    }
    return message;
  }

  private requireLiveRecipient(
    name: string,
  ): NonNullable<ReturnType<HiveDatabase["getAgentByName"]>> {
    const recipient = this.db.getAgentByName(name);
    if (recipient === null) {
      throw new Error(`Recipient agent not found: ${name}`);
    }
    if (
      recipient.status === "dead" ||
      recipient.status === "done" ||
      recipient.status === "failed"
    ) {
      throw new Error(`Recipient agent is ${recipient.status}: ${name}`);
    }
    return recipient;
  }

  private async withSessionLock<T>(
    session: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(session) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.sessionLocks.set(session, tail);

    try {
      return await task;
    } finally {
      if (this.sessionLocks.get(session) === tail) {
        this.sessionLocks.delete(session);
      }
    }
  }
}
