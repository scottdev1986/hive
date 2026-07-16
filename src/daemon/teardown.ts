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
import { readFile } from "node:fs/promises";
import { codexAgentHostPidfile } from "../adapters/tools/codex-app-server";
import type { AgentRecord } from "../schemas";
import {
  bindAgentSession,
  TmuxSessionHost,
  type TmuxEngine,
} from "./session-host/tmux-host";
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

/** A process tree sampled at a moment in time. Not a live query — the point of
 * this type is that it OUTLIVES the parent links it was derived from. */
export type CapturedTree = readonly ReapedProcess[];

export interface ReapOutcome {
  /** Processes that were signalled and are now gone. */
  killed: ReapedProcess[];
  /** Processes that were signalled and are STILL ALIVE. A non-empty list is a
   * failed kill and must be surfaced, never swallowed. */
  survivors: ReapedProcess[];
}

export interface VerifiedStopDependencies {
  sessions: TmuxSessionHost;
  reap?: ReapDependencies;
  readHostPid?: (agent: AgentRecord) => Promise<number | null>;
  sessionRoots?: (agent: AgentRecord) => Promise<readonly number[]>;
  legacySessionRoots?: (session: string) => Promise<readonly number[]>;
  selfPid?: number;
}

export type StopAgentSession = (
  agent: AgentRecord,
) => Promise<ReapOutcome>;

export const defaultReapDependencies = (): ReapDependencies => ({
  ps: runPs,
  psState: runPsState,
  kill: (pid, signal) => process.kill(pid, signal),
  wait: (ms) => Bun.sleep(ms),
});

/** How long the kernel gets to make a SIGKILL true before we look again. */
const REAP_SETTLE_MS = 250;

/**
 * Snapshot every process under `rootPids`. MUST be called BEFORE the tmux
 * session is torn down, and the reason is the whole bug.
 *
 * A detached child — anything an agent `nohup`ed or backgrounded, which SPEC
 * §12 says they do routinely — ignores the SIGHUP tmux sends when it kills the
 * pane, survives, and is REPARENTED TO INIT. Its ppid becomes 1. From that
 * moment it is not a descendant of the pane, of the agent, or of anything else
 * Hive can name: the parent links that made it findable are gone, and no
 * later `ps` walk can ever attribute it again.
 *
 * So the tree is captured while those links still exist, and the captured pid
 * list — not a live query — is what gets killed afterwards. This was measured,
 * not reasoned: an earlier version of this file captured only the ROOT pids
 * before the kill and walked the tree afterwards. It reported "1 process
 * reaped" and left the `nohup`ed child running with ppid 1, which is precisely
 * the leak the whole path exists to close. Every unit test passed, because a
 * fake process table does not reparent anything.
 */
export async function captureProcessTree(
  rootPids: readonly number[],
  dependencies: ReapDependencies = defaultReapDependencies(),
  selfPid: number = process.pid,
): Promise<CapturedTree> {
  if (rootPids.length === 0) return [];
  const roots = [...new Set(rootPids)];
  for (const pid of roots) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === selfPid) {
      throw new Error(`Refusing process-tree capture for invalid root pid ${pid}`);
    }
  }
  const processes = parseProcessTable(await dependencies.ps());
  for (const pid of roots) {
    if (!processes.some((process) => process.pid === pid)) {
      throw new Error(`Process-tree probe did not contain root pid ${pid}`);
    }
  }
  return descendantsOf(processes, roots)
    .filter((sample) => sample.pid > 1 && sample.pid !== selfPid)
    .map((sample) => ({ pid: sample.pid, command: sample.command }));
}

/**
 * SIGKILL a captured tree, then LOOK AGAIN.
 *
 * SIGKILL rather than SIGTERM because this path is only reached once the user
 * has already decided: the X and the app quit both mean "now", and a vendor CLI
 * that traps SIGTERM to flush a transcript would turn "immediate" into
 * "eventually". The graceful shutdown of an agent's *conversation* is the
 * database's job, and it has already happened by the time we get here.
 *
 * Deepest-last is irrelevant to SIGKILL, but leaves are signalled first anyway
 * so a supervisor cannot notice a dead child and respawn it inside the window.
 */
