import {
  AgentMessageSchema,
  ORCHESTRATOR_NAME,
  type AgentMessage,
  type AgentRecord,
  type ControlIntent,
  type MessagePriority,
  type OrchestratorMessageEnvelope,
} from "../schemas";
import { TmuxAdapter } from "../adapters/tmux";
import { HiveDatabase } from "./db";
import {
  createOrchestratorEnvelope,
  formatOrchestratorWake,
  orchestratorTmuxSession,
} from "./orchestrator-lifecycle";

export interface TmuxSender {
  sendMessage(session: string, text: string): Promise<void>;
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

const DEFAULT_URGENT_DEADLINE_MS = 30_000;
const DEFAULT_CRITICAL_DEADLINE_MS = 10_000;

export class BunTmuxSender implements TmuxSender {
  constructor(private readonly tmux: Pick<TmuxAdapter, "sendKeys"> = new TmuxAdapter()) {}

  async sendMessage(session: string, text: string): Promise<void> {
    await this.tmux.sendKeys(session, text);
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
  ) {}

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
          return this.deliver(current, currentRecipient.tmuxSession);
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
      return this.deliver(current, currentRecipient.tmuxSession);
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
          delivered.push(await this.deliver(
            message,
            currentRecipient.tmuxSession,
          ));
        } catch {
          // A failed pane must not prevent later queued messages from delivery.
        }
      }
      return delivered;
    });
  }

  inbox(agentName: string): AgentMessage[] {
    const deliveredAt = new Date().toISOString();
    return this.db.claimUndeliveredMessages(agentName, deliveredAt).map(
      (message) => message.priority === "normal"
        ? this.db.transitionMessage(message.id, "applied", deliveredAt)!
        : this.db.transitionMessage(message.id, "injected", deliveredAt)!,
    );
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
    session: string,
  ): Promise<AgentMessage> {
    const text = message.priority === "normal"
      ? `📨 message from ${message.from}: ${message.body}`
      : [
          `⚠️ ${message.priority.toUpperCase()} HIVE CONTROL ${message.id} from ${message.from}: ${message.body}`,
          `Acknowledge with hive_ack_message agent=${JSON.stringify(message.to)} messageId=${JSON.stringify(message.id)}${
            message.capabilityEpoch === null
              ? ""
              : ` capabilityEpoch=${message.capabilityEpoch}`
          } applied=true.`,
        ].join("\n");
    await this.tmux.sendMessage(
      session,
      text,
    );
    const delivered = this.markInjected(message);
    if (delivered === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
    return delivered;
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
    for (const queued of this.db.listMessages()) {
      let message = queued;
      if (message.priority !== "critical" || message.state !== "queued") {
        continue;
      }
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
        await this.withSessionLock(recipient.tmuxSession, async () => {
          const latest = this.db.getAgentByName(message.to);
          if (latest === null) return;
          await this.controls!.interruptAndRestart(latest, message);
          this.markInjected(message);
        });
        recovered += 1;
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

  private markInjected(message: AgentMessage): AgentMessage {
    const now = new Date().toISOString();
    const injected = this.db.markMessageDelivered(message.id, now);
    if (injected === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
    return this.db.transitionMessage(
      message.id,
      message.priority === "normal" ? "applied" : "injected",
      now,
    )!;
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

export { MessageDelivery as DeliveryService };
