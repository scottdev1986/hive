import { describe, expect, test } from "bun:test";
import { reapProcessTree, type ReapDependencies } from "./teardown";

/**
 * A fake process table. `ps` output is the only thing the reaper reads, so the
 * whole policy is testable without spawning anything — and the interesting
 * cases (a process that ignores SIGKILL, a zombie, the daemon appearing in its
 * own tree) cannot be produced on demand with real processes anyway.
 */
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
      [...alive.values()]
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

    const outcome = await reapProcessTree([100, 500], dependencies, 7);

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

  test("never signals the daemon itself, even if it appears in the tree", async () => {
    const { dependencies, signalled } = world([
      { pid: 7, ppid: 1, command: "hive daemon" },
      { pid: 100, ppid: 7, command: "-zsh" },
    ]);

    // pid 7 is the daemon and is handed in as a root by a bad tmux read.
    const outcome = await reapProcessTree([7], dependencies, 7);

    expect(signalled).not.toContain(7);
    expect(outcome.killed).toEqual([]);
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
