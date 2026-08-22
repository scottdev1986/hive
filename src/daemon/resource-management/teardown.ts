import type { AgentRecord } from "../../schemas/agent";
import type { ProviderRun } from "../../schemas/provider-run";
import { HostOperationError } from "../session-host/host-operations";
import {
  type CommandOutput,
  descendantsOf,
  parseProcessTable,
  parseStateTable,
  runPs,
  runPsState,
} from "./resources";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  sessiondTeardownSucceeded,
} from "../session-host/hive-terminal-host";
import { mintSessionRequestId } from "../session-host/locators";
import { SessiondWireError } from "../session-host/sessiond-host";

export interface ReapDependencies {
  ps: CommandOutput;
  psState: CommandOutput;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  wait: (ms: number) => Promise<void>;
}

export interface ReapedProcess {
  pid: number;
  command: string;
}

export type CapturedTree = readonly ReapedProcess[];

export interface ReapOutcome {
  killed: ReapedProcess[];
  /** Processes that were signalled and are STILL ALIVE. A non-empty list is a failed kill and must be surfaced, never swallowed. */
  survivors: ReapedProcess[];
}

export interface VerifiedSessiondStopDependencies {
  terminalHost: Pick<HiveTerminalHostAdapter, "terminate"> &
    Partial<Pick<HiveTerminalHostAdapter, "stopProvider">>;
  reap?: ReapDependencies;
  readHostPid: (agent: AgentRecord) => Promise<number | null>;
  readProviderRun?: (agent: AgentRecord) => ProviderRun | null;
  selfPid?: number;
}

export type StopAgentSession = (agent: AgentRecord) => Promise<ReapOutcome>;

export const defaultReapDependencies = (): ReapDependencies => ({
  ps: runPs,
  psState: runPsState,
  kill: (pid, signal) => process.kill(pid, signal),
  wait: (ms) => Bun.sleep(ms),
});

const REAP_SETTLE_MS = 250;

/** Snapshot every process under `rootPids` before its parent links disappear. A detached child created with `nohup` or backgrounding can survive terminal teardown and be REPARENTED TO INIT. Its ppid becomes 1. From that moment it is not a descendant of the pane, of the agent, or of anything else Hive can name: the parent links that made it findable are gone, and no later `ps` walk can ever attribute it again. Capture the tree while those links still exist, then kill the captured pid list rather than walking live descendants after teardown. Do not defer the walk: reparenting makes detached children impossible to attribute, and fake process tables do not reproduce it. */
/** The root pid given to captureProcessTree is positively absent from the process table. Distinct from an invalid root (pid <= 1, self): there is no tree to capture, so teardown can succeed on the terminate readback alone. */
export class ProcessTreeRootAbsentError extends Error {}

export async function captureProcessTree(
  rootPids: readonly number[],
  dependencies: ReapDependencies = defaultReapDependencies(),
  selfPid: number = process.pid,
): Promise<CapturedTree> {
  if (rootPids.length === 0) return [];
  const roots = [...new Set(rootPids)];
  for (const pid of roots) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === selfPid) {
      throw new Error(
        `Refusing process-tree capture for invalid root pid ${pid}`,
      );
    }
  }
  const processes = parseProcessTable(await dependencies.ps());
  for (const pid of roots) {
    if (!processes.some((process) => process.pid === pid)) {
      throw new ProcessTreeRootAbsentError(
        `Process-tree probe did not contain root pid ${pid}`,
      );
    }
  }
  return descendantsOf(processes, roots)
    .filter((sample) => sample.pid > 1 && sample.pid !== selfPid)
    .map((sample) => ({ pid: sample.pid, command: sample.command }));
}

