import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureProcessTree,
  reapCapturedTree,
  ResumeRollbackError,
  resumeCapturedTree,
  stopAgentSession,
  suspendCapturedTree,
  type ReapDependencies,
} from "./teardown";
import { parseProcessTable, runPs } from "./resources";
import type { AgentRecord } from "../schemas";
import {
  CodexAppServerManager,
  codexAgentHostPidfile,
  runCodexAppServerHost,
} from "../adapters/tools/codex-app-server";

/** capture + reap, the way every caller uses them when nothing reparents. */
const reapProcessTree = async (
  roots: readonly number[],
  dependencies: ReapDependencies,
  selfPid: number,
) =>
  reapCapturedTree(
    await captureProcessTree(roots, dependencies, selfPid),
    dependencies,
    selfPid,
  );

/** The fake world covers states the kernel cannot safely produce on demand. */
interface FakeProcess {
  pid: number;
  ppid: number;
  command: string;
  stat?: string;
  /** Survives the kill, like a process wedged in uninterruptible IO. */
  unkillable?: boolean;
}

function world(processes: FakeProcess[]) {
  const alive = new Map(processes.map((entry) => [entry.pid, { ...entry }]));
  const signalled: number[] = [];
  const dependencies: ReapDependencies = {
    ps: async () =>
      [...alive.values()]
        .map((p) => `${p.pid} ${p.ppid} 1024 ${p.command}`)
        .join("\n"),
    psState: async () =>
      [{ pid: 1, ppid: 0, command: "init", stat: "S" }, ...alive.values()]
        .map((p) => `${p.pid} ${p.ppid} ${p.stat ?? "S"}`)
        .join("\n"),
    kill: (pid) => {
      signalled.push(pid);
      const target = alive.get(pid);
      if (target !== undefined && target.unkillable !== true) alive.delete(pid);
    },
    wait: async () => undefined,
  };
  return { dependencies, signalled, alive };
}

async function realProcesses() {
  return parseProcessTable(await runPs());
}

async function waitForProcess(
  predicate: (processes: Awaited<ReturnType<typeof realProcesses>>) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    if (predicate(await realProcesses())) return true;
    await Bun.sleep(20);
  } while (Date.now() < deadline);
  return false;
}

/** A signal-aware world: SIGSTOP/SIGCONT flip a process's state instead of
 * killing it, so a non-destructive pause can be observed. Every process stays
 * alive (present in `ps`) — that is the whole point of suspend. */
function suspendableWorld(processes: FakeProcess[]) {
  const alive = new Map(processes.map((entry) => [entry.pid, { ...entry }]));
  const signals: Array<{ pid: number; signal: string }> = [];
  const dependencies: ReapDependencies = {
    ps: async () =>
      [...alive.values()]
        .map((p) => `${p.pid} ${p.ppid} 1024 ${p.command}`)
        .join("\n"),
    psState: async () =>
      [{ pid: 1, ppid: 0, command: "init", stat: "S" }, ...alive.values()]
        .map((p) => `${p.pid} ${p.ppid} ${p.stat ?? "S"}`)
        .join("\n"),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
      const target = alive.get(pid);
      if (target === undefined || target.unkillable === true) return;
      if (signal === "SIGSTOP") target.stat = "T";
      else if (signal === "SIGCONT") target.stat = "S";
    },
    wait: async () => undefined,
  };
  return { dependencies, signals, alive };
}

