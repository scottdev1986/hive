import { formatRoundedSeconds } from "../../shared/duration";
import { pollUntil } from "../../shared/poll-until";

export const POLL_MS = 1_000;

export const QUIET_LIMIT = 12;

/** Pane changes required before a redrawing screen counts as proof of life. One change is not enough to return early: a TUI paints itself once at startup. Three separate changes cannot come from a single repaint — they mean something is still running an event loop. At 1 Hz this costs about three seconds. What three changes cannot tell you is *whose* event loop. See `launchedProcessAlive` — the screen is not the agent. */
export const HEARTBEAT_MIN = 3;

/** Pane text that means the launch itself failed — never a slow start. */
export const LAUNCH_FAILURE_PATTERNS = [
  /^(Error|error):/m,
  /^\[hive\] process exited with status \d+$/m,
  /command not found/,
  /not supported/i,
  /not found\.?$/m,
];

export interface ProofOfLifeDeps<Target = string> {
  readonly hasSession: (session: Target) => Promise<boolean>;
  readonly capturePane: (session: Target) => Promise<string>;
  /** The newest protocol status event this agent has produced, as the event store's monotonic sequence, re-read live on every poll. Null until it has produced one. Not the agent row's clock. Launch admission, `preserveStuck`, a failed spawn and a capability revocation all stamp that clock, so a launch this daemon was in the middle of giving up on would answer "something moved" and be credited with a lifecycle event it never emitted. */
  readonly newestEventSeq: () => string | null;
  /** A codex agent's rollout mtime, or null when there is none to read (a non-codex agent, no worktree, or an unreadable artifact). Still a positive signal — it just cannot be the *only* one, since it stays silent through the entire reasoning phase. */
  readonly codexActivity: () => Promise<string | null>;
  /** Is the process hive actually launched still running inside this pane? True/false when we can read the pane's process tree; null when we cannot (no pane, unreadable `ps`) — unknown, and unknown never counts as life. A pane redraw proves only that some process is moving. The pane root is a wrapper shell, and `pane_current_command` therefore cannot distinguish the provider from its wrapper. Search the process tree for the launched command instead of hardcoding provider names, which launch-time setup may wrap. */
  readonly launchedProcessAlive: () => Promise<boolean | null>;
  readonly launchedCommand: string;
  readonly wait: (ms: number) => Promise<void>;
  readonly settled?: () => boolean;
  readonly pollMs?: number;
  readonly quietLimit?: number;
  readonly heartbeatMin?: number;
  /** Pane text that means this launch failed. Defaults to `LAUNCH_FAILURE_PATTERNS`. The resume path adds its own — a resume can fail in a way a spawn cannot ("No conversation found"), and without the pattern that death is still caught, but only by outliving the quiet limit and only reported as silence. The distinct reason is worth keeping. */
  readonly failurePatterns?: readonly RegExp[];
}

export type ProofOfLife =
  { alive: true; signal: string } | { alive: false; reason: string };

function tailLines(value: string, count: number): string {
  const trimmed = value.trimEnd();
  if (trimmed.length === 0) return "";
  return trimmed.split(/\r?\n/).slice(-count).join("\n").trim();
}

/** Distinguishes a readable screen that stayed still from one that could not be sampled. Reporting "screen never redrew" when capture failed claims an observation that never happened. */
export function quietReason(
  quietMs: number,
  paneTail: string,
  paneReadable = true,
): string {
  const base =
    `no sign of life for ${formatRoundedSeconds(quietMs)} ` +
    (paneReadable
      ? "(screen never redrew, no hook event, no tool activity)"
      : "(screen was never readable, no hook event, no tool activity)");
  return paneTail === "" ? base : `${base}; last pane output:\n${paneTail}`;
}

export function orphanedPaneReason(command: string, paneTail: string): string {
  const base =
    `the pane is redrawing but no \`${command}\` process is ` +
    "running in it: the launch died behind a live wrapper";
  return paneTail === "" ? base : `${base}; last pane output:\n${paneTail}`;
}

