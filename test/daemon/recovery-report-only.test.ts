// The crash-recovery sweep observes and reports; it never closes an agent.
//
// The three claims here are the whole of that contract. The first is the
// regression: before this change the sweep called markAgentDead on its own, so
// a false reading of "the terminal is gone" cost a living agent its row, its
// capability, and its quota. Now the row is the owner's to close, and a wrong
// report costs one glance.
//
// The evidence bar is the second claim. Every branch that reports must have
// watched something disappear — a terminal session, a provider run. An absent
// heartbeat is not death: kimi's lastEventAt freezes at spawn, so a clock-keyed
// death is a report about missing instrumentation, and it has twice been wrong.
// The third test pins the report's identity off that clock for the same reason.
import { describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { CrashRecovery } from "../../src/daemon/recovery/recovery-service";
import type { SessionInspection } from "../../src/daemon/session-host/session-host-contract";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";

const AGENT_ID = "018f1e90-7b5a-7cc0-8000-0000000005a1";
const SPAWNED_AT = "2026-08-02T09:00:00.000Z";

const locator = {
  schemaVersion: 1 as const,
  instanceId: "recovery-report-fixture",
  subject: { kind: "agent" as const, agentId: AGENT_ID },
  generation: 1,
  sessionId: "ses_018f1e90-7b5a-7cc0-8000-0000000005a2",
  hostKind: "sessiond" as const,
  engineBuildId: "engine-fixture",
};

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: AGENT_ID,
    name: "kimi-victim",
    tool: "kimi",
    model: "kimi-k2",
    category: "simple_coding",
    status: "working",
    taskDescription: "Land the lifecycle milestone",
    worktreePath: "/tmp/hive-kimi-victim",
    branch: "hive/kimi-victim-lifecycle",
    contextPct: 30,
    createdAt: SPAWNED_AT,
    lastEventAt: SPAWNED_AT,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    sessionLocator: locator,
    ...overrides,
  };
}

/** A session that is positively gone: the host says the shell exited and the
 * provider run reconciles to nothing. Neither reading is a clock. */
function exitedInspection(): SessionInspection {
  return {
    schemaVersion: 1,
    locator,
    presence: "exited",
    complete: true,
    hostPid: null,
    hostStartToken: null,
    shellRoot: null,
    foreground: { state: "shell-idle", runId: null },
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    outputSeq: "0",
    checkpointSeq: "0",
    checkpointAvailable: false,
    input: { state: "CLOSED", ownerViewerId: null, claimId: null },
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
      state: "expired",
      workspaceSessionId: "workspace-fixture",
      openTerminalRevision: "1",
      expiresAt: "2026-08-02T09:00:15.000Z",
    },
    exit: { code: 1, signal: null, observedAt: "2026-08-02T09:05:00.000Z" },
    survivors: [],
    evidenceAt: "2026-08-02T09:05:00.000Z",
    diagnosticIds: [],
  };
}

type Published = {
  from: string;
  to: string;
  body: string;
  idempotencyKey: string | undefined;
};

function recoveryOver(db: HiveDatabase): {
  recovery: CrashRecovery;
  published: Published[];
} {
  const published: Published[] = [];
  const recovery = new CrashRecovery({
    db,
    terminalHost: {
      reconcileProviderRun: () => null,
      inspect: async () => exitedInspection(),
      terminate: async () => {
        throw new Error("the sweep must not terminate a session");
      },
    },
    publish: async (from, to, body, options) => {
      published.push({
        from,
        to,
        body,
        idempotencyKey: options?.idempotencyKey,
      });
    },
    mail: {
      getItem: () => null,
      unsettledMailCount: () => 2,
    },
  });
  return { recovery, published };
}

describe("the crash-recovery sweep", () => {
  test("leaves the agent row exactly as it found it", async () => {
    const db = new HiveDatabase(":memory:");
    const before = db.upsertAgent(agent());
    const { recovery } = recoveryOver(db);

    const outcomes = await recovery.sweep();

    // Positive control: the sweep did reach this agent. Without it, a sweep
    // that skipped every row would satisfy the equality below.
    expect(outcomes).toEqual([
      {
        agent: "kimi-victim",
        action: "reported",
        reason: "its terminal is gone",
      },
    ]);
    // The whole row, not a status spot-check: capability epoch, worktree path,
    // and branch all have to survive too, and the worktree they name is only
    // ever removed by the owner-commanded kill path.
    expect(db.getAgentById(AGENT_ID)).toEqual(before);
  });

  test("reports the evidence and both dispositions to the orchestrator", async () => {
    const db = new HiveDatabase(":memory:");
    db.upsertAgent(agent());
    const { recovery, published } = recoveryOver(db);

    await recovery.sweep();

    expect(published).toHaveLength(1);
    const report = published[0];
    if (report === undefined) throw new Error("no report was published");
    expect(report.from).toBe("hive-lifecycle");
    expect(report.to).toBe(ORCHESTRATOR_NAME);
    expect(report.body).toContain(
      "kimi-victim looks dead: its terminal is gone",
    );
    expect(report.body).toContain("Its record is unchanged");
    expect(report.body).toContain(
      "Worktree untouched at /tmp/hive-kimi-victim (branch hive/kimi-victim-lifecycle)",
    );
    expect(report.body).toContain("2 unsettled message(s)");
    expect(report.body).toContain("hive_mark_dead agent=kimi-victim");
    // The report must not tell the owner that /recover itself revives the
    // agent: recovery only ever reports evidence, so a re-run of /recover
    // on this same agent would just re-report the identical death.
    expect(report.body).not.toContain("hive_recover");
  });

  test("gives the report an identity that does not ride the agent's heartbeat", async () => {
    // A key carrying lastEventAt makes one death several reports on a live
    // clock and, on a frozen one, ties report identity to the exact field that
    // must never be evidence. Keyed on the agent alone, the 30 s tick coalesces.
    const db = new HiveDatabase(":memory:");
    const record = db.upsertAgent(agent());
    const { recovery, published } = recoveryOver(db);

    await recovery.sweep();
    db.upsertAgent({ ...record, lastEventAt: "2026-08-02T09:30:00.000Z" });
    await recovery.sweep();

    expect(published).toHaveLength(2);
    expect(published[0]?.idempotencyKey).toBe(`death-evidence:${AGENT_ID}`);
    expect(published[1]?.idempotencyKey).toBe(published[0]?.idempotencyKey);
  });
});

// /recover's named-agent form ("manual retry")
// calls recoverAgent, not sweep. It has to hold the same report-only contract:
// this is the path an operator reaches for expecting a "recovery", so it is
// the one most likely to be mistaken for a relaunch if the two ever drift.
describe("recoverAgent (/recover's manual, named-agent form)", () => {
  test("reports the same evidence as the sweep and never touches the row or the terminal", async () => {
    const db = new HiveDatabase(":memory:");
    const before = db.upsertAgent(agent());
    const { recovery, published } = recoveryOver(db);

    // The stubbed terminalHost.terminate() throws if called (see recoveryOver
    // above), so a relaunch attempt here would fail the test, not pass it
    // quietly. inspect()/reconcileProviderRun() are stubbed to report the
    // terminal exited, matching the sweep's fixture exactly.
    const outcome = await recovery.recoverAgent("kimi-victim");

    expect(outcome).toEqual({
      agent: "kimi-victim",
      action: "reported",
      reason: "its terminal is gone",
    });
    expect(db.getAgentById(AGENT_ID)).toEqual(before);
    expect(published).toHaveLength(1);
    expect(published[0]?.body).toContain("kimi-victim looks dead");
  });
});