describe("suspend/resume process tree (non-destructive pause)", () => {
  test("SIGSTOPs the whole tree without killing it, then SIGCONT resumes it", async () => {
    const { dependencies, alive } = suspendableWorld([
      { pid: 100, ppid: 1, command: "-bash" },
      { pid: 200, ppid: 100, command: "codex" },
      { pid: 300, ppid: 200, command: "mcp-stdio" },
    ]);
    const captured = await captureProcessTree([100], dependencies, 1);
    const outcome = await suspendCapturedTree(captured, dependencies, 1);

    expect(outcome.suspended.map((p) => p.pid).sort()).toEqual([100, 200, 300]);
    expect(outcome.unstopped).toEqual([]);
    // Non-destructive: every process is still alive, just stopped.
    expect([...alive.keys()].sort()).toEqual([100, 200, 300]);
    expect([...alive.values()].every((p) => p.stat === "T")).toBe(true);

    await resumeCapturedTree(captured, dependencies, 1);
    expect([...alive.values()].every((p) => p.stat === "S")).toBe(true);
    expect([...alive.keys()].sort()).toEqual([100, 200, 300]);
  });

  test("a process that will not stop is reported as an unstopped survivor", async () => {
    const { dependencies } = suspendableWorld([
      { pid: 100, ppid: 1, command: "-bash" },
      { pid: 200, ppid: 100, command: "codex", unkillable: true },
    ]);
    const captured = await captureProcessTree([100], dependencies, 1);
    const outcome = await suspendCapturedTree(captured, dependencies, 1);
    expect(outcome.unstopped.map((p) => p.pid)).toEqual([200]);
    expect(outcome.suspended.map((p) => p.pid)).toEqual([100]);
  });
});

