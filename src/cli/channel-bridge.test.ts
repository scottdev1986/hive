import { describe, expect, test } from "bun:test";
import {
  ChannelBridge,
  type BridgeTransport,
  type ChannelEventWire,
  type DaemonClient,
} from "./channel-bridge";

// These are protocol-level fakes: they assert the exact JSON-RPC shapes that
// Claude Code's Channels preview specifies. The shapes themselves were
// verified against a live claude 2.1.206 session, not against these fakes.
class FakeTransport implements BridgeTransport {
  readonly sent: any[] = [];
  private handler: ((message: unknown) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(message: unknown): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  receive(message: unknown): void {
    this.handler?.(message);
  }
  close(): void {
    this.closeHandler?.();
  }
  notifications(method: string): any[] {
    return this.sent.filter((message) => message.method === method);
  }
}

interface FakeDaemonOptions {
  enabled?: boolean;
  permissionRelay?: boolean;
  batches?: ChannelEventWire[][];
}

class FakeDaemon implements DaemonClient {
  readonly registrations: string[] = [];
  readonly acks: Array<{ deliveryId: string; ok: boolean }> = [];
  readonly permissionRequests: any[] = [];
  private batches: ChannelEventWire[][];

  constructor(private readonly options: FakeDaemonOptions = {}) {
    this.batches = [...(options.batches ?? [])];
  }

  async register(agent: string, _client: string, version: string) {
    this.registrations.push(`${agent}@${version}`);
    return {
      enabled: this.options.enabled ?? true,
      permissionRelay: this.options.permissionRelay ?? true,
    };
  }

  async poll(): Promise<{ ok: true; events: ChannelEventWire[] } | { ok: false }> {
    const batch = this.batches.shift();
    if (batch === undefined) {
      // No more scripted work: park forever so the pump loop idles.
      return await new Promise(() => undefined);
    }
    return { ok: true, events: batch };
  }

  async ack(_agent: string, deliveryId: string, ok: boolean): Promise<void> {
    this.acks.push({ deliveryId, ok });
  }

  async permissionRequest(request: unknown): Promise<void> {
    this.permissionRequests.push(request);
  }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "claude-code", version: "2.1.206" },
  },
};

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

function bridge(daemon: DaemonClient, transport: FakeTransport): ChannelBridge {
  const value = new ChannelBridge({
    agent: "maya",
    transport,
    daemon,
    pollWaitMs: 10,
    reconnectDelayMs: 1,
  });
  value.start();
  return value;
}

