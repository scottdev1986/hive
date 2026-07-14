/**
 * What to do about the daemon that is already running when the binary changes.
 *
 * Replacing a file is easy. Replacing the control plane while agents are
 * writing, approvals are pending, and landing authority is live is not. The
 * handshake already *detects* the problem: a daemon started from the old binary
 * presents the old content-addressed build hash, and `probeDaemonReuse` refuses
 * to adopt it. Detection without a restart path is a dead end, though — the
 * user is left with a new `hive` that will not talk to the daemon it just
 * updated past. This module is that path.
 *
 * Three distinctions do all the work, and conflating any two of them is a bug:
 *
 *   stale   — same project, different build. Ours to restart.
 *   foreign — a different project's daemon on our port. Never ours to kill.
 *   busy    — stale, but a team is live. Ours to leave alone until quiescence.
 *
 * `handshakeMismatch` reports only the first field that differs, in a fixed
 * order that puts product version ahead of project identity. Trusting that
 * reason string alone would let a version bump masquerade as permission to kill
 * another project's daemon, so identity is compared here, first, explicitly.
 */
import { readFileSync } from "node:fs";
import {
  cleanupLifecycleFiles,
  getPidFilePath,
  readDaemonPort,
} from "../daemon/lifecycle";
import {
  handshakeMismatch,
  parseDaemonHandshake,
  type DaemonHandshake,
} from "../daemon/handshake";

const HANDSHAKE_TIMEOUT_MS = 500;

export type DaemonUpdateState =
  /** Nothing running. Activation is unconditionally safe. */
  | { state: "absent" }
  /** Running our exact build. Nothing to do. */
  | { state: "current"; port: number }
  /** Ours, wrong build, quiescent. Restart it. */
  | { state: "stale"; port: number; pid: number | null; reason: string }
  /** Ours, wrong build, team live. Stage only; never interrupt. */
  | { state: "busy"; port: number; reason: string; liveAgents: readonly string[] }
  /** Someone else's. Refuse, loudly, and touch nothing. */
  | { state: "foreign"; port: number; reason: string };

export function readDaemonPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(getPidFilePath(), "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export interface InspectDeps {
  /** Resolve project identity only after proving a Hive daemon is present. */
  readonly expected: DaemonHandshake | (() => Promise<DaemonHandshake>);
  /** Names of agents that are alive; a live team defers activation. */
  readonly liveAgents: (port: number) => Promise<readonly string[]>;
  readonly port?: number | null;
  readonly fetcher?: typeof fetch;
  readonly pid?: () => number | null;
}

async function readHandshake(
  port: number,
  fetcher: typeof fetch,
): Promise<DaemonHandshake | null> {
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/handshake`, {
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    return response.ok ? parseDaemonHandshake(await response.json()) : null;
  } catch {
    return null;
  }
}

/**
 * `/handshake` is the daemon's public, non-authorizing identity route, exactly
 * like `/health`. Reading it needs no capability, so the update flow adds no
 * new authenticated surface: quiescence is read through the existing,
 * capability-checked `hive_status` tool via the `liveAgents` dependency.
 */
export async function inspectDaemonForUpdate(
  deps: InspectDeps,
): Promise<DaemonUpdateState> {
  const port = deps.port === undefined ? readDaemonPort() : deps.port;
  if (port === null || port <= 0 || port > 65_535) return { state: "absent" };

  const actual = await readHandshake(port, deps.fetcher ?? fetch);
  if (actual === null) {
    // Port file points at nothing that speaks Hive. Treat as absent rather
    // than kill a pid we cannot identify.
    return { state: "absent" };
  }
  const expected = typeof deps.expected === "function"
    ? await deps.expected()
    : deps.expected;

  // Identity before everything. A daemon serving another project is never ours
  // to stop, whatever else differs. Both keys are identity: `hiveUuid` names the
  // project, `identityKey` names the directory that resolved to it.
  if (actual.hiveUuid !== expected.hiveUuid) {
    return { state: "foreign", port, reason: "project identity (HiveUUID)" };
  }
  if (actual.identityKey !== expected.identityKey) {
    return { state: "foreign", port, reason: "project identity key" };
  }

  const reason = handshakeMismatch(expected, actual);
  if (reason === null) return { state: "current", port };

  const live = await deps.liveAgents(port).catch(() => {
    // If we cannot prove the team is idle, assume it is not. Refusing to
    // activate costs a retry; guessing costs an agent mid-write.
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
  | { stopped: true; pid: number | null }
  | { stopped: false; reason: string };

const isNoSuchProcess = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  (error as { code?: unknown }).code === "ESRCH";

/**
 * Stop a stale daemon so the next `hive init` spawns the new binary.
 *
 * We stop rather than hot-swap on purpose. The daemon owns SQLite state,
 * approvals, and landing authority; a clean SIGTERM lets it checkpoint and exit
 * while nothing is in flight, which is only knowable because `inspectDaemonForUpdate`
 * already proved the team is idle. Hot-swapping a live control plane is the
 * alternative, and it buys nothing when there is by definition no work to
 * preserve.
 */
export async function restartStaleDaemon(
  state: DaemonUpdateState,
  deps: RestartDeps = {},
): Promise<RestartOutcome> {
  if (state.state === "absent") return { stopped: true, pid: null };
  if (state.state === "current") return { stopped: false, reason: "daemon is already current" };
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
    cleanup(0);
    return { stopped: false, reason: "no daemon pid was recorded" };
  }

  try {
    kill(state.pid, "SIGTERM");
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }

  // Wait for the port to go quiet before reporting success; a caller that
  // immediately re-runs `ensureStarted` would otherwise race the old listener
  // and adopt it one last time.
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const stillRunning = deps.isRunning;
  if (stillRunning !== undefined) {
    const deadline = (deps.timeoutMs ?? 5_000) / 50;
    for (let attempt = 0; attempt < deadline; attempt += 1) {
      if (!(await stillRunning(state.port))) break;
      await sleep(50);
    }
    if (await stillRunning(state.port)) {
      return { stopped: false, reason: `daemon on port ${state.port} did not exit` };
    }
  }

  cleanup(state.pid);
  return { stopped: true, pid: state.pid };
}

/**
 * Why the update flow will not act, and the one thing the user can do about it.
 *
 * Both cases name a command, and both have earned it. Hive will not kill a live
 * team to activate a release, and it will not stop a daemon serving a different
 * project — those are the user's calls, not ours. That is the test a command in
 * a message has to pass: never ask for work Hive could have done itself, and
 * when the user genuinely must decide, say it in one labelled `Fix:` line
 * rather than burying it in prose.
 */
export function explainRefusal(state: DaemonUpdateState): string | null {
  switch (state.state) {
    case "busy":
      return `${state.liveAgents.length} agent(s) still working (${state.liveAgents.join(", ")}); ` +
        "the running daemon and team are unaffected\n" +
        "Fix: run `hive stop`, then rerun `hive update`";
    case "foreign":
      return `port ${state.port} serves a different project (${state.reason})\n` +
        "Fix: stop that daemon, then update this project";
    default:
      return null;
  }
}
