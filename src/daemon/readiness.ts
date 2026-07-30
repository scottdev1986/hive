/**
 * Determines whether a launch is alive without treating slow reasoning as
 * death. Codex rollout activity begins only when the model emits, so it cannot
 * prove life during reasoning. A redrawing screen can, but only while the
 * launched provider process is also present; a live wrapper can redraw after
 * its provider exits.
 *
 * Keep these states distinct:
 *
 *   reasoning     pane redraws ~1/s, agent running         ALIVE
 *   prompt wait   pane frozen, agent process running       ALIVE  (process signal)
 *   idle at rest  pane frozen, but the turn-end hook fired ALIVE  (event signal)
 *   dead          pane frozen, no agent process            DEAD   (fail loud)
 *   dead behind   pane redraws ~1/s, no agent process      DEAD
 *   a live wrapper
 *
 * The middle rows are why a frozen pane can never mean death on its own: a run
 * whose turn simply ended or is waiting for permission can remain pane-static.
 * Death requires an explicit failure, a vanished session, or failure to prove
 * that the launched process is still present.
 */

/** One second, matching the TUI redraw rate we are listening for. */
export const POLL_MS = 1_000;

/**
 * Consecutive output-silent polls before we fall back to process existence.
 *
 * A live agent can remain static at a prompt, so reaching this limit does not
 * mean death. It only ends output observation before a process check determines
 * whether the quiet provider is still running.
 */
export const QUIET_LIMIT = 12;

/**
 * Pane changes required before a redrawing screen counts as proof of life.
 *
 * One change is not enough to return early: a TUI paints itself once at startup.
 * Three separate changes cannot come from a single repaint — they mean something
 * is still running an event loop. At 1 Hz this costs about three seconds.
 *
 * What three changes cannot tell you is *whose* event loop. See
 * `launchedProcessAlive` — the screen is not the agent.
 */
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
  /** The agent row's `lastEventAt`, re-read live on every poll. */
  readonly lastEventAt: () => string | null;
  /**
   * A codex agent's rollout mtime, or null when there is none to read (a
   * non-codex agent, no worktree, or an unreadable artifact). Still a positive
   * signal — it just cannot be the *only* one, since it stays silent through
   * the entire reasoning phase.
   */
  readonly codexActivity: () => Promise<string | null>;
  /**
   * Is the process hive actually launched still running inside this pane?
   *
   * True/false when we can read the pane's process tree; null when we cannot
   * (no pane, unreadable `ps`) — unknown, and unknown never counts as life.
   *
   * A pane redraw proves only that some process is moving. The pane root is a
   * wrapper shell, and `pane_current_command` therefore cannot distinguish the
   * provider from its wrapper. Search the process tree for the launched command
   * instead of hardcoding provider names, which launch-time setup may wrap.
   */
  readonly launchedProcessAlive: () => Promise<boolean | null>;
  /** The command hive launched (`codex`, `claude`, etc.), for the record and
   * for the reason string an operator has to read. */
  readonly launchedCommand: string;
  readonly wait: (ms: number) => Promise<void>;
  /**
   * True once the agent row has left "spawning" — the daemon itself already
   * concluded the agent is up, which outranks anything we could infer from a
   * screen. Absent for the control-restart watch, which has no such row.
   */
  readonly settled?: () => boolean;
  readonly pollMs?: number;
  readonly quietLimit?: number;
  readonly heartbeatMin?: number;
  /**
   * Pane text that means this launch failed. Defaults to
   * `LAUNCH_FAILURE_PATTERNS`. The resume path adds its own — a resume can fail
   * in a way a spawn cannot ("No conversation found"), and without the pattern
   * that death is still caught, but only by outliving the quiet limit and only
   * reported as silence. The distinct reason is worth keeping.
   */
  readonly failurePatterns?: readonly RegExp[];
}

export type ProofOfLife =
  /** Something proved it is running. `signal` names which, for the record. */
  | { alive: true; signal: string }
  /** Nothing did, and here is why we are sure. */
  | { alive: false; reason: string };

function tailLines(value: string, count: number): string {
  const trimmed = value.trimEnd();
  if (trimmed.length === 0) return "";
  return trimmed.split(/\r?\n/).slice(-count).join("\n").trim();
}