describe("reapProcessTree", () => {
  test("kills what tmux cannot reach: the whole tree under the pane", async () => {
    // The shape that actually leaks: the pane's shell owns the vendor CLI,
    // which owns an MCP stdio child. Killing the tmux session tears down the
    // pane; these keep running.
    const { dependencies, alive } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "claude --model opus" },
      { pid: 102, ppid: 101, command: "bun mcp-server" },
      { pid: 999, ppid: 1, command: "unrelated" },
    ]);

    const outcome = await reapProcessTree([100], dependencies, 1);

    expect(outcome.killed.map((p) => p.pid).sort()).toEqual([100, 101, 102]);
    expect(outcome.survivors).toEqual([]);
    expect(alive.has(999)).toBe(true);
  });

  test("reaps a codex host that is a child of the daemon, not of the pane", async () => {
    // The host hangs off the DAEMON, so no pane signal reaches it. It is only
    // reaped because it is passed as a root in its own right.
    const { dependencies } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 500, ppid: 7, command: "codex app-server --listen unix://..." },
    ]);

    const outcome = await reapProcessTree([100, 500], dependencies, 1);

    expect(outcome.killed.map((p) => p.pid).sort()).toEqual([100, 500]);
  });

  test("a process that survives SIGKILL is reported, not rounded down to success", async () => {
    const { dependencies } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "wedged", unkillable: true },
    ]);

    const outcome = await reapProcessTree([100], dependencies, 1);

    expect(outcome.killed.map((p) => p.pid)).toEqual([100]);
    expect(outcome.survivors).toEqual([{ pid: 101, command: "wedged" }]);
  });

  test("a zombie counts as dead: it is an exit nobody reaped", async () => {
    const { dependencies } = world([
      { pid: 100, ppid: 1, command: "-zsh", stat: "Z", unkillable: true },
    ]);

    const outcome = await reapProcessTree([100], dependencies, 1);

    expect(outcome.survivors).toEqual([]);
    expect(outcome.killed.map((p) => p.pid)).toEqual([100]);
  });

  test("refuses the daemon itself as a process-tree root", async () => {
    const { dependencies, signalled } = world([
      { pid: 7, ppid: 1, command: "hive daemon" },
      { pid: 100, ppid: 7, command: "-zsh" },
    ]);

    await expect(reapProcessTree([7], dependencies, 7)).rejects.toThrow(
      "invalid root pid 7",
    );

    expect(signalled).not.toContain(7);
  });

  test("kills a detached child that tmux reparented to init", async () => {
    // THE BUG OBSERVATION CAUGHT, and the reason capture is a separate step.
    //
    // The agent nohup'ed a command (101). Killing the tmux session tears the
    // pane down: the shell (100) dies, and 101 — which ignored the SIGHUP —
    // is reparented to init, so its ppid becomes 1. A tree walk performed
    // AFTER the session died finds nothing under 100 and reports a clean kill
    // over a process that is still running. Capturing first is what makes 101
    // killable, because at capture time it was still a child of the pane.
    const { dependencies, alive } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "nohup long-build" },
    ]);

    const captured = await captureProcessTree([100], dependencies, 1);

    // tmux kills the pane. The shell dies; the nohup'ed child is reparented.
    alive.delete(100);
    const orphan = alive.get(101)!;
    orphan.ppid = 1;

    const outcome = await reapCapturedTree(captured, dependencies, 1);

    expect(outcome.killed.map((p) => p.pid).sort()).toEqual([100, 101]);
    expect(outcome.survivors).toEqual([]);
    expect(alive.has(101)).toBe(false);
  });

  test("real ps capture survives reparenting and reaps only the captured tree", async () => {
    const shell = Bun.spawn(["sh", "-c", "sleep 60 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let childPid: number | undefined;
    try {
      expect(await waitForProcess((processes) => {
        childPid = processes.find((entry) => entry.ppid === shell.pid)?.pid;
        return childPid !== undefined;
      })).toBe(true);
      expect(childPid).toBeDefined();
      expect(await waitForProcess((processes) =>
        processes.some((entry) => entry.pid === unrelated.pid)
      )).toBe(true);

      const captured = await captureProcessTree([shell.pid]);
      expect(captured.map((entry) => entry.pid)).toContain(shell.pid);
      expect(captured.map((entry) => entry.pid)).toContain(childPid!);

      shell.kill("SIGKILL");
      await shell.exited;
      expect(await waitForProcess((processes) =>
        processes.some((entry) =>
          entry.pid === childPid && entry.ppid !== shell.pid
        )
      )).toBe(true);

      const outcome = await reapCapturedTree(captured);

      expect(outcome.survivors).toEqual([]);
      expect(outcome.killed.map((entry) => entry.pid)).toContain(childPid!);
      expect(await waitForProcess((processes) =>
        !processes.some((entry) => entry.pid === childPid)
      )).toBe(true);
      expect((await realProcesses()).some((entry) =>
        entry.pid === unrelated.pid
      )).toBe(true);
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The reaper already removed it.
        }
      }
      shell.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([shell.exited, unrelated.exited]);
    }
  });

  test("reaps a real Codex host after its pane session is gone", async () => {
    const host = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const unrelated = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const killedSessions: string[] = [];
    const record = {
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-5-codex",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: "/tmp/maya",
      branch: "hive/maya-test",
      tmuxSession: "hive-maya",
      contextPct: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      lastEventAt: "2026-07-13T00:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
    } satisfies AgentRecord;
    try {
      expect(() => process.kill(host.pid, 0)).not.toThrow();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();

      const outcome = await stopAgentSession(record, {
        tmux: {
          hasSession: async () => false,
          listPanePids: async () => {
            throw new Error("pane lookup must not run for a missing session");
          },
          killSession: async (session) => {
            killedSessions.push(session);
          },
        },
        readHostPid: async () => host.pid,
      });

      expect(outcome.survivors).toEqual([]);
      expect(outcome.killed.map((entry) => entry.pid)).toContain(host.pid);
      expect(killedSessions).toEqual(["hive-maya"]);
      expect(await Promise.race([
        host.exited,
        Bun.sleep(1_000).then(() => null),
      ])).not.toBeNull();
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally {
      host.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([host.exited, unrelated.exited]);
    }
  });

  test("refuses capture after the root has vanished", async () => {
    // The negative control for the test above: this is what the broken version
    // did, and it is why "the tests passed" was not "the process is dead".
    const { dependencies, alive } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 101, ppid: 100, command: "nohup long-build" },
    ]);

    alive.delete(100);
    alive.get(101)!.ppid = 1;

    await expect(captureProcessTree([100], dependencies, 1)).rejects.toThrow(
      "did not contain root pid 100",
    );
  });

  test("refuses to report reaping when the verification probe sees no positive control", async () => {
    const { dependencies } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
    ]);
    dependencies.psState = async () => "";

    await expect(reapProcessTree([100], dependencies, 1)).rejects.toThrow(
      "did not contain verification pid 1",
    );
  });

  test("no roots is a no-op, not a sweep of everything", async () => {
    const { dependencies, signalled } = world([
      { pid: 100, ppid: 1, command: "-zsh" },
    ]);

    expect(await reapProcessTree([], dependencies, 1))
      .toEqual({ killed: [], survivors: [] });
    expect(signalled).toEqual([]);
  });
});

