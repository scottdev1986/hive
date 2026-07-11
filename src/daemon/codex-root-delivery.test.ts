import { describe, expect, test } from "bun:test";
import {
  CodexRootDelivery,
  type RootProtocolConnection,
} from "./codex-root-delivery";

class FakeConnection implements RootProtocolConnection {
  live = true;
  readonly delivered: string[] = [];
  closed = 0;
  failNext = false;

  isLive(): boolean {
    return this.live;
  }

  async deliverMessage(content: string): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      this.live = false;
      return false;
    }
    this.delivered.push(content);
    return true;
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.live = false;
  }
}

function harness(options: {
  socketExists?: boolean;
  threadId?: string | null;
  connectError?: boolean;
} = {}) {
  const connection = new FakeConnection();
  let connects = 0;
  const delivery = new CodexRootDelivery(() => "/repo", {
    socketPath: () => "/tmp/hive-codex-root-test.sock",
    socketExists: () => options.socketExists ?? true,
    discoverThreadId: async () =>
      options.threadId === undefined ? "thread-1" : options.threadId,
    connect: async () => {
      connects += 1;
      if (options.connectError === true) throw new Error("ECONNREFUSED");
      return connection;
    },
  });
  return { delivery, connection, connects: () => connects };
}

describe("CodexRootDelivery", () => {
  test("is inert without a root socket — the Claude-root machine case", async () => {
    const h = harness({ socketExists: false });
    expect(h.delivery.isLive()).toEqual(false);
    expect(await h.delivery.deliverMessage("wake", {})).toEqual(false);
    expect(h.connects()).toEqual(0);
  });

  test("lazily attaches to the root thread and reuses the connection", async () => {
    const h = harness();
    expect(h.delivery.isLive()).toEqual(true);
    expect(await h.delivery.deliverMessage("first", {})).toEqual(true);
    expect(await h.delivery.deliverMessage("second", {})).toEqual(true);
    expect(h.connection.delivered).toEqual(["first", "second"]);
    expect(h.connects()).toEqual(1);
  });

  test("a stale socket costs one failed connect, not a crash", async () => {
    const h = harness({ connectError: true });
    expect(await h.delivery.deliverMessage("wake", {})).toEqual(false);
    expect(h.connects()).toEqual(1);
  });

  test("reports unconfirmed when no thread is discoverable", async () => {
    const h = harness({ threadId: null });
    expect(await h.delivery.deliverMessage("wake", {})).toEqual(false);
    expect(h.connects()).toEqual(0);
  });

  test("drops a failed connection and reconnects on the next wake", async () => {
    const h = harness();
    expect(await h.delivery.deliverMessage("first", {})).toEqual(true);
    h.connection.failNext = true;
    expect(await h.delivery.deliverMessage("second", {})).toEqual(false);
    expect(h.connection.closed).toEqual(1);
    // The next delivery reconnects rather than staying dead forever.
    h.connection.live = true;
    expect(await h.delivery.deliverMessage("third", {})).toEqual(true);
    expect(h.connects()).toEqual(2);
  });

  test("concurrent wakes share one connect attempt", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.delivery.deliverMessage("first", {}),
      h.delivery.deliverMessage("second", {}),
    ]);
    expect(first).toEqual(true);
    expect(second).toEqual(true);
    expect(h.connects()).toEqual(1);
  });
});
