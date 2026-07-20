import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KillSessionOptions } from "../adapters/tmux";
import { killAgentCli, killOrigin, stopAgentSessions, stopHive } from "./control";
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
    expect(body.origin).toStartWith("hive kill ppid=");
    expect(body.origin).toContain(`ppid=${process.ppid}`);
    expect(body.origin).toContain("argv=");
  });

  test("hive stop's fan-out kills carry a stop origin, not a kill origin", async () => {
    const bodies: Array<{ origin?: string }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ reaped: { killed: [], survivors: [] } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const states: Array<"live" | "dead"> = ["live", "dead"];

    await Bun.write(join(killHome, "daemon.port"), "4483\n");
    await stopHive({
      tmux: new FakeStopTmux([]),
      readAgents: () => [sessiondAgent("maya")],
      readPid: () => 4242,
      kill: () => {},
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.origin).toStartWith("hive stop ppid=");
  });
});

describe("hive stop daemon", () => {
  test("authoritatively stops sessiond before signalling the daemon", async () => {
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
      readAgents: () => [sessiondAgent("maya")],
      stopSessiond: async (agent) => {
        order.push(`sessiond:${agent.name}`);
      },
      readPid: () => 4242,
      kill: () => order.push("SIGTERM"),
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
    });

    expect(order).toEqual([
      "sessiond:maya",
      "SIGTERM",
      `session:${agentTmuxSession("maya")}`,
      `session:${orchestratorTmuxSession()}`,
    ]);
  });

  test("attempts every sessiond teardown and refuses daemon shutdown on failure", async () => {
    const attempts: string[] = [];
    let signalled = false;

    await expect(stopHive({
      tmux: new FakeStopTmux([]),
      readAgents: () => [sessiondAgent("maya"), sessiondAgent("sam", 2)],
      stopSessiond: async (agent) => {
        attempts.push(agent.name);
        if (agent.name === "maya") throw new Error("tree still present");
      },
      readPid: () => 4242,
      kill: () => {
        signalled = true;
      },
      liveness: async () => "live",
      cleanup: () => {},
      log: () => {},
    })).rejects.toThrow(
      /sessiond teardown was not verified: maya: tree still present/,
    );

    expect(attempts).toEqual(["maya", "sam"]);
    expect(signalled).toBe(false);
  });

  test("unknown daemon liveness preserves every process and session", async () => {
    const tmux = new FakeStopTmux([agentTmuxSession("maya")]);
    let signalled = false;

    await expect(stopHive({
      tmux,
      readPid: () => 4242,
      kill: () => {
        signalled = true;
      },
      liveness: async () => "unknown",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
    })).rejects.toThrow(/unknown/);

    expect(signalled).toBe(false);
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
      kill: () => {},
      liveness: async () => "live",
      cleanup: () => {
        cleaned = true;
      },
      sleep: async () => {},
      timeoutMs: 50,
      log: (message) => logs.push(message),
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
      kill: () => {},
      liveness: async () => states.shift() ?? "dead",
      cleanup: (pid) => {
        cleanedPid = pid;
      },
      sleep: async () => {},
      timeoutMs: 150,
      log: (message) => logs.push(message),
    });

    expect(cleanedPid).toBe(4242);
    expect(logs).toEqual(["Stopped the Hive daemon and its sessions."]);
  });
});