describe("initialize handshake", () => {
  test("declares the channel and permission-relay capabilities", () => {
    const transport = new FakeTransport();
    bridge(new FakeDaemon(), transport);
    transport.receive(initialize);

    expect(transport.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          experimental: {
            // Presence of this key is what registers the channel listener.
            "claude/channel": {},
            "claude/channel/permission": {},
          },
        },
      },
    });
  });

  test("answers an unknown request so the CLI never stalls", () => {
    const transport = new FakeTransport();
    bridge(new FakeDaemon(), transport);
    transport.receive({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(transport.sent[0]).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("message push", () => {
  test("pushes a queued message as notifications/claude/channel and acks it", async () => {
    const transport = new FakeTransport();
    const daemon = new FakeDaemon({
      batches: [[{
        kind: "message",
        deliveryId: "d1",
        content: "reuse the middleware",
        meta: { sender: "sam" },
      }]],
    });
    bridge(daemon, transport);
    transport.receive(initialize);
    transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();

    expect(daemon.registrations).toEqual(["maya@2.1.206"]);
    expect(transport.notifications("notifications/claude/channel")).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: {
          content: "reuse the middleware",
          meta: { sender: "sam" },
        },
      },
    ]);
    expect(daemon.acks).toEqual([{ deliveryId: "d1", ok: true }]);
  });

  test("stops pumping when the daemon permanently declines the channel", async () => {
    const transport = new FakeTransport();
    const daemon = new FakeDaemon({ enabled: false });
    bridge(daemon, transport);
    transport.receive(initialize);
    transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();

    expect(daemon.registrations).toHaveLength(1);
    expect(transport.notifications("notifications/claude/channel")).toEqual([]);
  });

  test("retries a retryable refusal instead of losing the channel", async () => {
    const transport = new FakeTransport();
    let attempts = 0;
    const daemon = new FakeDaemon({
      batches: [[{
        kind: "message",
        deliveryId: "d9",
        content: "late but delivered",
        meta: {},
      }]],
    });
    // The agent row lands on the third registration attempt.
    daemon.register = async () => {
      attempts += 1;
      return attempts < 3
        ? { enabled: false, permissionRelay: false, retryable: true }
        : { enabled: true, permissionRelay: true, retryable: false };
    };

    bridge(daemon, transport);
    transport.receive(initialize);
    transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(
      transport.notifications("notifications/claude/channel")[0]?.params.content,
    ).toBe("late but delivered");
  });
});

describe("permission relay", () => {
  test("forwards a permission_request to the daemon's approval queue", async () => {
    const transport = new FakeTransport();
    const daemon = new FakeDaemon();
    bridge(daemon, transport);
    transport.receive(initialize);
    transport.receive({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "zvrrq",
        tool_name: "Bash",
        description: "Publish the package",
        input_preview: '{"command":"npm publish"}',
      },
    });
    await settle();

    expect(daemon.permissionRequests).toEqual([
      {
        agent: "maya",
        requestId: "zvrrq",
        toolName: "Bash",
        description: "Publish the package",
        inputPreview: '{"command":"npm publish"}',
      },
    ]);
  });

  test("ignores a permission_request with no request id", async () => {
    const transport = new FakeTransport();
    const daemon = new FakeDaemon();
    bridge(daemon, transport);
    transport.receive({
      jsonrpc: "2.0",
      method: "notifications/claude/channel/permission_request",
      params: { tool_name: "Bash" },
    });
    await settle();
    expect(daemon.permissionRequests).toEqual([]);
  });

  test("relays an orchestrator verdict back to the CLI dialog", async () => {
    const transport = new FakeTransport();
    const daemon = new FakeDaemon({
      batches: [[{
        kind: "permission-decision",
        deliveryId: "d2",
        requestId: "zvrrq",
        behavior: "deny",
      }]],
    });
    bridge(daemon, transport);
    transport.receive(initialize);
    transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();

    expect(
      transport.notifications("notifications/claude/channel/permission"),
    ).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/claude/channel/permission",
        params: { request_id: "zvrrq", behavior: "deny" },
      },
    ]);
    // A verdict is not a delivery; it is never acked back to the daemon.
    expect(daemon.acks).toEqual([]);
  });
});

describe("resilience", () => {
  test("re-registers after the daemon forgets the connection", async () => {
    const transport = new FakeTransport();
    let polls = 0;
    const daemon: DaemonClient = {
      registrations: 0,
      async register() {
        (this as any).registrations += 1;
        return { enabled: true, permissionRelay: true };
      },
      async poll() {
        polls += 1;
        if (polls === 1) return { ok: false };
        if (polls === 2) {
          return {
            ok: true,
            events: [{
              kind: "message",
              deliveryId: "d3",
              content: "after restart",
              meta: {},
            }],
          };
        }
        return await new Promise(() => undefined);
      },
      async ack() {},
      async permissionRequest() {},
    } as DaemonClient & { registrations: number };

    bridge(daemon, transport);
    transport.receive(initialize);
    transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((daemon as any).registrations).toBe(2);
    expect(
      transport.notifications("notifications/claude/channel")[0]?.params.content,
    ).toBe("after restart");
  });

  test("stops pumping once stdin closes", async () => {
    const transport = new FakeTransport();
    const daemon = new FakeDaemon({ batches: [[]] });
    bridge(daemon, transport);
    transport.receive(initialize);
    transport.close();
    transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    expect(daemon.registrations).toEqual([]);
  });
});
