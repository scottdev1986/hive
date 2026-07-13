import { describe, expect, test } from "bun:test";
import {
  CHANNELS_MIN_VERSION,
  ChannelRegistry,
  PERMISSION_RELAY_MIN_VERSION,
  parseCliVersion,
  versionAtLeast,
} from "./channels";
import { ORCHESTRATOR_NAME, type AgentRecord } from "../schemas";

const timestamp = "2026-07-09T12:00:00.000Z";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "claude",
    model: "claude-fable-5",
    category: "simple_coding",
    status: "idle",
    taskDescription: "Build the daemon",
    worktreePath: "/tmp/hive-maya",
    branch: "hive/maya-daemon",
    tmuxSession: "hive-maya",
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: true,
    ...overrides,
  };
}

class FakeAgents {
  constructor(private record: AgentRecord | null) {}
  getAgentByName(name: string): AgentRecord | null {
    return this.record?.name === name ? this.record : null;
  }
  set(record: AgentRecord | null): void {
    this.record = record;
  }
}

const register = (
  registry: ChannelRegistry,
  version = "2.1.206",
): ReturnType<ChannelRegistry["register"]> =>
  registry.register("maya", "claude-code", version);

describe("version gates", () => {
  test("parses and compares semantic versions", () => {
    expect(parseCliVersion("2.1.206 (Claude Code)")).toEqual([2, 1, 206]);
    expect(parseCliVersion("not a version")).toBeNull();
    expect(versionAtLeast("2.1.80", CHANNELS_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.79", CHANNELS_MIN_VERSION)).toBe(false);
    // 206 > 80 numerically, not lexically.
    expect(versionAtLeast("2.1.206", CHANNELS_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.2.0", CHANNELS_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("1.9.99", CHANNELS_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("2.1.80", PERMISSION_RELAY_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("2.1.81", PERMISSION_RELAY_MIN_VERSION)).toBe(true);
  });
});

describe("ChannelRegistry.register", () => {
  test("accepts the reserved root without an agent row", () => {
    const registry = new ChannelRegistry(new FakeAgents(null));
    expect(registry.register(ORCHESTRATOR_NAME, "claude-code", "2.1.206"))
      .toMatchObject({ enabled: true, retryable: false });
    expect(registry.isLive(ORCHESTRATOR_NAME)).toEqual(true);
  });
  test("accepts a live channels-enabled agent on a supported CLI", () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    expect(register(registry)).toEqual({
      enabled: true,
      permissionRelay: true,
      retryable: false,
    });
  });

  test("permanently declines a CLI older than the Channels preview", () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    const result = register(registry, "2.1.79");
    expect(result.enabled).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("predates Channels");
  });

  test("grants channel delivery without the relay on 2.1.80", () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    expect(register(registry, "2.1.80")).toEqual({
      enabled: true,
      permissionRelay: false,
      retryable: false,
    });
  });

  test("permanently declines an agent that was not launched with Channels", () => {
    const registry = new ChannelRegistry(
      new FakeAgents(agent({ channelsEnabled: false })),
    );
    const result = register(registry);
    expect(result.enabled).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("not launched with the Channels preview");
  });

  test("permanently declines a control-paused agent so safety keeps the fallback", () => {
    const registry = new ChannelRegistry(
      new FakeAgents(agent({ status: "control-paused", writeRevoked: true })),
    );
    expect(register(registry)).toMatchObject({
      enabled: false,
      retryable: false,
    });
  });

  test("permanently declines a terminal agent", () => {
    const registry = new ChannelRegistry(
      new FakeAgents(agent({ status: "dead" })),
    );
    expect(register(registry)).toMatchObject({
      enabled: false,
      retryable: false,
    });
  });

  test("asks the bridge to retry when the agent row has not landed yet", () => {
    // A bridge can start before the daemon inserts the agent row; losing that
    // race must not cost the session its channel for the rest of its life.
    const registry = new ChannelRegistry(new FakeAgents(null));
    expect(register(registry)).toMatchObject({
      enabled: false,
      retryable: true,
    });
  });

  test("an old CLI is refused permanently even before the agent row exists", () => {
    const registry = new ChannelRegistry(new FakeAgents(null));
    expect(register(registry, "2.1.79")).toMatchObject({
      enabled: false,
      retryable: false,
    });
  });
});

describe("ChannelRegistry delivery", () => {
  test("delivers a queued event to a waiting poll and confirms on ack", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);

    const polled = registry.poll("maya", 5_000);
    const delivered = registry.deliverMessage("maya", "hello", { sender: "sam" });

    const events = await polled;
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("message");
    if (event.kind !== "message") throw new Error("expected message event");
    expect(event.content).toBe("hello");
    expect(event.meta).toEqual({ sender: "sam" });

    registry.ack("maya", event.deliveryId, true);
    expect(await delivered).toBe(true);
  });

  test("queues an event pushed before the bridge polls", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    const delivered = registry.deliverMessage("maya", "early", {});
    const events = await registry.poll("maya", 5_000);
    expect(events).toHaveLength(1);
    registry.ack("maya", events[0]!.deliveryId, true);
    expect(await delivered).toBe(true);
  });

  test("reports failure when the bridge acks a failed write", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    const delivered = registry.deliverMessage("maya", "hello", {});
    const events = await registry.poll("maya", 5_000);
    registry.ack("maya", events[0]!.deliveryId, false);
    expect(await delivered).toBe(false);
  });

  test("times out an unacknowledged delivery so the caller falls back", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()), {
      ackTimeoutMs: 10,
    });
    register(registry);
    expect(await registry.deliverMessage("maya", "hello", {})).toBe(false);
  });

  test("refuses delivery without a registered channel", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    expect(registry.isLive("maya")).toBe(false);
    expect(await registry.deliverMessage("maya", "hello", {})).toBe(false);
  });

  test("stops being live once the agent leaves a live status", async () => {
    const agents = new FakeAgents(agent());
    const registry = new ChannelRegistry(agents);
    register(registry);
    expect(registry.isLive("maya")).toBe(true);
    agents.set(agent({ status: "dead" }));
    expect(registry.isLive("maya")).toBe(false);
    expect(await registry.deliverMessage("maya", "hello", {})).toBe(false);
  });

  test("treats a bridge that stopped polling as not live", () => {
    let now = 1_000;
    const registry = new ChannelRegistry(new FakeAgents(agent()), {
      livenessMs: 100,
      now: () => now,
    });
    register(registry);
    expect(registry.isLive("maya")).toBe(true);
    now += 500;
    expect(registry.isLive("maya")).toBe(false);
  });

  test("an empty long poll resolves without events", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    expect(await registry.poll("maya", 5)).toEqual([]);
  });

  test("a superseding poll resolves the previous one empty", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    const first = registry.poll("maya", 60_000);
    const second = registry.poll("maya", 5);
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
  });

  test("poll rejects for an unregistered agent so the bridge re-registers", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    await expect(registry.poll("maya", 5)).rejects.toThrow(
      "No registered channel for agent: maya",
    );
  });

  test("dropping a channel fails its pending deliveries", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    const delivered = registry.deliverMessage("maya", "hello", {});
    await registry.poll("maya", 5);
    registry.drop("maya");
    expect(await delivered).toBe(false);
    expect(registry.isLive("maya")).toBe(false);
  });

  test("re-registering replaces the old connection", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    const stalePoll = registry.poll("maya", 60_000);
    register(registry);
    expect(await stalePoll).toEqual([]);
    expect(registry.isLive("maya")).toBe(true);
  });
});

