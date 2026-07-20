import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KillSessionOptions } from "../adapters/tmux";
import { killAgentCli, killOrigin, stopAgentSessions, stopHive } from "./control";
import type { InvokerIdentity } from "./invoker";
import { writeCredential } from "../daemon/credentials";
import { agentTmuxSession, orchestratorTmuxSession } from "../daemon/tmux-sessions";
import type { AgentRecord } from "../schemas";

function sessiondAgent(name: string, generation = 1): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-test",
    category: "complex_coding",
    status: "working",
    taskDescription: "test",
    worktreePath: null,
    branch: null,
    tmuxSession: `hive-${name}`,
    contextPct: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    lastEventAt: "2026-07-18T00:00:00.000Z",
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: {
      schemaVersion: 1,
      instanceId: "test-instance",
      subject: { kind: "agent", agentId: `agent-${name}` },
      generation,
      sessionId: `ses_0198a8f0-0000-7000-8000-00000000000${generation}`,
      hostKind: "sessiond",
      engineBuildId: "engine-test",
    },
  };
}

class FakeStopTmux {
  readonly killed: string[] = [];

  constructor(readonly sessions: string[]) {}

  async listSessions(): Promise<string[]> {
    return this.sessions;
  }

  async listPanePids(_session: string): Promise<number[]> {
    return [];
  }

  async killSession(
    session: string,
    _options?: KillSessionOptions,
  ): Promise<void> {
    this.killed.push(session);
    const index = this.sessions.indexOf(session);
    if (index !== -1) this.sessions.splice(index, 1);
  }
}

describe("hive stop agent sessions", () => {
  test("the dead-daemon fallback stops every session owned by this instance", async () => {
    const maya = agentTmuxSession("maya");
    const sam = agentTmuxSession("sam");
    const tmux = new FakeStopTmux([maya, "unrelated", sam]);
    const stopped = await stopAgentSessions({ tmux });

    expect(stopped).toEqual(2);
    expect(tmux.killed).toEqual([maya, sam]);
    expect(tmux.sessions).toEqual(["unrelated"]);
  });

  test("captures every process tree before removing the first session", async () => {
    const tmux = new FakeStopTmux([
      agentTmuxSession("maya"),
      agentTmuxSession("sam"),
    ]);
    let captures = 0;
    tmux.listPanePids = async () => {
      expect(tmux.killed).toEqual([]);
      captures += 1;
      return [];
    };
    const stopped = await stopAgentSessions({ tmux });

    expect(stopped).toEqual(2);
    expect(captures).toBe(2);
  });

  test("scratch stop targets only sessions scoped to its HIVE_HOME", async () => {
    const scratch = "/tmp/hive-scratch-stop";
    const other = "/tmp/hive-real-instance";
    const ownAgent = agentTmuxSession("maya", scratch);
    const ownOrchestrator = orchestratorTmuxSession(scratch);
    const tmux = new FakeStopTmux([
      ownAgent,
      ownOrchestrator,
      agentTmuxSession("sam", other),
      orchestratorTmuxSession(other),
      "hive-orchestrator",
      "hive-legacy-agent",
      "unrelated",
    ]);

    const stopped = await stopAgentSessions({ tmux, hiveHome: scratch });

    expect(stopped).toEqual(2);
    expect(tmux.killed).toEqual([ownAgent, ownOrchestrator]);
  });

  test("preserves every session when one process tree cannot be captured", async () => {
    const tmux = new FakeStopTmux([agentTmuxSession("maya")]);
    tmux.listPanePids = async () => {
      throw new Error("ps unavailable");
    };

    await expect(stopAgentSessions({ tmux })).rejects.toThrow(
      /process tree could not be captured.*ps unavailable/s,
    );
    expect(tmux.killed).toEqual([]);
  });
});

