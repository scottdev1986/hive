/**
 * Killing an agent is killing its PROCESSES, not its tmux session.
 *
 * Teardown used to be one line — `tmux killSession` — and that is not a kill.
 * tmux tears down the pane and sends SIGHUP to the pane's process group, which
 * the well-behaved half of an agent's tree honours. Everything else survives:
 * the Codex app-server host (a child of the DAEMON, never of the pane, so no
 * pane signal can ever reach it), MCP stdio children the vendor CLI spawned,
 * and anything an agent backgrounded, `nohup`ed or `setsid`ed away from its
 * shell. Those processes hold model sessions open and cost real money, and the
 * only trace they leave is a pid nobody is looking at.
 *
 * So the kill walks the real tree from real roots and SIGKILLs it, and then it
 * LOOKS AGAIN. A signal delivered is an act; a process gone is a state, and
 * this repo has paid repeatedly for reading the first as the second. Whatever
 * is still standing after the second look is reported as a survivor rather
 * than rounded down to success.
 */
import {
  descendantsOf,
  parseProcessTable,
  parseStateTable,
  runPs,
  runPsState,
  type CommandOutput,
} from "./resources";

export interface ReapDependencies {
  /** `ps -axo pid=,ppid=,rss=,command=` — the tree, with commands for the report. */
  ps: CommandOutput;
  /** `ps -axo pid=,ppid=,stat=` — the verification pass, which must see zombies. */
  psState: CommandOutput;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  wait: (ms: number) => Promise<void>;
}

export interface ReapedProcess {
  pid: number;
  command: string;
}

export interface ReapOutcome {
  /** Processes that were signalled and are now gone. */
  killed: ReapedProcess[];
  /** Processes that were signalled and are STILL ALIVE. A non-empty list is a
   * failed kill and must be surfaced, never swallowed. */
  survivors: ReapedProcess[];
}

export const defaultReapDependencies = (): ReapDependencies => ({
  ps: runPs,
  psState: runPsState,
  kill: (pid, signal) => process.kill(pid, signal),
  wait: (ms) => Bun.sleep(ms),
});

/** How long the kernel gets to make a SIGKILL true before we look again. */
const REAP_SETTLE_MS = 250;

/**
 * SIGKILL every process reachable from `rootPids`, then verify.
 *
 * SIGKILL rather than SIGTERM because this path is only ever reached when the
 * user has already decided: the X and the app quit both mean "now", and a
 * vendor CLI that traps SIGTERM to flush a transcript would turn "immediate"
 * into "eventually". The graceful shutdown of an agent's *conversation* is the
 * database's job, and it has already happened by the time we get here.
 *
 * Deepest-first, so a supervisor cannot notice a dead child and respawn it
 * inside the window. `selfPid` is never killed: a bad root (an empty tmux
 * query, a recycled pid) must not let the daemon shoot itself.
 */
export async function reapProcessTree(
  rootPids: readonly number[],
  dependencies: ReapDependencies = defaultReapDependencies(),
  selfPid: number = process.pid,
): Promise<ReapOutcome> {
  const roots = rootPids.filter((pid) =>
    Number.isSafeInteger(pid) && pid > 1 && pid !== selfPid
  );
  if (roots.length === 0) return { killed: [], survivors: [] };

  const tree = descendantsOf(
    parseProcessTable(await dependencies.ps()),
    [...roots],
  ).filter((sample) => sample.pid > 1 && sample.pid !== selfPid);
  if (tree.length === 0) return { killed: [], survivors: [] };

  // descendantsOf returns breadth-first from the roots, so reversing it puts
  // the leaves first.
  for (const sample of [...tree].reverse()) {
    try {
      dependencies.kill(sample.pid, "SIGKILL");
    } catch {
      // Already gone between the sample and the signal. That is a success.
    }
  }

  await dependencies.wait(REAP_SETTLE_MS);

  // Look again. A zombie is an exit its parent has not reaped, so it counts as
  // dead — the process is not running anyone's code.
  const alive = new Set(
    parseStateTable(await dependencies.psState())
      .filter((sample) => !sample.stat.startsWith("Z"))
      .map((sample) => sample.pid),
  );
  const killed: ReapedProcess[] = [];
  const survivors: ReapedProcess[] = [];
  for (const sample of tree) {
    const entry = { pid: sample.pid, command: sample.command };
    if (alive.has(sample.pid)) survivors.push(entry);
    else killed.push(entry);
  }
  return { killed, survivors };
}
