/** What to do about the daemon that is already running when the binary changes. Replacing a file is easy. Replacing the control plane while agents are writing, approvals are pending, and landing authority is live is not. The handshake already *detects* the problem: a daemon started from the old binary presents the old content-addressed build hash, and `probeDaemonReuse` refuses to adopt it. Detection without a restart path is a dead end, though — the user is left with a new `hive` that will not talk to the daemon it just updated past. This module is that path. Three distinctions do all the work, and conflating any two of them is a bug: stale — same project, different build. Ours to restart. foreign — a different project's daemon on our port. Never ours to kill. busy — stale, but a team is live. Ours to leave alone until quiescence. `handshakeMismatch` reports only the first field that differs, in a fixed order that puts product version ahead of project identity. Trusting that reason string alone would let a version bump masquerade as permission to kill another project's daemon, so identity is compared here, first, explicitly. */
import { readFileSync } from "node:fs";
import { isErrnoCode } from "../shared/error-message";
import {
  cleanupLifecycleFiles,
  type DaemonHandshake,
  getPidFilePath,
  handshakeMismatch,
  probeHandshake,
  readDaemonPort,
} from "../daemon/lifecycle/daemon-lifecycle";
import { isDaemonPort } from "../shared/daemon-port";

const HANDSHAKE_TIMEOUT_MS = 500;

export type DaemonUpdateState =
  | { state: "absent" }
  | { state: "current"; port: number }
  | { state: "stale"; port: number; pid: number | null; reason: string }
  /** Port is occupied; nothing there answered as Hive. Do not kill, do not claim it is gone. */
  | { state: "unknown"; port: number; reason: string }
  /** Ours, wrong build, team live. Stage only; never interrupt. */
  | {
      state: "busy";
      port: number;
      reason: string;
      liveAgents: readonly string[];
    }
  /** Someone else's. Refuse, loudly, and touch nothing. */
  | { state: "foreign"; port: number; reason: string };

export function readDaemonPid(): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(getPidFilePath(), "utf8").trim(),
      10,
    );
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface InspectDeps {
  readonly expected: DaemonHandshake | (() => Promise<DaemonHandshake>);
  readonly liveAgents: (port: number) => Promise<readonly string[]>;
  readonly port?: number | null;
  readonly fetcher?: typeof fetch;
  readonly pid?: () => number | null;
}

async function readHandshake(
  port: number,
  fetcher: typeof fetch,
): Promise<DaemonHandshake | null> {
  return probeHandshake(port, { timeoutMs: HANDSHAKE_TIMEOUT_MS, fetcher });
}

/** `/handshake` is the daemon's public, non-authorizing identity route, exactly like `/health`. Reading it needs no capability, so the update flow adds no new authenticated surface: quiescence is read through the existing, capability-checked `hive_status` tool via the `liveAgents` dependency. */
export async function inspectDaemonForUpdate(
  deps: InspectDeps,
): Promise<DaemonUpdateState> {
  const port = deps.port === undefined ? readDaemonPort() : deps.port;
  if (port === null || !isDaemonPort(port)) return { state: "absent" };

  const actual = await readHandshake(port, deps.fetcher ?? fetch);
  if (actual === null) {
    return { state: "unknown", port, reason: "no Hive handshake" };
  }
  const provided = deps.expected;
  const expected = provided instanceof Function ? await provided() : provided;

  // Identity before everything. A daemon serving another project or instance is never ours to stop.
  if (actual.hiveUuid !== expected.hiveUuid) {
    return { state: "foreign", port, reason: "project identity (HiveUUID)" };
  }
  if (actual.identityKey !== expected.identityKey) {
    return { state: "foreign", port, reason: "project identity key" };
  }
  if (actual.instanceId !== expected.instanceId) {
    return { state: "foreign", port, reason: "instance identity" };
  }

  const reason = handshakeMismatch(expected, actual);
  if (reason === null) return { state: "current", port };

  const live = await deps.liveAgents(port).catch(() => {
    // If we cannot prove the team is idle, assume it is not. Refusing to activate costs a retry; guessing costs an agent mid-write.
    return ["<unknown>"] as const;
  });
  if (live.length > 0) {
    return { state: "busy", port, reason, liveAgents: live };
  }
  return { state: "stale", port, pid: (deps.pid ?? readDaemonPid)(), reason };
}

