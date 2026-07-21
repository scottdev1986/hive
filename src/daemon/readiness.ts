/**
 * Did this launch come up, or is it dead?
 *
 * The old answer measured time-to-first-tool-call: fifteen one-second polls,
 * and a launch that had not produced a hook event or a fresh rollout write by
 * then was killed. That is a proxy for *acting*, and a high-effort model does
 * not act for a long time — it thinks first. So complex-coding Codex was
 * indistinguishable from a corpse and could not be spawned at all, while
 * low-effort Codex, which greps within a second, sailed through. The variable
 * was never health. It was reasoning effort.
 *
 * The subtle part, and the reason the previous fix failed: a rollout-freshness
 * check *already existed* for exactly this case, and it is structurally
 * incapable of firing. Measured against a real gpt-5.6-sol high-effort run,
 * polling once a second:
 *
 *     t=0s    rollout written at session start   size 35730
 *     t=1-13s model reasoning                    size 35730, UNCHANGED
 *     t=15s   first output                       size 38294
 *
 * Codex writes the rollout when the session opens and then nothing at all until
 * the model emits. So `rollout_mtime > watch_started_at` is false for the whole
 * reasoning window, and the one signal meant to keep a thinking Codex alive can
 * only fire at the first tool call — the very event we were already failing to
 * wait for. The bug was never a missing signal. It was a broken predicate over a
 * signal we already had, and no repair to the comparison would have saved it:
 * during reasoning the rollout is not a liveness signal at all.
 *
 * What a thinking agent *does* emit is a redrawing screen. The Codex TUI renders
 * `Working (12s • esc to interrupt)` and increments it once a second; measured
 * again here against a live gpt-5.6-sol high run, the pane changed on every one
 * of the 13 consecutive polls it spent reasoning, before it touched a single
 * tool. That is the heartbeat. It is emitted by thinking, not by acting, which
 * is the whole point.
 *
 * But a redraw says only that *something* is running an event loop, and the
 * something is not necessarily the agent. Hive's own launch wraps the provider
 * in a shell (`holdPaneOnFailure`), so the pane's process is a wrapper and the
 * agent is its child; any wrapper that prints — a spinner, a clock — redraws the
 * pane whether or not the child behind it is alive. Measured: a wrapper animating
 * once a second over a child that had already exited changed the pane on 5 of 5
 * polls, and this function called it alive. So the redraw is corroborated,
 * every poll, by the one signal that names the agent instead of describing its
 * screen: the launched binary is still running in that pane's process tree
 * (`launchedProcessAlive`). Both halves are checked against the real thing — a
 * high-effort Codex thinking past 15 seconds still reads alive, and the dead
 * child behind the live wrapper no longer does.
 *
 * Four states have to stay distinct, and conflating any two of them is the bug
 * in one direction or the other:
 *
 *   reasoning     pane redraws ~1/s, agent running         ALIVE  (was killed)
 *   prompt wait   pane frozen, agent process running       ALIVE  (process signal)
 *   idle at rest  pane frozen, but the turn-end hook fired ALIVE  (event signal)
 *   dead          pane frozen, no agent process            DEAD   (fail loud)
 *   dead behind   pane redraws ~1/s, no agent process      DEAD   (was "alive")
 *   a live wrapper
 *
 * The middle rows are why a frozen pane can never mean death on its own: a run
 * whose turn simply ended or is waiting for permission can remain pane-static.
 * Death requires an explicit failure, a vanished session, or failure to prove
 * that the launched process is still present.
 *
 * The fail-loud contract from the commit that introduced this is preserved
 * exactly, and sharpened: a dead launch is still killed, its reservation
 * released, and its reason recorded. It just gets killed for being dead rather
 * than for being slow or waiting for input.
 */

/** One second, matching the TUI redraw rate we are listening for. */
export const POLL_MS = 1_000;

