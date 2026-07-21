import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceFeedSnapshotFixture,
  WORKSPACE_FEED_SNAPSHOT_FIXTURE,
  workspaceFeedAgentFixture,
} from "../../scripts/test-fixtures/workspace-feed-snapshot";
import type { AgentRecord } from "../schemas";
import {
  FEED_GIVE_UP_MS,
  FEED_HEARTBEAT_MS,
  FEED_POLL_MS,
  FEED_RETRY_MAX_MS,
  parseOrchestratorStatus,
  publishWorkspaceVisibility,
  runWorkspaceFeed,
  WorkspaceVisibilityPublisher,
} from "./workspace-feed";
import type { OrchestratorStatus } from "../daemon/orchestrator-status";

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
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

/** One scripted poll: returns a snapshot or throws. `abort` ends the loop
 * after the step is processed, exactly like SIGTERM between polls. */
type Step = (abort: () => void) => AgentRecord[];

interface FeedRun {
  exitCode: number;
  lines: Array<Record<string, unknown>>;
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
  fetchOrchestrator: () => Promise<OrchestratorStatus | null> = async () => null,
): Promise<FeedRun> {
  const controller = new AbortController();
  const lines: Array<Record<string, unknown>> = [];
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
  return { exitCode, lines, sleeps };
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
  test("publishes the observed Workspace PID identity with its full inventory", async () => {
    const requests: Request[] = [];
    await publishWorkspaceVisibility(
      4483,
      "workspace-launch",
      7210,
      { schemaVersion: 1, inventoryRevision: "1", terminals: [] },
      {
        observeProcess: (pid) => {
          expect(pid).toBe(7210);
          return { startToken: "7210:500" };
        },
        post: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json({ state: "accepted", inventoryRevision: "1" });
        },
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://127.0.0.1:4483/workspace-visibility");
    expect(await requests[0]!.json()).toEqual({
      schemaVersion: 1,
      source: {
        sessionId: "workspace-launch",
        process: { processId: 7210, startToken: "7210:500" },
      },
      inventoryRevision: "1",
      terminals: [],
    });
  });

  test("records one live-source conflict and stops publishing that inventory", async () => {
    const output: Array<Record<string, unknown>> = [];
    let requests = 0;
    const publisher = new WorkspaceVisibilityPublisher(
      (inventory) => publishWorkspaceVisibility(
        4483,
        "competing-workspace",
        7210,
        inventory,
        {
          observeProcess: () => ({ startToken: "7210:500" }),
          post: async () => {
            requests += 1;
            return Response.json({
              state: "rejected",
              reason: "source-identity-mismatch",
              diagnostic: "another live Workspace source already owns the inventory",
            }, { status: 409 });
          },
        },
      ),
      (line) => output.push(JSON.parse(line) as Record<string, unknown>),
    );
    const line = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      inventoryRevision: "1",
      terminals: [],
    }));

    publisher.publishLine(line);
    publisher.publishLine(line);
    publisher.publishLine(line);
    await publisher.flush();

    expect(requests).toEqual(1);
    expect(output).toEqual([{
      v: 1,
      error: "workspace visibility publish halted [source-identity-mismatch]: " +
        "another live Workspace source already owns the inventory",
    }]);
  });

  test("preserves every known orchestrator lifecycle word", () => {
    for (const status of ["spawning", "working", "idle", "exited"] as const) {
      expect(parseOrchestratorStatus(status)).toEqual(status);
    }
    expect(parseOrchestratorStatus("running")).toEqual(null);
    expect(parseOrchestratorStatus(undefined)).toEqual(null);
  });

  test("emits the shared wire snapshot, stays silent while unchanged, heartbeats at 5s", async () => {
    const run = await runScript(
      [
        snapshot(workspaceFeedAgentFixture), // t=0: first snapshot
        snapshot(workspaceFeedAgentFixture), // t=1s..4s: unchanged, silent
        snapshot(workspaceFeedAgentFixture),
        snapshot(workspaceFeedAgentFixture),
        snapshot(workspaceFeedAgentFixture),
        last(snapshot(workspaceFeedAgentFixture)), // t=5s: heartbeat
      ],
      async () => "dangerous",
      async () => "working",
    );
    const fixture = await Bun.file(WORKSPACE_FEED_SNAPSHOT_FIXTURE).json();
    expect(run.exitCode).toEqual(0);
    expect(run.lines).toHaveLength(2);
    expect(await buildWorkspaceFeedSnapshotFixture()).toEqual(fixture);
    expect(run.lines[0]).toEqual(fixture);
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

  test("exits non-zero once the daemon is gone for 30s", async () => {
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
  });

  test("an abort mid-outage exits zero: a closing app is not a dead daemon", async () => {
    const run = await runScript([
      failure("connect ECONNREFUSED"),
      lastFailure("connect ECONNREFUSED"),
    ]);
    expect(run.exitCode).toEqual(0);
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
