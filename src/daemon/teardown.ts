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
import type { AgentRecord, CapturedProcess, PauseCapture } from "../schemas";
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

export interface SessionStopAdapter {
  hasSession: (session: string) => Promise<boolean>;
  listPanePids: (session: string) => Promise<number[]>;
  killSession: (
    session: string,
    options: { ignoreMissing: true },
  ) => Promise<void>;
}

export interface VerifiedStopDependencies {
  tmux: SessionStopAdapter;
  reap?: ReapDependencies;
  readHostPid?: (agent: AgentRecord) => Promise<number | null>;
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

export interface SuspendOutcome {
  /** Processes now halted — reported as `T` (stopped) or gone. Neither is
   * running anyone's code. */
  suspended: ReapedProcess[];
  /** Processes signalled that are STILL RUNNING. A non-empty list is a failed
   * suspend and must be surfaced: a paused agent that can still mutate is not
   * paused. */
  unstopped: ReapedProcess[];
}

/**
 * SIGSTOP a captured tree — a NON-DESTRUCTIVE halt that preserves the process,
 * its rollout/thread, and its tmux holder instead of killing them. This is the
 * mechanism a critical `pause` uses: capability is revoked first, then the tree
 * is frozen so a still-authorized-looking local shell cannot mutate, and a
 * later `resumeCapturedTree` (SIGCONT) brings the exact same process back.
 *
 * Leaves are signalled first, exactly as the reap does, so a supervisor cannot
 * notice a stopped child and act inside the window. Verification reads the same
 * state table the reap uses: a process reporting `T` is stopped; one that is
 * gone (`Z`/absent) is also not running code. Anything still running is an
 * unstopped survivor.
 */
export async function suspendCapturedTree(
  captured: CapturedTree,
  dependencies: ReapDependencies = defaultReapDependencies(),
  verificationPid: number = process.pid,
): Promise<SuspendOutcome> {
  if (captured.length === 0) return { suspended: [], unstopped: [] };

  for (const entry of [...captured].reverse()) {
    try {
      dependencies.kill(entry.pid, "SIGSTOP");
    } catch {
      // Gone between the capture and the signal — that is a safely halted tree.
    }
  }

  await dependencies.wait(REAP_SETTLE_MS);

  const states = parseStateTable(await dependencies.psState());
  if (!states.some((sample) => sample.pid === verificationPid)) {
    throw new Error(
      `Process-state verification did not contain verification pid ${verificationPid}`,
    );
  }
  const running = new Set(
    states
      .filter((sample) =>
        !sample.stat.startsWith("T") && !sample.stat.startsWith("Z")
      )
      .map((sample) => sample.pid),
  );
  const suspended: ReapedProcess[] = [];
  const unstopped: ReapedProcess[] = [];
  for (const entry of captured) {
    if (running.has(entry.pid)) unstopped.push(entry);
    else suspended.push(entry);
  }
  return { suspended, unstopped };
}

/** SIGCONT a captured tree, resuming the exact processes a suspend froze.
 * Parents are continued before children (the reverse of suspend) so a child
 * never resumes into a still-stopped parent. SIGCONT errors propagate, and
 * every captured PID must read back non-stopped before success. */
export async function resumeCapturedTree(
  captured: CapturedTree,
  dependencies: ReapDependencies = defaultReapDependencies(),
  verificationPid: number = process.pid,
): Promise<void> {
  if (captured.length === 0) {
    throw new Error("resume refused: empty process capture");
  }
  const continued: number[] = [];
  const failures: string[] = [];
  const reStop = () => {
    for (const pid of continued) {
      try {
        dependencies.kill(pid, "SIGSTOP");
      } catch {
        // best-effort re-freeze
      }
    }
  };
  for (const entry of captured) {
    try {
      dependencies.kill(entry.pid, "SIGCONT");
      continued.push(entry.pid);
    } catch (error) {
      failures.push(
        `SIGCONT pid ${entry.pid}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  if (failures.length > 0) {
    reStop();
    throw new Error(`SIGCONT failed: ${failures.join("; ")}`);
  }
  await dependencies.wait(REAP_SETTLE_MS);
  const states = parseStateTable(await dependencies.psState());
  if (!states.some((sample) => sample.pid === verificationPid)) {
    reStop();
    throw new Error(
      `Process-state verification did not contain verification pid ${verificationPid}`,
    );
  }
  const byPid = new Map(states.map((sample) => [sample.pid, sample]));
  for (const entry of captured) {
    const live = byPid.get(entry.pid);
    if (live === undefined) {
      reStop();
      throw new Error(
        `SIGCONT readback: pid ${entry.pid} vanished (not non-stopped)`,
      );
    }
    if (live.stat.startsWith("T")) {
      reStop();
      throw new Error(
        `SIGCONT readback: pid ${entry.pid} is still stopped (${live.stat})`,
      );
    }
    if (live.stat.startsWith("Z")) {
      reStop();
      throw new Error(
        `SIGCONT readback: pid ${entry.pid} is a zombie (${live.stat})`,
      );
    }
  }
}


/** `ps -axo pid=,lstart=` — stable process start identity for PID-reuse detection. */
export const runPsBirth: CommandOutput = async () => {
  const child = Bun.spawn(["ps", "-axo", "pid=,lstart="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return await new Response(child.stdout).text();
};

export function parseBirthTable(raw: string): Map<number, string> {
  const births = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*\S|\S)\s*$/.exec(line);
    if (match === null) continue;
    births.set(Number(match[1]), match[2]!.trim());
  }
  return births;
}

export interface PauseCaptureDependencies extends ReapDependencies {
  /** Optional override for process birth identity (`ps -o lstart=`). */
  psBirth?: CommandOutput;
}

/**
 * Capture a pause-time tree with stable birth identity for every process.
 * `rootPids` are tmux pane roots; `hostPid` is an optional Codex app-server host
 * (a daemon child unreachable from the pane). Empty roots with no host fail.
 */
export async function capturePauseBoundTree(
  rootPids: readonly number[],
  hostPid: number | null,
  dependencies: PauseCaptureDependencies = defaultReapDependencies(),
  selfPid: number = process.pid,
): Promise<CapturedProcess[]> {
  const roots = [...new Set(rootPids.filter((pid) =>
    Number.isSafeInteger(pid) && pid > 1 && pid !== selfPid
  ))];
  if (hostPid !== null) {
    if (!Number.isSafeInteger(hostPid) || hostPid <= 1 || hostPid === selfPid) {
      throw new Error(`Refusing pause capture for invalid host pid ${hostPid}`);
    }
  }
  if (roots.length === 0 && hostPid === null) {
    throw new Error("pause capture refused: no tmux roots and no app-server host");
  }
  const processes = parseProcessTable(await dependencies.ps());
  for (const pid of roots) {
    if (!processes.some((process) => process.pid === pid)) {
      throw new Error(`Process-tree probe did not contain root pid ${pid}`);
    }
  }
  if (hostPid !== null && !processes.some((process) => process.pid === hostPid)) {
    throw new Error(`Process-tree probe did not contain app-server host pid ${hostPid}`);
  }
  const birthRaw = await (dependencies.psBirth ?? runPsBirth)();
  const births = parseBirthTable(birthRaw);
  const rootSet = new Set(roots);
  const treeRoots = hostPid === null ? roots : [...roots, hostPid];
  const descendants = descendantsOf(processes, treeRoots);
  const seen = new Set<number>();
  const tree: CapturedProcess[] = [];
  for (const sample of descendants) {
    if (sample.pid <= 1 || sample.pid === selfPid) continue;
    if (seen.has(sample.pid)) continue;
    seen.add(sample.pid);
    const birth = births.get(sample.pid);
    if (birth === undefined || birth.length === 0) {
      throw new Error(`Process ${sample.pid} has no readable birth/start identity`);
    }
    let role: CapturedProcess["role"] = "descendant";
    if (hostPid !== null && sample.pid === hostPid) role = "app-server-host";
    else if (rootSet.has(sample.pid)) role = "tmux-root";
    tree.push({
      pid: sample.pid,
      command: sample.command,
      birth,
      role,
    });
  }
  if (hostPid !== null && !seen.has(hostPid)) {
    throw new Error(`App-server host pid ${hostPid} vanished during capture`);
  }
  if (tree.length === 0) {
    throw new Error("pause capture produced an empty process tree");
  }
  return tree;
}

/** Build a durable PauseCapture bound to this agent and its toolSession. */
export function buildPauseCapture(
  agent: AgentRecord,
  tree: CapturedProcess[],
  hostPid: number | null,
  capturedAt: string = new Date().toISOString(),
): PauseCapture {
  return {
    agentId: agent.id,
    agentName: agent.name,
    tmuxSession: agent.tmuxSession,
    toolSessionId: agent.toolSessionId ?? null,
    processIncarnation: agent.processIncarnation ?? 0,
    hostPid,
    tree,
    capturedAt,
  };
}

/**
 * Prove the paused process tree is still the exact same incarnation. Never
 * re-lists panes or invents PIDs — only validates the stored capture against
 * live birth identities. Failure means resume must stay paused/revoked.
 */
export interface PauseValidationDependencies extends PauseCaptureDependencies {
  tmux?: SessionStopAdapter;
  readHostPid?: (agent: AgentRecord) => Promise<number | null>;
}

export async function validatePauseCapture(
  agent: AgentRecord,
  capture: PauseCapture,
  dependencies: PauseValidationDependencies = defaultReapDependencies(),
): Promise<void> {
  if (capture.agentId !== agent.id || capture.agentName !== agent.name) {
    throw new Error(
      `pause capture is bound to ${capture.agentName}/${capture.agentId}, not ${agent.name}/${agent.id}`,
    );
  }
  if (capture.tmuxSession !== agent.tmuxSession) {
    throw new Error(
      `pause capture tmux session ${capture.tmuxSession} does not match ${agent.tmuxSession}`,
    );
  }
  const currentTool = agent.toolSessionId ?? null;
  if (capture.toolSessionId !== currentTool) {
    throw new Error(
      `pause capture toolSession ${capture.toolSessionId ?? "null"} does not match ` +
        `current ${currentTool ?? "null"} (session replaced or cleared)`,
    );
  }
  if (capture.tree.length === 0) {
    throw new Error("pause capture tree is empty");
  }
  // Live tmux pane roots must exactly match the captured tmux-root set.
  if (dependencies.tmux !== undefined) {
    if (!await dependencies.tmux.hasSession(capture.tmuxSession)) {
      throw new Error(
        `pause capture tmux session ${capture.tmuxSession} is missing (recreated or destroyed)`,
      );
    }
    const livePanes = [...await dependencies.tmux.listPanePids(capture.tmuxSession)]
      .filter((pid) => pid > 1)
      .sort((a, b) => a - b);
    const capturedRoots = capture.tree
      .filter((entry) => entry.role === "tmux-root")
      .map((entry) => entry.pid)
      .sort((a, b) => a - b);
    if (
      livePanes.length !== capturedRoots.length ||
      livePanes.some((pid, i) => pid !== capturedRoots[i])
    ) {
      throw new Error(
        `pause capture tmux roots stale/replaced: captured [${capturedRoots.join(",")}] ` +
          `live [${livePanes.join(",")}]`,
      );
    }
  }
  // Current app-server host must match the capture (null↔null or same pid).
  if (dependencies.readHostPid !== undefined) {
    const liveHost = await dependencies.readHostPid(agent);
    if (liveHost !== capture.hostPid) {
      throw new Error(
        `pause capture host mismatch: captured ${capture.hostPid ?? "null"}, ` +
          `live ${liveHost ?? "null"}`,
      );
    }
  }
  const processes = parseProcessTable(await dependencies.ps());
  const byPid = new Map(processes.map((sample) => [sample.pid, sample]));
  const birthRaw = await (dependencies.psBirth ?? runPsBirth)();
  const births = parseBirthTable(birthRaw);
  for (const entry of capture.tree) {
    const live = byPid.get(entry.pid);
    if (live === undefined) {
      throw new Error(
        `pause capture pid ${entry.pid} (${entry.role}) has vanished`,
      );
    }
    const birth = births.get(entry.pid);
    if (birth === undefined || birth.length === 0) {
      throw new Error(
        `pause capture pid ${entry.pid} has no readable birth identity now`,
      );
    }
    if (birth !== entry.birth) {
      throw new Error(
        `pause capture pid ${entry.pid} was reused: captured birth ${JSON.stringify(entry.birth)}, ` +
          `live birth ${JSON.stringify(birth)}`,
      );
    }
    if (live.command !== entry.command) {
      throw new Error(
        `pause capture pid ${entry.pid} command changed: captured ${JSON.stringify(entry.command)}, ` +
          `live ${JSON.stringify(live.command)}`,
      );
    }
  }
  if (capture.hostPid !== null) {
    const host = capture.tree.find((entry) =>
      entry.pid === capture.hostPid && entry.role === "app-server-host"
    );
    if (host === undefined) {
      throw new Error(
        `pause capture claims host pid ${capture.hostPid} but tree has no app-server-host entry`,
      );
    }
  }
}

/** SIGCONT the exact pause capture after validation. Never recaptures. */
export async function resumePauseCapture(
  capture: PauseCapture,
  dependencies: ReapDependencies = defaultReapDependencies(),
  verificationPid: number = process.pid,
): Promise<void> {
  await resumeCapturedTree(
    capture.tree.map((entry) => ({ pid: entry.pid, command: entry.command })),
    dependencies,
    verificationPid,
  );
}

/** Capture + SIGSTOP a full pause-bound tree (tmux roots + optional host). */
export async function suspendAgentForPause(
  agent: AgentRecord,
  dependencies: VerifiedStopDependencies & { requireAppServerHost?: boolean },
): Promise<{ capture: PauseCapture; outcome: SuspendOutcome }> {
  const reap: PauseCaptureDependencies = {
    ...(dependencies.reap ?? defaultReapDependencies()),
  };
  const selfPid = dependencies.selfPid ?? process.pid;
  const hostPid = await (dependencies.readHostPid ?? readCodexHostPid)(agent);
  if (dependencies.requireAppServerHost === true && hostPid === null) {
    throw new Error(
      `pause refused for ${agent.name}: app-server host pidfile missing while app-server is live`,
    );
  }
  const roots = await sessionRoots(agent.tmuxSession, dependencies.tmux);
  const tree = await capturePauseBoundTree(roots, hostPid, reap, selfPid);
  const capture = buildPauseCapture(agent, tree, hostPid);
  const outcome = await suspendCapturedTree(
    tree.map((entry) => ({ pid: entry.pid, command: entry.command })),
    reap,
    selfPid,
  );
  return { capture, outcome };
}

/** Validate the stored capture and SIGCONT it. Throws on any identity failure. */
export async function resumeAgentFromPauseCapture(
  agent: AgentRecord,
  capture: PauseCapture,
  dependencies: VerifiedStopDependencies,
): Promise<void> {
  const selfPid = dependencies.selfPid ?? process.pid;
  const reap: PauseValidationDependencies = {
    ...(dependencies.reap ?? defaultReapDependencies()),
    tmux: dependencies.tmux,
    readHostPid: dependencies.readHostPid ?? readCodexHostPid,
  };
  await validatePauseCapture(agent, capture, reap);
  await resumePauseCapture(capture, reap, selfPid);
}


/** Non-destructively suspend a live tmux session's whole process tree. The
 * session, panes, and pids are left intact for a later resume. */
export async function suspendTmuxSession(
  session: string,
  dependencies: VerifiedStopDependencies,
  extraRoots: readonly number[] = [],
): Promise<SuspendOutcome> {
  const reap = dependencies.reap ?? defaultReapDependencies();
  const selfPid = dependencies.selfPid ?? process.pid;
  const captured = await captureProcessTree(
    [...await sessionRoots(session, dependencies.tmux), ...extraRoots],
    reap,
    selfPid,
  );
  return suspendCapturedTree(captured, reap, selfPid);
}

/** Resume a previously-suspended tmux session's process tree. The tree is
 * re-captured from the surviving session (SIGSTOP does not remove the panes),
 * so this works after a daemon restart as long as the session still exists. */
export async function resumeTmuxSession(
  session: string,
  dependencies: VerifiedStopDependencies,
  extraRoots: readonly number[] = [],
): Promise<void> {
  const reap = dependencies.reap ?? defaultReapDependencies();
  const selfPid = dependencies.selfPid ?? process.pid;
  const captured = await captureProcessTree(
    [...await sessionRoots(session, dependencies.tmux), ...extraRoots],
    reap,
    selfPid,
  );
  await resumeCapturedTree(captured, reap);
}

export async function readCodexHostPid(agent: AgentRecord): Promise<number | null> {
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

async function sessionRoots(
  session: string,
  tmux: SessionStopAdapter,
): Promise<number[]> {
  if (!await tmux.hasSession(session)) return [];
  const roots = await tmux.listPanePids(session);
  if (roots.length === 0) {
    throw new Error(
      `Process-root probe returned no panes for live tmux session ${session}`,
    );
  }
  return roots;
}

export async function stopTmuxSession(
  session: string,
  dependencies: VerifiedStopDependencies,
  extraRoots: readonly number[] = [],
  beforeKill?: () => void | Promise<void>,
): Promise<ReapOutcome> {
  const reap = dependencies.reap ?? defaultReapDependencies();
  const selfPid = dependencies.selfPid ?? process.pid;
  const captured = await captureProcessTree(
    [...await sessionRoots(session, dependencies.tmux), ...extraRoots],
    reap,
    selfPid,
  );
  await beforeKill?.();

  let killError: unknown;
  try {
    await dependencies.tmux.killSession(session, { ignoreMissing: true });
  } catch (error) {
    killError = error;
  }

  let sessionError: unknown;
  try {
    if (await dependencies.tmux.hasSession(session)) {
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
  const hostPid = await (dependencies.readHostPid ?? readCodexHostPid)(agent);
  return await stopTmuxSession(
    agent.tmuxSession,
    dependencies,
    hostPid === null ? [] : [hostPid],
    beforeKill,
  );
}

export function verifiedAgentStop(
  tmux: SessionStopAdapter,
  reap?: ReapDependencies,
): StopAgentSession {
  return (agent) =>
    stopAgentSession(
      agent,
      { tmux, ...(reap === undefined ? {} : { reap }) },
    );
}
