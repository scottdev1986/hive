import { ORCHESTRATOR_NAME, type AgentRecord } from "../schemas";

// Claude Code gained Channels (research preview) in 2.1.80 and the
// claude/channel/permission relay in 2.1.81. Older CLIs silently drop the
// notifications, so both gates are enforced before any delivery is trusted.
export const CHANNELS_MIN_VERSION = "2.1.80";
export const PERMISSION_RELAY_MIN_VERSION = "2.1.81";

export function parseCliVersion(
  text: string,
): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const left = parseCliVersion(version);
  const right = parseCliVersion(minimum);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return true;
}

export interface ChannelMessageEvent {
  kind: "message";
  deliveryId: string;
  content: string;
  meta: Record<string, string>;
}

export interface ChannelPermissionDecisionEvent {
  kind: "permission-decision";
  deliveryId: string;
  requestId: string;
  behavior: "allow" | "deny";
}

export type ChannelEvent =
  | ChannelMessageEvent
  | ChannelPermissionDecisionEvent;

export interface ChannelRegistration {
  enabled: boolean;
  reason?: string;
  permissionRelay: boolean;
  /**
   * True when the refusal may resolve on its own — the agent row has not
   * appeared yet, or the session is momentarily not accepting deliveries. The
   * bridge retries these and gives up permanently on the rest, so a spawn race
   * never costs a session its channel.
   */
  retryable: boolean;
}

interface ChannelConnection {
  clientVersion: string;
  lastPollAt: number;
  queue: ChannelEvent[];
  waiter: ((events: ChannelEvent[]) => void) | null;
  waiterTimer: ReturnType<typeof setTimeout> | null;
  pendingAcks: Map<string, (ok: boolean) => void>;
}

interface PendingPermission {
  agentName: string;
  requestId: string;
  createdAt: number;
}

export interface ChannelRegistryOptions {
  ackTimeoutMs?: number;
  livenessMs?: number;
  permissionTtlMs?: number;
  now?: () => number;
}

interface AgentLookup {
  getAgentByName(name: string): AgentRecord | null;
}

const LIVE_STATUSES: ReadonlySet<AgentRecord["status"]> = new Set([
  "spawning",
  "working",
  "idle",
  "awaiting-approval",
  "stuck",
]);

// Channels delivery is fire-and-forget at the vendor boundary: the bridge's
// ack means "written to the CLI's stdio transport", never "seen by the model".
export class ChannelRegistry {
  private readonly connections = new Map<string, ChannelConnection>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly ackTimeoutMs: number;
  private readonly livenessMs: number;
  private readonly permissionTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: AgentLookup,
    options: ChannelRegistryOptions = {},
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
    this.livenessMs = options.livenessMs ?? 45_000;
    this.permissionTtlMs = options.permissionTtlMs ?? 30 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  register(
    agentName: string,
    clientName: string,
    clientVersion: string,
  ): ChannelRegistration {
    // A CLI too old to speak Channels, or an agent hive did not launch with
    // the preview, can never become eligible: refuse permanently.
    if (!versionAtLeast(clientVersion, CHANNELS_MIN_VERSION)) {
      return {
        enabled: false,
        permissionRelay: false,
        retryable: false,
        reason:
          `${clientName} ${clientVersion} predates Channels (${CHANNELS_MIN_VERSION})`,
      };
    }
    // The root is not an agent row, but it is launched by Hive with the same
    // verified Claude Channels bridge. It is the one interactive recipient
    // that must never fall back to pane input.
    if (agentName === ORCHESTRATOR_NAME) {
      const existing = this.connections.get(agentName);
      if (existing !== undefined) this.disconnect(agentName, existing);
      this.connections.set(agentName, {
        clientVersion,
        lastPollAt: this.now(),
        queue: [],
        waiter: null,
        waiterTimer: null,
        pendingAcks: new Map(),
      });
      return {
        enabled: true,
        retryable: false,
        permissionRelay: versionAtLeast(
          clientVersion,
          PERMISSION_RELAY_MIN_VERSION,
        ),
      };
    }
    const agent = this.db.getAgentByName(agentName);
    if (agent !== null && !agent.channelsEnabled) {
      return {
        enabled: false,
        permissionRelay: false,
        retryable: false,
        reason:
          `agent ${agentName} was not launched with the Channels preview enabled`,
      };
    }
    if (agent === null || !LIVE_STATUSES.has(agent.status)) {
      // A bridge can start before the daemon has the agent row (spawn race, or
      // a daemon restart mid-session), so a missing row is worth retrying. A
      // terminal or control-paused agent never becomes eligible again: its
      // process is gone or was replaced read-only and without Channels.
      return {
        enabled: false,
        permissionRelay: false,
        retryable: agent === null,
        reason: `agent ${agentName} is not live`,
      };
    }
    const existing = this.connections.get(agentName);
    if (existing !== undefined) this.disconnect(agentName, existing);
    this.connections.set(agentName, {
      clientVersion,
      lastPollAt: this.now(),
      queue: [],
      waiter: null,
      waiterTimer: null,
      pendingAcks: new Map(),
    });
    return {
      enabled: true,
      retryable: false,
      permissionRelay: versionAtLeast(
        clientVersion,
        PERMISSION_RELAY_MIN_VERSION,
      ),
    };
  }

