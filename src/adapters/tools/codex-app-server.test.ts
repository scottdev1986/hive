import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AgentRecord, HookEvent } from "../../schemas";
import { basename, join } from "node:path";
import { hiveInstanceSuffix } from "../../daemon/tmux-sessions";
import {
  CodexAppServerManager,
  buildCodexAppServerCommand,
  CodexAppServerClient,
  type CodexAppServerTransport,
  codexAgentHostPidfile,
  codexAgentSocketPath,
  hostPidfileAgentId,
  reapOrphanCodexHosts,
  renderCodexHostMessage,
  runCodexAppServerHost,
} from "./codex-app-server";

class FakeTransport implements CodexAppServerTransport {
  readonly sent: any[] = [];
  private messageHandler: (message: any) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  rateRead = 0;
  /** The rollout the app-server names for this thread. Null models a build
   * that reports no path — unknown, which the gate must deny. */
  rolloutPath: string | null = "/tmp/maya/rollout.jsonl";
  threadReadFails = false;

  send(message: any): void {
    this.sent.push(message);
    if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === "initialize") {
      result = { userAgent: "codex", codexHome: "/tmp/codex" };
    } else if (message.method === "thread/start") {
      result = { thread: { id: "thread-1" } };
    } else if (message.method === "thread/read") {
      if (this.threadReadFails) {
        queueMicrotask(() =>
          this.messageHandler({
            id: message.id,
            error: { code: -32000, message: "thread/read failed" },
          })
        );
        return;
      }
      result = { thread: { id: "thread-1", path: this.rolloutPath } };
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

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5-codex",
    category: "simple_coding",
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
    readOnly: true,
    writeRevoked: false,
    ...overrides,
  };
}

