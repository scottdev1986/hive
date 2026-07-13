import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../schemas";
import {
  FEED_GIVE_UP_MS,
  FEED_HEARTBEAT_MS,
  FEED_POLL_MS,
  FEED_RETRY_MAX_MS,
  runWorkspaceFeed,
} from "./workspace-feed";

const timestamp = "2026-07-10T12:00:00.000Z";

function agent(name: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "claude",
    model: "claude-test",
    category: "simple_coding",
    status: "working",
    taskDescription: "Feed test",
    worktreePath: `/tmp/${name}`,
    branch: `hive/${name}-test`,
    tmuxSession: `hive-${name}`,
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
    ...overrides,
  };
}

/** One scripted poll: returns a snapshot or throws. `abort` ends the loop
 * after the step is processed, exactly like SIGTERM between polls. */
type Step = (abort: () => void) => AgentRecord[];

interface FeedRun {
  exitCode: number;
  lines: Array<Record<string, unknown>>;
  presence: boolean[];
  sleeps: number[];
}

/** Drives the real loop on a fake clock: sleeping advances time instantly, so
 * heartbeat and give-up behavior are exact, not wall-clock flaky. Autonomy and
 * the orchestrator's status are injected (default null) so no test ever touches
 * a real daemon. */
async function runScript(
  steps: Step[],
  fetchAutonomy: () => Promise<"sandboxed" | "dangerous" | null> = async () =>
    null,
  fetchOrchestrator: () => Promise<"working" | "idle" | null> = async () => null,
): Promise<FeedRun> {
  const controller = new AbortController();
  const lines: Array<Record<string, unknown>> = [];
  const presence: boolean[] = [];
  const sleeps: number[] = [];
  let time = 0;
  let index = 0;
  const exitCode = await runWorkspaceFeed(4483, {
    signal: controller.signal,
    now: () => time,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    write: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    setPresence: async (_port, present) => {
      presence.push(present);
    },
    fetchAutonomy,
    fetchOrchestrator,
    fetchStatus: async () => {
      const step = steps[index];
      if (step === undefined) {
        throw new Error("feed polled past the end of the script");
      }
      index += 1;
      return step(() => controller.abort());
    },
  });
  return { exitCode, lines, presence, sleeps };
}

const snapshot = (...agents: AgentRecord[]): Step => () => agents;
const failure = (message: string): Step => () => {
  throw new Error(message);
};
const last = (step: Step): Step => (abort) => {
  const result = step(abort);
  abort();
  return result;
};
const lastFailure = (message: string): Step => (abort) => {
  abort();
  throw new Error(message);
};

