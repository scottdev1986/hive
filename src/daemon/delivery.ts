import {
  type AgentMessage,
  AgentMessageSchema,
  type AgentRecord,
  canonicalOrchestratorName,
  isOrchestratorName,
  type MessagePriority,
  ORCHESTRATOR_NAME,
  orchestratorRecipientNames,
  type ProviderRun,
} from "../schemas";
import { isComposerLeased } from "./composer-lease";
import type { HiveDatabase } from "./db";
import type { PaneProcessState } from "./resources";
import { requireSessiondAgentLocator } from "./session-host/hive-terminal-host";
import {
  encodeSubmittedText,
  type SessiondAgentInput,
} from "./session-host/sessiond-agent-input";

function idempotencySenders(from: string): readonly string[] {
  return isOrchestratorName(from) ? orchestratorRecipientNames() : [from];
}

function agentSessionLockKey(agent: AgentRecord): string {
  const locator = agent.sessionLocator;
  return locator === undefined
    ? `agent:${agent.id}`
    : [
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
  ): Promise<void>;
}

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
  idempotencyKey?: string;
}

export function queuedDeliveryNote(
  message: AgentMessage,
  recipient: AgentRecord | null,
): string | undefined {
  if (message.state !== "queued") return undefined;
  if (recipient === null && isOrchestratorName(message.to)) {
    return "Queued until the queen's TUI can receive an inbox notice.";
  }
  if (recipient === null) return undefined;
  return recipient.status === "working"
    ? `Queued until ${recipient.name} finishes its current turn.`
    : `Queued until Hive can show ${recipient.name} an inbox notice.`;
}

/**
 * Durable inbox delivery with two policies only:
 *
 * - normal waits for an idle/turn-end path;
 * - urgent sends Escape once, then shows the same compact inbox notice.
 *
 * A terminal notice is deliberately not a delivery receipt. Only the recipient's
 * hive_ack_message call moves a row to acknowledged.
 */