export async function reapCapturedTree(
  captured: CapturedTree,
  dependencies: ReapDependencies = defaultReapDependencies(),
  verificationPid: number = process.pid,
): Promise<ReapOutcome> {
  if (captured.length === 0) return { killed: [], survivors: [] };

  for (const entry of [...captured].reverse()) {
    try {
      dependencies.kill(entry.pid, "SIGKILL");
    } catch {
      // Already gone between the capture and the signal. That is a success.
    }
  }

  await dependencies.wait(REAP_SETTLE_MS);

  // A zombie is an exit its parent has not reaped, so it counts as dead — the
  // process is not running anyone's code.
  const states = parseStateTable(await dependencies.psState());
  if (!states.some((sample) => sample.pid === verificationPid)) {
    throw new Error(
      `Process-state verification did not contain verification pid ${verificationPid}`,
    );
  }
  const alive = new Set(
    states
      .filter((sample) => !sample.stat.startsWith("Z"))
      .map((sample) => sample.pid),
  );
  const killed: ReapedProcess[] = [];
  const survivors: ReapedProcess[] = [];
  for (const entry of captured) {
    if (alive.has(entry.pid)) survivors.push(entry);
    else killed.push(entry);
  }
  return { killed, survivors };
}

async function defaultHostPid(agent: AgentRecord): Promise<number | null> {
  const path = codexAgentHostPidfile(agent);
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!/^\d+$/.test(value)) {
      throw new Error(`Invalid Codex host pidfile for ${agent.name}: ${path}`);
    }
    return Number(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function stopTmuxSession(
  session: string,
  dependencies: VerifiedStopDependencies,
  extraRoots: readonly number[] = [],
  beforeKill?: () => void | Promise<void>,
): Promise<ReapOutcome> {
  const inspection = await dependencies.sessions.inspectLegacyTmuxSession(
    session,
  );
  if (inspection.presence === "unknown") {
    throw new Error(`tmux session ${session} presence is unknown`);
  }
  const reap = dependencies.reap ?? defaultReapDependencies();
  const selfPid = dependencies.selfPid ?? process.pid;
  const roots = inspection.presence === "present"
    ? await (dependencies.legacySessionRoots?.(session) ??
      Promise.resolve(inspection.panePids))
    : [];
  if (inspection.presence === "present" && roots.length === 0) {
    throw new Error(
      `Process-root probe returned no panes for live tmux session ${session}`,
    );
  }
  const captured = await captureProcessTree(
    [...roots, ...extraRoots],
    reap,
    selfPid,
  );
  await beforeKill?.();

  let killError: unknown;
  try {
    await dependencies.sessions.terminateLegacyTmuxSession(session);
  } catch (error) {
    killError = error;
  }

  let sessionError: unknown;
  try {
    const readback = await dependencies.sessions.inspectLegacyTmuxSession(
      session,
    );
    if (readback.presence === "unknown") {
      sessionError = new Error(`tmux session ${session} presence is unknown`);
    } else if (readback.presence === "present") {
      sessionError = killError ??
        new Error(`Tmux session ${session} survived kill-session`);
    }
  } catch (error) {
    sessionError = error;
  }

  let reaped: ReapOutcome;
  try {
    reaped = await reapCapturedTree(
      captured,
      reap,
      selfPid,
    );
  } catch (error) {
    if (sessionError === undefined) throw error;
    throw new Error(
      `Tmux and process readback both failed for ${session}: ${
        error instanceof Error ? error.message : "unknown process error"
      }`,
      { cause: sessionError },
    );
  }
  if (sessionError !== undefined) throw sessionError;
  return reaped;
}

export async function stopAgentSession(
  agent: AgentRecord,
  dependencies: VerifiedStopDependencies,
  beforeKill?: () => void | Promise<void>,
): Promise<ReapOutcome> {
  const hostPid = await (dependencies.readHostPid ?? defaultHostPid)(agent);
  const locator = bindAgentSession(dependencies.sessions, agent, {
    extraRoots: async () => {
      const inspection = await dependencies.sessions.inspect(locator);
      if (inspection.presence === "unknown") {
        throw new Error(`Session presence is unknown for ${agent.name}`);
      }
      return [
        ...(inspection.presence === "present"
          ? await dependencies.sessionRoots?.(agent) ?? []
          : []),
        ...(hostPid === null ? [] : [hostPid]),
      ];
    },
    ...(beforeKill === undefined ? {} : { beforeTerminate: beforeKill }),
  });
  const outcome = await dependencies.sessions.terminateWithProcessOutcome(locator, {
    mode: "immediate",
    reason: `stop agent ${agent.id}`,
    requestId: crypto.randomUUID(),
  });
  if (outcome.result.state === "unknown") {
    throw outcome.failure ?? new Error(
      `SessionHost could not verify termination for ${agent.name}: ${
        outcome.result.errors.map((error) => error.diagnosticId).join(", ") || "unknown"
      }`,
    );
  }
  return outcome.reaped;
}

export function verifiedAgentStop(
  tmux: TmuxEngine,
  reap?: ReapDependencies,
): StopAgentSession {
  const sessions = new TmuxSessionHost({ adapter: tmux, reap });
  return (agent) =>
    stopAgentSession(
      agent,
      { sessions, ...(reap === undefined ? {} : { reap }) },
    );
}
