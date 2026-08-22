import { describe, expect, test } from "bun:test";
import {
  FEED_GIVE_UP_MS,
  FEED_POLL_MS,
  FEED_RETRY_MAX_MS,
  FEED_STATUS_TIMEOUT_MAX_MS,
  FEED_STATUS_TIMEOUT_MS,
  classifyWorkspaceAutonomyResponse,
  parseWorkspaceOrchestratorSnapshot,
  publishWorkspaceVisibility,
  registerWorkspaceOwner,
  runWorkspaceFeed,
  StatusPollTimeoutError,
  type WorkspaceOrchestratorSnapshot,
  type WorkspaceAutonomyState,
  WorkspaceVisibilityPublisher,
  WorkspaceVisibilityPublishTimeoutError,
} from "../../src/cli/workspace-feed";
import {
  presentWorkspaceAgent,
  presentWorkspaceOrchestrator,
  type WorkspaceAgentPresentation,
} from "../../src/cli/workspace-feed-presentation";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import { WorkspaceVisibilityAuthority } from "../../src/daemon/session-host/workspace-visibility";
import type { AgentRecord } from "../../src/schemas/agent";
import {
  buildWorkspaceFeedSnapshotFixture,
  WORKSPACE_FEED_SNAPSHOT_FIXTURE,
  workspaceFeedAgentFixture,
} from "../fixtures/builders/workspace-feed-snapshot";
import type { JsonValue } from "../../src/shared/json";

const timestamp = "2026-07-10T12:00:00.000Z";

function agent(
  name: string,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
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
    contextPct: 10,
    createdAt: timestamp,
    lastEventAt: timestamp,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
}

type FeedLine = {
  v?: number;
  error?: string;
  stale?: boolean;
  reason?: string;
  agents?: Array<AgentRecord & { presentation: WorkspaceAgentPresentation }>;
  autonomyState?: WorkspaceAutonomyState;
  orchestrator?: { name?: string; status?: string; presentation?: unknown };
};

/** One scripted poll: returns a snapshot or throws. `abort` ends the loop
 * after the step is processed, exactly like SIGTERM between polls. */
type Step = (abort: () => void) => AgentRecord[];

interface FeedRun {
  exitCode: number;
  lines: Array<FeedLine>;
  sleeps: number[];
}

/** Drives the real loop on a fake clock: sleeping advances time instantly, so
 * heartbeat and give-up behavior are exact, not wall-clock flaky. Autonomy and
 * the orchestrator's status are injected so no test ever touches a real daemon. */
async function runScript(
  steps: Step[],
  fetchAutonomy: () => Promise<WorkspaceAutonomyState> = async () => ({
    kind: "absent",
  }),
  fetchOrchestrator: () => Promise<WorkspaceOrchestratorSnapshot | null> = async () =>
    null,
  verifyInstance: () => Promise<void> = async () => {},
): Promise<FeedRun> {
  const controller = new AbortController();
  const lines: Array<FeedLine> = [];
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
      // SAFETY: The test owns this value and its fields.
      lines.push(JSON.parse(line) as FeedLine);
    },
    fetchAutonomy,
    fetchOrchestrator,
    verifyInstance,
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

const snapshot =
  (...agents: AgentRecord[]): Step =>
  () =>
    agents;
const failure =
  (message: string): Step =>
  () => {
    throw new Error(message);
  };
const last =
  (step: Step): Step =>
  (abort) => {
    const result = step(abort);
    abort();
    return result;
  };
const lastFailure =
  (message: string): Step =>
  (abort) => {
    abort();
    throw new Error(message);
  };

const orchestrator = (
  status: WorkspaceOrchestratorSnapshot["status"],
  overrides: Partial<WorkspaceOrchestratorSnapshot> = {},
): WorkspaceOrchestratorSnapshot => ({
  name: "queen",
  status,
  host: "sessiond",
  hostState: null,
  hostDiagnostic: null,
  sessionLocator: null,
  ...overrides,
});

const currentAutonomy = (
  value: "sandboxed" | "dangerous",
): WorkspaceAutonomyState => ({ kind: "current", value });

