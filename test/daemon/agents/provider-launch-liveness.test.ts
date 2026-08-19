import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { HiveDatabase } from "../../../src/daemon/database/hive-database";
import { compactActiveTeam } from "../../../src/daemon/orchestrator-host/orchestrator-projections";
import { HiveDaemon } from "../../../src/daemon/server";
import type { SessionInspection } from "../../../src/daemon/session-host/session-host-contract";
import type { SpawnAdmission } from "../../../src/daemon/spawn/admission";
import { HiveSpawner } from "../../../src/daemon/spawn/spawner-impl";
import { StatusService } from "../../../src/daemon/status-service/status-projection-service";
import type { AgentRecord } from "../../../src/schemas/agent";
import type { RoutingPolicy } from "../../../src/schemas/routing-policy";
import { OUTSIDE_REPO_TMPDIR } from "../../outside-repo-tmpdir";

const policy: RoutingPolicy = {
  schemaVersion: 3,
  revision: 1,
  updatedAt: "2026-08-14T19:31:13.902Z",
  provisional: false,
  providers: {},
  models: [],
  global: null,
  categories: {
    simple_coding: {
      mode: "user-weighted",
      candidates: [
        {
          provider: "kimi",
          model: "kimi-code/k3",
          effort: { mode: "provider-controlled" },
          weight: 1,
        },
      ],
    },
  },
};

function presentInspection(
  locator: SessionInspection["locator"],
): SessionInspection {
  return {
    schemaVersion: 1,
    locator,
    presence: "present",
    complete: true,
    hostPid: 3_900,
    hostStartToken: "3900:1",
    shellRoot: {
      pid: 4_000,
      startToken: "4000:1",
      processGroupId: 4_000,
    },
    foreground: {
      state: "unmanaged",
      runId: null,
      pid: 5_000,
      startToken: "5000:1",
      foregroundProcessGroupId: 5_000,
    },
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    outputSeq: "1",
    checkpointSeq: "0",
    checkpointAvailable: false,
    viewerCount: 0,
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    resources: {},
    visibility: {
      state: "visible",
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2026-08-14T20:31:13.902Z",
    },
    exit: null,
    survivors: [],
    evidenceAt: "2026-08-14T19:31:13.902Z",
    diagnosticIds: [],
  };
}

interface LaunchFixture {
  readonly db: HiveDatabase;
  readonly spawner: HiveSpawner;
  readonly inspection: () => SessionInspection | null;
  readonly close: () => Promise<void>;
}

/** A kimi launch whose readiness proves the process alive while its credential never reaches the daemon's MCP surface — the shape that used to be recorded as a death. The reporting seams are parameters so a test can hold that answer open and watch what the launch does meanwhile. */
async function liveKimiLaunch(
  reporting: {
    mcpClientSeen?: (subject: string, since: string) => boolean;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    hierarchyAdmission?: () => SpawnAdmission | undefined;
  } = {},
): Promise<LaunchFixture> {
  const root = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-provider-liveness-root-"),
  );
  const home = await mkdtemp(
    join(OUTSIDE_REPO_TMPDIR, "hive-provider-liveness-home-"),
  );
  const worktree = join(root, "maude");
  await mkdir(worktree, { recursive: true });
  await copyFile(
    join(import.meta.dir, "../../../AGENT_STANDARDS.md"),
    join(root, "AGENT_STANDARDS.md"),
  );
  const previousHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  const db = new HiveDatabase(":memory:");
  let inspection: SessionInspection | null = null;
  const spawner = new HiveSpawner({
    db,
    repoRoot: root,
    port: 4_317,
    config: {},
    readRoutingPolicy: () => policy,
    isModelEnabled: async () => true,
    readBilling: async () => null,
    createWorktree: async () => ({ path: worktree, branch: "hive/maude" }),
    unavailableAgentNames: async () => new Set(),
    stopSession: async () => ({ killed: [], survivors: [] }),
    sleep: reporting.sleep ?? (async () => {}),
    mcpClientSeen: reporting.mcpClientSeen ?? (() => false),
    mcpReportingTimeoutMs: reporting.timeoutMs ?? 0,
    measureWorktreeHead: async () => "0".repeat(40),
    ...(reporting.hierarchyAdmission === undefined
      ? {}
      : { hierarchyAdmission: reporting.hierarchyAdmission }),
    buildMemoryIndex: async () => "",
    ps: async () =>
      [
        " 4000     1  1024 /bin/zsh",
        ` 4100  4000  2048 ${process.execPath} src/cli.ts agent-ui --provider kimi`,
        " 5000  4100  4096 kimi acp",
      ].join("\n"),
    issueCredential: () => "hv1.credential-maude.secret",
    claudeExecutable: "claude",
    codexExecutable: "codex",
    grokExecutable: "grok",
    kimiExecutable: "kimi",
    opencodeExecutable: "opencode",
    sessiond: {
      prepareAgentCreation: async () => ({
        engineBuildId: "engine-test",
        visibility: {
          workspaceSessionId: "workspace-fixture",
          workspacePid: 3_800,
          workspaceStartToken: "3800:1",
          openTerminalRevision: "1",
        },
      }),
      admit: async () => null,
      terminalHost: {
        create: async (specification) => {
          inspection = presentInspection(specification.locator);
          return {
            locator: specification.locator,
            inspection,
            created: true,
          };
        },
        inspect: async () => {
          if (inspection === null) throw new Error("terminal was not created");
          return inspection;
        },
        terminate: async (locator) => ({
          locator,
          state: "terminated",
          exit: null,
          survivors: [],
          errors: [],
        }),
      },
    },
  });

  return {
    db,
    spawner,
    inspection: () => inspection,
    close: async () => {
      db.close();
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(home, { recursive: true, force: true }),
      ]);
    },
  };
}