export interface RestartDeps {
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly cleanup?: (pid: number) => void;
  readonly isRunning?: (port: number) => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

export type RestartOutcome =
  { stopped: true; pid: number | null } | { stopped: false; reason: string };

const isNoSuchProcess = <T>(error: T): boolean => isErrnoCode(error, "ESRCH");

/** Stop a stale daemon so the next `hive` spawns the new binary. We stop rather than hot-swap on purpose. The daemon owns SQLite state, approvals, and landing authority; a clean SIGTERM lets it checkpoint and exit while nothing is in flight, which is only knowable because `inspectDaemonForUpdate` already proved the team is idle. Hot-swapping a live control plane is the alternative, and it buys nothing when there is by definition no work to preserve. */
export async function restartStaleDaemon(
  state: DaemonUpdateState,
  deps: RestartDeps = {},
): Promise<RestartOutcome> {
  if (state.state === "absent") return { stopped: true, pid: null };
  if (state.state === "current")
    return { stopped: false, reason: "daemon is already current" };
  if (state.state === "unknown") {
    return {
      stopped: false,
      reason: `port ${state.port} did not identify as a Hive daemon`,
    };
  }
  if (state.state === "foreign") {
    return {
      stopped: false,
      reason: `refusing to stop another project's daemon on port ${state.port}`,
    };
  }
  if (state.state === "busy") {
    return {
      stopped: false,
      reason: `${state.liveAgents.length} agent(s) live (${state.liveAgents.join(", ")})`,
    };
  }

  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const cleanup = deps.cleanup ?? cleanupLifecycleFiles;
  if (state.pid === null) {
    return { stopped: false, reason: "no daemon pid was recorded" };
  }

  try {
    kill(state.pid, "SIGTERM");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }

  // Wait for the port to go quiet before reporting success; a caller that immediately re-runs `ensureStarted` would otherwise race the old listener and adopt it one last time.
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stillRunning = deps.isRunning;
  if (stillRunning !== undefined) {
    const deadline = (deps.timeoutMs ?? 5_000) / 50;
    for (let attempt = 0; attempt < deadline; attempt += 1) {
      if (!(await stillRunning(state.port))) break;
      await sleep(50);
    }
    if (await stillRunning(state.port)) {
      return {
        stopped: false,
        reason: `daemon on port ${state.port} did not exit`,
      };
    }
  }

  cleanup(state.pid);
  return { stopped: true, pid: state.pid };
}

/** Why the update flow will not act, and the one thing the user can do about it. Both cases name a command, and both have earned it. Hive will not kill a live team to activate a release, and it will not stop a daemon serving a different project — those are the user's calls, not ours. That is the test a command in a message has to pass: never ask for work Hive could have done itself, and when the user genuinely must decide, say it in one labelled `Fix:` line rather than burying it in prose. */
export function explainRefusal(state: DaemonUpdateState): string | null {
  switch (state.state) {
    case "busy":
      return (
        `${state.liveAgents.length} agent(s) still working (${state.liveAgents.join(", ")}); ` +
        "the running daemon and team are unaffected\n" +
        "Fix: run `hive stop`, then rerun `hive update`"
      );
    case "foreign":
      return (
        `port ${state.port} serves a different project (${state.reason})\n` +
        "Fix: stop that daemon, then update this project"
      );
    case "unknown":
      return (
        `port ${state.port} did not identify as a Hive daemon (${state.reason})\n` +
        "Fix: stop whatever is bound to that port, then retry"
      );
    default:
      return null;
  }
}