/**
 * Distinguishes a readable screen that stayed still from one that could not be
 * sampled. Reporting "screen never redrew" when capture failed claims an
 * observation that never happened.
 */
export function quietReason(
  quietMs: number,
  paneTail: string,
  paneReadable = true,
): string {
  const base =
    `no sign of life for ${Math.round(quietMs / 1000)}s ` +
    (paneReadable
      ? "(screen never redrew, no hook event, no tool activity)"
      : "(screen was never readable, no hook event, no tool activity)");
  return paneTail === "" ? base : `${base}; last pane output:\n${paneTail}`;
}

/**
 * The death of an agent whose screen is busy and whose process is gone.
 *
 * It is a distinct reason from silence because it is a distinct death, and the
 * operator reading it needs to know which one happened: nothing was silent
 * here, the pane was redrawing the whole time. The agent simply was not the one
 * doing it.
 */
export function orphanedPaneReason(command: string, paneTail: string): string {
  const base =
    `the pane is redrawing but no \`${command}\` process is ` +
    "running in it: the launch died behind a live wrapper";
  return paneTail === "" ? base : `${base}; last pane output:\n${paneTail}`;
}

/**
 * Poll a launched agent until activity proves it is alive, or until the quiet
 * limit makes us consult process existence directly.
 *
 * There is deliberately no wall-clock deadline. No fixed number can be right:
 * reasoning time is unbounded, and a model that thinks for five minutes is not
 * a dead one. Silence ends the observation window; a positive process check
 * proves that a quiet vendor is still alive.
 *
 * This returns as soon as it has an answer, so it does not hold `spawn()` open
 * for the length of a turn — a working agent starts redrawing within a second
 * or two, and that is all the proof required.
 */
export async function watchForProofOfLife<Target = string>(
  session: Target,
  baselineEventAt: string,
  deps: ProofOfLifeDeps<Target>,
): Promise<ProofOfLife> {
  const pollMs = deps.pollMs ?? POLL_MS;
  const quietLimit = deps.quietLimit ?? QUIET_LIMIT;
  const heartbeatMin = deps.heartbeatMin ?? HEARTBEAT_MIN;
  const failurePatterns = deps.failurePatterns ?? LAUNCH_FAILURE_PATTERNS;

  // Compare the rollout with an observed baseline, not another clock. The only
  // relevant question is whether the artifact changed during this watch.
  const startedAt = new Date().toISOString();

  let previousPane: string | null = null;
  let heartbeats = 0;
  let quiet = 0;
  let lastPaneTail = "";
  // Did the screen ever answer at all? Distinguishes a pane we watched stay
  // still from a pane we could never read.
  let paneReadable = false;
  // A transiently unreadable process tree must not erase the last conclusive
  // observation. A later explicit false still replaces an earlier true.
  let lastKnownLaunchedProcessAlive: boolean | null = null;
  // Count redraws that cannot be credited because the expected agent is absent.
  // This lets the death
  // be reported as the thing it actually was: not a silent pane, a busy one with
  // nobody behind it.
  let orphanedRedraws = 0;

  for (;;) {
    await deps.wait(pollMs);

    // Positive signals first, cheapest first. A launch that has already proved
    // itself is not interrogated further — we do not ask the host about an agent we
    // can already see working.
    if (deps.settled?.() === true) {
      return { alive: true, signal: "agent reported ready" };
    }

    const eventAt = deps.lastEventAt();
    if (eventAt !== null && eventAt > baselineEventAt) {
      return { alive: true, signal: "hook event" };
    }

    // This signal stays silent during reasoning, so it cannot stand alone.
    const activity = await deps.codexActivity().catch(() => null);
    if (activity !== null && activity > startedAt) {
      return { alive: true, signal: "tool activity" };
    }

    if (!(await deps.hasSession(session))) {
      return { alive: false, reason: "terminal session exited" };
    }

    // Whose event loop is drawing this screen? Asked once per poll, because a
    // redraw is only evidence about the agent if the agent is the one redrawing.
    const launched = await deps.launchedProcessAlive().catch(() => null);
    if (launched !== null) lastKnownLaunchedProcessAlive = launched;

    let paneChanged = false;
    try {
      const pane = await deps.capturePane(session);
      paneReadable = true;
      lastPaneTail = tailLines(pane, 15);

      // A launch error is a launch error however lively the screen looks.
      if (failurePatterns.some((p) => p.test(tailLines(pane, 5)))) {
        return { alive: false, reason: lastPaneTail || "Agent launch error" };
      }

      paneChanged = previousPane !== null && pane !== previousPane;
      previousPane = pane;
    } catch {
      // An unreadable pane is not evidence of death — the session check above is
      // what decides that. It is simply no signal this tick.
      if (!(await deps.hasSession(session))) {
        return { alive: false, reason: "terminal session exited" };
      }
    }

    // A redraw is a heartbeat only when the agent is the one with the pulse.
    // `launched === true` is the whole predicate: the binary hive put
    // in this pane is still running in it, so the screen it is painting is its
    // own. A wrapper's animation over a dead child fails here, which is the
    // point; so does `null`, because a process tree we could not read is not
    // evidence of life and unknown is never the flattering answer.
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

    // Silence is no activity evidence, not death evidence. Once the observation
    // window ends below, the last conclusive launched-process check distinguishes
    // a live prompt wait from an absent or never-measurable launch.
    quiet += 1;
    if (quiet >= quietLimit) {
      // A static pane is normal while a live vendor waits at an interactive
      // prompt. Silence can end the observation window, but it cannot prove
      // death when the process hive launched was proven present and the final
      // sample was only transiently unreadable.
      if (lastKnownLaunchedProcessAlive === true) {
        return {
          alive: true,
          signal: `${deps.launchedCommand} process running in pane`,
        };
      }
      return {
        alive: false,
        // A frozen pane without a proven launched process and a pane animated by
        // a wrapper are both death; an operator needs to know which is visible.
        reason:
          orphanedRedraws > 0
            ? orphanedPaneReason(deps.launchedCommand, lastPaneTail)
            : quietReason(quietLimit * pollMs, lastPaneTail, paneReadable),
      };
    }
  }
}

