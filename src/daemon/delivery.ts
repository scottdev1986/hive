import {
  AgentMessageSchema,
  ORCHESTRATOR_NAME,
  type AgentMessage,
} from "../schemas";
import { sendKeys } from "../adapters/tmux";
import { HiveDatabase } from "./db";

export interface TmuxSender {
  sendMessage(session: string, text: string): Promise<void>;
}

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
  ) {}

  async send(from: string, to: string, body: string): Promise<AgentMessage> {
    // The orchestrator runs in the user's terminal, not in a tmux session or
    // the agents table, so messages to it always queue for hive_inbox.
    const recipient = to === ORCHESTRATOR_NAME
      ? null
      : this.requireLiveRecipient(to);
    const message = AgentMessageSchema.parse({
      id: crypto.randomUUID(),
      from,
      to,
      body,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    });
    this.db.insertMessage(message);

    if (recipient === null || recipient.status !== "idle") {
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
      return [];
    }
    const recipient = this.db.getAgentByName(agentName);
    if (recipient === null || recipient.status === "dead") {
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
    return this.db.getUndeliveredMessages(agentName).map((message) =>
      this.db.markMessageDelivered(message.id, deliveredAt)!,
    );
  }

  private async deliver(
    message: AgentMessage,
    session: string,
  ): Promise<AgentMessage> {
    await this.tmux.sendMessage(
      session,
      `📨 message from ${message.from}: ${message.body}`,
    );
    const delivered = this.db.markMessageDelivered(
      message.id,
      new Date().toISOString(),
    );
    if (delivered === null) {
      throw new Error(`Message disappeared during delivery: ${message.id}`);
    }
    return delivered;
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
    if (recipient.status === "dead") {
      throw new Error(`Recipient agent is dead: ${name}`);
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
