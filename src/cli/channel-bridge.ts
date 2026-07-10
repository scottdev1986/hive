// The hive-channel bridge: a stdio MCP server Claude Code spawns as a
// subprocess for its Channels research preview. Channels only work over stdio
// servers, but the hive daemon is HTTP, so this thin process sits between
// them — it declares the claude/channel capability to Claude, long-polls the
// daemon for queued deliveries, and pushes each as a notifications/claude/
// channel event. It also carries the v2.1.81 permission relay both ways.
//
// The bridge holds no state that matters: if it dies, the daemon still has the
// durable message and the tmux fallback remains. Its only job is to move
// already-persisted events onto a connection Claude is listening on.

import { agentFetch } from "./credential";

export interface BridgeTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
}

export interface DaemonClient {
  register(
    agent: string,
    clientName: string,
    clientVersion: string,
  ): Promise<{
    enabled: boolean;
    permissionRelay: boolean;
    retryable?: boolean;
    reason?: string;
  }>;
  poll(agent: string, waitMs: number): Promise<
    { ok: true; events: ChannelEventWire[] } | { ok: false }
  >;
  ack(agent: string, deliveryId: string, ok: boolean): Promise<void>;
  permissionRequest(request: {
    agent: string;
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): Promise<void>;
}

export type ChannelEventWire =
  | {
      kind: "message";
      deliveryId: string;
      content: string;
      meta: Record<string, string>;
    }
  | {
      kind: "permission-decision";
      deliveryId: string;
      requestId: string;
      behavior: "allow" | "deny";
    };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ChannelBridgeOptions {
  agent: string;
  transport: BridgeTransport;
  daemon: DaemonClient;
  pollWaitMs?: number;
  reconnectDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

// The real daemon long-poll takes up to pollWaitMs (25s) to return, so the
// success path has no reason to add delay. But a broken or faked poller (the
// 2026-07-10 OOM: a unit test's poll() always resolved instantly with an
// event) turns the loop into a microtask-speed allocator. This is a backstop
// against that, not a redesign: a handful of consecutive suspiciously-fast
// iterations trip a small floor delay, then the counter resets.
const FAST_ITERATION_THRESHOLD_MS = 5;
const FAST_ITERATION_LIMIT = 3;
const FAST_ITERATION_FLOOR_MS = 20;

export class ChannelBridge {
  private readonly agent: string;
  private readonly transport: BridgeTransport;
  private readonly daemon: DaemonClient;
  private readonly pollWaitMs: number;
  private readonly reconnectDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private registered = false;
  private running = false;
  private closed = false;
  private clientVersion = "0.0.0";
  private fastIterations = 0;

  constructor(options: ChannelBridgeOptions) {
    this.agent = options.agent;
    this.transport = options.transport;
    this.daemon = options.daemon;
    this.pollWaitMs = options.pollWaitMs ?? 25_000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
    this.sleep = options.sleep ?? ((ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    this.transport.onMessage((message) => {
      void this.handle(message).catch((error) => {
        this.log(`handle error: ${String(error)}`);
      });
    });
    this.transport.onClose(() => {
      // The CLI closed stdio: this bridge is done for good. A late
      // notifications/initialized must not resurrect the pump.
      this.closed = true;
      this.running = false;
    });
  }

  private async handle(raw: unknown): Promise<void> {
    if (!isRecord(raw)) return;
    const message = raw as JsonRpcMessage;
    if (message.method === "initialize") {
      const params = isRecord(message.params) ? message.params : {};
      const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
      this.clientVersion = typeof clientInfo.version === "string"
        ? clientInfo.version
        : "0.0.0";
      this.transport.send({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
          serverInfo: { name: "hive-channel", version: "0.1.0" },
          capabilities: {
            experimental: {
              // Presence of this key registers the channel listener; the
              // permission key opts into the v2.1.81 approval relay.
              "claude/channel": {},
              "claude/channel/permission": {},
            },
          },
        },
      });
      return;
    }
    if (message.method === "notifications/initialized") {
      await this.onInitialized();
      return;
    }
    if (message.method === "notifications/claude/channel/permission_request") {
      await this.onPermissionRequest(message.params ?? {});
      return;
    }
    // Any other request gets an empty result so the CLI does not stall.
    if (message.id !== undefined && message.method !== undefined) {
      this.transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }

  private async onInitialized(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    void this.pumpLoop();
  }

  private async onPermissionRequest(
    params: Record<string, unknown>,
  ): Promise<void> {
    const requestId = typeof params.request_id === "string"
      ? params.request_id
      : null;
    if (requestId === null) return;
    await this.daemon.permissionRequest({
      agent: this.agent,
      requestId,
      toolName: typeof params.tool_name === "string"
        ? params.tool_name
        : "tool",
      description: typeof params.description === "string"
        ? params.description
        : "",
      inputPreview: typeof params.input_preview === "string"
        ? params.input_preview
        : "",
    }).catch((error) => {
      this.log(`permission relay to daemon failed: ${String(error)}`);
    });
  }

  private async pumpLoop(): Promise<void> {
    while (this.running) {
      if (!this.registered) {
        const registration = await this.daemon
          .register(this.agent, "claude-code", this.clientVersion)
          .catch(() => null);
        if (registration === null) {
          await this.sleep(this.reconnectDelayMs);
          continue;
        }
        if (!registration.enabled) {
          if (registration.retryable ?? false) {
            // The agent row has not landed yet (spawn race, daemon restart).
            // Wait rather than costing this session its channel for good.
            await this.sleep(this.reconnectDelayMs);
            continue;
          }
          // A permanent refusal (old CLI, Channels off for this agent). Stop
          // pumping; the daemon uses the tmux fallback for this session.
          this.log(`channel disabled: ${registration.reason ?? "unknown"}`);
          this.running = false;
          return;
        }
        this.registered = true;
      }
      const iterationStart = this.now();
      const result = await this.daemon
        .poll(this.agent, this.pollWaitMs)
        .catch(() => ({ ok: false as const }));
      if (!result.ok) {
        this.registered = false;
        await this.sleep(this.reconnectDelayMs);
        continue;
      }
      for (const event of result.events) {
        await this.dispatch(event);
      }
      await this.enforceMinimumIterationInterval(iterationStart);
    }
  }

  // A poll() that resolves instantly, over and over, is never legitimate: the
  // real daemon either waits up to pollWaitMs or returns a queued backlog
  // after real network latency. Tripping this a few times in a row is the
  // signature of a fake/broken poller, so only then does it cost a delay.
  private async enforceMinimumIterationInterval(
    iterationStart: number,
  ): Promise<void> {
    const elapsed = this.now() - iterationStart;
    if (elapsed >= FAST_ITERATION_THRESHOLD_MS) {
      this.fastIterations = 0;
      return;
    }
    this.fastIterations += 1;
    if (this.fastIterations < FAST_ITERATION_LIMIT) return;
    this.fastIterations = 0;
    await this.sleep(FAST_ITERATION_FLOOR_MS);
  }

  private async dispatch(event: ChannelEventWire): Promise<void> {
    if (event.kind === "message") {
      let ok = true;
      try {
        this.transport.send({
          jsonrpc: "2.0",
          method: "notifications/claude/channel",
          params: { content: event.content, meta: event.meta },
        });
      } catch (error) {
        ok = false;
        this.log(`channel push failed: ${String(error)}`);
      }
      await this.daemon.ack(this.agent, event.deliveryId, ok).catch(() =>
        undefined
      );
      return;
    }
    // permission-decision: relay the verdict to the CLI's open dialog.
    this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission",
      params: { request_id: event.requestId, behavior: event.behavior },
    });
  }
}

export function createHttpDaemonClient(
  port: number,
  agent?: string,
): DaemonClient {
  const base = `http://127.0.0.1:${port}`;
  // The bridge may only speak for the agent it was launched for, so it presents
  // that agent's capability on every channel call.
  const send = agent === undefined ? fetch : agentFetch(agent);
  const post = async (path: string, body: unknown): Promise<Response> =>
    send(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    async register(agent, clientName, clientVersion) {
      const response = await post("/channel/register", {
        agent,
        clientName,
        clientVersion,
      });
      if (!response.ok) {
        return { enabled: false, permissionRelay: false, reason: "http error" };
      }
      return await response.json() as {
        enabled: boolean;
        permissionRelay: boolean;
        reason?: string;
      };
    },
    async poll(agent, waitMs) {
      const response = await post("/channel/poll", { agent, waitMs });
      if (!response.ok) return { ok: false };
      const body = await response.json() as { events: ChannelEventWire[] };
      return { ok: true, events: body.events };
    },
    async ack(agent, deliveryId, ok) {
      await post("/channel/ack", { agent, deliveryId, ok });
    },
    async permissionRequest(request) {
      await post("/channel/permission-request", request);
    },
  };
}

export function createStdioTransport(): BridgeTransport {
  const handlers: ((message: unknown) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          for (const handler of handlers) handler(parsed);
        } catch {
          // A malformed line is ignored; the CLI never sends partial frames.
        }
      }
    }
    for (const handler of closeHandlers) handler();
  })();
  return {
    send(message) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
  };
}

export async function runChannelBridge(
  agent: string,
  port: number,
): Promise<void> {
  const bridge = new ChannelBridge({
    agent,
    transport: createStdioTransport(),
    daemon: createHttpDaemonClient(port, agent),
  });
  bridge.start();
  // Keep the process alive until stdin closes (handled by the transport).
  await new Promise<void>(() => undefined);
}