/** SIGKILL a captured tree, then LOOK AGAIN. SIGKILL rather than SIGTERM because this path is only reached once the user has already decided: the X and the app quit both mean "now", and a vendor CLI that traps SIGTERM to flush a transcript would turn "immediate" into "eventually". The graceful shutdown of an agent's *conversation* is the database's job, and it has already happened by the time we get here. Deepest-last is irrelevant to SIGKILL, but leaves are signalled first anyway so a supervisor cannot notice a dead child and respawn it inside the window. */
export async function reapCapturedTree(
  captured: CapturedTree,
  dependencies: ReapDependencies = defaultReapDependencies(),
  verificationPid: number = process.pid,
): Promise<ReapOutcome> {
  if (captured.length === 0) return { killed: [], survivors: [] };

  for (const entry of [...captured].reverse()) {
    try {
      dependencies.kill(entry.pid, "SIGKILL");
    } catch {}
  }

  await dependencies.wait(REAP_SETTLE_MS);

  // A zombie is an exit its parent has not reaped, so it counts as dead — the process is not running anyone's code.
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

export async function stopSessiondAgentSession(
  agent: AgentRecord,
  dependencies: VerifiedSessiondStopDependencies,
  beforeKill?: () => void | Promise<void>,
): Promise<ReapOutcome> {
  const reap = dependencies.reap ?? defaultReapDependencies();
  const selfPid = dependencies.selfPid ?? process.pid;
  let terminalError: Error | undefined;
  // The host pid is read from the host itself, so a host that cannot be reached fails here FIRST — before the terminate below ever runs. There is no pid to capture and nothing to terminate through, so the failure is carried down to the one place that decides what an unreachable host means.
  let hostPid: number | null = null;
  try {
    hostPid = await dependencies.readHostPid(agent);
  } catch (error) {
    if (!(error instanceof HostOperationError)) throw error;
    terminalError = error;
  }
  let rootAbsent = false;
  let captured: CapturedTree;
  try {
    captured = await captureProcessTree(
      hostPid === null ? [] : [hostPid],
      reap,
      selfPid,
    );
  } catch (error) {
    // An absent root is a positively dead tree, not an unknown one. The terminate readback below remains the verification leg for survivors.
    if (!(error instanceof ProcessTreeRootAbsentError)) throw error;
    rootAbsent = true;
    captured = [];
  }
  await beforeKill?.();

  let providerError: Error | undefined;
  const run = dependencies.readProviderRun?.(agent) ?? null;
  if (run?.state === "running") {
    if (run.adapterChild === null) {
      providerError = new Error(
        `Provider child identity was never reported for ${agent.name}`,
      );
    } else if (dependencies.terminalHost.stopProvider === undefined) {
      providerError = new Error(
        `Provider process-group teardown is unavailable for ${agent.name}`,
      );
    } else {
      try {
        if (
          !(await dependencies.terminalHost.stopProvider(
            requireSessiondAgentLocator(agent),
            run,
          ))
        ) {
          providerError = new Error(
            `Provider process group was not positively verified gone for ${agent.name}`,
          );
        }
      } catch (error) {
        providerError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (terminalError === undefined) {
    try {
      const result = await dependencies.terminalHost.terminate(
        requireSessiondAgentLocator(agent),
        {
          mode: "immediate",
          reason: `stop agent ${agent.id}`,
          requestId: mintSessionRequestId(),
        },
      );
      if (!sessiondTeardownSucceeded(result)) {
        terminalError = new Error(
          `Sessiond termination was not positively verified for ${agent.name}: ${
            result.errors.map((error) => error.diagnosticId).join(", ") ||
            result.state
          }`,
        );
      }
    } catch (error) {
      // The broker positively has no such session and the root pid is positively absent from the process table: two independent absences are a completed teardown, not an unverifiable one. NOT_FOUND against a root that is still in the process table stays a failure.
      if (!(
        rootAbsent &&
        error instanceof SessiondWireError &&
        error.code === "NOT_FOUND"
      )) {
        terminalError =
          error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  let reaped: ReapOutcome;
  try {
    reaped = await reapCapturedTree(captured, reap, selfPid);
  } catch (error) {
    if (terminalError === undefined) throw error;
    throw new Error(
      `Sessiond and process readback both failed for ${agent.name}: ${
        error instanceof Error ? error.message : "unknown process error"
      }`,
      { cause: terminalError },
    );
  }
  if (providerError !== undefined) throw providerError;
  // An unreachable host is not a failed teardown. The host OWNS its session, so one whose socket cannot be connected to at all is not holding a session open, and refusing shutdown here saves nothing — it only wedges the quit path that exists to stop orphaning work. That is the distinction: a host that ANSWERS and reports the session still standing is a failed teardown and still refuses; a host that never answers leaves the captured process tree as the only measurement of what is live. Survivors are live work, so they refuse exactly as before.
  if (
    terminalError instanceof HostOperationError &&
    reaped.survivors.length === 0
  ) {
    return reaped;
  }
  if (terminalError !== undefined) throw terminalError;
  return reaped;
}