describe("Codex app-server adapter", () => {
  test("scopes Apps and inherited MCPs while attaching Graphify", () => {
    const command = buildCodexAppServerCommand({
      socket: "/tmp/agent.sock",
      worktree: "/tmp/maya",
      daemonPort: 4317,
      agentName: "maya",
      graphifyUrl: "http://127.0.0.1:7799/mcp",
    }, ["idea", "hive", "graphify"]);
    expect(command).toContain("features.apps=false");
    expect(command).toContain("features.multi_agent=false");
    expect(command).toContain(
      'mcp_servers.hive.bearer_token_env_var="HIVE_CAPABILITY_TOKEN"',
    );
    expect(command).toContain("mcp_servers.idea.enabled=false");
    expect(command.join(" ")).not.toContain("mcp_servers.hive.enabled=false");
    expect(command.join(" ")).not.toContain("mcp_servers.graphify.enabled=false");
    expect(command).toContain(
      'mcp_servers.graphify.url="http://127.0.0.1:7799/mcp"',
    );
  });

  test("threads the healthy Graphify URL through the host boundary", () => {
    const manager = new CodexAppServerManager({
      commandRunner: async () => 0,
      onEvent: async () => undefined,
      queueApproval: async () => "approval-1",
      authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
      observeRateLimits: async () => null,
    });
    expect(manager.buildHostCommand(agent(), 4317, "http://127.0.0.1:7799/mcp"))
      .toContain("--graphify-url");
  });

  test("the host exports its bearer environment to Codex without putting the token in argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-host-bearer-"));
    const executable = join(root, "codex");
    const capturedEnv = join(root, "captured-env");
    const capturedArgv = join(root, "captured-argv");
    const socket = join(root, "agent.sock");
    const previous = {
      token: Bun.env.HIVE_CAPABILITY_TOKEN,
      envPath: Bun.env.HIVE_CAPTURE_ENV_PATH,
      argvPath: Bun.env.HIVE_CAPTURE_ARGV_PATH,
    };
    try {
      await writeFile(executable, [
        "#!/bin/sh",
        'printf "%s" "$HIVE_CAPABILITY_TOKEN" > "$HIVE_CAPTURE_ENV_PATH"',
        'printf "%s\\n" "$@" > "$HIVE_CAPTURE_ARGV_PATH"',
        "",
      ].join("\n"));
      await chmod(executable, 0o755);
      Bun.env.HIVE_CAPABILITY_TOKEN = "hv1.native-reader-secret";
      Bun.env.HIVE_CAPTURE_ENV_PATH = capturedEnv;
      Bun.env.HIVE_CAPTURE_ARGV_PATH = capturedArgv;

      expect(await runCodexAppServerHost({
        socket,
        worktree: root,
        daemonPort: 4317,
        agentName: "maya",
        executable,
      })).toEqual(0);
      expect(await readFile(capturedEnv, "utf8")).toEqual(
        "hv1.native-reader-secret",
      );
      const argv = await readFile(capturedArgv, "utf8");
      expect(argv).toContain(
        'mcp_servers.hive.bearer_token_env_var="HIVE_CAPABILITY_TOKEN"',
      );
      expect(argv).not.toContain("hv1.native-reader-secret");
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      };
      restore("HIVE_CAPABILITY_TOKEN", previous.token);
      restore("HIVE_CAPTURE_ENV_PATH", previous.envPath);
      restore("HIVE_CAPTURE_ARGV_PATH", previous.argvPath);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the host boundary builds a writer's command: the app-server is the brokered driver", () => {
    // Writer admission is decided by the containment gate on the driver, not
    // here. This boundary refusing a writer would only mean Hive could never
    // host the one Codex writer surface that IS safe; what keeps the writer
    // contained is the read-only sandbox plus the per-mutation gate.
    const manager = new CodexAppServerManager({
      commandRunner: async () => 0,
      onEvent: async () => undefined,
      queueApproval: async () => "approval-1",
      authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
      observeRateLimits: async () => null,
    });
    expect(manager.buildHostCommand(agent({ readOnly: false }), 4317))
      .toContain("codex-app-server-host");
  });

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
      authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
      observeRateLimits: async (_model, response) => {
        observations.push(response);
        return observations.length === 1
          ? { fiveHourUsed: 11, weeklyUsed: 21 }
          : { fiveHourUsed: 13, weeklyUsed: 24 };
      },
    });

    expect(await manager.isAvailable()).toEqual(true);
    await manager.startAgent(agent({ readOnly: true }), {
      developerInstructions: "You are maya. Follow Hive rules.",
      initialUserPrompt: "Build the feature",
    }, "high");
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "account/rateLimits/read",
      "turn/start",
    ]);
    expect(transport.sent[0]?.params).toMatchObject({
      capabilities: { experimentalApi: false },
    });
    expect(transport.sent[2]?.params).toMatchObject({
      model: "gpt-5-codex",
      cwd: "/tmp/maya",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      developerInstructions: "You are maya. Follow Hive rules.",
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

  test("an idle follow-up turn retains the authorized effort", async () => {
    const transport = new FakeTransport();
    const manager = new CodexAppServerManager({
      transport: async () => transport,
      commandRunner: async () => 0,
      sleep: async () => undefined,
      onEvent: async () => undefined,
      queueApproval: async () => "approval-1",
      authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
      observeRateLimits: async () => null,
    });
    await manager.startAgent(agent({ readOnly: true }), {
      developerInstructions: "You are maya. Follow Hive rules.",
      initialUserPrompt: "Build",
    }, "high");
    // The initial turn completes; the session goes idle.
    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-5", status: "completed" },
      },
    });
    await Bun.sleep(0);
    // A follow-up delivered while idle starts a fresh turn. It must carry the
    // thread's authorized effort, not silently drop to the server-side default.
    await manager.deliver(agent(), "Next task");
    const lastTurnStart = [...transport.sent].reverse().find(
      (message) => message.method === "turn/start",
    );
    expect(lastTurnStart?.params).toMatchObject({
      effort: "high",
      input: [{ type: "text", text: "Next task" }],
    });
  });

  test("mechanically denies every mutating reader approval without queueing", async () => {
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
      authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
      observeRateLimits: async () => null,
    });
    await manager.startAgent(agent({ readOnly: true }), {
      developerInstructions: "You are maya. Follow Hive rules.",
      initialUserPrompt: "Run checks",
    }, "medium");

    const attempts = [
      {
        method: "item/commandExecution/requestApproval",
        params: {
          command: "npm publish",
          cwd: "/tmp/maya",
          reason: "requires elevated network access",
          additionalPermissions: { network: { enabled: true } },
        },
        result: { decision: "decline" },
      },
      {
        method: "item/fileChange/requestApproval",
        params: { grantRoot: "/tmp/maya", reason: "modify files" },
        result: { decision: "decline" },
      },
      {
        method: "item/permissions/requestApproval",
        params: {
          permissions: {
            filesystem: { write: ["/tmp/maya"] },
            network: { enabled: true },
          },
          reason: "elevated permissions",
        },
        result: { permissions: {}, scope: "turn" },
      },
      {
        method: "execCommandApproval",
        params: { command: ["bun", "run", "release"] },
        result: { decision: "denied" },
      },
      {
        method: "applyPatchApproval",
        params: { fileChanges: { "/tmp/maya/file.ts": { type: "add" } } },
        result: { decision: "denied" },
      },
    ];
    for (const [index, attempt] of attempts.entries()) {
      const id = 91 + index;
      transport.emit({ id, method: attempt.method, params: attempt.params });
      await Bun.sleep(0);
      expect(transport.sent.find((message) => message.id === id)).toEqual({
        id,
        result: attempt.result,
      });
    }
    expect(queued).toEqual([]);
    expect(await manager.resolveApproval("approval-1", true)).toEqual(false);
  });

  // The writer mutation gate. Every case here is a worst case: the question is
  // never "does an allow work" but "can anything that is not a proven, live,
  // freshly-attested holder reach the allow response".
  describe("writer mutation gate", () => {
    const FILE_CHANGE = "item/fileChange/requestApproval";
    const COMMAND = "item/commandExecution/requestApproval";

    /** A started writer session with a live turn, plus the gate's call log. */
    async function writerSession(options: {
      authorize?: (request: any) => Promise<any>;
      queueApproval?: () => Promise<string>;
    } = {}) {
      const transport = new FakeTransport();
      const gateCalls: any[] = [];
      const queued: string[] = [];
      const manager = new CodexAppServerManager({
        transport: async () => transport,
        commandRunner: async () => 0,
        sleep: async () => undefined,
        onEvent: async () => undefined,
        queueApproval: options.queueApproval ?? (async ({ description }) => {
          queued.push(description);
          return "approval-1";
        }),
        authorizeMutation: async (request) => {
          gateCalls.push(request);
          return options.authorize === undefined
            ? { allowed: false, reason: "test default deny" }
            : await options.authorize(request);
        },
        observeRateLimits: async () => null,
      });
      await manager.startAgent(agent({ readOnly: false, id: "agent-maya" }), {
        developerInstructions: "writer rules",
        initialUserPrompt: "write code",
      }, "high");
      // A live turn: the provider only asks for approval inside one.
      transport.emit({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-9" } },
      });
      await Bun.sleep(0);
      return { manager, transport, gateCalls, queued };
    }

    /** Emit one approval request and resolve with the response Codex received.
     * Polls, because a gated request is answered only once its approval
     * settles — which may be several awaits later. */
    async function ask(
      transport: FakeTransport,
      method: string,
      params: Record<string, unknown>,
      id = 501,
    ): Promise<any> {
      transport.emit({ id, method, params });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const response = transport.sent.find((message) => message.id === id);
        if (response !== undefined) return response;
        await Bun.sleep(1);
      }
      return undefined;
    }

    const bound = { threadId: "thread-1", turnId: "turn-9" };

    test("a denied gate never reaches an allow, and never queues", async () => {
      const { transport, gateCalls, queued } = await writerSession();
      const response = await ask(transport, COMMAND, {
        ...bound,
        command: "rm -rf /",
      });
      expect(response.result).toEqual({ decision: "decline" });
      expect(gateCalls).toHaveLength(1);
      // The approval is queued only AFTER the identity gate passes: a denied
      // holder must never even reach a human with a decision to make.
      expect(queued).toEqual([]);
    });

    test("an allowed gate plus an approval sends a one-shot accept, gated twice", async () => {
      const { manager, transport, gateCalls, queued } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      const asked = ask(transport, FILE_CHANGE, {
        ...bound,
        grantRoot: "/tmp/maya",
      });
      await Bun.sleep(1);
      // Nothing is decided while the approval waits.
      expect(transport.sent.find((m) => m.id === 501)).toBeUndefined();
      expect(queued).toHaveLength(1);
      expect(await manager.resolveApproval("approval-1", true)).toBe(true);

      const response = await asked;
      // `accept` decides exactly this request. `acceptForSession` — the other
      // arm of the same enum — would be a reusable permission, so it is never
      // what we send.
      expect(response.result).toEqual({ decision: "accept" });
      expect(response.result.decision).not.toBe("acceptForSession");
      // Gated once before the queue and once more before the allow.
      expect(gateCalls).toHaveLength(2);
      expect(gateCalls[0]).toMatchObject({
        agentId: "agent-maya",
        agentName: "maya",
        threadId: "thread-1",
        turnId: "turn-9",
        rolloutPath: "/tmp/maya/rollout.jsonl",
      });
    });

    test("TOCTOU: identity that drifts while the approval waits is denied", async () => {
      let pass = 0;
      const { manager, transport, gateCalls } = await writerSession({
        // Matches on the first pass, drifts on the second — exactly the window
        // a human approval holds open.
        authorize: async () => {
          pass += 1;
          return pass === 1
            ? { allowed: true }
            : { allowed: false, reason: "applied identity drifted mid-approval" };
        },
      });
      const asked = ask(transport, FILE_CHANGE, {
        ...bound,
        grantRoot: "/tmp/maya",
      });
      await Bun.sleep(1);
      expect(await manager.resolveApproval("approval-1", true)).toBe(true);
      const response = await asked;
      // Approved by a human, and still denied: the recheck is the authority.
      expect(response.result).toEqual({ decision: "decline" });
      expect(gateCalls).toHaveLength(2);
    });

    test("a denied approval stops at one gate call and never rechecks", async () => {
      const { manager, transport, gateCalls } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      const asked = ask(transport, COMMAND, { ...bound, command: "touch x" });
      await Bun.sleep(1);
      expect(await manager.resolveApproval("approval-1", false)).toBe(true);
      expect((await asked).result).toEqual({ decision: "decline" });
      expect(gateCalls).toHaveLength(1);
    });

    test("wrong thread and wrong turn are denied without consulting the gate", async () => {
      const { transport, gateCalls } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      const wrongThread = await ask(transport, COMMAND, {
        threadId: "thread-OTHER",
        turnId: "turn-9",
        command: "touch x",
      }, 511);
      const wrongTurn = await ask(transport, COMMAND, {
        threadId: "thread-1",
        turnId: "turn-STALE",
        command: "touch x",
      }, 512);
      const noIds = await ask(transport, COMMAND, { command: "touch x" }, 513);
      expect(wrongThread.result).toEqual({ decision: "decline" });
      expect(wrongTurn.result).toEqual({ decision: "decline" });
      expect(noIds.result).toEqual({ decision: "decline" });
      // Unbindable never even asks: there is no identity to attest.
      expect(gateCalls).toEqual([]);
    });

    test("a permissions escalation is refused outright, never gated, never granted", async () => {
      const { transport, gateCalls } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      const response = await ask(transport, "item/permissions/requestApproval", {
        ...bound,
        cwd: "/tmp/maya",
        permissions: { fileSystem: { write: ["/tmp/maya"] } },
      }, 521);
      // Empty profile: the narrowest scope this family can express is a whole
      // turn, which would outlive the one identity check that authorized it.
      expect(response.result).toEqual({ permissions: {}, scope: "turn" });
      expect(response.result.permissions).toEqual({});
      expect(gateCalls).toEqual([]);
    });

    test("the legacy turn-less families are refused: they cannot be bound to a turn", async () => {
      const { transport, gateCalls } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      const exec = await ask(transport, "execCommandApproval", {
        conversationId: "conv-1",
        callId: "call-1",
        command: ["rm", "-rf", "/"],
      }, 531);
      const patch = await ask(transport, "applyPatchApproval", {
        conversationId: "conv-1",
        callId: "call-2",
        fileChanges: {},
      }, 532);
      expect(exec.result).toEqual({ decision: "denied" });
      expect(patch.result).toEqual({ decision: "denied" });
      expect(gateCalls).toEqual([]);
    });

    test("a throwing gate, an unreadable thread, and a pathless build all deny", async () => {
      const throwing = await writerSession({
        authorize: async () => {
          throw new Error("daemon unreachable");
        },
      });
      expect((await ask(throwing.transport, COMMAND, { ...bound, command: "x" }))
        .result).toEqual({ decision: "decline" });

      // thread/read fails -> we cannot bind identity to this thread -> deny.
      const unreadable = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      unreadable.transport.threadReadFails = true;
      expect((await ask(unreadable.transport, COMMAND, { ...bound, command: "x" }))
        .result).toEqual({ decision: "decline" });
      expect(unreadable.gateCalls).toEqual([]);

      // A build that reports no rollout path still reaches the gate, which is
      // where "no path" becomes "unattested" and therefore a denial.
      const pathless = await writerSession({
        authorize: async (request) => ({
          allowed: request.rolloutPath !== null,
          reason: "no path",
        }),
      });
      pathless.transport.rolloutPath = null;
      expect((await ask(pathless.transport, COMMAND, { ...bound, command: "x" }))
        .result).toEqual({ decision: "decline" });
      expect(pathless.gateCalls[0].rolloutPath).toBeNull();
    });

    test("an unknown/malformed request is refused and never allowed", async () => {
      const { transport } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      // Not an approval family at all: the client throws rather than answering,
      // which the protocol layer turns into an error response, never an allow.
      transport.emit({ id: 541, method: "totally/unknown", params: {} });
      await Bun.sleep(1);
      const response = transport.sent.find((m) => m.id === 541);
      expect(response?.result).toBeUndefined();
    });

    test("a disconnect settles a waiting approval as denied", async () => {
      const { manager, transport } = await writerSession({
        authorize: async () => ({ allowed: true }),
      });
      const asked = ask(transport, COMMAND, { ...bound, command: "slow" }, 551);
      await Bun.sleep(1);
      // The turn is still waiting on a human. Tearing the session down must
      // resolve it as denied, not leave Codex hanging on a promise nobody owns.
      manager.disconnect("maya");
      const response = await asked;
      expect(response.result).toEqual({ decision: "decline" });
    });

    test("resolveApproval on an unknown id is never an allow", async () => {
      const { manager } = await writerSession();
      expect(await manager.resolveApproval("never-queued", true)).toBe(false);
    });
  });

  test("renders a readable host feed instead of raw protocol JSON", () => {
    expect(renderCodexHostMessage({
      method: "item/agentMessage/delta",
      params: { delta: "Tests are green." },
    })).toEqual("Tests are green.");
    expect(renderCodexHostMessage({
      method: "item/started",
      params: { item: { type: "commandExecution", command: "bun test" } },
    })).toEqual("\n$ bun test\n");
    expect(renderCodexHostMessage({
      method: "account/rateLimits/updated",
      params: {},
    })).toEqual(null);
  });
});