describe("runWorkspaceFeed", () => {
  test("emits the first snapshot, stays silent while unchanged, heartbeats at 5s", async () => {
    const maya = agent("maya");
    const run = await runScript([
      snapshot(maya), // t=0: first snapshot
      snapshot(maya), // t=1s..4s: unchanged, silent
      snapshot(maya),
      snapshot(maya),
      snapshot(maya),
      last(snapshot(maya)), // t=5s: unchanged, but the heartbeat is due
    ]);
    expect(run.exitCode).toEqual(0);
    expect(run.lines).toHaveLength(2);
    expect(run.lines[0]).toEqual({
      v: 1,
      agents: [JSON.parse(JSON.stringify(maya)) as unknown],
    });
    expect(run.lines[1]?.agents).toBeDefined();
    expect(run.sleeps.every((ms) => ms === FEED_POLL_MS)).toEqual(true);
  });

  test("any change emits immediately, without waiting for the heartbeat", async () => {
    const maya = agent("maya");
    const run = await runScript([
      snapshot(maya),
      last(snapshot({ ...maya, status: "idle", contextPct: 42 })),
    ]);
    expect(run.lines).toHaveLength(2);
    const [, changed] = run.lines;
    expect((changed?.agents as Array<{ status: string }>)[0]?.status)
      .toEqual("idle");
  });

  test("shutdown surrenders the lease it took on start", async () => {
    const run = await runScript([last(snapshot(agent("maya")))]);
    // Renewal no longer rides on the emit — it is taken before the first poll,
    // on the feed's own clock — so one grant here, then the surrender.
    expect(run.presence).toEqual([true, false]);
  });

  test("a failure is emitted once, retried with backoff, and recovery re-emits", async () => {
    const maya = agent("maya");
    const run = await runScript([
      failure("connect ECONNREFUSED"),
      failure("connect ECONNREFUSED"), // same failure: no second line
      failure("handshake mismatch"), // distinct failure: one new line
      last(snapshot(maya)), // recovery re-emits even a first-ever snapshot
    ]);
    expect(run.exitCode).toEqual(0);
    expect(run.lines).toEqual([
      { v: 1, error: "connect ECONNREFUSED" },
      { v: 1, error: "handshake mismatch" },
      { v: 1, agents: [JSON.parse(JSON.stringify(maya)) as unknown] },
    ]);
    // Backoff doubles from the poll interval and caps.
    expect(run.sleeps.slice(0, 3)).toEqual([
      Math.min(FEED_POLL_MS * 2, FEED_RETRY_MAX_MS),
      Math.min(FEED_POLL_MS * 4, FEED_RETRY_MAX_MS),
      FEED_RETRY_MAX_MS,
    ]);
  });

  test("an error after healthy polls resets nothing until 30s of silence", async () => {
    const maya = agent("maya");
    const run = await runScript([
      snapshot(maya),
      failure("daemon stopped"),
      last(snapshot(maya)), // back before the deadline: keep going
    ]);
    expect(run.exitCode).toEqual(0);
    // error line, then the recovery snapshot.
    expect(run.lines.map((line) => "error" in line)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("exits non-zero once the daemon is gone for 30s, still surrendering the lease", async () => {
    // Backoff caps at 4s, so ~9 consecutive failures cross the 30s deadline.
    const steps: Step[] = Array.from(
      { length: 30 },
      () => failure("connect ECONNREFUSED"),
    );
    const run = await runScript(steps);
    expect(run.exitCode).toEqual(1);
    expect(run.lines).toEqual([{ v: 1, error: "connect ECONNREFUSED" }]);
    const failedFor = run.sleeps.reduce((total, ms) => total + ms, 0);
    expect(failedFor).toBeGreaterThanOrEqual(FEED_GIVE_UP_MS - FEED_RETRY_MAX_MS);
    // The feed keeps offering the lease across the outage — the app is still
    // attached, and a daemon that comes back should find its viewer at once
    // rather than after the next successful poll. The POSTs simply fail while
    // it is down. What matters is that it surrenders on the way out.
    expect(run.presence.filter((present) => present).length)
      .toBeGreaterThanOrEqual(1);
    expect(run.presence.at(-1)).toEqual(false);
  });

  test("an abort mid-outage exits zero: a closing app is not a dead daemon", async () => {
    const run = await runScript([
      failure("connect ECONNREFUSED"),
      lastFailure("connect ECONNREFUSED"),
    ]);
    expect(run.exitCode).toEqual(0);
    expect(run.presence.at(-1)).toEqual(false);
  });

  test("the snapshot carries the autonomy dial, and a flip alone re-emits", async () => {
    const maya = agent("maya");
    const values: Array<"sandboxed" | "dangerous"> = [
      "sandboxed",
      "sandboxed",
      "dangerous", // agents unchanged; the dial flip must still emit
    ];
    let poll = 0;
    const run = await runScript(
      [snapshot(maya), snapshot(maya), last(snapshot(maya))],
      async () => values[poll++] ?? "dangerous",
    );
    expect(run.lines).toHaveLength(2);
    expect(run.lines[0]?.autonomy).toEqual("sandboxed");
    expect(run.lines[1]?.autonomy).toEqual("dangerous");
  });

  test("an unreadable autonomy omits the field and never drops the agents", async () => {
    const maya = agent("maya");
    const run = await runScript(
      [last(snapshot(maya))],
      async () => {
        throw new Error("daemon predates /autonomy");
      },
    );
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]?.agents).toBeDefined();
    expect("autonomy" in (run.lines[0] ?? {})).toEqual(false);
  });

  test("heartbeats renew the lease inside the daemon's TTL", async () => {
    const maya = agent("maya");
    // 11 unchanged polls: emits at t=0, 5s, 10s.
    const steps: Step[] = Array.from({ length: 11 }, () => snapshot(maya));
    steps.push(last(snapshot(maya)));
    const run = await runScript(steps);
    const renewals = run.presence.filter((present) => present).length;
    // Renewals ride the feed's own 5s clock (t=0, 5s, 10s), not the emits.
    expect(renewals).toBeGreaterThanOrEqual(3);
    expect(run.lines.length).toEqual(3);
    expect(run.sleeps.filter((ms) => ms === FEED_POLL_MS).length)
      .toEqual(run.sleeps.length);
  });

  test("a status poll that hangs forever cannot stop the lease renewals", async () => {
    // The 2026-07-12 incident reached by a hang instead of a kill: the feed is
    // alive, the app is attached and looks perfectly normal, but a wedged
    // status poll used to mean nothing ever renewed the lease — so the daemon
    // concluded nobody was watching and opened Terminal windows over live panes.
    const controller = new AbortController();
    const presence: boolean[] = [];
    let time = 0;
    await runWorkspaceFeed(4483, {
      // A daemon that accepted the request and never answered.
      fetchStatus: () => new Promise<AgentRecord[]>(() => {}),
      setPresence: async (_port, present) => {
        presence.push(present);
        // Three renewals is proof the heartbeat outlives the wedge; stop there
        // so the loop cannot spin.
        if (presence.filter(Boolean).length >= 3) controller.abort();
      },
      statusTimeoutMs: 1,
      write: () => {},
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      signal: controller.signal,
    });

    expect(presence.filter((present) => present).length).toBeGreaterThanOrEqual(3);
    // And it still surrenders on the way out.
    expect(presence.at(-1)).toEqual(false);
  });

  test("carries the root's status beside the agents, not inside them", async () => {
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      async () => null,
      async () => "working",
    );
    expect(run.lines[0]?.orchestrator).toEqual({ status: "working" });
    // Beside, never inside: the root has no AgentRecord, and inventing one
    // would break the no-row invariant the daemon relies on in four places.
    expect(run.lines[0]?.agents).toHaveLength(1);
  });

  /**
   * The load-bearing one. When the daemon cannot honestly say what the root is
   * doing, the field must be ABSENT — not "idle", not a stale last value, not a
   * placeholder. The Workspace renders a missing status as unknown/gray, so
   * omission is how the wire says "nobody knows", and an absent field is unknown,
   * never false.
   *
   * A test that only covered the happy path would let a future change quietly
   * default this to a status word, which is precisely the bug being fixed here:
   * a fabricated status that looks like a measurement.
   */
  test("omits the field entirely when the root's status is unknown", async () => {
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      async () => null,
      async () => null,
    );
    expect(run.lines[0]).not.toHaveProperty("orchestrator");
    // The agent list must still arrive: an unknowable root never takes the
    // rest of the snapshot down with it.
    expect(run.lines[0]?.agents).toHaveLength(1);
  });

  test("a root-status read that throws degrades to omission, not to a guess", async () => {
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      async () => null,
      async () => {
        throw new Error("daemon wedged");
      },
    );
    expect(run.lines[0]).not.toHaveProperty("orchestrator");
    expect(run.lines[0]?.agents).toHaveLength(1);
  });
});