/** Which layer produced a failed launch — and therefore what it is evidence of. A launch crosses two layers. The transport is this machine: the terminal host, the shell, the filesystem, the binary on disk. The model is the far side. Only the far side can say anything about a route, and Hive acts on what it says by quarantining that route for up to an hour (see QuotaService.launchCooldown). Recording a transport failure there benches a model that was never contacted. One over-long brief took Opus out of rotation for half an hour and silently downgraded every spawn that followed — the guard became the outage. The router (phases 1-6) will route on this same signal, so transport noise mixed into it corrupts the router's input, not just today's spawn. Named for the quarantine it feeds: the session-protocol wire type `LaunchFailureLayer` is a different domain (exec-failure surface) and keeps its name. */
export type QuarantineLaunchLayer = "transport" | "model";

/** What a shell prints when it cannot execute the provider binary at all: the pane died before the CLI ever ran, so the model was never contacted. */
const EXEC_FAILURE =
  /command not found|no such file or directory|permission denied|cannot execute|exec format error/i;

/** Classify a launch that started but never proved life. Reaching readiness means the terminal host carried the command and the shell ran it, so a failure here is normally the model's own: the CLI came up and refused, or it never answered. That is the true positive this quarantine exists for, and it must survive. The exception is a binary that could not be executed — a missing or unrunnable `claude`/`codex` — which surfaces here only as pane stderr, and is a fault of this machine rather than of the route. */
export function readinessFailureLayer(reason: string): QuarantineLaunchLayer {
  return EXEC_FAILURE.test(reason) ? "transport" : "model";
}

/** Poll a launched agent until activity proves it is alive, or until the quiet limit makes us consult process existence directly. There is deliberately no wall-clock deadline. No fixed number can be right: reasoning time is unbounded, and a model that thinks for five minutes is not a dead one. Silence ends the observation window; a positive process check proves that a quiet vendor is still alive. This returns as soon as it has an answer, so it does not hold `spawn()` open for the length of a turn — a working agent starts redrawing within a second or two, and that is all the proof required. */
export async function watchForProofOfLife<Target = string>(
  session: Target,
  baselineEventSeq: string | null,
  deps: ProofOfLifeDeps<Target>,
): Promise<ProofOfLife> {
  const pollMs = deps.pollMs ?? POLL_MS;
  const quietLimit = deps.quietLimit ?? QUIET_LIMIT;
  const heartbeatMin = deps.heartbeatMin ?? HEARTBEAT_MIN;
  const failurePatterns = deps.failurePatterns ?? LAUNCH_FAILURE_PATTERNS;

  const startedAt = new Date().toISOString();

  let previousPane: string | null = null;
  let heartbeats = 0;
  let quiet = 0;
  let lastPaneTail = "";
  // Did the screen ever answer at all? Distinguishes a pane we watched stay still from a pane we could never read.
  let paneReadable = false;
  // A transiently unreadable process tree must not erase the last conclusive observation. A later explicit false still replaces an earlier true.
  let lastKnownLaunchedProcessAlive: boolean | null = null;
  // Count redraws that cannot be credited because the expected agent is absent. This lets the death be reported as the thing it actually was: not a silent pane, a busy one with nobody behind it.
  let orphanedRedraws = 0;

  for (;;) {
    await deps.wait(pollMs);

    // Positive signals first, cheapest first. A launch that has already proved itself is not interrogated further — we do not ask the host about an agent we can already see working.
    if (deps.settled?.() === true) {
      return { alive: true, signal: "agent reported ready" };
    }

    const seq = deps.newestEventSeq();
    if (
      seq !== null &&
      (baselineEventSeq === null || BigInt(seq) > BigInt(baselineEventSeq))
    ) {
      return { alive: true, signal: "lifecycle event" };
    }

    // This signal stays silent during reasoning, so it cannot stand alone.
    const activity = await deps.codexActivity().catch(() => null);
    if (activity !== null && activity > startedAt) {
      return { alive: true, signal: "tool activity" };
    }

    if (!(await deps.hasSession(session))) {
      return { alive: false, reason: "terminal session exited" };
    }

    const launched = await deps.launchedProcessAlive().catch(() => null);
    if (launched !== null) lastKnownLaunchedProcessAlive = launched;

    let paneChanged = false;
    try {
      const pane = await deps.capturePane(session);
      paneReadable = true;
      lastPaneTail = tailLines(pane, 15);

      if (failurePatterns.some((p) => p.test(tailLines(pane, 5)))) {
        return { alive: false, reason: lastPaneTail || "Agent launch error" };
      }

      paneChanged = previousPane !== null && pane !== previousPane;
      previousPane = pane;
    } catch {
      if (!(await deps.hasSession(session))) {
        return { alive: false, reason: "terminal session exited" };
      }
    }

    // A redraw is a heartbeat only when the agent is the one with the pulse. `launched === true` is the whole predicate: the binary hive put in this pane is still running in it, so the screen it is painting is its own. A wrapper's animation over a dead child fails here, which is the point; so does `null`, because a process tree we could not read is not evidence of life and unknown is never the flattering answer.
    if (paneChanged) {
      if (launched === true) {
        heartbeats += 1;
        quiet = 0;
        if (heartbeats >= heartbeatMin) {
          return {
            alive: true,
            signal: `screen redrawing (${deps.launchedCommand} running in pane)`,
          };
        }
        continue;
      }
      if (launched === false) orphanedRedraws += 1;
    }

    // Silence is no activity evidence, not death evidence. Once the observation window ends below, the last conclusive launched-process check distinguishes a live prompt wait from an absent or never-measurable launch.
    quiet += 1;
    if (quiet >= quietLimit) {
      // A static pane is normal while a live vendor waits at an interactive prompt. Silence can end the observation window, but it cannot prove death when the process hive launched was proven present and the final sample was only transiently unreadable.
      if (lastKnownLaunchedProcessAlive === true) {
        return {
          alive: true,
          signal: `${deps.launchedCommand} process running in pane`,
        };
      }
      return {
        alive: false,
        reason:
          orphanedRedraws > 0
            ? orphanedPaneReason(deps.launchedCommand, lastPaneTail)
            : quietReason(quietLimit * pollMs, lastPaneTail, paneReadable),
      };
    }
  }
}