/** The launch settles its name reservation in the background; wait for that positive signal rather than for a status the failure path also writes. */
async function settled(db: HiveDatabase, name: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!db.isAgentNameReserved(name)) return;
    await Bun.sleep(5);
  }
}

test("a live provider that misses launch reporting is projected as running", async () => {
  const fixture = await liveKimiLaunch();
  const { db, spawner } = fixture;

  try {
    const admitted = await spawner.spawn({
      task: "Continue working after a quiet Kimi launch",
      category: "simple_coding",
    });
    await settled(db, admitted.name);
    expect(db.isAgentNameReserved(admitted.name)).toBeFalse();

    const agent = db.getAgentById(admitted.id);
    const inspection = fixture.inspection();
    if (agent === null || inspection === null) {
      throw new Error("live launch fixture did not settle");
    }
    const run = db.getActiveProviderRunForAgent(agent.id);
    if (run === null) throw new Error("live provider run is missing");

    const status = StatusService.create(db, "instance-fixture");
    const silent = status.current(agent, new Date("2026-08-14T19:32:47.328Z"));
    expect(status.displayStatus(agent, silent)).toBe("unknown");
    expect(status.displayStatus({ ...agent, status: "stuck" }, silent)).toBe(
      "unknown",
    );
    status.observeHook(
      agent,
      {
        kind: "turn-start",
        agentName: agent.name,
        providerRunId: run.runId,
        toolSessionId: "kimi-session-fixture",
        timestamp: "2026-08-14T19:31:17.000Z",
      },
      "accepted",
    );
    const fused = status.current(agent, new Date("2026-08-14T19:32:47.328Z"));
    if (fused.turnState === null) {
      throw new Error("working turn evidence is missing");
    }
    const measuredStuck = {
      ...fused,
      turnState: { ...fused.turnState, value: "stuck" as const },
      healthState: {
        value: "delayed" as const,
        source: { kind: "sessiond" as const, id: "sessiond-fixture" },
        observedAt: "2026-08-14T19:32:47.328Z",
        freshness: "fresh" as const,
        confidence: "authoritative" as const,
      },
    };
    expect(status.displayStatus(agent, measuredStuck)).toBe("stuck");
    expect(status.dimensionsFrom(measuredStuck)).toMatchObject({
      turn: { kind: "observed", field: { value: "stuck" } },
      health: { kind: "observed", field: { value: "delayed" } },
    });
    const projectedAgent = {
      ...agent,
      status: status.displayStatus(agent, fused),
      statusDimensions: status.dimensionsFrom(fused),
    };
    const activity = status.activitySnapshot({
      agent: projectedAgent,
      run,
      inspection,
      gitPaths: [],
      events: [],
      status: fused,
      observedAt: "2026-08-14T19:32:47.328Z",
    });
    const projection = compactActiveTeam(
      [projectedAgent],
      new Map(),
      new Map([[agent.id, activity]]),
    )[0];
    const recentOutcome = db.listRunOutcomes().at(-1);

    expect({
      providerRun: { state: run.state, endedAt: run.endedAt },
      recentRunOutcome:
        recentOutcome === undefined
          ? null
          : {
              outcome: recentOutcome.outcome,
              endedAt: recentOutcome.endedAt,
            },
      status: projection?.status,
      activity: projection?.activity,
    }).toMatchObject({
      providerRun: { state: "running", endedAt: null },
      recentRunOutcome: null,
      status: "working",
      activity: {
        terminalState: "present",
        providerState: "unmanaged",
        turnState: "working",
      },
    });
  } finally {
    await fixture.close();
  }
});

