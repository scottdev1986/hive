import { describe, expect, test } from "bun:test";
import type { AgentRecord, HookEvent } from "../../schemas";
import {
  CodexAppServerManager,
  type CodexAppServerTransport,
  reapOrphanCodexHosts,
  renderCodexViewerMessage,
} from "./codex-app-server";

class FakeTransport implements CodexAppServerTransport {
  readonly sent: any[] = [];
  private messageHandler: (message: any) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  rateRead = 0;

  send(message: any): void {
    this.sent.push(message);
    if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === "initialize") {
      result = { userAgent: "codex", codexHome: "/tmp/codex" };
    } else if (message.method === "thread/start") {
      result = { thread: { id: "thread-1" } };
    } else if (message.method === "turn/start") {
      result = { turn: { id: `turn-${this.sent.length}` } };
    } else if (message.method === "turn/steer") {
      result = { turnId: message.params.expectedTurnId };
    } else if (message.method === "account/rateLimits/read") {
      this.rateRead += 1;
      result = {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 10 + this.rateRead,
            windowDurationMins: 300,
            resetsAt: 1_800_000_000,
          },
          secondary: {
            usedPercent: 20 + this.rateRead,
            windowDurationMins: 10_080,
            resetsAt: 1_800_500_000,
          },
        },
        rateLimitsByLimitId: null,
      };
    }
    queueMicrotask(() => this.messageHandler({ id: message.id, result }));
  }

  emit(message: any): void {
    this.messageHandler(message);
  }

  close(): void {
    this.closeHandler();
  }

  onMessage(handler: (message: any) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }
}

function agent(): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    tier: "standard",
    status: "spawning",
    taskDescription: "test app server",
    worktreePath: "/tmp/maya",
    branch: "hive/maya-test",
    tmuxSession: "hive-maya",
    contextPct: 0,
    createdAt: "2026-07-10T12:00:00.000Z",
    lastEventAt: "2026-07-10T12:00:00.000Z",
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
  };
}

describe("Codex app-server adapter", () => {
  test("initializes, starts a thread and turn, steers with the active turn precondition, and interrupts", async () => {
    const transport = new FakeTransport();
    const events: HookEvent[] = [];
    const observations: unknown[] = [];
    const manager = new CodexAppServerManager({
      socketPath: () => "/tmp/fake.sock",
      transport: async () => transport,
      commandRunner: async () => 0,
      sleep: async () => undefined,
      onEvent: async (event) => {
        events.push(event);
      },
      queueApproval: async () => "approval-1",
      observeRateLimits: async (_model, response) => {
        observations.push(response);
        return observations.length === 1
          ? { fiveHourUsed: 11, weeklyUsed: 21 }
          : { fiveHourUsed: 13, weeklyUsed: 24 };
      },
    });

    expect(await manager.isAvailable()).toEqual(true);
    await manager.startAgent(agent(), "Build the feature", false, "high");
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "account/rateLimits/read",
      "turn/start",
    ]);
    expect(transport.sent[2]?.params).toMatchObject({
      model: "gpt-5-codex",
      cwd: "/tmp/maya",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    expect(transport.sent[4]?.params).toMatchObject({
      threadId: "thread-1",
      effort: "high",
      input: [{ type: "text", text: "Build the feature" }],
    });

    await manager.steer(agent(), "Focus on the tests");
    expect(transport.sent.at(-1)).toMatchObject({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-5",
        input: [{ type: "text", text: "Focus on the tests" }],
      },
    });
    await manager.interrupt(agent());
    expect(transport.sent.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-5" },
    });
    expect(events[0]?.kind).toEqual("session-start");
    transport.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-5",
        tokenUsage: {
          total: { totalTokens: 50_000 },
          modelContextWindow: 100_000,
        },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-5", status: "interrupted" },
      },
    });
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(observations).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      kind: "turn-end",
      agentName: "maya",
      contextPct: 50,
      usageUnits: 3,
      usageSource: "provider",
    });
  });

  test("routes app-server approvals through Hive and translates the decision", async () => {
    const transport = new FakeTransport();
    const queued: string[] = [];
    const manager = new CodexAppServerManager({
      transport: async () => transport,
      commandRunner: async () => 0,
      sleep: async () => undefined,
      onEvent: async () => undefined,
      queueApproval: async ({ description }) => {
        queued.push(description);
        return "approval-1";
      },
      observeRateLimits: async () => null,
    });
    await manager.startAgent(agent(), "Run checks", false, "medium");

    transport.emit({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-5",
        itemId: "item-1",
        command: "npm publish",
        cwd: "/tmp/maya",
        reason: "requires network",
      },
    });
    await Bun.sleep(0);
    expect(queued[0]).toContain("npm publish");
    expect(await manager.resolveApproval("approval-1", false)).toEqual(true);
    await Bun.sleep(0);
    expect(transport.sent.at(-1)).toEqual({
      id: 91,
      result: { decision: "decline" },
    });
  });

  test("renders a readable viewer feed instead of raw protocol JSON", () => {
    expect(renderCodexViewerMessage({
      method: "item/agentMessage/delta",
      params: { delta: "Tests are green." },
    })).toEqual("Tests are green.");
    expect(renderCodexViewerMessage({
      method: "item/started",
      params: { item: { type: "commandExecution", command: "bun test" } },
    })).toEqual("\n$ bun test\n");
    expect(renderCodexViewerMessage({
      method: "account/rateLimits/updated",
      params: {},
    })).toEqual(null);
  });
});

describe("reapOrphanCodexHosts", () => {
  interface FakeWorld {
    files: Map<string, string>;
    commands: Map<number, string>;
    killed: number[];
  }

  const dependencies = (world: FakeWorld) => ({
    listSocketDir: async () => [...world.files.keys()],
    readPidFile: async (name: string) => {
      const contents = world.files.get(name);
      if (contents === undefined) throw new Error("missing");
      return contents;
    },
    removeFile: async (name: string) => {
      world.files.delete(name);
    },
    processCommand: async (pid: number) => world.commands.get(pid) ?? null,
    kill: (pid: number) => {
      world.killed.push(pid);
    },
  });

  const status = (map: Record<string, "live" | "dead" | "unknown">) =>
  (id: string) => map[id] ?? "unknown";

  test("kills only verified codex children of known-dead agents", async () => {
    const world: FakeWorld = {
      files: new Map([
        ["hive-codex-dead-agent.sock.pid", "4242\n"],
        ["hive-codex-dead-agent.sock", ""],
        ["hive-codex-live-agent.sock.pid", "5151\n"],
        ["hive-codex-foreign-agent.sock.pid", "6161\n"],
        ["hive-codex-recycled.sock.pid", "7171\n"],
        ["unrelated.txt", "ignore me"],
      ]),
      commands: new Map([
        [4242, "codex app-server --stdio"],
        [5151, "codex app-server --stdio"],
        [6161, "codex app-server --stdio"],
        [7171, "vim notes.txt"],
      ]),
      killed: [],
    };
    const reaped = await reapOrphanCodexHosts(
      status({
        "dead-agent": "dead",
        "live-agent": "live",
        recycled: "dead",
      }),
      dependencies(world),
    );

    expect(reaped).toEqual([4242]);
    expect(world.killed).toEqual([4242]);
    // Dead agents' pidfiles and sockets are cleared even when the pid was
    // recycled by another program; live and unknown agents keep theirs.
    expect([...world.files.keys()].sort()).toEqual([
      "hive-codex-foreign-agent.sock.pid",
      "hive-codex-live-agent.sock.pid",
      "unrelated.txt",
    ]);
  });
});