const absentAutonomy = async (): Promise<WorkspaceAutonomyState> => ({
  kind: "absent",
});

const rootLocator = {
  schemaVersion: 1 as const,
  instanceId: "instance",
  subject: { kind: "root" as const },
  generation: 1,
  sessionId: "ses_0198a8f0-0000-7000-8000-000000000001",
  hostKind: "sessiond" as const,
  engineBuildId: "engine",
};

const presentedAgent = (record: AgentRecord) => ({
  ...record,
  presentation: presentWorkspaceAgent(record),
});

const presentedOrchestrator = (record: WorkspaceOrchestratorSnapshot) => ({
  ...record,
  presentation: presentWorkspaceOrchestrator(record),
});

describe("workspace feed presentation", () => {
  test("unknown raw states fail closed while measured blocks carry attention", () => {
    expect(
      presentWorkspaceAgent(
        agent("future", {
          status: "unknown",
        }),
      ),
    ).toEqual({
      panePresence: "visible",
      terminalState: "live",
      headerDetail: "unknown",
      paneStatus: { kind: "unknown" },
      activity: "unknown",
      attention: null,
    });

    expect(
      presentWorkspaceAgent(
        agent("review", {
          status: "awaiting-approval",
          lastEventAt: timestamp,
          taskDescription: "Approve the review",
        }),
      ),
    ).toEqual({
      panePresence: "visible",
      terminalState: "live",
      headerDetail: "awaiting-approval",
      paneStatus: { kind: "waiting", waitingKind: "approval" },
      activity: "needs-user",
      attention: {
        id: "status-agent:review",
        severity: "waiting",
        title: "review is awaiting approval",
        detail: "Approve the review",
        raisedAt: Date.parse(timestamp) / 1_000,
      },
    });
  });

  test("dimension evidence and root-host failure are resolved before Swift", () => {
    const dimensional = presentWorkspaceAgent({
      ...workspaceFeedAgentFixture,
      status: "dead",
    });
    expect(dimensional.paneStatus).toEqual({ kind: "running" });
    expect(dimensional.activity).toBe("working");
    expect(dimensional.panePresence).toBe("visible");
    expect(dimensional.terminalState).toBe("live");
    expect(dimensional.headerDetail).toBe(
      "runtime=ready · turn=working · input=empty · mail=none · " +
        "health=healthy · attention=none",
    );
    expect(dimensional.attention).toBeNull();

    const closed = presentWorkspaceAgent(agent("retired", { status: "dead" }));
    expect(closed.panePresence).toBe("closed");
    expect(closed.terminalState).toBe("exited");

    expect(
      presentWorkspaceOrchestrator(
        orchestrator("failed", {
          hostState: "failed",
        }),
      ),
    ).toEqual({
      panePresence: "visible",
      terminalState: "failed",
      headerDetail: "Failed",
      paneStatus: { kind: "failed" },
      activity: "failed",
      attention: null,
    });
  });

  test("matches the queen TUI's done, idle, and question states", () => {
    expect(presentWorkspaceOrchestrator(orchestrator("done"))).toMatchObject({
      headerDetail: "Done",
      paneStatus: { kind: "completed" },
      activity: "done",
      attention: null,
    });
    expect(presentWorkspaceOrchestrator(orchestrator("idle"))).toMatchObject({
      headerDetail: "Idle",
      paneStatus: { kind: "running" },
      activity: "idle",
      attention: null,
    });
    expect(
      presentWorkspaceOrchestrator(
        orchestrator("awaiting_answer", { statusObservedAt: timestamp }),
      ),
    ).toMatchObject({
      headerDetail: "Answer needed",
      paneStatus: { kind: "waiting", waitingKind: "userInput" },
      activity: "needs-user",
      attention: {
        id: "status-orchestrator:queen",
        severity: "waiting",
        title: "Queen is asking a question",
        detail: "Answer needed in the queen pane",
        raisedAt: Date.parse(timestamp) / 1_000,
      },
    });
  });
});

