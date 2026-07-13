import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AgentRecord, HookEvent } from "../../schemas";
import { basename, join } from "node:path";
import { hiveInstanceSuffix } from "../../daemon/tmux-sessions";
import {
  CodexAppServerManager,
  CodexAppServerClient,
  CodexAppServerThreadConnection,
  type CodexAppServerTransport,
  codexAgentHostPidfile,
  codexAgentSocketPath,
  hostPidfileAgentId,
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

test("second-client thread connection resumes, injects, and steers without a TUI transport", async () => {
  const transport = new FakeTransport();
  const client = new CodexAppServerClient(transport, {
    notification: () => undefined,
    request: async () => ({}),
  });
  const connection = new CodexAppServerThreadConnection(client);
  await connection.initialize();
  await connection.resume("thread-tui");
  await connection.injectItems("thread-tui", "HIVE_ROOT_MESSAGE");
  await connection.steer("thread-tui", "continue", "turn-active");

  expect(transport.sent.map((message) => message.method)).toEqual([
    "initialize",
    "initialized",
    "thread/resume",
    "thread/inject_items",
    "turn/steer",
  ]);
  expect(transport.sent[3]?.params).toEqual({
    threadId: "thread-tui",
    items: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "HIVE_ROOT_MESSAGE" }],
    }],
  });
});

function agent(): AgentRecord {
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
    readOnly: false,
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
      readOnly: false,
      writeRevoked: false,
      channelsEnabled: false,
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
      readOnly: false,
      writeRevoked: false,
      channelsEnabled: false,
    };
    const path = codexAgentSocketPath(agent);
    const filename = path.split("/").pop()!;
    expect(filename).toContain("agent-with-special-chars");
    expect(filename).not.toContain("@");
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("#");
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
      readOnly: false,
      writeRevoked: false,
      channelsEnabled: false,
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
      readOnly: false,
      writeRevoked: false,
      channelsEnabled: false,
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
      world.commands.delete(Math.abs(pid));
    },
  });

  const status = (map: Record<string, "live" | "dead" | "unknown">) =>
  (id: string) => map[id] ?? "unknown";

  // The pidfile names are BUILT BY THE PRODUCTION WRITER, never hand-typed.
  //
  // They used to be spelled `hive-codex-dead-agent.sock.pid` here — a format
  // nothing in Hive has ever written. The real name carries the instance hash
  // (`hive-codex-<suffix>-<agentId>.sock.pid`), and the reaper's old greedy
  // pattern captured `<suffix>-<agentId>` as the agent id, so against a REAL
  // filename the lookup always answered "unknown" and the reaper skipped every
  // pidfile it saw. The fixture was the only thing that ever matched it: a
  // green test standing exactly where the bug was. Generating the names from
  // `codexAgentHostPidfile` is what makes this test able to fail.
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

  // A recycled pid held by a process that merely TALKS about codex is not a
  // codex host. Hive puts an agent's task prompt on the command line, so an
  // agent briefed to work on this reaper has "codex app-server" in its own
  // `ps` output — as does the orchestrator, whose system prompt names every
  // vendor. The old check was `command.includes("codex app-server")`, which
  // those satisfy: the only thing standing between a recycled pid and a
  // SIGKILL of a live agent was the dead-agent-row guard. Match the binary,
  // which a prompt cannot forge.
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
      expect(await processCommand(appServer.pid)).toStartWith(
        `${executable} app-server`,
      );
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
          processCommand,
          kill: (pid) => process.kill(pid, "SIGKILL"),
        },
      )).toEqual([appServer.pid]);
      await appServer.exited;

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
      await rm(root, { recursive: true, force: true });
    }
  });
});