describe("codexAgentSocketPath", () => {
  test("derives socket path in tmpdir with agent ID and hive instance hash", () => {
    const agent: AgentRecord = {
      id: "agent-test",
      name: "test",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/test",
      branch: "main",
      tmuxSession: "hive-test",
      contextPct: 0,
      createdAt: "2026-07-10T12:00:00.000Z",
      lastEventAt: "2026-07-10T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: true,
      writeRevoked: false,
    };
    const path = codexAgentSocketPath(agent);
    expect(path).toContain("hive-codex-");
    expect(path).toContain("agent-test");
    expect(path).toContain(".sock");
    expect(path).toMatch(new RegExp(`^${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  test("replaces non-alphanumeric characters in agent ID", () => {
    const agent: AgentRecord = {
      id: "agent@with:special#chars",
      name: "test",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/test",
      branch: "main",
      tmuxSession: "hive-test",
      contextPct: 0,
      createdAt: "2026-07-10T12:00:00.000Z",
      lastEventAt: "2026-07-10T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: true,
      writeRevoked: false,
    };
    const path = codexAgentSocketPath(agent);
    const filename = path.split("/").pop()!;
    expect(filename).toContain("agent-with-special-chars");
    expect(filename).not.toContain("@");
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("#");
  });

  test("compacts UUID agent IDs and recovers them from the pidfile name", () => {
    const agent: AgentRecord = {
      id: "ba8f86b7-de0c-4ddb-b493-2aea2a978d48",
      name: "test",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/test",
      branch: "main",
      tmuxSession: "hive-test",
      contextPct: 0,
      createdAt: "2026-07-10T12:00:00.000Z",
      lastEventAt: "2026-07-10T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: true,
      writeRevoked: false,
    };
    const path = codexAgentSocketPath(agent);
    expect(Buffer.byteLength(path)).toBeLessThan(104);
    expect(basename(path)).not.toContain(agent.id);
    expect(hostPidfileAgentId(basename(`${path}.pid`))).toEqual(agent.id);
  });

  test("throws when socket path would exceed AF_UNIX length limit", () => {
    const agent: AgentRecord = {
      id: "x".repeat(200),
      name: "test",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/test",
      branch: "main",
      tmuxSession: "hive-test",
      contextPct: 0,
      createdAt: "2026-07-10T12:00:00.000Z",
      lastEventAt: "2026-07-10T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: true,
      writeRevoked: false,
    };
    expect(() => codexAgentSocketPath(agent)).toThrow(
      /exceeds the AF_UNIX length limit/,
    );
  });

  test("deduplicates sockets for the same hive instance", () => {
    const agent: AgentRecord = {
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "spawning",
      taskDescription: "test",
      worktreePath: "/tmp/maya",
      branch: "main",
      tmuxSession: "hive-maya",
      contextPct: 0,
      createdAt: "2026-07-10T12:00:00.000Z",
      lastEventAt: "2026-07-10T12:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: true,
      writeRevoked: false,
    };
    const path1 = codexAgentSocketPath(agent);
    const path2 = codexAgentSocketPath(agent, "/some/hive/home");
    const path3 = codexAgentSocketPath(agent, "/some/hive/home");
    expect(path2).toEqual(path3);
  });
});

describe("reapOrphanCodexHosts", () => {
  interface FakeWorld {
    files: Map<string, string>;
    commands: Map<number, string>;
    processStates?: Map<number, "live" | "dead" | "unknown">;
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
    fileState: async (name: string) =>
      world.files.has(name) ? "present" as const : "absent" as const,
    processCommand: async (pid: number) => world.commands.get(pid) ?? null,
    processState: async (pid: number) =>
      world.processStates?.get(pid) ??
        (world.commands.has(pid) ? "live" as const : "dead" as const),
    kill: (pid: number) => {
      world.killed.push(pid);
      world.commands.delete(Math.abs(pid));
    },
  });

  const status = (map: Record<string, "live" | "dead" | "unknown">) =>
  (id: string) => map[id] ?? "unknown";

  // Generate fixtures through the production writer so instance-qualified
  // pidfile parsing cannot drift from its producer.
  const pidfileFor = (id: string): string =>
    basename(codexAgentHostPidfile({ id } as AgentRecord));
  const socketFor = (id: string): string =>
    basename(codexAgentSocketPath({ id } as AgentRecord));

  test("the reaper parses the name the host writer actually produces", () => {
    const name = pidfileFor("dead-agent");
    expect(name).toContain(hiveInstanceSuffix());
    expect(hostPidfileAgentId(name)).toBe("dead-agent");
    // A pidfile belonging to another instance is not ours to reap.
    expect(
      hostPidfileAgentId("hive-codex-0123456789-dead-agent.sock.pid"),
    ).toBeNull();
  });

  test("kills only verified codex children of known-dead agents", async () => {
    const world: FakeWorld = {
      files: new Map([
        [pidfileFor("dead-agent"), "4242\n"],
        [socketFor("dead-agent"), ""],
        [pidfileFor("live-agent"), "5151\n"],
        [pidfileFor("foreign-agent"), "6161\n"],
        [pidfileFor("recycled"), "7171\n"],
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
    expect(world.killed).toEqual([-4242]);
    // Dead agents' pidfiles and sockets are cleared even when the pid was
    // recycled by another program; live and unknown agents keep theirs.
    expect([...world.files.keys()].sort()).toEqual([
      pidfileFor("foreign-agent"),
      pidfileFor("live-agent"),
      "unrelated.txt",
    ].sort());
  });

  test("does not report a no-op kill as a successful reap", async () => {
    const world: FakeWorld = {
      files: new Map([[pidfileFor("unkillable"), "7373\n"]]),
      commands: new Map([[7373, "codex app-server --stdio"]]),
      killed: [],
    };

    expect(reapOrphanCodexHosts(
      status({ unkillable: "dead" }),
      {
        ...dependencies(world),
        kill: (pid) => {
          world.killed.push(pid);
        },
      },
    )).rejects.toThrow("still running after reap");
  });

  test("preserves host files when process identity is unreadable", async () => {
    const name = pidfileFor("unreadable");
    const socket = socketFor("unreadable");
    const world: FakeWorld = {
      files: new Map([[name, "7474\n"], [socket, ""]]),
      commands: new Map(),
      processStates: new Map([[7474, "unknown"]]),
      killed: [],
    };

    await expect(reapOrphanCodexHosts(
      status({ unreadable: "dead" }),
      dependencies(world),
    )).rejects.toThrow("cannot verify process 7474");
    expect(world.killed).toEqual([]);
    expect([...world.files.keys()].sort()).toEqual([name, socket].sort());
  });

  test("unknown after signaling is not proof of exit", async () => {
    const name = pidfileFor("unverified-exit");
    const socket = socketFor("unverified-exit");
    const world: FakeWorld = {
      files: new Map([[name, "7575\n"], [socket, ""]]),
      commands: new Map([[7575, "codex app-server --stdio"]]),
      processStates: new Map([[7575, "unknown"]]),
      killed: [],
    };

    await expect(reapOrphanCodexHosts(
      status({ "unverified-exit": "dead" }),
      {
        ...dependencies(world),
        kill: (pid) => {
          world.killed.push(pid);
          world.commands.delete(Math.abs(pid));
        },
      },
    )).rejects.toThrow("cannot verify exit of Codex app-server 7575");
    expect(world.killed).toEqual([-7575]);
    expect([...world.files.keys()].sort()).toEqual([name, socket].sort());
  });

  test("does not accept a no-op file removal as cleanup", async () => {
    const name = pidfileFor("stale-files");
    const socket = socketFor("stale-files");
    const world: FakeWorld = {
      files: new Map([[name, "7676\n"], [socket, ""]]),
      commands: new Map(),
      killed: [],
    };

    await expect(reapOrphanCodexHosts(
      status({ "stale-files": "dead" }),
      {
        ...dependencies(world),
        removeFile: async () => {},
      },
    )).rejects.toThrow(`Codex app-server cleanup left ${socket} behind`);
    expect([...world.files.keys()].sort()).toEqual([name, socket].sort());
  });

  // Prompt text can name codex app-server; argv[0] cannot be forged by it.
  test("does not reap a process that only mentions codex in its prompt", async () => {
    const claudeAgent =
      "/Users/x/.local/bin/claude --model claude-opus-4-8 --append-system-prompt " +
      "Fix the reaper: it matches codex app-server by substring.";
    const world: FakeWorld = {
      files: new Map([
        [pidfileFor("impostor"), "8181\n"],
        [pidfileFor("real-host"), "9191\n"],
      ]),
      commands: new Map([
        [8181, claudeAgent],
        [9191, "codex app-server --stdio"],
      ]),
      killed: [],
    };

    const reaped = await reapOrphanCodexHosts(
      status({ impostor: "dead", "real-host": "dead" }),
      dependencies(world),
    );

    // The impostor is spared; the genuine orphan is still reaped.
    expect(reaped).toEqual([9191]);
    expect(world.killed).toEqual([-9191]);
  });

  test("kills a real orphan app-server process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-orphan-"));
    const executable = join(root, "codex");
    const childPidPath = join(root, "child.pid");
    let childPid = 0;
    let appServer: ReturnType<typeof Bun.spawn> | null = null;
    let unrelated: ReturnType<typeof Bun.spawn> | null = null;
    try {
      await symlink("/bin/sh", executable);
      await writeFile(
        join(root, "app-server"),
        "nohup /bin/sleep 30 >/dev/null 2>&1 & " +
          "child=$!; printf '%s\\n' \"$child\" > \"$1\"; wait\n",
      );
      appServer = Bun.spawn([executable, "app-server", childPidPath], {
        cwd: root,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      unrelated = Bun.spawn(["/bin/sleep", "30"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      for (let attempt = 0; attempt < 100 && childPid === 0; attempt += 1) {
        childPid = Number(
          (await readFile(childPidPath, "utf8").catch(() => "")).trim(),
        );
        if (childPid === 0) await Bun.sleep(10);
      }
      expect(childPid).toBeGreaterThan(0);

      const processCommand = async (pid: number): Promise<string | null> => {
        const ps = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const [command, exitCode] = await Promise.all([
          new Response(ps.stdout).text(),
          ps.exited,
        ]);
        return exitCode === 0 ? command.trim() : null;
      };
      const processState = async (
        pid: number,
      ): Promise<"live" | "dead" | "unknown"> => {
        try {
          process.kill(pid, 0);
          return "live";
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH"
            ? "dead"
            : "unknown";
        }
      };
      expect(await processCommand(appServer.pid)).toStartWith(
        `${executable} app-server`,
      );
      expect(await processState(appServer.pid)).toBe("live");
      expect(await processState(unrelated.pid)).toBe("live");
      const name = pidfileFor("real-orphan");
      const files = new Map([[name, `${appServer.pid}\n`]]);
      expect(await reapOrphanCodexHosts(
        status({ "real-orphan": "dead" }),
        {
          listSocketDir: async () => [...files.keys()],
          readPidFile: async (file) => files.get(file) ?? "",
          removeFile: async (file) => {
            files.delete(file);
          },
          fileState: async (file) =>
            files.has(file) ? "present" : "absent",
          processCommand,
          processState,
          kill: (pid) => process.kill(pid, "SIGKILL"),
        },
      )).toEqual([appServer.pid]);
      await appServer.exited;
      expect(await processState(appServer.pid)).toBe("dead");
      expect(await processState(unrelated.pid)).toBe("live");
      expect(files.size).toBe(0);

      let childAlive = true;
      for (let attempt = 0; attempt < 50 && childAlive; attempt += 1) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(10);
        } catch {
          childAlive = false;
        }
      }
      expect(childAlive).toBe(false);
    } finally {
      if (appServer !== null) {
        try {
          process.kill(-appServer.pid, "SIGKILL");
        } catch {
          // The reaper already killed the group.
        }
      }
      if (unrelated !== null) {
        try {
          unrelated.kill("SIGKILL");
        } catch {
          // The control process exited independently.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("a writer thread still starts in the read-only sandbox", async () => {
  // The app-server is the brokered driver, so a writer is admissible here —
  // but its sandbox is identical to a reader's. The sandbox is the structural
  // containment: it is what makes an unasked mutation impossible, leaving the
  // approval request as the only way to the filesystem.
  const transport = new FakeTransport();
  const manager = new CodexAppServerManager({
    transport: async () => transport,
    commandRunner: async () => 0,
    sleep: async () => undefined,
    onEvent: async () => undefined,
    queueApproval: async () => "approval-1",
    authorizeMutation: async () => ({ allowed: false, reason: "not under test" }),
    observeRateLimits: async () => null,
  });
  await manager.startAgent(agent({ readOnly: false }), {
    developerInstructions: "writer rules",
    initialUserPrompt: "write code",
  }, "high");

  const threadStart = transport.sent.find((m) => m.method === "thread/start");
  expect(threadStart?.params).toMatchObject({ sandbox: "read-only" });
  expect(threadStart?.params?.approvalPolicy).toBe("on-request");
});

test("CodexAppServerManager refuses a worker without an initial user prompt", async () => {
  let connected = false;
  const manager = new CodexAppServerManager({
    transport: async () => {
      connected = true;
      return new FakeTransport();
    },
    queueApproval: async () => "x",
    authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
    observeRateLimits: async () => null,
    onEvent: async () => {},
  });
  await expect(manager.startAgent(
    agent({ readOnly: true }),
    { developerInstructions: "reader rules" },
    "high",
  )).rejects.toThrow("requires an initial user prompt");
  expect(connected).toBeFalse();
});