/** Can this launch report, or is it alive and permanently mute? Proof of life is not proof of reporting: a pane redraws and a process holds the tree whether or not the agent's hive MCP client ever connected — and an agent without that channel cannot publish mail, poll it, or hive_land no matter how healthy it looks. The one truthful signal is the vendor MCP client's own handshake: every supported vendor initializes its MCP servers at session start, and the daemon's /mcp endpoint authenticates each request with the agent's own credential. An authenticated request from the agent's subject therefore proves the whole chain at once — the right port, the right config, a credential that works — measured on the receiving side, never inferred from the agent looking alive. Inherited (user) MCP servers are the opposite tolerance: their failure changes nothing here. */
/** Vendor MCP initialization competes with every simultaneous launch, so the timeout must allow for a fully loaded machine rather than an idle startup. */
export const MCP_REPORTING_TIMEOUT_MS = 90_000;

/** Wait, bounded, for the agent's credential to be seen on the daemon's MCP surface at or after `since` (the launch baseline, so a dead predecessor's handshake never counts). Returns null when reporting is proven, or the named failure — "hive MCP unreachable" — which the launch path only warns about: readiness has already proved that process alive, so a missed control channel is not a death and refusing one killed live agents. The launch does not wait for this answer either; it runs last and unawaited, and the standing observation a caller acts on is `credentialReporting` in hive_status. The timeout is a parameter so tests can collapse it, and bounds only how long this watch itself runs. */
export async function waitForMcpReporting(
  subject: string,
  since: string,
  seen: (subject: string, since: string) => boolean,
  wait: (ms: number) => Promise<void>,
  timeoutMs = MCP_REPORTING_TIMEOUT_MS,
): Promise<string | null> {
  const reported = await pollUntil(() => seen(subject, since), {
    intervalMs: 200,
    timeoutMs,
    sleep: wait,
  });
  return reported
    ? null
    : `hive MCP unreachable: no authenticated request from ${JSON.stringify(
        subject,
      )}'s credential within ${formatRoundedSeconds(timeoutMs)} of launch`;
}