describe("workspace autonomy response", () => {
  test("keeps current, absent, refused, malformed, and future modes distinct", () => {
    expect(
      classifyWorkspaceAutonomyResponse(200, { autonomy: "sandboxed" }),
    ).toEqual({ kind: "current", value: "sandboxed" });
    expect(classifyWorkspaceAutonomyResponse(200, { autonomy: null })).toEqual({
      kind: "absent",
    });
    expect(
      classifyWorkspaceAutonomyResponse(403, { error: "forbidden" }),
    ).toEqual({ kind: "refused", statusCode: 403, reason: "forbidden" });
    expect(classifyWorkspaceAutonomyResponse(200, {})).toMatchObject({
      kind: "malformed",
    });
    expect(
      classifyWorkspaceAutonomyResponse(200, { autonomy: "future-mode" }),
    ).toEqual({ kind: "unsupported", value: "future-mode" });
  });
});

describe("runWorkspaceFeed", () => {
  test("register and publish make the real daemon authority current", async () => {
    const db = new HiveDatabase(":memory:");
    const authority = new WorkspaceVisibilityAuthority({
      expectedInstanceId: "workspace-feed-instance",
      observeProcess: (pid) =>
        pid === 7210 ? { startToken: "7210:500" } : null,
      discoverEngineBuildId: async () => "workspace-feed-engine",
    });
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      workspaceVisibility: authority,
      spawner: { spawn: async () => agent("unused") },
      repoRoot: "/tmp/workspace-feed-integration",
    });
    const token = daemon.capabilities.mint("user", "user").token;
    const post = (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return daemon.fetch(new Request(input, { ...init, headers }));
    };
    const deps = {
      observeProcess: () => ({ startToken: "7210:500" }),
      post,
    };
    const inventory = {
      schemaVersion: 1 as const,
      inventoryRevision: "1",
      terminals: [
        {
          agentId: "agent-feed",
          agentName: "maya",
          locator: {
            schemaVersion: 1 as const,
            instanceId: "workspace-feed-instance",
            subject: { kind: "agent" as const, agentId: "agent-feed" },
            generation: 1,
            sessionId: "ses_019fe800-0000-7000-8000-000000000001",
            hostKind: "sessiond" as const,
            engineBuildId: "workspace-feed-engine",
          },
          state: "live" as const,
        },
      ],
    };

    try {
      await registerWorkspaceOwner(4483, "workspace-launch", 7210, deps);
      await publishWorkspaceVisibility(
        4483,
        "workspace-launch",
        7210,
        inventory,
        deps,
      );

      expect(authority.ownerRegistered()).toBe(true);
      expect(authority.sourceVerified()).toBe(true);
      expect(authority.currentSnapshot()).toEqual({
        ...inventory,
        source: {
          sessionId: "workspace-launch",
          process: { processId: 7210, startToken: "7210:500" },
        },
      });
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("records one live-source conflict and stops publishing that inventory", async () => {
    const output: Array<FeedLine> = [];
    let requests = 0;
    const publisher = new WorkspaceVisibilityPublisher(
      (inventory) =>
        publishWorkspaceVisibility(
          4483,
          "competing-workspace",
          7210,
          inventory,
          {
            observeProcess: () => ({ startToken: "7210:500" }),
            post: async () => {
              requests += 1;
              return Response.json(
                {
                  error:
                    "another live Workspace source already owns the inventory",
                  reason: "source-identity-mismatch",
                },
                { status: 409 },
              );
            },
          },
        ),
      // SAFETY: The test owns this value and its fields.
      (line) => output.push(JSON.parse(line) as FeedLine),
    );
    const line = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        inventoryRevision: "1",
        terminals: [],
      }),
    );

    publisher.publishLine(line);
    publisher.publishLine(line);
    publisher.publishLine(line);
    await publisher.flush();

    expect(requests).toEqual(1);
    expect(output).toEqual([
      {
        v: 1,
        error:
          "workspace visibility publish halted [source-identity-mismatch]: " +
          "another live Workspace source already owns the inventory",
      },
    ]);
  });

  test("a hung publish is bounded, aborted, and reported with its duration", async () => {
    let aborted = false;
    await expect(
      publishWorkspaceVisibility(
        4483,
        "workspace-launch",
        7210,
        { schemaVersion: 1, inventoryRevision: "1", terminals: [] },
        {
          observeProcess: () => ({ startToken: "7210:500" }),
          timeoutMs: 20,
          // Never resolves: a hung request must not stall renewal forever.
          post: (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
            }),
        },
      ),
    ).rejects.toThrow(new WorkspaceVisibilityPublishTimeoutError(20));
    expect(aborted).toBe(true);
  });

  test("a publish whose headers arrive but body stalls is still bounded", async () => {
    const outcome = publishWorkspaceVisibility(
      4483,
      "workspace-launch",
      7210,
      { schemaVersion: 1, inventoryRevision: "1", terminals: [] },
      {
        observeProcess: () => ({ startToken: "7210:500" }),
        timeoutMs: 20,
        post: async () =>
          new Response(new ReadableStream({ start() {} }), { status: 409 }),
      },
    ).then(
      () => "resolved",
      (error: JsonValue) => error,
    );
    expect(
      await Promise.race([outcome, Bun.sleep(100).then(() => "still pending")]),
    ).toBeInstanceOf(WorkspaceVisibilityPublishTimeoutError);
  });

  test("a stalled publish does not block the next one: newest inventory still lands", async () => {
    const output: Array<FeedLine> = [];
    const published: string[] = [];
    let attempts = 0;
    const publisher = new WorkspaceVisibilityPublisher(
      (inventory) =>
        publishWorkspaceVisibility(4483, "workspace-launch", 7210, inventory, {
          observeProcess: () => ({ startToken: "7210:500" }),
          timeoutMs: 20,
          post: async (_input, init) => {
            attempts += 1;
            // SAFETY: The test owns this value and its fields.
            const body = (await new Request("http://x", init).json()) as {
              inventoryRevision: string;
            };
            // The first attempt hangs forever.
            if (attempts === 1) return await new Promise<Response>(() => {});
            published.push(body.inventoryRevision);
            return Response.json({
              state: "accepted",
              inventoryRevision: body.inventoryRevision,
            });
          },
        }),
      // SAFETY: The test owns this value and its fields.
      (line) => output.push(JSON.parse(line) as FeedLine),
    );
    const inventory = (revision: string): Uint8Array =>
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          inventoryRevision: revision,
          terminals: [],
        }),
      );

    publisher.publishLine(inventory("1"));
    // Three more arrive while revision 1 is stuck. They are full snapshots, so
    // only the newest is worth sending; the middle two are dropped, never queued.
    publisher.publishLine(inventory("2"));
    publisher.publishLine(inventory("3"));
    publisher.publishLine(inventory("4"));
    await publisher.flush();

    expect(attempts).toBe(2);
    expect(published).toEqual(["4"]);
    expect(output).toEqual([
      { v: 1, error: "workspace visibility publish timed out after 20ms" },
    ]);
  });

  test("a slow but successful publish is reported as a warning, not a failure", async () => {
    const output: Array<FeedLine> = [];
    const publisher = new WorkspaceVisibilityPublisher(
      async () => ({ durationMs: 1_500 }),
      // SAFETY: The test owns this value and its fields.
      (line) => output.push(JSON.parse(line) as FeedLine),
      1_000,
    );
    publisher.publishLine(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          inventoryRevision: "7",
          terminals: [],
        }),
      ),
    );
    await publisher.flush();

    expect(output).toEqual([
      {
        v: 1,
        error: "workspace visibility publish was slow: 1500ms for revision 7",
      },
    ]);
  });

  test("preserves every known orchestrator status word", () => {
    for (const status of [
      "spawning",
      "connecting",
      "ready",
      "queued",
      "submitting",
      "working",
      "idle",
      "awaiting_approval",
      "awaiting_answer",
      "cancelling",
      "done",
      "failed",
      "disconnected",
      "exited",
    ] as const) {
      expect(
        parseWorkspaceOrchestratorSnapshot({
          name: "queen",
          status,
          host: "sessiond",
          hostState: null,
          hostDiagnostic: null,
          sessionLocator: null,
        }),
      ).toEqual(orchestrator(status));
    }
    expect(
      parseWorkspaceOrchestratorSnapshot({
        name: "queen",
        status: "running",
        host: "sessiond",
        hostState: null,
        hostDiagnostic: null,
        sessionLocator: rootLocator,
      }),
    ).toBeNull();
  });

  test("preserves a pending root locator with a concrete launch status", () => {
    expect(
      parseWorkspaceOrchestratorSnapshot({
        name: "queen",
        status: "spawning",
        host: "sessiond",
        hostState: "awaiting-visibility",
        hostDiagnostic: null,
        sessionLocator: rootLocator,
      }),
    ).toEqual(
      orchestrator("spawning", {
        host: "sessiond",
        hostState: "awaiting-visibility",
        sessionLocator: rootLocator,
      }),
    );
    expect(
      parseWorkspaceOrchestratorSnapshot({
        name: "queen",
        status: null,
        host: "sessiond",
        hostState: null,
        hostDiagnostic: null,
        sessionLocator: null,
      }),
    ).toBeNull();
  });

  test("preserves exact root provider identity while connecting", () => {
    expect(
      parseWorkspaceOrchestratorSnapshot({
        name: "queen",
        status: "connecting",
        tool: "codex",
        model: "gpt-5.6-sol",
        host: "sessiond",
        hostState: null,
        hostDiagnostic: null,
        sessionLocator: null,
      }),
    ).toEqual(
      orchestrator("connecting", {
        tool: "codex",
        model: "gpt-5.6-sol",
      }),
    );
    expect(
      parseWorkspaceOrchestratorSnapshot({
        name: "queen",
        status: "working",
        host: "sessiond",
        hostState: null,
        hostDiagnostic: null,
        sessionLocator: null,
      }),
    ).toEqual(orchestrator("working"));
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
      async () => currentAutonomy("dangerous"),
      async () =>
        orchestrator("working", {
          tool: "codex",
          model: "gpt-5.6-sol",
        }),
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
    expect(
      // SAFETY: The test owns this value and its fields.
      (changed?.agents as Array<{ status: string }> | undefined)?.[0]?.status,
    ).toEqual("idle");
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
      {
        v: 1,
        agents: [presentedAgent(maya)],
        autonomyState: { kind: "absent" },
      },
    ]);
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
    expect(run.lines.map((line) => "error" in line)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("a transient instance verification failure retries instead of exiting", async () => {
    const maya = agent("maya");
    let attempts = 0;
    const run = await runScript(
      [last(snapshot(maya))],
      undefined,
      undefined,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("daemon still starting");
      },
    );
    expect(run.exitCode).toEqual(0);
    expect(attempts).toEqual(2);
    expect(run.lines).toEqual([
      { v: 1, error: "daemon still starting" },
      {
        v: 1,
        agents: [presentedAgent(maya)],
        autonomyState: { kind: "absent" },
      },
    ]);
  });

  test("exits non-zero once the daemon is gone for 30s", async () => {
    // Backoff caps at 4s, so ~9 consecutive failures cross the 30s deadline.
    const steps: Step[] = Array.from({ length: 30 }, () =>
      failure("connect ECONNREFUSED"),
    );
    const run = await runScript(steps);
    expect(run.exitCode).toEqual(1);
    expect(run.lines).toEqual([
      { v: 1, error: "connect ECONNREFUSED" },
      // Giving up is said out loud, so a reader is never left inferring it from
      // the stream ending.
      { v: 1, stale: true, reason: "connect ECONNREFUSED" },
    ]);
    const failedFor = run.sleeps.reduce((total, ms) => total + ms, 0);
    expect(failedFor).toBeGreaterThanOrEqual(
      FEED_GIVE_UP_MS - FEED_RETRY_MAX_MS,
    );
  });

  test("an abort mid-outage exits zero: a closing app is not a dead daemon", async () => {
    const run = await runScript([
      failure("connect ECONNREFUSED"),
      lastFailure("connect ECONNREFUSED"),
    ]);
    expect(run.exitCode).toEqual(0);
  });

  test("the status budget doubles to its ceiling and spends no outage deadline", async () => {
    // The ladder the shipped constants produce: 5s, 10s, 20s, and 20s from
    // then on. Each rung is under the 30s give-up on its own, which is exactly
    // why summing them was the mistake — three rungs plus their retry sleeps
    // pass 30s of accumulated outage, and charging that to the deadline would
    // let waiting for an answer be what declares the daemon dead.
    expect(FEED_STATUS_TIMEOUT_MS).toEqual(5_000);
    expect([
      FEED_STATUS_TIMEOUT_MS,
      Math.min(FEED_STATUS_TIMEOUT_MS * 2, FEED_STATUS_TIMEOUT_MAX_MS),
      Math.min(FEED_STATUS_TIMEOUT_MS * 4, FEED_STATUS_TIMEOUT_MAX_MS),
      Math.min(FEED_STATUS_TIMEOUT_MS * 8, FEED_STATUS_TIMEOUT_MAX_MS),
    ]).toEqual([5_000, 10_000, 20_000, 20_000]);

    // Driven at a scaled base so the same ladder runs in milliseconds: a
    // daemon that never answers at all, which is the worst a slow one can look.
    const controller = new AbortController();
    const lines: Array<FeedLine> = [];
    let time = 0;
    let polls = 0;
    const exitCode = await runWorkspaceFeed(4483, {
      signal: controller.signal,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      write: (line) => {
        // SAFETY: The test owns this value and its fields.
        lines.push(JSON.parse(line) as FeedLine);
      },
      statusTimeoutMs: 50,
      fetchStatus: async () => {
        polls += 1;
        if (polls >= 3) controller.abort();
        return new Promise<never>(() => {});
      },
    });

    expect(lines.map((line) => line.error)).toEqual([
      "status poll timed out after 50ms",
      "status poll timed out after 100ms",
      "status poll timed out after 200ms",
    ]);
    expect(exitCode).toEqual(0);
  });

  test("a daemon that only ever answers late never trips the outage deadline", async () => {
    // The sequence that survived the first fix: each wait is under the give-up
    // deadline while their sum is well past it. Rejections are immediate here so
    // the injected clock can run far beyond 30s without the test waiting for it.
    const controller = new AbortController();
    const lines: Array<FeedLine> = [];
    let time = 0;
    let polls = 0;
    const exitCode = await runWorkspaceFeed(4483, {
      signal: controller.signal,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      write: (line) => {
        // SAFETY: The test owns this value and its fields.
        lines.push(JSON.parse(line) as FeedLine);
      },
      fetchStatus: async () => {
        polls += 1;
        if (polls >= 20) controller.abort();
        throw new StatusPollTimeoutError(FEED_STATUS_TIMEOUT_MS);
      },
    });

    // Long past the deadline, and still neither an exit nor a staleness
    // declaration, because none of that elapsed time was refusal.
    expect(time).toBeGreaterThan(FEED_GIVE_UP_MS);
    expect(lines.some((line) => "stale" in line)).toEqual(false);
    expect(exitCode).toEqual(0);
  });

  test("a refusal does not buy the patience a late answer earns", async () => {
    // A refusal is not evidence that anyone is working on an answer, so it must
    // leave the budget where it was. Were it to escalate, the 70ms poll below
    // would fit inside a widened budget and succeed; at the untouched 50ms base
    // it must still time out.
    const maya = agent("maya");
    const controller = new AbortController();
    const lines: Array<FeedLine> = [];
    let time = 0;
    let polls = 0;
    const exitCode = await runWorkspaceFeed(4483, {
      signal: controller.signal,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      write: (line) => {
        // SAFETY: The test owns this value and its fields.
        lines.push(JSON.parse(line) as FeedLine);
      },
      statusTimeoutMs: 50,
      fetchStatus: async () => {
        polls += 1;
        if (polls >= 2) controller.abort();
        if (polls === 1) throw new Error("connect ECONNREFUSED");
        await new Promise((resolve) => setTimeout(resolve, 70));
        return [maya];
      },
    });

    expect(lines.map((line) => line.error)).toEqual([
      "connect ECONNREFUSED",
      "status poll timed out after 50ms",
    ]);
    expect(lines.some((line) => "agents" in line)).toEqual(false);
    expect(exitCode).toEqual(0);
  });

  test("a daemon slower than the poll timeout still reports a spawn and a kill", async () => {
    // A daemon that is alive and answering correctly, only slower than the
    // poll allows, is a different fault from one that is gone: its answer is
    // available, so the roster it feeds must still move. Scaled down from the
    // observed failure — the ratio of latency to timeout is what decides the
    // outcome, not the magnitudes — and driven through the real timer because
    // the injected clock deliberately does not arm it.
    const maya = agent("maya");
    const otis = agent("otis");
    const controller = new AbortController();
    const lines: Array<FeedLine> = [];
    let time = 0;
    let polls = 0;
    const exitCode = await runWorkspaceFeed(4483, {
      signal: controller.signal,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      write: (line) => {
        // SAFETY: The test owns this value and its fields.
        lines.push(JSON.parse(line) as FeedLine);
      },
      statusTimeoutMs: 50,
      fetchStatus: async () => {
        polls += 1;
        // Enough polls for the roster to move twice, then stop: a feed that
        // recovers has no deadline of its own to end the test with.
        if (polls >= 5) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 70));
        // otis is killed after the first two polls; maya outlives him.
        return polls <= 2 ? [maya, otis] : [maya];
      },
    });
    const rosters = lines
      .filter(
        (
          line,
        ): line is FeedLine & { agents: NonNullable<FeedLine["agents"]> } =>
          line.agents !== undefined,
      )
      .map((line) => line.agents.map((each) => each.name));

    expect(rosters).toContainEqual(["maya", "otis"]);
    // The half that would have caught the frozen roster: a feed that only ever
    // adds looks correct until an agent has to disappear.
    expect(rosters).toContainEqual(["maya"]);
    expect(exitCode).toEqual(0);
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
      async () => currentAutonomy(values[poll++] ?? "dangerous"),
    );
    expect(run.lines).toHaveLength(2);
    expect(run.lines[0]?.autonomyState).toEqual(currentAutonomy("sandboxed"));
    expect(run.lines[1]?.autonomyState).toEqual(currentAutonomy("dangerous"));
  });

  test("an unreadable autonomy is typed and never drops the agents", async () => {
    const maya = agent("maya");
    const run = await runScript([last(snapshot(maya))], async () => {
      throw new Error("daemon predates /autonomy");
    });
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]?.agents).toBeDefined();
    expect(run.lines[0]?.autonomyState).toEqual({
      kind: "unreachable",
      reason: "daemon predates /autonomy",
    });
  });

  test("carries the root's status beside the agents, not inside them", async () => {
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      absentAutonomy,
      async () => orchestrator("working"),
    );
    const root = orchestrator("working");
    expect(run.lines[0]?.orchestrator).toEqual(presentedOrchestrator(root));
    // Root sits beside the agent list, never as a fabricated AgentRecord.
    expect(run.lines[0]?.agents).toHaveLength(1);
  });

  test("omits the field when the root-status channel is unavailable", async () => {
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      absentAutonomy,
      async () => null,
    );
    expect(run.lines[0]).not.toHaveProperty("orchestrator");
    // A failed independent root read must not drop the rest of the snapshot.
    expect(run.lines[0]?.agents).toHaveLength(1);
  });

  test("carries a pending sessiond root locator with spawning status", async () => {
    const pending = orchestrator("spawning", {
      host: "sessiond",
      hostState: "awaiting-visibility",
      sessionLocator: rootLocator,
    });
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      absentAutonomy,
      async () => pending,
    );
    expect(run.lines[0]?.orchestrator).toEqual(presentedOrchestrator(pending));
  });

  test("a root-status read that throws degrades to omission, not to a guess", async () => {
    const run = await runScript(
      [last(snapshot(agent("maya")))],
      absentAutonomy,
      async () => {
        throw new Error("daemon wedged");
      },
    );
    expect(run.lines[0]).not.toHaveProperty("orchestrator");
    expect(run.lines[0]?.agents).toHaveLength(1);
  });
});
