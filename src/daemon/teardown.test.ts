import { describe, expect, test } from "bun:test";
import {
  captureProcessTree,
  reapCapturedTree,
  type ReapDependencies,
} from "./teardown";
import { parseProcessTable, runPs } from "./resources";

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