/**
 * A launch is recorded as started on the evidence that proved its process
 * alive. The reachability check can change none of that, so it must not be
 * consulted until the recording is complete — every part of it. Booking the row
 * ahead of the hierarchy binding alone would only move the lie: an agent that
 * reads `working` cannot make a hierarchy write until it is bound.
 *
 * Measured at the first consult, which is the one instant that distinguishes
 * the two orderings, and asserted on both facts. The spy answers false and the
 * poll then never returns, so a launch that waited for it could not settle.
 */
test("a launch is fully recorded before MCP reporting is consulted", async () => {
  const identity = {
    nodeId: "node_01a0020d-0000-7000-8000-000000000001",
    agentId: "agent-maude",
    generation: 1,
    capabilityEpoch: 1,
  };
  let bound: string | null = null;
  let seenAtFirstConsult: { status?: string; bound: string | null } | undefined;
  const fixture = await liveKimiLaunch({
    mcpClientSeen: (subject) => {
      seenAtFirstConsult ??= {
        ...(fixture.db.getLiveAgentByName(subject) === null
          ? {}
          : { status: fixture.db.getLiveAgentByName(subject)?.status }),
        bound,
      };
      return false;
    },
    // Readiness settles first, so only the reachability poll is left waiting here.
    sleep: async () => {
      if (seenAtFirstConsult !== undefined) await new Promise(() => {});
    },
    timeoutMs: 60_000,
    hierarchyAdmission: () =>
      ({
        preflight: () => identity,
        prepareLaunch: () => {},
        revalidateLaunch: () => {},
        takeLaunchContext: () => undefined,
        bindAfterReadiness: (_: unknown, credentialId: string) => {
          bound = credentialId;
        },
        failLaunch: () => {},
      }) as unknown as SpawnAdmission,
  });
  const { db, spawner } = fixture;

  try {
    const admitted = await spawner.spawn({
      task: "Report late after a live Kimi launch",
      category: "simple_coding",
      runId: "run_01a0020d-0000-7000-8000-000000000002",
    });
    await settled(db, admitted.name);

    expect(seenAtFirstConsult).toEqual({
      status: "working",
      bound: "credential-maude",
    });
    expect(db.isAgentNameReserved(admitted.name)).toBeFalse();
    // Still an observation and still not a verdict: the run stays open.
    expect(db.getActiveProviderRunForAgent(admitted.id)?.endedAt).toBeNull();
    expect(db.listRunOutcomes()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("a missing terminal is unknown rather than stuck", () => {
  const db = new HiveDatabase(":memory:");
  const locator = {
    schemaVersion: 1 as const,
    instanceId: "instance-fixture",
    subject: { kind: "agent" as const, agentId: "agent-maude" },
    generation: 1,
    sessionId: "ses_01a0020d-0000-7000-8000-000000000001",
    hostKind: "sessiond" as const,
    engineBuildId: "engine-test",
  };
  const agent: AgentRecord = {
    id: "agent-maude",
    name: "maude",
    tool: "kimi",
    model: "kimi-code/k3",
    category: "simple_coding",
    status: "working",
    taskDescription: "Continue a quiet turn",
    worktreePath: "/bounded/maude",
    branch: "hive/maude",
    sessionLocator: locator,
    contextPct: null,
    createdAt: "2026-08-14T19:31:13.902Z",
    lastEventAt: "2026-08-14T19:31:17.000Z",
    capabilityEpoch: 1,
    readOnly: false,
    writeRevoked: false,
  };
  db.insertAgent(agent);
  db.bindTerminalHostSession({
    locator,
    visibility: {
      workspaceSessionId: "workspace-fixture",
      workspacePid: 3_800,
      workspaceStartToken: "3800:1",
      openTerminalRevision: "1",
    },
  });
  db.completeTerminalHostSession(locator, {
    expectedExecutable: "bun",
    executableVerified: true,
    verifiedShellRoot: null,
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    visibility: {
      state: "visible",
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2026-08-14T20:31:13.902Z",
    },
  });
  const runId = "01a0020d-0000-7000-8000-000000000002";
  db.insertProviderRun({
    runId,
    agentId: agent.id,
    terminal: locator,
    provider: agent.tool,
    model: agent.model,
    effort: null,
    conversationId: null,
    adapterChild: null,
    protocolReceipt: null,
    capabilityEpoch: agent.capabilityEpoch,
    launchGrantId: "launch-fixture",
    startedAt: agent.createdAt,
    endedAt: null,
    state: "running",
    exitReason: null,
  });
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: {
      async spawn() {
        return agent;
      },
    },
    repoRoot: process.cwd(),
  });
  const project = (
    daemon as unknown as {
      statusLiveness(
        current: AgentRecord,
        sessions: readonly SessionInspection[] | null,
      ): AgentRecord;
    }
  ).statusLiveness.bind(daemon);

  expect(project(agent, [presentInspection(locator)]).status).toBe("working");
  expect(project(agent, []).status).toBe("unknown");
  db.close();
});