/**
 * Consecutive output-silent polls before we fall back to process existence.
 *
 * The number is derived from the signal, not guessed at the model. Measured, the
 * TUI redraws once a second and did so on 24 of 24 consecutive polls through a
 * pure reasoning phase. Twelve is an order of magnitude above that interval: a
 * live agent can miss twelve heartbeats while waiting at a static prompt, so
 * reaching this limit does not itself mean death. It ends the output-observation
 * window; a positive process check proves the vendor is still here.
 *
 * This is the whole difference from the fifteen seconds it replaces. That number
 * bounded *reasoning time* — a quantity nobody can bound, since a model may
 * legitimately think for minutes. This one bounds only how long readiness waits
 * for a faster activity signal before consulting the vendor process itself.
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
   * This exists because "the pane changed" answers the wrong question. It asks
   * whether *something* on that screen is moving, and hive's own launch puts a
   * wrapper shell between tmux and the agent: `holdPaneOnFailure` runs the
   * provider inside a subshell so a provider that calls `exit` cannot bypass
   * the diagnostic hold. So the thing tmux calls the pane's process is a shell,
   * and anything that shell prints — a spinner, a clock, a progress line — is a
   * redraw the old predicate took as proof that the *agent* was alive.
   * Constructed and measured: a wrapper animating once a second over a child
   * that exited
   * immediately changed the pane on 5 of 5 polls and was reported `alive:true,
   * signal: "screen redrawing"`. Hive would have recorded a dead launch as a
   * successful one.
   *
   * The obvious discriminator does not work, and it is worth saying why so
   * nobody tries it again: `pane_current_command` is `zsh` for a perfectly
   * healthy Codex agent (the wrapper is the foreground process, not the
   * provider) and `bash` for the dead-child wrapper. Both are shells. The
   * foreground command cannot tell an agent from its wrapper.
   *
   * The process *tree* can, and it is the only thing here that names the agent
   * rather than describing its screen: measured on a live spawn, pane_pid is the
   * wrapper shell and the `codex` process is right there as its child. So the
   * question is whether the binary hive launched into this pane is still among
   * that pane's descendants. It is the launched command, not a hardcoded
   * provider name, because the Codex app-server path launches `hive
   * codex-app-server-host` and not `codex` at all — a check that looked for
   * "codex" would kill every app-server agent it was meant to protect.
   */
  readonly launchedProcessAlive: () => Promise<boolean | null>;
  /** The command hive launched (`codex`, `claude`, `hive`), for the record and
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

export function quietReason(quietMs: number, paneTail: string): string {
  const base = `no sign of life for ${Math.round(quietMs / 1000)}s ` +
    "(screen never redrew, no hook event, no tool activity)";
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
  const base = `the pane is redrawing but no \`${command}\` process is ` +
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

  // The rollout's value *now*, not the wall clock. Comparing a file's mtime to
  // `Date.now()` was the original mistake: it silently depends on the two clocks
  // agreeing and on the file not already being fresh. A baseline of the observed
  // value asks the only question that matters — did this change?
  const startedAt = new Date().toISOString();

  let previousPane: string | null = null;
  let heartbeats = 0;
  let quiet = 0;
  let lastPaneTail = "";
  // Redraws we watched happen and refused to credit, because the agent that was
  // supposed to be drawing them was not running. Counted only so the death can
  // be reported as the thing it actually was: not a silent pane, a busy one with
  // nobody behind it.
  let orphanedRedraws = 0;

  for (;;) {
    await deps.wait(pollMs);

    // Positive signals first, cheapest first. A launch that has already proved
    // itself is not interrogated further — we do not ask tmux about an agent we
    // can already see working.
    if (deps.settled?.() === true) {
      return { alive: true, signal: "agent reported ready" };
    }

    const eventAt = deps.lastEventAt();
    if (eventAt !== null && eventAt > baselineEventAt) {
      return { alive: true, signal: "hook event" };
    }

    // Still a real signal, and still worth reading — it just cannot be the only
    // one, because it stays silent for the whole reasoning phase. The predicate
    // is unchanged from the version that was failing in the field: it was never
    // wrong, it simply had nothing to observe until the first tool call.
    const activity = await deps.codexActivity().catch(() => null);
    if (activity !== null && activity > startedAt) {
      return { alive: true, signal: "tool activity" };
    }

    if (!(await deps.hasSession(session))) {
      return { alive: false, reason: "tmux session exited" };
    }

    // Whose event loop is drawing this screen? Asked once per poll, because a
    // redraw is only evidence about the agent if the agent is the one redrawing.
    const launched = await deps.launchedProcessAlive().catch(() => null);

    let paneChanged = false;
    try {
      const pane = await deps.capturePane(session);
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
        return { alive: false, reason: "tmux session exited" };
      }
    }

    // A redraw is a heartbeat only when the agent is the one with the pulse.
    // `launched === true` is the whole of the new predicate: the binary hive put
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
    // window ends below, a positive launched-process check distinguishes a live
    // prompt wait from an absent or unmeasurable launch.
    quiet += 1;
    if (quiet >= quietLimit) {
      // A static pane is normal while a live vendor waits at an interactive
      // prompt. Silence can end the observation window, but it cannot prove
      // death when the process hive launched is still present.
      if (launched === true) {
        return {
          alive: true,
          signal: `${deps.launchedCommand} process running in pane`,
        };
      }
      return {
        alive: false,
        // A frozen pane without a proven launched process and a pane animated by
        // a wrapper are both death; an operator needs to know which is visible.
        reason: orphanedRedraws > 0
          ? orphanedPaneReason(deps.launchedCommand, lastPaneTail)
          : quietReason(quietLimit * pollMs, lastPaneTail),
      };
    }
  }
}