/**
 * Can this launch report, or is it alive and permanently mute?
 *
 * Proof of life is not proof of reporting: a pane redraws and a process holds
 * the tree whether or not the agent's hive MCP client ever connected — and an
 * agent without that channel cannot hive_send, hive_inbox, or hive_land no
 * matter how healthy it looks. The one truthful signal is the vendor MCP
 * client's own handshake: every supported vendor initializes its MCP servers
 * at session start, and the daemon's /mcp endpoint authenticates each request
 * with the agent's own credential. An authenticated request from the agent's
 * subject therefore proves the whole chain at once — the right port, the
 * right config, a credential that works — measured on the receiving side,
 * never inferred from the agent looking alive. Inherited (human) MCP servers
 * are the opposite tolerance: their failure changes nothing here.
 */
/**
 * Vendor MCP initialization competes with every simultaneous launch, so the
 * timeout must allow for a fully loaded machine rather than an idle startup.
 */
export const MCP_REPORTING_TIMEOUT_MS = 90_000;

/**
 * Wait, bounded, for the agent's credential to be seen on the daemon's MCP
 * surface at or after `since` (the launch baseline, so a dead predecessor's
 * handshake never counts). Returns null when reporting is proven, or the
 * named failure — "hive MCP unreachable" — that the launch path must refuse
 * with. The timeout is a parameter so tests can collapse it; an unreachable
 * MCP must fail fast and legibly, never spin.
 */
export async function waitForMcpReporting(
  subject: string,
  since: string,
  seen: (subject: string, since: string) => boolean,
  wait: (ms: number) => Promise<void>,
  timeoutMs = MCP_REPORTING_TIMEOUT_MS,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (!seen(subject, since)) {
    if (Date.now() >= deadline) {
      return `hive MCP unreachable: no authenticated request from ${JSON.stringify(
        subject,
      )}'s credential within ${Math.round(timeoutMs / 1000)}s of launch`;
    }
    await wait(200);
  }
  return null;
}