export class MessageDelivery {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: HiveDatabase,
    private readonly sessions: SessionSender,
    // Kept as a positional slot while callers move off the old control runtime.
    _unusedControlRuntime?: unknown,
    private readonly rootProtocol?: RootProtocolDeliverer,
    _unusedTiming?: unknown,
    private readonly processState?: (
      agent: AgentRecord,
    ) => Promise<PaneProcessState | "unknown">,
    private readonly composerActive: (
      recipient: string,
    ) => boolean = isComposerLeased,
    private readonly sessiondInput?: SessiondAgentInput,
  ) {}

  async send(
    from: string,
    to: string,
    body: string,
    options: SendOptions = {},
  ): Promise<AgentMessage> {
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
    if (
      recipient !== null &&
      ["dead", "done", "failed"].includes(recipient.status)
    ) {
      throw new Error(`Recipient agent is ${recipient.status}: ${to}`);
    }

    const now = new Date().toISOString();
    const message = this.db.insertMessage(
      AgentMessageSchema.parse({
        id: crypto.randomUUID(),
        from,
        to,
        body,
        createdAt: now,
        priority: options.priority ?? "normal",
        state: "queued",
        sequence: this.db.nextMessageSequence(to),
        idempotencyKey: options.idempotencyKey ?? null,
      }),
    );

    if (to === ORCHESTRATOR_NAME) {
      await this.wakeOrchestrator();
    } else if (message.priority === "urgent") {
      await this.flushUrgent(to);
    } else {
      await this.flushQueued(to);
    }
    return this.getStoredMessage(message.id);
  }

  /** Normal notices are sent only when an agent is idle. */
  async flushQueued(agentName: string): Promise<AgentMessage[]> {
    if (isOrchestratorName(agentName)) return this.wakeOrchestrator();
    const recipient = this.db.getAgentByName(agentName);
    if (
      recipient === null ||
      recipient.status !== "idle" ||
      this.composerActive(agentName)
    ) {
      return [];
    }
    return this.withSessionLock(agentSessionLockKey(recipient), async () => {
      const current = this.db.getAgentByName(agentName);
      if (
        current === null ||
        current.status !== "idle" ||
        this.composerActive(agentName)
      ) {
        return [];
      }
      return this.deliverAgentNotice(current, false);
    });
  }

  /** Urgent delivery sends Escape once before posting the compact notice. */
  async flushUrgent(agentName: string): Promise<AgentMessage[]> {
    if (isOrchestratorName(agentName)) return this.wakeOrchestrator();
    const recipient = this.db.getAgentByName(agentName);
    if (
      recipient === null ||
      ["dead", "done", "failed", "awaiting-approval"].includes(
        recipient.status,
      ) ||
      this.composerActive(agentName)
    ) {
      return [];
    }
    return this.withSessionLock(agentSessionLockKey(recipient), async () => {
      const current = this.db.getAgentByName(agentName);
      if (current === null || this.composerActive(agentName)) return [];
      return this.deliverAgentNotice(current, current.status === "working");
    });
  }

  /** Idle recipients have no further hook event, so the maintenance sweep wakes them. */
  async wakeIdleRecipients(): Promise<AgentMessage[]> {
    const notified: AgentMessage[] = [];
    for (const agent of this.db.listAgents()) {
      if (agent.status === "idle") {
        notified.push(...(await this.flushQueued(agent.name)));
      }
    }
    if (
      orchestratorRecipientNames().some(
        (name) => this.db.getUnacknowledgedMessages(name).length > 0,
      )
    ) {
      notified.push(...(await this.wakeOrchestrator()));
    }
    return notified;
  }

  /** Reading is pure. It never changes a message's acknowledgement state. */
  async inbox(agentName: string): Promise<AgentMessage[]> {
    return this.db.getUnacknowledgedMessages(agentName);
  }

  async orchestratorInbox(): Promise<AgentMessage[]> {
    return orchestratorRecipientNames().flatMap((name) =>
      this.db.getUnacknowledgedMessages(name),
    );
  }

  readOrchestratorMessage(id: string): AgentMessage | null {
    const message = this.db.getMessage(id);
    return message !== null && isOrchestratorName(message.to) ? message : null;
  }

  async wakeOrchestrator(): Promise<AgentMessage[]> {
    if (this.rootComposerActive() || this.rootProtocol?.isLive() !== true) {
      return [];
    }
    return this.withSessionLock("root", async () => {
      if (this.rootComposerActive() || this.rootProtocol?.isLive() !== true) {
        return [];
      }
      const messages = await this.orchestratorInbox();
      const queued = messages.filter((message) => message.state === "queued");
      if (queued.length === 0) return [];
      const urgent = queued.some((message) => message.priority === "urgent");
      const rootProtocol = this.rootProtocol;
      if (rootProtocol === undefined) return [];
      const outcome = await rootProtocol.deliverMessage(
        this.formatNotice(messages, urgent),
        {
          message_id: queued[0]?.id ?? "",
          unread: String(messages.length),
          urgent: String(urgent),
        },
      );
      if (!outcome.delivered) return [];
      return queued.map((message) => this.markNotified(message.id));
    });
  }

  acknowledge(agentName: string, messageId: string): AgentMessage {
    const message = this.getStoredMessage(messageId);
    if (message.to !== canonicalOrchestratorName(agentName)) {
      throw new Error(`Message ${messageId} is not addressed to ${agentName}`);
    }
    if (message.state === "queued") {
      throw new Error(`Message ${messageId} has not been notified`);
    }
    return (
      this.db.transitionMessage(
        messageId,
        "acknowledged",
        new Date().toISOString(),
      ) ?? message
    );
  }

  blockedDeliveries(): Map<
    string,
    { messageId: string; queuedMinutes: number; diagnostic: string }
  > {
    return new Map();
  }

  private async deliverAgentNotice(
    recipient: AgentRecord,
    interrupt: boolean,
  ): Promise<AgentMessage[]> {
    const messages = this.db.getUnacknowledgedMessages(recipient.name);
    const queued = messages.filter((message) => message.state === "queued");
    if (queued.length === 0) return [];
    const urgent = queued.some((message) => message.priority === "urgent");
    const notice = this.formatNotice(messages, urgent);
    const first = queued[0];
    if (first === undefined) return [];
    const messageId = `hive-notice:${recipient.name}:${first.id}`;

    if (this.sessiondInput !== undefined) {
      const terminal = requireSessiondAgentLocator(recipient);
      const run = this.db.getActiveProviderRunByTerminal(terminal);
      if (run === null || !(await this.providerIsRunning(recipient))) return [];
      const expectedForeground = this.expectedForeground(run);
      if (interrupt) {
        const cancelled = await this.sessiondInput.writeAutomated({
          terminal,
          expectedForeground: {
            providerRunId: run.runId,
            ...expectedForeground,
          },
          bytes: new TextEncoder().encode("\u001b"),
          idempotencyKey: `${messageId}:escape`,
        });
        if (cancelled.outcome === "declined") return [];
      }
      const written = await this.sessiondInput.writeAutomated({
        terminal,
        expectedForeground: { providerRunId: run.runId, ...expectedForeground },
        bytes: encodeSubmittedText(notice),
        idempotencyKey: messageId,
      });
      if (written.outcome === "declined") return [];
    } else {
      await this.sessions.sendSessionMessage(recipient, notice, {
        messageId,
        interrupt,
      });
    }
    return queued.map((message) => this.markNotified(message.id));
  }

  private formatNotice(
    messages: readonly AgentMessage[],
    urgent: boolean,
  ): string {
    const first = messages[0];
    if (urgent) {
      return messages.length === 1 && first !== undefined
        ? `⚠️ Hive: urgent message from ${first.from}. Check hive_inbox now.`
        : `⚠️ Hive: ${messages.length} unread messages, including urgent mail. Check hive_inbox now.`;
    }
    return messages.length === 1 && first !== undefined
      ? `📨 Hive: message from ${first.from}. Check hive_inbox.`
      : `📨 Hive: ${messages.length} unread messages. Check hive_inbox.`;
  }

  private rootComposerActive(): boolean {
    return orchestratorRecipientNames().some((name) =>
      this.composerActive(name),
    );
  }

  private async providerIsRunning(agent: AgentRecord): Promise<boolean> {
    if (this.processState === undefined) return true;
    return (
      (await this.processState(agent).catch(() => "unknown")) === "running"
    );
  }

  private expectedForeground(run: ProviderRun): {
    pid: number;
    startToken: string;
    processGroupId: number;
  } {
    return {
      pid: run.pid,
      startToken: run.startToken,
      processGroupId: run.foregroundProcessGroupId,
    };
  }

  private markNotified(id: string): AgentMessage {
    const message = this.db.transitionMessage(
      id,
      "notified",
      new Date().toISOString(),
    );
    if (message === null)
      throw new Error(`Message disappeared during notification: ${id}`);
    return message;
  }

  private getStoredMessage(id: string): AgentMessage {
    const message = this.db.getMessage(id);
    if (message === null) throw new Error(`Message not found: ${id}`);
    return message;
  }

  private async withSessionLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionLocks.set(
      key,
      previous.then(() => next),
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionLocks.get(key) === next) this.sessionLocks.delete(key);
    }
  }
}
