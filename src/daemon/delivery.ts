import {
  AgentMessageSchema,
  ORCHESTRATOR_NAME,
  type AgentMessage,
  type AgentRecord,
  type ControlIntent,
  type MessagePriority,
  type OrchestratorMessageEnvelope,
} from "../schemas";
import { sendKeys } from "../adapters/tmux";
import { HiveDatabase } from "./db";
import {
  createOrchestratorEnvelope,
  formatOrchestratorWake,
  ORCHESTRATOR_TMUX_SESSION,
} from "./orchestrator-lifecycle";

export interface TmuxSender {
  sendMessage(session: string, text: string): Promise<void>;
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

const DEFAULT_URGENT_DEADLINE_MS = 30_000;
const DEFAULT_CRITICAL_DEADLINE_MS = 10_000;

export class BunTmuxSender implements TmuxSender {
  async sendMessage(session: string, text: string): Promise<void> {
    await sendKeys(session, text);
  }
}

export class MessageDelivery {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: HiveDatabase,
    private readonly tmux: TmuxSender,
    private readonly controls?: CriticalControlRuntime,
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
    const capabilityEpoch = priority === "critical" && recipient !== null
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
      try {
        await this.controls.interruptAndRestart(currentRecipient, message);
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
    }

    if (recipient === null) {
      return message;
    }

    if (recipient.status !== "idle") {
      return message;
    }

    return this.withSessionLock(recipient.tmuxSession, async () => {
      const current = this.getStoredMessage(message.id);
      if (current.deliveredAt !== null) {
        return current;
      }

      const currentRecipient = this.requireLiveRecipient(to);
      if (currentRecipient.status !== "idle") {
        return current;
      }
      return this.deliver(current, currentRecipient.tmuxSession);
    });
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
      if (currentRecipient?.status !== "idle") {
        return [];
      }

      const delivered: AgentMessage[] = [];
      for (const queued of this.db.getUndeliveredMessages(agentName)) {
        try {
          const message = this.db.getMessage(queued.id);
          if (message === null || message.deliveredAt !== null) {
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
    return this.withSessionLock(ORCHESTRATOR_TMUX_SESSION, async () =>
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
    return this.withSessionLock(ORCHESTRATOR_TMUX_SESSION, async () => {
      const delivered: AgentMessage[] = [];
      for (const message of this.db.getUndeliveredMessages(ORCHESTRATOR_NAME)) {
        await this.tmux.sendMessage(
          ORCHESTRATOR_TMUX_SESSION,
          formatOrchestratorWake(createOrchestratorEnvelope(message)),
        );
        const acknowledged = this.db.acknowledgeMessage(
          message.id,
          new Date().toISOString(),
        );
        if (acknowledged !== null) {
          delivered.push(this.db.transitionMessage(
            acknowledged.id,
            "applied",
            acknowledged.deliveredAt!,
          )!);
        }
      }
      return delivered;
    });
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
        await this.controls.interruptAndRestart(recipient, message);
        this.markInjected(message);
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
