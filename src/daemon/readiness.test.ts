import { describe, expect, test } from "bun:test";
import { QUIET_LIMIT, watchForProofOfLife, type ProofOfLifeDeps } from "./readiness";

/**
 * A pane that redraws like a real TUI: the Codex composer increments
 * `Working (Ns • esc to interrupt)` once a second, which is what a thinking
 * agent emits and a dead one cannot.
 */
function tickingPane(): () => Promise<string> {
  let second = 0;
  return async () => `> task\n• Working (${(second += 1)}s • esc to interrupt)`;
}

const frozen = (text: string) => async () => text;

function deps(over: Partial<ProofOfLifeDeps> = {}): ProofOfLifeDeps {
  return {
    hasSession: async () => true,
    capturePane: frozen("idle"),
    lastEventAt: () => null,
    codexActivity: async () => null,
    // The healthy default: the agent hive launched is running in its pane.
    launchedProcessAlive: async () => true,
    launchedCommand: "codex",
    wait: async () => {},
    ...over,
  };
}

const BASELINE = "2026-07-11T00:00:00.000Z";

describe("proof of life", () => {
  test("a model that only thinks is alive — the bug that made deep-tier Codex unspawnable", async () => {
    // No hook event, no rollout write, no tool call: exactly the state that got
    // liam and ethan killed at 15s. The screen is redrawing, which is the whole
    // point — thinking emits a heartbeat even though it emits no actions.
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: tickingPane(),
    }));
    expect(proof).toEqual({
      alive: true,
      signal: "screen redrawing (codex running in pane)",
    });
  });

  test("survives far past the retired 15s deadline while it reasons", async () => {
    let polls = 0;
    const pane = tickingPane();
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: async () => {
        polls += 1;
        return pane();
      },
      // A five-minute thinker is not a dead one; there is no wall clock left to
      // outlive.
      heartbeatMin: 300,
    }));
    expect(proof.alive).toBe(true);
    expect(polls).toBeGreaterThan(200);
  });

  test("a spinning wrapper over a dead child is DEAD, however lively the screen", async () => {
    // The whole defect, reproduced. A wrapper prints a clock once a second while
    // the provider it launched has already exited; the pane changes on every
    // poll. Measured against a real tmux pane, this animates 5 of 5 polls — and
    // the old predicate ("three pane changes") called that a healthy launch and
    // recorded a dead provider as a successful spawn.
    let tick = 0;
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: async () => `[wrapper] launching provider... ${(tick += 1)}`,
      launchedProcessAlive: async () => false,
      launchedCommand: "codex",
    }));
    expect(proof.alive).toBe(false);
    if (!proof.alive) {
      // And it names the death it actually died. This pane was never silent.
      expect(proof.reason).toContain("no `codex` process is running in it");
      expect(proof.reason).toContain("died behind a live wrapper");
      expect(proof.reason).not.toContain("screen never redrew");
    }
  });

  test("a thinking agent still lives — the redraw counts when the agent is the one drawing", async () => {
    // The guard against fixing one bug by restoring another. Same ticking pane
    // as the deep-tier Codex case, and the only difference from the test above
    // is that the launched process is genuinely running: no hook event, no
    // rollout write, no tool call, and it must still read as alive.
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: tickingPane(),
      launchedProcessAlive: async () => true,
    }));
    expect(proof.alive).toBe(true);
  });

  test("an unreadable process tree is unknown, and unknown is not life", async () => {
    // `ps` failed, or tmux reported no pane. That is not evidence the agent is
    // running, so a redraw we cannot attribute buys nothing — and hive says so
    // rather than flattering itself with a default.
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: tickingPane(),
      launchedProcessAlive: async () => null,
    }));
    expect(proof.alive).toBe(false);
  });

  test("a launched process that is not the provider is still the launched process", async () => {
    // The Codex app-server path runs `hive codex-app-server-host`, not `codex`.
    // Readiness looks for the binary hive launched, so an app-server agent
    // proves life exactly like a TUI one; a check hardcoded to "codex" would
    // have killed every one of them.
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: tickingPane(),
      launchedProcessAlive: async () => true,
      launchedCommand: "hive",
    }));
    expect(proof).toEqual({
      alive: true,
      signal: "screen redrawing (hive running in pane)",
    });
  });

  test("a frozen screen with no events and no activity is dead, and says why", async () => {
    const proof = await watchForProofOfLife("s", BASELINE, deps());
    expect(proof.alive).toBe(false);
    if (!proof.alive) {
      expect(proof.reason).toContain("no sign of life");
      expect(proof.reason).toContain("screen never redrew");
    }
  });

  test("a hung launch is caught FASTER than the timer it replaces", async () => {
    let polls = 0;
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      wait: async () => {
        polls += 1;
      },
    }));
    expect(proof.alive).toBe(false);
    // The old probe waited out 15 polls. A positive test for silence beats a
    // stopwatch: this is not a loosening of the fail-loud contract.
    expect(polls).toBe(QUIET_LIMIT);
    expect(QUIET_LIMIT).toBeLessThan(15);
  });

  test("a screen that paints once and then hangs is dead, not alive", async () => {
    // One repaint is not a pulse. A process that drew itself and froze must not
    // be mistaken for one that is working.
    let painted = 0;
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: async () => (painted += 1) <= 2 ? `paint ${painted}` : "paint 2",
    }));
    expect(proof.alive).toBe(false);
  });

  test("an idle agent whose turn ended is alive via its hook event, not its pane", async () => {
    // The middle state, and the reason a frozen pane can never mean death on its
    // own: a finished turn goes pane-static within seconds.
    let polls = 0;
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: frozen("done, awaiting input"),
      lastEventAt: () => (polls += 1) >= 3 ? "2026-07-11T00:00:05.000Z" : BASELINE,
    }));
    expect(proof).toEqual({ alive: true, signal: "hook event" });
  });

  test("a rollout write still proves life, and still cannot prove it during reasoning", async () => {
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      codexActivity: async () => new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(proof).toEqual({ alive: true, signal: "tool activity" });

    // Measured against real Codex: the rollout is written at session start and
    // then goes silent for the entire reasoning phase. A rollout whose mtime
    // predates the watch is not a signal, and on its own it kills a thinker.
    const stale = await watchForProofOfLife("s", BASELINE, deps({
      codexActivity: async () => "2020-01-01T00:00:00.000Z",
    }));
    expect(stale.alive).toBe(false);
  });

  test("a vanished session is dead however lively the last screen looked", async () => {
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: tickingPane(),
      hasSession: async () => false,
    }));
    expect(proof).toEqual({ alive: false, reason: "tmux session exited" });
  });

  test("a launch error fails immediately, redrawing or not", async () => {
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: frozen("codex: command not found"),
    }));
    expect(proof.alive).toBe(false);
    if (!proof.alive) expect(proof.reason).toContain("command not found");
  });

  test("the row leaving spawning outranks anything a screen could say", async () => {
    let settled = false;
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      wait: async () => {
        settled = true;
      },
      settled: () => settled,
    }));
    expect(proof).toEqual({ alive: true, signal: "agent reported ready" });
  });

  test("an unreadable pane is not evidence of death while the session lives", async () => {
    let polls = 0;
    const proof = await watchForProofOfLife("s", BASELINE, deps({
      capturePane: async () => {
        throw new Error("pane unavailable");
      },
      // The session is up and a hook event lands; a capture failure must not
      // outvote that.
      lastEventAt: () => (polls += 1) >= 2 ? "2026-07-11T00:00:05.000Z" : BASELINE,
    }));
    expect(proof.alive).toBe(true);
  });
});