  isLive(agentName: string): boolean {
    const connection = this.connections.get(agentName);
    if (connection === undefined) return false;
    if (
      connection.waiter === null &&
      this.now() - connection.lastPollAt > this.livenessMs
    ) {
      return false;
    }
    if (agentName === ORCHESTRATOR_NAME) return true;
    const agent = this.db.getAgentByName(agentName);
    return agent !== null && agent.channelsEnabled &&
      LIVE_STATUSES.has(agent.status);
  }

  async poll(agentName: string, waitMs: number): Promise<ChannelEvent[]> {
    const connection = this.connections.get(agentName);
    if (connection === undefined) {
      throw new Error(`No registered channel for agent: ${agentName}`);
    }
    connection.lastPollAt = this.now();
    if (connection.queue.length > 0) {
      return connection.queue.splice(0, connection.queue.length);
    }
    if (connection.waiter !== null) {
      // A newer poll supersedes the old one; resolve it empty so the bridge's
      // previous request returns instead of hanging forever.
      this.resolveWaiter(connection, []);
    }
    return await new Promise<ChannelEvent[]>((resolve) => {
      connection.waiter = resolve;
      connection.waiterTimer = setTimeout(() => {
        this.resolveWaiter(connection, []);
      }, Math.min(Math.max(waitMs, 0), 60_000));
      connection.waiterTimer.unref?.();
    });
  }

  ack(agentName: string, deliveryId: string, ok: boolean): void {
    const connection = this.connections.get(agentName);
    const pending = connection?.pendingAcks.get(deliveryId);
    if (connection === undefined || pending === undefined) return;
    connection.pendingAcks.delete(deliveryId);
    pending(ok);
  }

  /**
   * Push one message event to the agent's bridge and wait for the bridge to
   * confirm it wrote the notification to the CLI transport. Resolves false
   * when no verified live channel exists or the bridge does not confirm in
   * time; the caller then falls back to tmux injection.
   */
  async deliverMessage(
    agentName: string,
    content: string,
    meta: Record<string, string>,
  ): Promise<boolean> {
    if (!this.isLive(agentName)) return false;
    const connection = this.connections.get(agentName)!;
    const deliveryId = crypto.randomUUID();
    const confirmed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        connection.pendingAcks.delete(deliveryId);
        resolve(false);
      }, this.ackTimeoutMs);
      timer.unref?.();
      connection.pendingAcks.set(deliveryId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
    this.enqueue(connection, {
      kind: "message",
      deliveryId,
      content,
      meta,
    });
    return await confirmed;
  }

  /** Relay an approval decision back to the CLI's still-open dialog. */
  pushPermissionDecision(
    agentName: string,
    requestId: string,
    behavior: "allow" | "deny",
  ): boolean {
    if (!this.isLive(agentName)) return false;
    const connection = this.connections.get(agentName)!;
    this.enqueue(connection, {
      kind: "permission-decision",
      deliveryId: crypto.randomUUID(),
      requestId,
      behavior,
    });
    return true;
  }

  notePermissionRequest(
    agentName: string,
    requestId: string,
    approvalId: string,
  ): void {
    this.prunePermissions();
    this.permissions.set(approvalId, {
      agentName,
      requestId,
      createdAt: this.now(),
    });
  }

  takePermissionByApproval(
    approvalId: string,
  ): { agentName: string; requestId: string } | null {
    const pending = this.permissions.get(approvalId);
    if (pending === undefined) return null;
    this.permissions.delete(approvalId);
    return { agentName: pending.agentName, requestId: pending.requestId };
  }

  drop(agentName: string): void {
    const connection = this.connections.get(agentName);
    if (connection === undefined) return;
    this.disconnect(agentName, connection);
  }

  private enqueue(
    connection: ChannelConnection,
    event: ChannelEvent,
  ): void {
    connection.queue.push(event);
    if (connection.waiter !== null) {
      this.resolveWaiter(
        connection,
        connection.queue.splice(0, connection.queue.length),
      );
    }
  }

  private resolveWaiter(
    connection: ChannelConnection,
    events: ChannelEvent[],
  ): void {
    const waiter = connection.waiter;
    if (connection.waiterTimer !== null) clearTimeout(connection.waiterTimer);
    connection.waiter = null;
    connection.waiterTimer = null;
    waiter?.(events);
  }

  private disconnect(
    agentName: string,
    connection: ChannelConnection,
  ): void {
    this.resolveWaiter(connection, []);
    for (const [deliveryId, resolve] of connection.pendingAcks) {
      connection.pendingAcks.delete(deliveryId);
      resolve(false);
    }
    this.connections.delete(agentName);
  }

  private prunePermissions(): void {
    const cutoff = this.now() - this.permissionTtlMs;
    for (const [approvalId, pending] of this.permissions) {
      if (pending.createdAt < cutoff) this.permissions.delete(approvalId);
    }
  }
}
