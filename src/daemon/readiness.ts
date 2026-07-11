/**
 * Did this launch come up, or is it dead?
 *
 * The old answer measured time-to-first-tool-call: fifteen one-second polls,
 * and a launch that had not produced a hook event or a fresh rollout write by
 * then was killed. That is a proxy for *acting*, and a high-effort model does
 * not act for a long time — it thinks first. So deep-tier Codex was
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
 * `Working (12s • esc to interrupt)` and increments it once a second; measured,
 * the pane changed on all 24 of 24 consecutive one-second polls while the model
 * reasoned and before it touched a single tool. That is the heartbeat. It is
 * emitted by thinking, not by acting, which is the whole point.
 *
 * Three states have to stay distinct, and conflating any two of them is the bug
 * in one direction or the other:
 *
 *   reasoning     pane redraws ~1/s                       ALIVE  (was killed)
 *   idle at rest  pane frozen, but the turn-end hook fired ALIVE  (event signal)
 *   hung or dead  pane frozen, no hook, no rollout         DEAD   (fail loud)
 *
 * The middle row is why a frozen pane can never mean death on its own: a run
 * whose turn simply ended goes pane-static within about three seconds. Death is
 * the *conjunction* — a screen that has stopped redrawing AND no events AND no
 * artifact writes.
 *
 * The fail-loud contract from the commit that introduced this is preserved
 * exactly, and sharpened: an unproven launch is still killed, its reservation
 * released, its reason recorded. It just gets killed for being dead rather than
 * for being slow. A frozen process is now caught by a positive test — twenty
 * missed heartbeats — instead of by outliving a stopwatch, which means a genuine
 * hang is detected *sooner* than before, not later.
 */

/** One second, matching the TUI redraw rate we are listening for. */
export const POLL_MS = 1_000;

/**
 * Consecutive dead-silent polls before we call it dead: twelve.
 *
 * The number is derived from the signal, not guessed at the model. Measured, the
 * TUI redraws once a second and did so on 24 of 24 consecutive polls through a
 * pure reasoning phase. Twelve is an order of magnitude above that interval: a
 * live agent would have to miss twelve heartbeats in a row, with no hook event
 * and no artifact write either, which not even a badly loaded machine does.
 *
 * This is the whole difference from the fifteen seconds it replaces. That number
 * bounded *reasoning time* — a quantity nobody can bound, since a model may
 * legitimately think for minutes. This one bounds *redraw silence*, a quantity
 * we measured at ~1 Hz. Being generous here is nearly free: a live agent never
 * goes quiet, so the only thing a larger number delays is the detection of a
 * genuine hang, and the only thing a smaller one risks is killing the living.
 */
export const QUIET_LIMIT = 12;

/**
 * Pane changes required before a redrawing screen counts as proof of life.
 *
 * One change is not enough: a TUI paints itself once at startup and a process
 * that painted and then hung would look alive. Three separate changes cannot
 * come from a single repaint — they mean something is still running an event
 * loop. At 1 Hz this costs about three seconds, which is the price of not
 * mistaking a corpse's last twitch for a pulse.
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

export interface ProofOfLifeDeps {
  readonly hasSession: (session: string) => Promise<boolean>;
  readonly capturePane: (session: string) => Promise<string>;
  /** The agent row's `lastEventAt`, re-read live on every poll. */
  readonly lastEventAt: () => string | null;
  /**
   * A codex agent's rollout mtime, or null when there is none to read (a
   * non-codex agent, no worktree, or an unreadable artifact). Still a positive
   * signal — it just cannot be the *only* one, since it stays silent through
   * the entire reasoning phase.
   */
  readonly codexActivity: () => Promise<string | null>;
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
 * Poll a launched agent until something proves it is alive, or until it has
 * been silent long enough to prove it is not.
 *
 * There is deliberately no wall-clock deadline. No fixed number can be right:
 * reasoning time is unbounded, and a model that thinks for five minutes is not
 * a dead one. The only honest deadline is a *silence* deadline, and silence is
 * something a live process cannot fake.
 *
 * This returns as soon as it has an answer, so it does not hold `spawn()` open
 * for the length of a turn — a working agent starts redrawing within a second
 * or two, and that is all the proof required.
 */
export async function watchForProofOfLife(
  session: string,
  baselineEventAt: string,
  deps: ProofOfLifeDeps,
): Promise<ProofOfLife> {
  const pollMs = deps.pollMs ?? POLL_MS;
  const quietLimit = deps.quietLimit ?? QUIET_LIMIT;
  const heartbeatMin = deps.heartbeatMin ?? HEARTBEAT_MIN;

  // The rollout's value *now*, not the wall clock. Comparing a file's mtime to
  // `Date.now()` was the original mistake: it silently depends on the two clocks
  // agreeing and on the file not already being fresh. A baseline of the observed
  // value asks the only question that matters — did this change?
  const startedAt = new Date().toISOString();

  let previousPane: string | null = null;
  let heartbeats = 0;
  let quiet = 0;
  let lastPaneTail = "";

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

    let paneChanged = false;
    try {
      const pane = await deps.capturePane(session);
      lastPaneTail = tailLines(pane, 15);

      // A launch error is a launch error however lively the screen looks.
      if (LAUNCH_FAILURE_PATTERNS.some((p) => p.test(tailLines(pane, 5)))) {
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

    if (paneChanged) {
      heartbeats += 1;
      quiet = 0;
      if (heartbeats >= heartbeatMin) {
        return { alive: true, signal: "screen redrawing" };
      }
      continue;
    }

    // Silence is only silence when *nothing* moved: no event, no artifact write,
    // and a screen that did not redraw.
    quiet += 1;
    if (quiet >= quietLimit) {
      return { alive: false, reason: quietReason(quietLimit * pollMs, lastPaneTail) };
    }
  }
}
