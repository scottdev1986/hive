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
  type SessiondInjectResult,
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

/**
 * The terminal's foreground identity measured now, returned ONLY when the
 * run's recorded identity is no longer observable (recorded pid dead, or its
 * start token no longer matches). A live recorded identity yields undefined:
 * it means the provider process exists and simply is not foreground — for
 * example a tool subprocess owns the tty — and typing into whatever is
 * foreground would deliver the notice to the wrong process.
 */
export type StaleRunForeground = (
  recipient: AgentRecord,
  run: ProviderRun,
) => Promise<
  { pid: number; startToken: string; processGroupId: number } | undefined
>;

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
    private readonly staleRunForeground?: StaleRunForeground,
  ) {}

  /** Latest per-recipient decline sentence, kept for blockedDeliveries. The
   * durable record is the message-attempt row; this map only preserves the
   * host's exact wording, which the attempt outcome enum cannot carry. */
  private readonly declines = new Map<
    string,
    { messageId: string; reason: string }
  >();

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
      const first = queued[0];
      if (first === undefined) return [];
      const urgent = queued.some((message) => message.priority === "urgent");
      const rootProtocol = this.rootProtocol;
      if (rootProtocol === undefined) return [];
      const outcome = await rootProtocol.deliverMessage(
        this.formatNotice(messages, urgent),
        {
          message_id: first.id,
          unread: String(messages.length),
          urgent: String(urgent),
        },
      );
      if (!outcome.delivered) {
        this.declines.set(ORCHESTRATOR_NAME, {
          messageId: first.id,
          reason: outcome.reason,
        });
        return [];
      }
      this.declines.delete(ORCHESTRATOR_NAME);
      return queued.map((message) => this.markNotified(message.id));
    });
  }

  acknowledge(agentName: string, messageId: string): AgentMessage {
    const message = this.getStoredMessage(messageId);
    if (message.to !== canonicalOrchestratorName(agentName)) {
      throw new Error(`Message ${messageId} is not addressed to ${agentName}`);
    }
    // A queued row is acknowledgeable. hive_inbox serves queued rows precisely
    // so a recipient can read mail whose terminal notice has not landed yet,
    // and an acknowledgement is the recipient's own statement that it read the
    // message — stronger evidence than any notice. The durable record keeps
    // the distinction: an ack from queued leaves notifiedAt null, an ack after
    // a notice carries both timestamps.
    return (
      this.db.transitionMessage(
        messageId,
        "acknowledged",
        new Date().toISOString(),
      ) ?? message
    );
  }

  /** Recipients whose oldest queued message has a recorded failed delivery.
   * A queued message that simply has not met a delivery trigger yet is not
   * blocked and does not appear here. */
  blockedDeliveries(): Map<
    string,
    { messageId: string; queuedMinutes: number; diagnostic: string }
  > {
    const blocked = new Map<
      string,
      { messageId: string; queuedMinutes: number; diagnostic: string }
    >();
    const recipients = this.db
      .listAgents()
      .filter((agent) => !["dead", "done", "failed"].includes(agent.status))
      .map((agent) => agent.name);
    recipients.push(ORCHESTRATOR_NAME);
    for (const recipient of recipients) {
      const first = this.db
        .getUnacknowledgedMessages(recipient)
        .find((message) => message.state === "queued");
      if (first === undefined) continue;
      const noted = this.declines.get(recipient);
      const lastAttempt = this.db.listMessageAttempts(first.id).at(-1);
      const diagnostic =
        noted?.messageId === first.id
          ? noted.reason
          : lastAttempt !== undefined &&
              lastAttempt.outcome !== "written" &&
              lastAttempt.outcome !== "pending"
            ? lastAttempt.outcome
            : undefined;
      if (diagnostic === undefined) continue;
      blocked.set(recipient, {
        messageId: first.id,
        queuedMinutes: Math.floor(
          (Date.now() - Date.parse(first.createdAt)) / 60_000,
        ),
        diagnostic,
      });
    }
    return blocked;
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
      if (run === null || !(await this.providerIsRunning(recipient))) {
        this.declines.set(recipient.name, {
          messageId: first.id,
          reason:
            run === null
              ? "no active provider run is bound to the terminal"
              : "provider process is not running",
        });
        return [];
      }
      // Escape at most once per message, ever: cancelling a turn is a side
      // effect that must not repeat when the notice write fails and a later
      // trigger retries this delivery. The durable attempt history is the
      // evidence of a prior try, not this process's memory.
      const priorAttempts = this.db.listMessageAttempts(first.id);
      const attempt = this.db.beginMessageAttempt({
        attemptId: crypto.randomUUID(),
        messageId: first.id,
        expectedProviderRunId: run.runId,
        terminalGeneration: terminal.generation,
        expectedForeground: this.expectedForeground(run),
        attemptedAt: new Date().toISOString(),
      });
      if (interrupt && priorAttempts.length === 0) {
        // Escape is the accelerator, not the deliverable: a declined Escape
        // leaves the turn running, and the notice below is still worth
        // writing. Both writes share one fence path, so a cancelled turn
        // cannot outrun its own notice to a different foreground.
        await this.writeWithFenceRecovery(recipient, run, terminal, {
          bytes: new TextEncoder().encode("\u001b"),
          idempotencyKey: `${messageId}:escape`,
        });
      }
      const written = await this.writeWithFenceRecovery(
        recipient,
        run,
        terminal,
        {
          bytes: encodeSubmittedText(notice),
          idempotencyKey: attempt.attemptId,
        },
      );
      if (written.outcome === "declined") {
        this.db.finishMessageAttempt(attempt.attemptId, {
          outcome: written.reason.includes("foreground-changed")
            ? "foreground-changed"
            : written.reason.startsWith("claim ")
              ? "input-busy"
              : "unknown",
          terminalReceipt: written.receipt ?? null,
        });
        this.declines.set(recipient.name, {
          messageId: first.id,
          reason: written.reason,
        });
        return [];
      }
      this.db.finishMessageAttempt(attempt.attemptId, {
        outcome: "written",
        terminalReceipt: written.receipt,
      });
      this.declines.delete(recipient.name);
    } else {
      await this.sessions.sendSessionMessage(recipient, notice, {
        messageId,
        interrupt,
      });
    }
    return queued.map((message) => this.markNotified(message.id));
  }

  /**
   * One fenced write with a single recovery. The run's recorded foreground
   * identity can be a startup transient that died a second after launch: the
   * vendor spawned a child and moved the terminal's process group, so the
   * host refuses every write fenced on the record as `foreground-changed`,
   * forever. When that happens and the recorded identity is provably gone,
   * retry once against the foreground measured now. A recorded identity that
   * is still alive is never overridden — the provider process exists and
   * simply is not foreground (a tool subprocess may own the tty), and typing
   * into whatever is foreground would reach the wrong process. The retry
   * needs its own key: the host replays a known key's receipt verbatim, and
   * the failed try stored a rejection under the original one.
   */
  private async writeWithFenceRecovery(
    recipient: AgentRecord,
    run: ProviderRun,
    terminal: ReturnType<typeof requireSessiondAgentLocator>,
    write: { bytes: Uint8Array; idempotencyKey: string },
  ): Promise<SessiondInjectResult> {
    const input = this.sessiondInput;
    if (input === undefined) {
      return { outcome: "declined", reason: "sessiond input is not wired" };
    }
    const first = await input.writeAutomated({
      terminal,
      expectedForeground: {
        providerRunId: run.runId,
        ...this.expectedForeground(run),
      },
      bytes: write.bytes,
      idempotencyKey: write.idempotencyKey,
    });
    if (
      first.outcome !== "declined" ||
      !first.reason.includes("foreground-changed") ||
      this.staleRunForeground === undefined
    ) {
      return first;
    }
    const measured = await this.staleRunForeground(recipient, run);
    if (measured === undefined) return first;
    return input.writeAutomated({
      terminal,
      expectedForeground: { providerRunId: run.runId, ...measured },
      bytes: write.bytes,
      idempotencyKey: `${write.idempotencyKey}:remeasured`,
    });
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