describe("permission relay", () => {
  test("maps an approval back to its channel request", () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    registry.notePermissionRequest("maya", "zvrrq", "approval-1");
    expect(registry.takePermissionByApproval("approval-1")).toEqual({
      agentName: "maya",
      requestId: "zvrrq",
    });
    // A verdict is relayed exactly once.
    expect(registry.takePermissionByApproval("approval-1")).toBeNull();
  });

  test("pushes an allow verdict to the bridge", async () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    register(registry);
    expect(registry.pushPermissionDecision("maya", "zvrrq", "allow")).toBe(true);
    const events = await registry.poll("maya", 5_000);
    expect(events).toEqual([
      {
        kind: "permission-decision",
        deliveryId: expect.any(String),
        requestId: "zvrrq",
        behavior: "allow",
      },
    ]);
  });

  test("cannot push a verdict without a live channel", () => {
    const registry = new ChannelRegistry(new FakeAgents(agent()));
    expect(registry.pushPermissionDecision("maya", "zvrrq", "deny")).toBe(false);
  });

  test("expires stale permission mappings", () => {
    let now = 1_000;
    const registry = new ChannelRegistry(new FakeAgents(agent()), {
      permissionTtlMs: 50,
      now: () => now,
    });
    registry.notePermissionRequest("maya", "aaaaa", "approval-old");
    now += 500;
    registry.notePermissionRequest("maya", "bbbbb", "approval-new");
    expect(registry.takePermissionByApproval("approval-old")).toBeNull();
    expect(registry.takePermissionByApproval("approval-new")).not.toBeNull();
  });
});