describe("kill origin instrumentation (#64)", () => {
  let killHome = "";
  let previousHome: string | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    killHome = mkdtempSync(join(tmpdir(), "hive-kill-origin-"));
    previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = killHome;
    writeCredential("operator", "test-operator-token");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (previousHome === undefined) {
      delete process.env.HIVE_HOME;
    } else {
      process.env.HIVE_HOME = previousHome;
    }
    rmSync(killHome, { recursive: true, force: true });
  });

  test("killAgentCli sends its origin with the kill request", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({ reaped: { killed: [], survivors: [] } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const maya = sessiondAgent("maya");
    await killAgentCli(
      "maya",
      4483,
      maya.sessionLocator,
      killOrigin("kill"),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/agents/maya/kill");
    const body = requests[0]!.body as { sessionLocator: unknown; origin?: string };
    expect(body.sessionLocator).toEqual(maya.sessionLocator);
    expect(body.origin).toStartWith("hive kill pid=");
    expect(body.origin).toContain(`ppid=${process.ppid}`);
    expect(body.origin).toContain("argv=");
  });

  test("killOrigin carries the full invoker identity (#70): pid chain, cwd, worktree flag", () => {
    const origin = killOrigin("stop", {
      pid: 100,
      ppid: 200,
      argv: ["stop"],
      cwd: "/repo",
      chain: ["200:zsh", "300:tmux"],
      agentWorktree: false,
    });
    expect(origin).toBe(
      'hive stop pid=100 ppid=200 argv=["stop"] cwd=/repo agentWorktree=no chain=[200:zsh,300:tmux]',
    );
  });

  test("hive stop sends its stop origin in the daemon /stop request", async () => {
    const bodies: Array<{ origin: string; confirmUnlanded: boolean }> = [];
    const states: Array<"live" | "dead"> = ["live", "dead"];

    await Bun.write(join(killHome, "daemon.port"), "4483\n");
    await stopHive({
      tmux: new FakeStopTmux([]),
      readPid: () => 4242,
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
      invoker: nonWorktreeInvoker(),
      requestStop: async (body) => {
        bodies.push(body);
        return { state: "stopping", killed: ["maya"] };
      },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.origin).toStartWith("hive stop pid=");
    expect(bodies[0]!.origin).toContain("chain=[");
    expect(bodies[0]!.confirmUnlanded).toBe(false);
  });
});

function nonWorktreeInvoker(): InvokerIdentity {
  return {
    pid: 100,
    ppid: 200,
    argv: ["stop"],
    cwd: "/repo",
    chain: ["200:zsh"],
    agentWorktree: false,
  };
}

describe("hive stop daemon", () => {
  test("delegates the stop to the daemon before sweeping sessions", async () => {
    const order: string[] = [];
    const tmux = new FakeStopTmux([
      agentTmuxSession("maya"),
      orchestratorTmuxSession(),
    ]);
    tmux.killSession = async (session) => {
      order.push(`session:${session}`);
      tmux.killed.push(session);
      const index = tmux.sessions.indexOf(session);
      if (index !== -1) tmux.sessions.splice(index, 1);
    };
    const states: Array<"live" | "dead"> = ["live", "dead"];

    await stopHive({
      tmux,
      readPid: () => 4242,
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
      invoker: nonWorktreeInvoker(),
      requestStop: async () => {
        order.push("daemon:/stop");
        return { state: "stopping", killed: ["maya"] };
      },
    });

    expect(order).toEqual([
      "daemon:/stop",
      `session:${agentTmuxSession("maya")}`,
      `session:${orchestratorTmuxSession()}`,
    ]);
  });

  test("refuses from inside an agent worktree before contacting anything (#70)", async () => {
    // Both 2026-07-20 fleet-kill waves came from agent shells. An agent
    // worktree invocation is refused before liveness, before the daemon,
    // before any session is touched.
    const tmux = new FakeStopTmux([agentTmuxSession("maya")]);
    let daemonContacted = false;
    let livenessRead = false;

    await expect(stopHive({
      tmux,
      readPid: () => 4242,
      liveness: async () => {
        livenessRead = true;
        return "live";
      },
      cleanup: () => {},
      log: () => {},
      invoker: {
        pid: 100,
        ppid: 200,
        argv: [],
        cwd: "/repo/.hive/worktrees/maya",
        chain: ["200:bash"],
        agentWorktree: true,
      },
      requestStop: async () => {
        daemonContacted = true;
        return { state: "stopping", killed: [] };
      },
    })).rejects.toThrow(/agent worktree/);

    expect(daemonContacted).toBe(false);
    expect(livenessRead).toBe(false);
    expect(tmux.killed).toEqual([]);
  });

  test("refuses a defaulted stop transport inside a test runner (#70)", async () => {
    // The incident shape: a bun test process (NODE_ENV=test is ambient right
    // now) calling stopHive without injecting requestStop. The lethal default
    // would resolve the ambient HIVE_HOME's daemon; refuse instead.
    const tmux = new FakeStopTmux([]);

    await expect(stopHive({
      tmux,
      readPid: () => 4242,
      liveness: async () => "live",
      cleanup: () => {},
      log: () => {},
      invoker: nonWorktreeInvoker(),
    })).rejects.toThrow(/test-runner process/);

    expect(tmux.killed).toEqual([]);
  });

  test("names the agents and their unlanded state when the daemon refuses", async () => {
    const calls: Array<{ confirmUnlanded: boolean }> = [];
    let cleaned = false;

    await expect(stopHive({
      tmux: new FakeStopTmux([]),
      readPid: () => 4242,
      liveness: async () => "live",
      cleanup: () => {
        cleaned = true;
      },
      log: () => {},
      invoker: nonWorktreeInvoker(),
      confirm: async () => null,
      requestStop: async (body) => {
        calls.push({ confirmUnlanded: body.confirmUnlanded });
        return {
          state: "refused-unlanded",
          unlanded: [
            { name: "maya", branch: "hive/maya-x", dirtyFiles: 7, unmergedCommits: 2 },
          ],
        };
      },
    })).rejects.toThrow(
      /maya \(branch hive\/maya-x: 2 unmerged commit\(s\), 7 uncommitted file\(s\)\)/,
    );

    expect(calls).toEqual([{ confirmUnlanded: false }]);
    expect(cleaned).toBe(false);
  });

  test("a TTY confirmation retries the stop with explicit confirmation", async () => {
    const calls: Array<{ confirmUnlanded: boolean }> = [];
    const states: Array<"live" | "dead"> = ["live", "dead"];

    await stopHive({
      tmux: new FakeStopTmux([]),
      readPid: () => 4242,
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
      invoker: nonWorktreeInvoker(),
      confirm: async () => true,
      requestStop: async (body) => {
        calls.push({ confirmUnlanded: body.confirmUnlanded });
        return body.confirmUnlanded
          ? { state: "stopping", killed: ["maya"] }
          : {
            state: "refused-unlanded",
            unlanded: [
              { name: "maya", branch: null, dirtyFiles: 1, unmergedCommits: 0 },
            ],
          };
      },
    });

    expect(calls).toEqual([
      { confirmUnlanded: false },
      { confirmUnlanded: true },
    ]);
  });

  test("--force sends explicit confirmation on the first request", async () => {
    const calls: Array<{ confirmUnlanded: boolean }> = [];
    const states: Array<"live" | "dead"> = ["live", "dead"];

    await stopHive({
      tmux: new FakeStopTmux([]),
      readPid: () => 4242,
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
      invoker: nonWorktreeInvoker(),
      force: true,
      confirm: async () => {
        throw new Error("--force must never prompt");
      },
      requestStop: async (body) => {
        calls.push({ confirmUnlanded: body.confirmUnlanded });
        return { state: "stopping", killed: ["maya"] };
      },
    });

    expect(calls).toEqual([{ confirmUnlanded: true }]);
  });

  test("a stop-failed answer is a refusal, not a success", async () => {
    let cleaned = false;
    const logs: string[] = [];

    await expect(stopHive({
      tmux: new FakeStopTmux([]),
      readPid: () => 4242,
      liveness: async () => "live",
      cleanup: () => {
        cleaned = true;
      },
      log: (message) => logs.push(message),
      invoker: nonWorktreeInvoker(),
      requestStop: async () => ({
        state: "stop-failed",
        failures: ["maya: 2 process(es) survived SIGKILL"],
      }),
    })).rejects.toThrow(
      /agent teardown failed: maya: 2 process\(es\) survived SIGKILL/,
    );

    expect(cleaned).toBe(false);
    expect(logs).toEqual([]);
  });

  test("unknown daemon liveness preserves every process and session", async () => {
    const tmux = new FakeStopTmux([agentTmuxSession("maya")]);
    let daemonContacted = false;

    await expect(stopHive({
      tmux,
      readPid: () => 4242,
      liveness: async () => "unknown",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
      invoker: nonWorktreeInvoker(),
      requestStop: async () => {
        daemonContacted = true;
        return { state: "stopping", killed: [] };
      },
    })).rejects.toThrow(/unknown/);

    expect(daemonContacted).toBe(false);
    expect(tmux.killed).toEqual([]);
  });

  test("a positively dead daemon fallback reaps a real detached session child", async () => {
    const childProgram = "setInterval(() => {}, 1000)";
    const parentProgram = [
      `const child = Bun.spawn([${JSON.stringify(process.execPath)}, \"-e\", ${JSON.stringify(childProgram)}], { detached: true, stdin: \"ignore\", stdout: \"ignore\", stderr: \"ignore\" });`,
      "console.log(child.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = Bun.spawn([process.execPath, "-e", parentProgram], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = parent.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    const childPid = Number.parseInt(output.trim(), 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);

    const session = agentTmuxSession("maya");
    let sessionPresent = true;
    const tmux = {
      listSessions: async () => sessionPresent ? [session] : [],
      listPanePids: async () => [parent.pid],
      killSession: async () => {
        sessionPresent = false;
        try {
          process.kill(parent.pid, "SIGKILL");
        } catch {
          // The fallback's reaper may win the race.
        }
      },
    };
    try {
      await stopHive({
        tmux,
        readPid: () => null,
        liveness: async () => "dead",
        cleanup: () => {},
        log: () => {},
        invoker: nonWorktreeInvoker(),
      });

      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      for (const pid of [parent.pid, childPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone is the intended result.
        }
      }
      await parent.exited;
    }
  });

  test("does not report success or remove lifecycle evidence while the daemon is live", async () => {
    const tmux = new FakeStopTmux([]);
    const logs: string[] = [];
    let cleaned = false;

    await expect(stopHive({
      tmux,
      readPid: () => 4242,
      liveness: async () => "live",
      cleanup: () => {
        cleaned = true;
      },
      sleep: async () => {},
      timeoutMs: 50,
      log: (message) => logs.push(message),
      invoker: nonWorktreeInvoker(),
      requestStop: async () => ({ state: "stopping", killed: [] }),
    })).rejects.toThrow(/daemon pid 4242 did not stop/);

    expect(cleaned).toBe(false);
    expect(logs).toEqual([]);
  });

  test("reports success only after liveness proves the daemon dead", async () => {
    const tmux = new FakeStopTmux([]);
    const states: Array<"live" | "unknown" | "dead"> = ["live", "unknown", "dead"];
    const logs: string[] = [];
    let cleanedPid: number | undefined;

    await stopHive({
      tmux,
      readPid: () => 4242,
      liveness: async () => states.shift() ?? "dead",
      cleanup: (pid) => {
        cleanedPid = pid;
      },
      sleep: async () => {},
      timeoutMs: 150,
      log: (message) => logs.push(message),
      invoker: nonWorktreeInvoker(),
      requestStop: async () => ({ state: "stopping", killed: [] }),
    });

    expect(cleanedPid).toBe(4242);
    expect(logs).toEqual(["Stopped the Hive daemon and its sessions."]);
  });
});