describe("pause capture birth binding (N5)", () => {
  function pauseWorld(
    processes: Array<FakeProcess & { birth?: string }>,
  ) {
    const alive = new Map(processes.map((entry) => [entry.pid, { ...entry }]));
    const signals: Array<{ pid: number; signal: string }> = [];
    const dependencies = {
      ps: async () =>
        [...alive.values()]
          .map((p) => `${p.pid} ${p.ppid} 1024 ${p.command}`)
          .join("\n"),
      psState: async () =>
        [{ pid: 1, ppid: 0, command: "init", stat: "S" }, ...alive.values()]
          .map((p) => `${p.pid} ${p.ppid} ${p.stat ?? "S"}`)
          .join("\n"),
      psBirth: async () =>
        [...alive.values()]
          .map((p) => `${p.pid} ${p.birth ?? `birth-${p.pid}`}`)
          .join("\n"),
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push({ pid, signal });
        const target = alive.get(pid);
        if (target === undefined || target.unkillable === true) return;
        if (signal === "SIGSTOP") target.stat = "T";
        else if (signal === "SIGCONT") target.stat = "S";
      },
      wait: async () => undefined,
    };
    return { dependencies, signals, alive };
  }

  test("capturePauseBoundTree records birth and roles including app-server host", async () => {
    const { capturePauseBoundTree } = await import("./teardown");
    const { dependencies } = pauseWorld([
      { pid: 100, ppid: 1, command: "-zsh", birth: "Mon Jul 13 10:00:00 2026" },
      { pid: 200, ppid: 100, command: "codex", birth: "Mon Jul 13 10:00:01 2026" },
      { pid: 900, ppid: 1, command: "codex app-server", birth: "Mon Jul 13 10:00:02 2026" },
    ]);
    const tree = await capturePauseBoundTree([100], 900, dependencies, 1);
    expect(tree.map((e) => e.pid).sort()).toEqual([100, 200, 900]);
    expect(tree.find((e) => e.pid === 100)?.role).toBe("tmux-root");
    expect(tree.find((e) => e.pid === 200)?.role).toBe("descendant");
    expect(tree.find((e) => e.pid === 900)).toMatchObject({
      role: "app-server-host",
      birth: "Mon Jul 13 10:00:02 2026",
    });
  });

  test("production manager pidfile binds the app-server host into pause capture", async () => {
    const { suspendAgentForPause } = await import("./teardown");
    const root = mkdtempSync(join(tmpdir(), "hive-pause-pidfile-"));
    const previousHiveHome = Bun.env.HIVE_HOME;
    const previousPath = Bun.env.PATH;
    Bun.env.HIVE_HOME = root;
    const agent = {
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-test",
      category: "simple_coding",
      status: "working",
      taskDescription: "test",
      worktreePath: root,
      branch: "hive/maya-test",
      tmuxSession: "hive-maya",
      contextPct: null,
      createdAt: "2026-07-15T20:00:00.000Z",
      lastEventAt: "2026-07-15T20:00:00.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      processIncarnation: 4,
      processStartedAt: "2026-07-15T20:00:00.000Z",
      readOnly: true,
      writeRevoked: false,
    } satisfies AgentRecord;
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const fakeCodex = join(bin, "codex");
    await Bun.write(fakeCodex, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(fakeCodex, 0o755);
    Bun.env.PATH = `${bin}:${previousPath ?? ""}`;
    const manager = new CodexAppServerManager({
      onEvent: async () => {},
      queueApproval: async () => "unused",
      denyApproval: async () => undefined,
      authorizeMutation: async () => ({ allowed: false, reason: "test default deny" }),
      observeRateLimits: async () => null,
    });
    const command = manager.buildHostCommand(agent, 4317);
    const socket = command[command.indexOf("--socket") + 1]!;
    let hostPid: number | null = null;
    let hostRun: Promise<number> | null = null;
    try {
      const pidfile = codexAgentHostPidfile(agent);
      expect(`${socket}.pid`).toBe(pidfile);
      hostRun = runCodexAppServerHost({
        socket,
        worktree: root,
        daemonPort: 4317,
        agentName: agent.name,
      });
      for (let attempt = 0; attempt < 100 && !existsSync(pidfile); attempt += 1) {
        await Bun.sleep(10);
      }
      hostPid = Number(readFileSync(pidfile, "utf8").trim());
      expect(hostPid).toBeGreaterThan(1);
      const { dependencies } = pauseWorld([
        { pid: 100, ppid: 1, command: "-zsh", birth: "birth-PANE" },
        {
          pid: hostPid,
          ppid: 1,
          command: "codex app-server",
          birth: "birth-HOST",
        },
      ]);

      const paused = await suspendAgentForPause(agent, {
        tmux: {
          hasSession: async () => true,
          listPanePids: async () => [100],
          killSession: async () => undefined,
        },
        reap: dependencies,
        selfPid: 1,
        requireAppServerHost: true,
      });

      expect(paused.capture).toMatchObject({
        hostPid,
        processIncarnation: 4,
      });
      expect(paused.capture.tree.find((entry) => entry.pid === hostPid))
        .toMatchObject({ role: "app-server-host", birth: "birth-HOST" });
      expect(paused.outcome.unstopped).toEqual([]);
    } finally {
      if (hostPid !== null) {
        try {
          process.kill(-hostPid, "SIGKILL");
        } catch {
          // The fake host already exited.
        }
      }
      await hostRun?.catch(() => undefined);
      manager.close();
      if (previousHiveHome === undefined) delete Bun.env.HIVE_HOME;
      else Bun.env.HIVE_HOME = previousHiveHome;
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validatePauseCapture fails on PID reuse (birth mismatch)", async () => {
    const { capturePauseBoundTree, validatePauseCapture, buildPauseCapture } =
      await import("./teardown");
    const { dependencies, alive } = pauseWorld([
      { pid: 100, ppid: 1, command: "-zsh", birth: "birth-A" },
      { pid: 200, ppid: 100, command: "codex", birth: "birth-B" },
    ]);
    const tree = await capturePauseBoundTree([100], null, dependencies, 1);
    const agent = {
      id: "agent-maya",
      name: "maya",
      tmuxSession: "hive-maya",
      toolSessionId: "session-1",
    } as unknown as import("../schemas").AgentRecord;
    const capture = buildPauseCapture(agent, tree, null);
    // PID 200 reused by a different process
    alive.get(200)!.birth = "birth-REUSED";
    await expect(validatePauseCapture(agent, capture, dependencies))
      .rejects.toThrow(/reused/);
  });

  test("validatePauseCapture fails when a captured pid vanishes", async () => {
    const { capturePauseBoundTree, validatePauseCapture, buildPauseCapture } =
      await import("./teardown");
    const { dependencies, alive } = pauseWorld([
      { pid: 100, ppid: 1, command: "-zsh", birth: "birth-A" },
      { pid: 200, ppid: 100, command: "codex", birth: "birth-B" },
    ]);
    const tree = await capturePauseBoundTree([100], null, dependencies, 1);
    const agent = {
      id: "agent-maya",
      name: "maya",
      tmuxSession: "hive-maya",
      toolSessionId: "session-1",
    } as unknown as import("../schemas").AgentRecord;
    const capture = buildPauseCapture(agent, tree, null);
    alive.delete(200);
    await expect(validatePauseCapture(agent, capture, dependencies))
      .rejects.toThrow(/vanished/);
  });

  test("validatePauseCapture fails when toolSession was replaced", async () => {
    const { capturePauseBoundTree, validatePauseCapture, buildPauseCapture } =
      await import("./teardown");
    const { dependencies } = pauseWorld([
      { pid: 100, ppid: 1, command: "-zsh", birth: "birth-A" },
    ]);
    const tree = await capturePauseBoundTree([100], null, dependencies, 1);
    const agent = {
      id: "agent-maya",
      name: "maya",
      tmuxSession: "hive-maya",
      toolSessionId: "session-OLD",
    } as unknown as import("../schemas").AgentRecord;
    const capture = buildPauseCapture(agent, tree, null);
    await expect(validatePauseCapture(
      { ...agent, toolSessionId: "session-NEW" },
      capture,
      dependencies,
    )).rejects.toThrow(/toolSession/);
  });

  test("validatePauseCapture fails when host is missing from live processes", async () => {
    const { capturePauseBoundTree, validatePauseCapture, buildPauseCapture } =
      await import("./teardown");
    const { dependencies, alive } = pauseWorld([
      { pid: 100, ppid: 1, command: "-zsh", birth: "birth-A" },
      { pid: 900, ppid: 1, command: "codex app-server", birth: "birth-HOST" },
    ]);
    const tree = await capturePauseBoundTree([100], 900, dependencies, 1);
    const agent = {
      id: "agent-maya",
      name: "maya",
      tmuxSession: "hive-maya",
      toolSessionId: "session-1",
    } as unknown as import("../schemas").AgentRecord;
    const capture = buildPauseCapture(agent, tree, 900);
    alive.delete(900);
    await expect(validatePauseCapture(agent, capture, dependencies))
      .rejects.toThrow(/vanished/);
  });

  test("resumePauseCapture SIGCONTs the exact persisted pids, never invents new ones", async () => {
    const { capturePauseBoundTree, resumePauseCapture, buildPauseCapture } =
      await import("./teardown");
    const { dependencies, signals, alive } = pauseWorld([
      { pid: 100, ppid: 1, command: "-zsh", birth: "birth-A", stat: "T" },
      { pid: 200, ppid: 100, command: "codex", birth: "birth-B", stat: "T" },
      { pid: 999, ppid: 1, command: "impostor", birth: "birth-X", stat: "T" },
    ]);
    const tree = await capturePauseBoundTree([100], null, dependencies, 1);
    // Impostor is not in capture; resume must not CONT it.
    await resumePauseCapture(
      buildPauseCapture({
        id: "a",
        name: "maya",
        tmuxSession: "hive-maya",
        toolSessionId: null,
      } as unknown as import("../schemas").AgentRecord, tree, null),
      dependencies,
      1,
    );
    const contPids = signals.filter((s) => s.signal === "SIGCONT").map((s) => s.pid).sort();
    expect(contPids).toEqual([100, 200]);
    expect(alive.get(999)?.stat).toBe("T");
  });

  test("empty roots without host refuse capture", async () => {
    const { capturePauseBoundTree } = await import("./teardown");
    const { dependencies } = pauseWorld([]);
    await expect(capturePauseBoundTree([], null, dependencies, 1))
      .rejects.toThrow(/no tmux roots and no app-server host/);
  });
});

describe("SIGCONT fail-closed re-freeze", () => {
  test("partial SIGCONT physically verifies already-continued pids re-stopped", async () => {
    const signals: Array<{ pid: number; signal: string }> = [];
    const states = new Map([[100, "T"], [200, "T"]]);
    const deps = {
      ps: async () => "100 1 1024 a\n200 1 1024 b\n",
      psState: async () =>
        `1 0 S\n100 1 ${states.get(100)}\n200 1 ${states.get(200)}\n`,
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push({ pid, signal });
        if (pid === 200 && signal === "SIGCONT") {
          throw new Error("ESRCH");
        }
        states.set(pid, signal === "SIGSTOP" ? "T" : "S");
      },
      wait: async () => undefined,
    };
    let failure: unknown;
    try {
      await resumeCapturedTree(
        [{ pid: 100, command: "a" }, { pid: 200, command: "b" }],
        deps,
        1,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ResumeRollbackError);
    expect((failure as ResumeRollbackError).rollbackVerified).toBe(true);
    expect((failure as Error).message).toMatch(/SIGCONT failed/);
    expect(signals.filter((s) => s.signal === "SIGSTOP").map((s) => s.pid))
      .toContain(100);
    expect(states.get(100)).toBe("T");
  });

  test("still-T readback re-SIGSTOPs the tree", async () => {
    const { resumeCapturedTree } = await import("./teardown");
    const signals: Array<{ pid: number; signal: string }> = [];
    const deps = {
      ps: async () => "100 1 1024 a\n",
      psState: async () => "1 0 S\n100 1 T\n",
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push({ pid, signal });
      },
      wait: async () => undefined,
    };
    let failure: unknown;
    try {
      await resumeCapturedTree([{ pid: 100, command: "a" }], deps, 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ResumeRollbackError);
    expect((failure as ResumeRollbackError).rollbackVerified).toBe(true);
    expect((failure as Error).message).toMatch(/still stopped/);
    expect(signals.some((s) => s.pid === 100 && s.signal === "SIGSTOP")).toBe(true);
  });

  test("failed rollback reports unverified when readback still sees code running", async () => {
    const deps = {
      ps: async () => "100 1 1024 a\n200 1 1024 b\n",
      psState: async () => "1 0 S\n100 1 S\n200 1 T\n",
      kill: (pid: number, signal: NodeJS.Signals) => {
        if (pid === 200 && signal === "SIGCONT") throw new Error("ESRCH");
        if (pid === 100 && signal === "SIGSTOP") throw new Error("EPERM");
      },
      wait: async () => undefined,
    };
    let failure: unknown;
    try {
      await resumeCapturedTree(
        [{ pid: 100, command: "a" }, { pid: 200, command: "b" }],
        deps,
        1,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ResumeRollbackError);
    expect((failure as ResumeRollbackError).rollbackVerified).toBe(false);
    expect((failure as Error).message).toMatch(/may still be running/);
  });
});

describe("pause capture host descendants", () => {
  test("captures descendants under the app-server host root", async () => {
    const { capturePauseBoundTree } = await import("./teardown");
    const deps = {
      ps: async () =>
        [
          "100 1 1024 -zsh",
          "200 100 1024 codex",
          "900 1 1024 codex app-server",
          "901 900 1024 host-child",
        ].join("\n"),
      psState: async () => "1 0 S\n",
      psBirth: async () =>
        ["100 b1", "200 b2", "900 b9", "901 b91"].join("\n"),
      kill: () => undefined,
      wait: async () => undefined,
    };
    const tree = await capturePauseBoundTree([100], 900, deps, 1);
    expect(tree.map((e) => e.pid).sort()).toEqual([100, 200, 900, 901]);
    expect(tree.find((e) => e.pid === 900)?.role).toBe("app-server-host");
    expect(tree.find((e) => e.pid === 901)?.role).toBe("descendant");
  });
});
