import { describe, expect, test } from "bun:test";
import type { KillSessionOptions } from "../adapters/tmux";
import { stopAgentSessions, stopHive } from "./control";
import { agentTmuxSession, orchestratorTmuxSession } from "../daemon/tmux-sessions";

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

describe("hive stop daemon", () => {
  test("signals a live daemon before touching the sessions it must reap", async () => {
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
      kill: () => order.push("SIGTERM"),
      liveness: async () => states.shift() ?? "dead",
      cleanup: () => {},
      sleep: async () => {},
      timeoutMs: 50,
      log: () => {},
    });

    expect(order[0]).toBe("SIGTERM");
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
