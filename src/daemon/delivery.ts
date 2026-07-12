import {
  AgentMessageSchema,
  ORCHESTRATOR_NAME,
  unknownVendor,
  type AgentMessage,
  type AgentRecord,
  type ControlIntent,
  type MessagePriority,
  type OrchestratorMessageEnvelope,
} from "../schemas";
import { TmuxAdapter } from "../adapters/tmux";
import type { PaneProcessState } from "./resources";
import { HiveDatabase } from "./db";
import {
  createOrchestratorEnvelope,
  formatOrchestratorWake,
  orchestratorTmuxSession,
} from "./orchestrator-lifecycle";

export interface TmuxSender {
  sendMessage(
    session: string,
    text: string,
    options?: { interrupt?: boolean },
  ): Promise<void>;
}

/**
 * Vendor-native push channel (Claude Code Channels). deliverMessage resolves
 * true only when the bridge confirmed the notification was written to the
 * CLI's transport; the CLI queues it for its next turn. There is no vendor
 * acknowledgement beyond that, so callers must not claim more than
 * "injected" for a channel delivery.
 */
export interface ChannelDeliverer {
  isLive(agentName: string): boolean;
  deliverMessage(
    agentName: string,
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean>;
}

export interface RootProtocolDeliverer {
  isLive(): boolean;
  deliverMessage(content: string, meta: Record<string, string>): Promise<boolean>;
}

export function formatChannelMessage(message: AgentMessage): {
  content: string;
  meta: Record<string, string>;
} {
  const content = message.priority === "normal"
    ? message.body
    : [
        message.body,
        `Acknowledge with hive_ack_message agent=${JSON.stringify(message.to)} messageId=${JSON.stringify(message.id)}${
          message.capabilityEpoch === null
            ? ""
            : ` capabilityEpoch=${message.capabilityEpoch}`
        } applied=true.`,
      ].join("\n");
  return {
    content,
    // Channel meta keys must be bare identifiers; anything else the CLI
    // silently drops from the rendered <channel> tag.
    meta: {
      sender: message.from,
      priority: message.priority,
      intent: message.intent,
      message_id: message.id,
      sequence: String(message.sequence),
    },
  };
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
 * A sender reading state "queued" has taken it as "will arrive shortly", told
 * the user an agent was directed, and been wrong: a normal message to a
 * channel-less recipient mid-turn is delivered only at its next turn boundary,
 * and a deep agent's next boundary routinely falls AFTER the work the message
 * was trying to steer. That is how a migration shipped without the three
 * safety requirements sent nine minutes earlier (aurora, 2026-07-12 16:55Z —
 * queued mid-turn, delivered at her turn boundary 17:04:45, seconds after she
 * landed). The note rides the send result so the sender learns the recipient's
 * real state at the only moment it can still act, not from a post-mortem.
 */
export function queuedDeliveryNote(
  message: AgentMessage,
  recipient: AgentRecord | null,
): string | undefined {
  if (message.state !== "queued" || recipient === null) return undefined;
  // A critical control left queued has already raised its own loud alert
  // through the restart-failure path.
  if (message.priority === "critical") return undefined;
  const name = recipient.name;
  switch (recipient.status) {
    case "dead":
    case "failed":
    case "done":
      return `NOT received: ${name} is ${recipient.status}, so this message will never be delivered.`;
    case "spawning":
      return `NOT received yet: ${name} is still spawning; the message is delivered when its session starts.`;
    case "idle":
      return `NOT received: the paste into ${name}'s pane was never submitted (no turn started), ` +
        `so the message stays queued and the daemon retries it on its next maintenance tick ` +
        `(the idle wake), as well as at any turn boundary ${name} reaches. ` +
        "Treat it as unheard until a turn confirms it.";
    case "awaiting-approval":
      return `NOT received yet: ${name} is blocked on a pending approval and hears nothing until it resolves; ` +
        "the message is delivered at the next turn boundary after that.";
    default:
      // working, control-paused, stuck: mid-turn shapes.
      return message.priority === "urgent"
        ? `NOT received yet: ${name} is mid-turn; urgent traffic is injected at its next tool call, ` +
          "and the acknowledgement deadline alerts if that never happens."
        : `NOT received yet: ${name} is mid-turn, and a normal message is delivered only when the ` +
          "current turn ends — for a deep task that can be after the work this message means to " +
          "steer has already shipped. If it must land mid-turn, resend with priority=urgent " +
          "(injected at the next tool call; urgent is preemption, not a fast lane).";
  }
}

export interface CriticalControlRuntime {
  interruptAndRestart(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<void>;
}

export interface NativeAgentControl {
  hasAgent(agentName: string): boolean;
  deliver(
    agent: AgentRecord,
    text: string,
    options?: { interrupt?: boolean },
  ): Promise<void>;
}

/**
 * How long a busy agent gets to acknowledge an urgent control, measured from the
 * moment it was injected rather than sent.
 *
 * Thirty seconds was a guess sized for an idle agent, and it false-alarmed on
 * agents that were merely working: real acknowledgement latencies recorded in
 * the field were 41s, 54s, 61s, 64s and 109s, every one of them an agent that
 * simply had to finish a tool call first. Three minutes clears the slowest
 * observed ack with margin while still catching an agent that has genuinely
 * stopped listening.
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
 * process hours before the historical codex deafness (~2h unconfirmable)
 * would have been noticed. Deaf-from-birth agents never open a turn at all
 * and are alerted at the five-minute deadline, not this one.
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
 * Does this vendor tell Hive when its turns begin and end?
 *
 * Every redelivery trigger Hive has hangs off that hook stream: flushQueued
 * fires on session-start and turn-end, flushUrgent on a tool boundary. Claude
 * and Codex post those events. GROK POSTS NOTHING — its CLI drives no hook
 * channel at all (adapters/tools/grok.ts), so it emits no session-start, no
 * turn boundary and no tool boundary, ever. Reading a grok agent through the
 * events table therefore answers "no turn events at all" for a healthy agent
 * and for a dead one alike, and waiting for one is waiting forever.
 *
 * Grok's turns are still observable — just on another surface: its own session
 * transcript, which refreshToolTelemetry folds into the agent row's
 * lastEventAt and status. That is the surface to read for grok.
 */
export function reportsTurnEvents(tool: AgentRecord["tool"]): boolean {
  switch (tool) {
    case "claude":
    case "codex":
      return true;
    case "grok":
      return false;
    default:
      return unknownVendor(tool, "reportsTurnEvents");
  }
}


export class BunTmuxSender implements TmuxSender {
  constructor(private readonly tmux: Pick<TmuxAdapter, "sendKeys"> = new TmuxAdapter()) {}

  async sendMessage(
    session: string,
    text: string,
    options: { interrupt?: boolean } = {},
  ): Promise<void> {
    await this.tmux.sendKeys(session, text, options);
  }

}

export class MessageDelivery {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: HiveDatabase,
    private readonly tmux: TmuxSender,
    private readonly controls?: CriticalControlRuntime,
    private readonly nativeControl?: NativeAgentControl,
    private readonly channels?: ChannelDeliverer,
    private readonly rootProtocol?: RootProtocolDeliverer,
    private readonly timing: {
      sleep?: (ms: number) => Promise<void>;
      submitConfirmMs?: number;
    } = {},
    /** What the OS says about the recipient's pane processes — a measurement,
     * consulted before any inference from silence. Absent (tests, embedded
     * daemons), triage falls back to the silence cap alone. */
    private readonly processState?: (
      tmuxSession: string,
    ) => Promise<PaneProcessState>,
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
    if (options.idempotencyKey !== undefined) {
      const existing = this.db.findMessageByIdempotency(
        from,
        options.idempotencyKey,
      );
      if (existing !== null) return existing;
    }
    const recipient = to === ORCHESTRATOR_NAME
      ? null
      : this.db.getAgentByName(to);
    if (
      to !== ORCHESTRATOR_NAME && recipient === null &&
      !this.db.isAgentNameReserved(to)
    ) {
      throw new Error(`Recipient agent not found: ${to}`);
    }
    if (recipient !== null) {
      this.requireLiveRecipient(to);
    }
    let priority = options.priority ?? "normal";
    const intent = options.intent ?? "instruction";
    if (["pause", "stop", "cancel", "restrict-writes"].includes(intent)) {
      priority = "critical";
    }
    const now = new Date();
    let capabilityEpoch = priority === "critical" && recipient !== null
      ? recipient.capabilityEpoch + 1
      : null;
    const deadlineMs = options.deadlineMs ??
      (priority === "critical"
        ? DEFAULT_CRITICAL_DEADLINE_MS
        : priority === "urgent"
          ? DEFAULT_URGENT_DEADLINE_MS
          : null);
    let currentRecipient = recipient;
    let message: AgentMessage;
    try {
      message = this.db.transaction(() => {
        if (priority === "critical" && recipient !== null) {
          currentRecipient = this.db.revokeAgentCapabilities(
            to,
            now.toISOString(),
          );
          capabilityEpoch = currentRecipient?.capabilityEpoch ?? capabilityEpoch;
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
          deadlineAt: deadlineMs === null
            ? null
            : new Date(now.getTime() + deadlineMs).toISOString(),
          sequence: this.db.nextMessageSequence(to),
          idempotencyKey: options.idempotencyKey ?? null,
          capabilityEpoch,
        });
        return this.db.insertMessage(value);
      });
    } catch (error) {
      const existing = options.idempotencyKey === undefined
        ? null
        : this.db.findMessageByIdempotency(from, options.idempotencyKey);
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
      return this.withSessionLock(currentRecipient.tmuxSession, async () => {
        try {
          const latestRecipient = this.requireLiveRecipient(to);
          await this.controls!.interruptAndRestart(latestRecipient, message);
        } catch (error) {
          const alertedAt = new Date().toISOString();
          this.db.markMessageAlerted(message.id, alertedAt);
          await this.send(
            "hive-control",
            ORCHESTRATOR_NAME,
            `Critical control ${message.id} revoked ${to}'s capability epoch but process restart failed: ${
              error instanceof Error ? error.message : "unknown error"
            }. Worktree was preserved; operator attention is required.`,
            { idempotencyKey: `control-restart-failed:${message.id}` },
          ).catch(() => undefined);
          return this.getStoredMessage(message.id);
        }
        return this.markInjected(message);
      });
    }

    if (recipient === null) {
      return message;
    }

    if (this.nativeControl?.hasAgent(recipient.name)) {
      return this.withSessionLock(recipient.tmuxSession, async () => {
        const current = this.getStoredMessage(message.id);
        if (current.deliveredAt !== null) return current;
        const currentRecipient = this.requireLiveRecipient(to);
        try {
          return await this.deliverNative(current, currentRecipient);
        } catch {
          // A native connection can disappear after liveness was checked. An
          // idle TUI remains a safe compatibility target; a busy headless
          // session keeps the durable message queued for recovery.
          if (currentRecipient.status !== "idle") return current;
          return this.deliver(current, currentRecipient);
        }
      });
    }

    // A live verified channel accepts messages mid-turn (the CLI queues them
    // for its next turn), so only a channel-less busy recipient short-circuits.
    const channelLive = this.channels?.isLive(to) ?? false;
    if (!channelLive && recipient.status !== "idle") {
      return message;
    }

    return this.withSessionLock(recipient.tmuxSession, async () => {
      const current = this.getStoredMessage(message.id);
      if (current.deliveredAt !== null) {
        return current;
      }

      // The recipient can die between the pre-insert check and this lock. The
      // message row is already durable, so leave it queued rather than failing
      // a send whose persistence already succeeded.
      if (!this.isDeliverable(this.db.getAgentByName(to))) {
        return current;
      }
      const viaChannel = await this.deliverViaChannel(current);
      if (viaChannel !== null) {
        return viaChannel;
      }
      // Re-read after the channel round trip: the agent may have died while
      // the push was in flight, and nothing may be pasted into a dead session.
      const currentRecipient = this.db.getAgentByName(to);
      if (
        !this.isDeliverable(currentRecipient) ||
        currentRecipient.status !== "idle"
      ) {
        return current;
      }
      return this.deliver(current, currentRecipient);
    });
  }

  private isDeliverable(
    recipient: AgentRecord | null,
  ): recipient is AgentRecord {
    return recipient !== null && recipient.status !== "dead" &&
      recipient.status !== "done" && recipient.status !== "failed";
  }

  async flushQueued(agentName: string): Promise<AgentMessage[]> {
    if (agentName === ORCHESTRATOR_NAME) {
      return this.wakeOrchestrator();
    }
    const recipient = this.db.getAgentByName(agentName);
    if (
      recipient === null || recipient.status === "dead" ||
      recipient.status === "done" || recipient.status === "failed"
    ) {
      return [];
    }

    return this.withSessionLock(recipient.tmuxSession, async () => {
      const currentRecipient = this.db.getAgentByName(agentName);
      if (
        currentRecipient?.status !== "idle" &&
        !(currentRecipient !== null &&
          this.nativeControl?.hasAgent(currentRecipient.name))
      ) {
        return [];
      }

      const delivered: AgentMessage[] = [];
      for (const queued of this.db.getUndeliveredMessages(agentName)) {
        try {
          const message = this.db.getMessage(queued.id);
          if (message === null || message.deliveredAt !== null) {
            continue;
          }
          if (this.nativeControl?.hasAgent(currentRecipient.name)) {
            delivered.push(await this.deliverNative(message, currentRecipient));
            continue;
          }
          const viaChannel = await this.deliverViaChannel(message);
          if (viaChannel !== null) {
            delivered.push(viaChannel);
            continue;
          }
          delivered.push(await this.deliver(message, currentRecipient));
        } catch (error) {
          // A failed pane must not prevent later queued messages from
          // delivery, but a systemic failure (dead bridge, vanished tmux)
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

  /**
   * Deliver queued urgent messages to a busy agent at a tool boundary.
   *
   * SPEC decision 1: urgent traffic injects at the nearest safe lifecycle
   * boundary rather than waiting for the turn to end — a deep agent's turn
   * can run for an hour, which is exactly how two urgent controls blew their
   * acknowledgement deadlines in the field. Between tool calls the TUI's
   * composer queues a paste as a steer message the model sees at its next
   * step, so this skips the idle gate that ordinary traffic honours. Normal
   * messages still wait for the turn boundary; critical ones have their own
   * revoke-and-restart machinery and are never pasted.
   */
  async flushUrgent(agentName: string): Promise<AgentMessage[]> {
    const recipient = this.db.getAgentByName(agentName);
    if (!this.isDeliverable(recipient)) return [];
    const queuedUrgent = this.db.getUndeliveredMessages(agentName)
      .filter((message) => message.priority === "urgent");
    if (queuedUrgent.length === 0) return [];
    return this.withSessionLock(recipient.tmuxSession, async () => {
      const currentRecipient = this.db.getAgentByName(agentName);
      if (!this.isDeliverable(currentRecipient)) return [];
      const delivered: AgentMessage[] = [];
      for (const queued of queuedUrgent) {
        try {
          const message = this.db.getMessage(queued.id);
          if (message === null || message.deliveredAt !== null) continue;
          if (this.nativeControl?.hasAgent(currentRecipient.name)) {
            delivered.push(await this.deliverNative(message, currentRecipient));
            continue;
          }
          const viaChannel = await this.deliverViaChannel(message);
          if (viaChannel !== null) {
            delivered.push(viaChannel);
            continue;
          }
          delivered.push(
            await this.deliver(message, currentRecipient),
          );
        } catch (error) {
          console.error(
            `Hive failed to inject urgent message ${queued.id} to ${agentName} at a tool boundary: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
      }
      return delivered;
    });
  }

  /**
   * Wake every live idle agent that still has mail waiting.
   *
   * Redelivery used to hang entirely off the recipient's own activity:
   * flushQueued on its session-start/turn-end hook, flushUrgent at a tool
   * boundary. Both are things a WORKING agent does. An agent that has finished
   * its task makes no more tool calls and reaches no more turn boundaries — so
   * a message enqueued while it was busy was retried by nothing once it went
   * quiet, and the agent an orchestrator most needs to redirect (the one with
   * free capacity) was the one it could not reach. Grok made it total: driving
   * no hook channel, it never fires ANY of those triggers, so its mail sat
   * queued forever (cesar, 2026-07-12: two controls queued, alive, idle, deaf,
   * killed to be stopped).
   *
   * The daemon already knows both halves — this agent is idle, this message is
   * queued — so it stops waiting to be told and does the waking itself, on the
   * maintenance tick. Each vendor is woken by the path that actually starts a
   * turn for it, which is the one flushQueued already picks: the app-server
   * turn for a native Codex session, the vendor channel for Claude, a
   * paste-and-submit into the pane for a TUI with neither.
   */
  async wakeIdleRecipients(): Promise<AgentMessage[]> {
    const woken: AgentMessage[] = [];
    for (const agent of this.db.listAgents()) {
      if (agent.status !== "idle") continue;
      if (this.db.getUndeliveredMessages(agent.name).length === 0) continue;
      woken.push(...await this.flushQueued(agent.name));
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
      return this.db.claimUndeliveredMessages(agentName, deliveredAt).map(
        (message) => message.priority === "normal"
          ? this.db.transitionMessage(message.id, "applied", deliveredAt)!
          : this.db.transitionMessage(message.id, "injected", deliveredAt)!,
      );
    };
    if (recipient === null) return claim();
    return this.withSessionLock(recipient.tmuxSession, async () => claim());
  }

  async orchestratorInbox(): Promise<OrchestratorMessageEnvelope[]> {
    return this.withSessionLock(orchestratorTmuxSession(), async () =>
      this.db.claimUndeliveredMessages(
        ORCHESTRATOR_NAME,
        new Date().toISOString(),
      ).map((message) => {
        const applied = this.db.transitionMessage(
          message.id,
          "applied",
          message.deliveredAt!,
        )!;
        return createOrchestratorEnvelope(applied);
      })
    );
  }

  readOrchestratorMessage(id: string): AgentMessage | null {
    const message = this.db.getMessage(id);
    return message?.to === ORCHESTRATOR_NAME ? message : null;
  }

  async wakeOrchestrator(): Promise<AgentMessage[]> {
    return this.withSessionLock(orchestratorTmuxSession(), async () => {
      const delivered: AgentMessage[] = [];
      for (const message of this.db.getUndeliveredMessages(ORCHESTRATOR_NAME)) {
        const injected = await this.deliverRootViaChannel(message);
        if (injected !== null) delivered.push(injected);
      }
      return delivered;
    });
  }

  private async deliverRootViaChannel(
    message: AgentMessage,
  ): Promise<AgentMessage | null> {
    if (this.rootProtocol?.isLive()) {
      const confirmed = await this.rootProtocol.deliverMessage(
        formatOrchestratorWake(createOrchestratorEnvelope(message)),
        { sender: message.from, message_id: message.id, sequence: String(message.sequence) },
      ).catch(() => false);
      // Unconfirmed falls through to the Claude Channels path rather than
      // giving up: a stale codex root socket (dead app-server, file left in
      // /tmp) must not cost a Claude root its wake.
      if (confirmed) {
        const now = new Date().toISOString();
        this.db.markMessageDelivered(message.id, now);
        return this.db.transitionMessage(message.id, "injected", now)!;
      }
    }
    if (this.channels === undefined || !this.channels.isLive(ORCHESTRATOR_NAME)) {
      return null;
    }
    const confirmed = await this.channels.deliverMessage(
      ORCHESTRATOR_NAME,
      formatOrchestratorWake(createOrchestratorEnvelope(message)),
      {
        sender: message.from,
        message_id: message.id,
        sequence: String(message.sequence),
      },
    ).catch(() => false);
    if (!confirmed) return null;
    const now = new Date().toISOString();
    const injected = this.db.markMessageDelivered(message.id, now);
    if (injected === null) {
      throw new Error(`Message disappeared during root channel delivery: ${message.id}`);
    }
    return this.db.transitionMessage(message.id, "injected", now)!;
  }

  /**
   * Attempt vendor-channel delivery. Returns the updated message when the
   * bridge confirmed the write, or null when no live channel exists (the
   * caller falls back to tmux). Channel-delivered messages stop at
   * "injected": the CLI queues the event for its next turn and provides no
   * application signal, so hive does not claim one — unlike the tmux path,
   * where paste-and-submit into an idle prompt structurally starts the turn.
   */
  private async deliverViaChannel(
    message: AgentMessage,
  ): Promise<AgentMessage | null> {
    if (this.channels === undefined || !this.channels.isLive(message.to)) {
      return null;
    }
    const { content, meta } = formatChannelMessage(message);
    const confirmed = await this.channels
      .deliverMessage(message.to, content, meta)
      .catch(() => false);
    if (!confirmed) {
      return null;
    }
    const now = new Date().toISOString();
    const injected = this.db.markMessageDelivered(message.id, now);
    if (injected === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
    return this.db.transitionMessage(message.id, "injected", now)!;
  }

  private async deliver(
    message: AgentMessage,
    recipient: AgentRecord,
  ): Promise<AgentMessage> {
    const text = this.formatAgentMessage(message);
    const boundaryBefore = this.turnBoundaryAt(message.to);
    // This is what makes priority mean anything. Until now every level did the
    // same thing here — paste and press Enter — so "urgent interrupts at the
    // next safe boundary" was a label on a database row, not a behaviour, and a
    // critical order revoking write authority could sit unread in a composer
    // while the agent kept writing. Normal traffic still waits for a turn
    // boundary: routine coordination is not worth discarding a model's
    // reasoning, and the cost of an interrupt is that the in-flight turn is
    // cancelled and never resumed.
    await this.tmux.sendMessage(recipient.tmuxSession, text, {
      interrupt: message.priority !== "normal",
    });

    // An idle TUI that accepts a paste submits it, and the model starts a turn
    // — 71ms, measured in the field. Nothing else makes an idle agent start
    // one. So if no turn begins, the paste did not take: the pane swallowed it
    // (a modal, a permission prompt, a composer that never pressed Enter) and
    // `tmux send-keys` returned 0 anyway, because exit 0 only ever meant tmux
    // accepted the keystrokes.
    //
    // Claiming "injected" on that exit code is the lie this whole bug is made
    // of: an orchestrator was told a stop order had landed, believed it, and
    // the agent kept working and landed the commit. A busy TUI is different and
    // is not checked here — it holds the paste in its composer until its next
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
    if (
      live.status === "idle" && reportsTurnEvents(live.tool) &&
      !(await this.turnStarted(message.to, boundaryBefore))
    ) {
      console.error(
        `Hive pasted message ${message.id} into ${message.to}'s pane, but ${message.to} never started a turn. ` +
          `The agent did not receive it; leaving the message queued rather than reporting it injected.`,
      );
      return this.getStoredMessage(message.id);
    }

    const delivered = this.markInjected(message);
    if (delivered === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
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
    const deadline = Date.now() +
      (this.timing.submitConfirmMs ?? SUBMIT_CONFIRM_MS);
    for (;;) {
      const boundary = this.turnBoundaryAt(agentName);
      if (boundary !== null && (before === null || boundary > before)) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await this.sleep(SUBMIT_POLL_MS);
    }
  }

  private async deliverNative(
    message: AgentMessage,
    agent: AgentRecord,
  ): Promise<AgentMessage> {
    const text = this.formatAgentMessage(message);
    await this.nativeControl!.deliver(agent, text, {
      interrupt: message.priority === "urgent",
    });
    const delivered = this.markInjected(message);
    if (delivered === null) {
      throw new Error(`Message disappeared during native delivery: ${message.id}`);
    }
    return delivered;
  }

  private formatAgentMessage(message: AgentMessage): string {
    return message.priority === "normal"
      ? `📨 message from ${message.from}: ${message.body}`
      : [
          `⚠️ ${message.priority.toUpperCase()} HIVE CONTROL ${message.id} from ${message.from}: ${message.body}`,
          `Acknowledge with hive_ack_message agent=${JSON.stringify(message.to)} messageId=${JSON.stringify(message.id)}${
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
    let updated = this.db.transitionMessage(
      messageId,
      "agent-acknowledged",
      now,
    )!;
    if (applied || message.priority === "critical") {
      updated = this.db.transitionMessage(messageId, "applied", now)!;
    }
    return updated;
  }

  /**
   * Close the loop on every message we handed over.
   *
   * "Injected" used to be a shrug: the channel bridge accepted the message, Hive
   * honestly declined to claim it had been applied — and then nothing ever looked
   * at it again. Ninety messages accumulated in that state, including twenty of
   * Hive's own control alerts. Hive *knew* they were unconfirmed, which is
   * exactly what the null appliedAt means, and told nobody, forever.
   *
   * Now "injected" is a promise with a deadline, and it resolves one of two ways.
   * Either the recipient reaches a turn boundary after the injection — which is
   * the moment the TUI actually submits a queued message, so it is real evidence
   * the message reached the model, not an exit code — or the message is still
   * waiting after long enough that someone should be told. It is never silent and
   * never forever. SPEC §3 promises work is either merged or explicitly
   * surfaced; a message is work, and this is what extends that promise to it.
   *
   * The trap is *where you look for that boundary*, and the first version of this
   * fell straight into it: it asked `agents.lastEventAt`, which the orchestrator
   * does not have, because the orchestrator is not a spawned agent and has no
   * agents row at all. So every root-bound message was unconfirmable by
   * construction — and root-bound is not an edge case, it is the overwhelming
   * majority. Measured against the live database: of 107 messages stuck in
   * "injected", 105 were addressed to the orchestrator. Reading the wrong surface
   * would therefore have surfaced all 105 as never-confirmed, which is the ninety
   * lines this function exists to *not* dump into the one context that has to stay
   * clear, and every one of them would have been a lie: the root had reached a turn
   * boundary after all 105, and reading the surface that actually records the root's
   * turns confirms all 105 and surfaces none. `turnBoundaryAt` is that surface.
   */
  async reconcileInjected(now = new Date().toISOString()): Promise<number> {
    let confirmed = 0;
    // Anchored to the caller's `now`, not the wall clock, so the deadline means
    // the same thing to a test as it does to the daemon.
    const cutoff = new Date(Date.parse(now) - DELIVERY_CONFIRM_DEADLINE_MS)
      .toISOString();
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
      // and a deep build turn routinely outlives any fixed deadline. This
      // alert fired seven times in one evening for agents that were simply
      // working, and a wolf-cry on the very channel that reveals genuine
      // deafness trains the one reader it has to ignore it. A busy message
      // stays unalerted (alertAt null), so every later sweep re-judges it and
      // still fires the moment its recipient stops showing signs of life.
      if (injectedAt < cutoff && message.alertAt === null) {
        const reason = await this.stalledReason(message.to, now);
        if (reason !== null) stalled.push({ message, reason });
      }
    }

    // Queued messages get the same triage, because a genuinely deaf recipient
    // never lets a message reach "injected" at all: the historical codex
    // deafness BLOCKED delivery, and a watchdog reading only the injected
    // state is blind to the one incident it exists for. Queued-while-busy is
    // routine (ordinary traffic waits for the turn boundary) and stays
    // silent; queued at a recipient that shows no signs of life is the alarm.
    // Root-bound messages are exempt: the root's queue is its inbox, drained
    // by hive_inbox on its own turns — and the root is this alert's audience,
    // so "you have unread mail" would be noise by construction.
    for (const message of this.db.listQueuedMessages()) {
      if (message.to === ORCHESTRATOR_NAME) continue;
      if (message.createdAt < cutoff && message.alertAt === null) {
        if (await this.stalledReason(message.to, now, "queued") === null) {
          continue;
        }
        // The sweep runs on its own timer, and twice in one day (aubrey
        // 16:27Z, aurora 17:04Z, 2026-07-12) it fired inside the second
        // between a recipient's turn-end and the flush completing that very
        // delivery — diagnosing a swallowed paste for a message that was
        // mid-paste under the session lock, and sending the orchestrator
        // chasing a loss that never happened. Serialize behind the
        // recipient's delivery lane and re-judge: only a message still
        // queued once any in-flight delivery has finished is stalled.
        const recipient = this.db.getAgentByName(message.to);
        if (recipient !== null) {
          const settled = await this.withSessionLock(
            recipient.tmuxSession,
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
      // precisely the silent loss SPEC §3 forbids. So we surface the FACT and
      // preserve the DETAIL: the count and each recipient's measured state go
      // in one line, every message stays queryable by id, and none is
      // discarded.
      const reasons = new Map<string, string>();
      for (const { message, reason } of stalled) {
        reasons.set(message.to, reason);
        this.db.markMessageAlerted(message.id, now);
      }
      const detail = [...reasons.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([, reason]) => reason).join("; ");
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
      // *that* report stalls too: a loop with no fixed point, feeding on the one
      // context §3 says must stay clear, and it grows by one message every time
      // the root is quiet. Born already alerted, it can never be surfaced again.
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
   * asking for one returns null, and null read as "never took a turn" is what made
   * every root-bound message permanently unconfirmable. Its turns are in the events
   * table, posted by its own hooks. Same question, different surface, and the rule
   * from §2 applies exactly: read what the tool measures and hands you.
   */
  private turnBoundaryAt(recipient: string): string | null {
    if (recipient === ORCHESTRATOR_NAME) {
      return this.db.latestTurnEndAt(ORCHESTRATOR_NAME);
    }
    // Was `lastEventAt`, which is the newest event of any kind. An idle agent
    // emits `notification` events while doing nothing, so an unsubmitted paste
    // got "confirmed" by the recipient sitting still. Only a real turn counts.
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
   * recipient has nothing to show: no turn events at all (the historical
   * codex deafness — five agents, zero hooks, ~2h unconfirmable), or a closed
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
    const agent = recipient === ORCHESTRATOR_NAME
      ? null
      : this.db.getAgentByName(recipient);
    if (agent !== null && (agent.status === "dead" || agent.status === "failed")) {
      return `${recipient} is ${agent.status} and will never reach a boundary`;
    }
    const boundary = this.db.latestTurnBoundary(recipient);
    if (boundary === null) {
      // "No turn events at all" is a diagnosis about a vendor that HAS a hook
      // stream and has gone silent on it. Said about grok, which has none, it
      // is true of every grok agent that ever lived and means nothing — and it
      // was said, about a healthy one (cesar, 2026-07-12). Judge that vendor on
      // the surface it does write: the transcript activity the telemetry sweep
      // carries into lastEventAt. Quiet past the open-turn cap is the same
      // finding this alert exists for; anything fresher is an agent working or
      // waiting, not a deaf one.
      if (agent !== null && !reportsTurnEvents(agent.tool)) {
        const silentMs = Date.parse(now) - Date.parse(agent.lastEventAt);
        return silentMs < OPEN_TURN_SILENCE_CAP_MS ? null : `${recipient} (${agent.tool}) has shown no session activity for ${
          Math.round(silentMs / 60_000)
        }m — it may be unable to hear`;
      }
      return `${recipient} has emitted no turn events at all — it may be unable to hear`;
    }
    if (boundary.kind === "turn-end") {
      // "Swallowed paste" is a diagnosis about a paste that happened; a queued
      // message was never pasted, and the alert that conflated the two sent
      // the orchestrator hunting a tmux loss that never occurred.
      return phase === "queued"
        ? `${recipient} went idle without receiving it — delivery at its turn boundaries has not landed`
        : `${recipient} is idle yet never submitted it — the paste may have been swallowed`;
    }
    // An open turn. Before inferring anything from silence, ask the OS: a
    // stopped or vanished process is a measured state, provable in one call,
    // and it rings NOW — not after a timeout dressed up as a diagnosis. A
    // failed probe reads as running (never alarm on a read we could not
    // make); the silence cap below remains the honest last resort for the one
    // wedge the kernel cannot see, a process alive but internally hung.
    if (agent !== null && this.processState !== undefined) {
      const state = await this.processState(agent.tmuxSession)
        .catch(() => "running" as const);
      if (state === "stopped") {
        return `${recipient}'s process is stopped (suspended mid-turn, ps state T) — it cannot hear anything`;
      }
      if (state === "gone") {
        return `${recipient}'s process is gone mid-turn — nothing is left to reach a boundary`;
      }
    }
    const life = recipient === ORCHESTRATOR_NAME
      ? this.db.latestEventAt(recipient)
      : agent?.lastEventAt ?? null;
    const quietMs = life === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(now) - Date.parse(life);
    if (quietMs < OPEN_TURN_SILENCE_CAP_MS) {
      return null; // Mid-turn and demonstrably alive: busy, not deaf.
    }
    return `${recipient} is mid-turn but has shown no sign of life for ${
      Math.round(quietMs / 60_000)
    }m`;
  }

  async alertExpiredControls(now = new Date().toISOString()): Promise<number> {
    let count = 0;
    for (const message of this.db.listExpiredUnacknowledged(now)) {
      if (this.db.markMessageAlerted(message.id, now)?.alertAt !== now) continue;
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

  async recoverCriticalControls(): Promise<number> {
    if (this.controls === undefined) return 0;
    let recovered = 0;
    for (const queued of this.db.listQueuedCriticalMessages()) {
      let message = queued;
      let recipient = this.db.getAgentByName(message.to);
      if (recipient === null) continue;
      if (!recipient.writeRevoked) {
        recipient = this.db.revokeAgentCapabilities(
          recipient.name,
          new Date().toISOString(),
        );
        if (recipient === null) continue;
        message = this.db.assignMessageCapabilityEpoch(
          message.id,
          recipient.capabilityEpoch,
        )!;
      }
      try {
        const acted = await this.withSessionLock(recipient.tmuxSession, async () => {
          // Re-check under the lock: this method runs from both the
          // maintenance tick and the session-start hook, and the queued-state
          // check above happened outside the lock. Without this, two
          // overlapping sweeps both see "queued" and interrupt-and-restart
          // the same agent twice.
          const current = this.db.getMessage(message.id);
          if (current === null || current.state !== "queued") return false;
          const latest = this.db.getAgentByName(message.to);
          if (latest === null) return false;
          await this.controls!.interruptAndRestart(latest, current);
          this.markInjected(current);
          return true;
        });
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
   * This used to mark a normal message "applied", the strongest claim in the
   * system, meaning the recipient acted on it. The entire evidence for that
   * claim was that `tmux send-keys` did not throw. Measured against a real busy
   * pane: the paste succeeds, exit 0, and the TUI then prints "Messages to be
   * submitted after next tool call" and holds the text — unsubmitted for over
   * two minutes while the model reasoned. Hive recorded "applied" at the exact
   * moment the screen said the opposite. That is measuring bytes written to a
   * pane and reporting that a mind changed.
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
    const stored = this.db.transitionMessage(message.id, "injected", now)!;

    // The acknowledgement clock starts when the agent could first have seen it,
    // not when the sender pressed send. Charging a recipient for time its message
    // spent queued is how a control expired seventeen minutes before it arrived.
    if (stored.deadlineAt !== null && this.ackBudgetMs(stored) !== null) {
      const deadline = new Date(
        new Date(now).getTime() + this.ackBudgetMs(stored)!,
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

  private requireLiveRecipient(name: string): NonNullable<
    ReturnType<HiveDatabase["getAgentByName"]>
  > {
    const recipient = this.db.getAgentByName(name);
    if (recipient === null) {
      throw new Error(`Recipient agent not found: ${name}`);
    }
    if (
      recipient.status === "dead" || recipient.status === "done" ||
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
