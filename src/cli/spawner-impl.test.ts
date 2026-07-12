import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalAdapter } from "../adapters/terminal";
import type { ShadowSpawn } from "../daemon/routing-shadow";
import {
  accountBillingFromCodexRateLimits,
  type AccountBilling,
} from "../daemon/usage-credits";
import type { Approval } from "../daemon/db";
import { CLAUDE_CHANNELS_FLAG } from "../adapters/tools/claude";
import {
  DEFAULT_ROUTING,
  QuotaConfigSchema,
  isLiveAgent,
  known,
  unknown,
} from "../schemas";
import type {
  AgentRecord,
  AgentMessage,
  CapabilityRecord,
  Route,
  RoutingTier,
  TerminalHandle,
} from "../schemas";
import {
  buildAgentPrompt,
  buildLandingProtocol,
  CODING_GUIDELINES,
  HIVE_PROTOCOL_RULES,
  HiveSpawner,
  LANDING_MAX_ATTEMPTS,
  NAME_POOL,
  resolveAgentName,
  selectAgentName,
} from "../daemon/spawner-impl";
import { HiveDatabase } from "../daemon/db";
import { QuotaLedger } from "../daemon/quota-ledger";
import { QuotaService } from "../daemon/quota";
import { agentTmuxSession } from "../daemon/tmux-sessions";
import type { CapabilityDiscoveryResult } from "../daemon/capability-discovery";

const timestamp = "2026-07-09T12:00:00.000Z";
const tempRoots: string[] = [];

function capabilityRecord(
  provider: "claude" | "codex",
  model: string,
  levels: string[],
): CapabilityRecord {
  const surface = provider === "claude"
    ? "claude.initialize" as const
    : "codex.model/list" as const;
  return {
    provider,
    accountFingerprint: "account",
    cliVersion: "test",
    canonicalId: model,
    variant: null,
    launchToken: model,
    displayName: null,
    aliases: [],
    entitled: known(true, surface, timestamp),
    hidden: unknown("surface-silent", surface, timestamp),
    supportsEffort: provider === "claude"
      ? known(true, surface, timestamp)
      : unknown("surface-silent", surface, timestamp),
    supportedEffortLevels: known(levels, surface, timestamp),
    defaultEffort: provider === "codex"
      ? known(levels[0]!, surface, timestamp)
      : unknown("surface-silent", surface, timestamp),
    observedAt: timestamp,
  };
}

const discovery = (record: CapabilityRecord): CapabilityDiscoveryResult => ({
  status: "ok" as const,
  records: [record],
  effectiveDefault: {
    provider: record.provider,
    model: known(record.canonicalId, record.provider === "claude"
      ? "claude.initialize"
      : "codex.model/list", timestamp),
    effort: unknown("surface-silent", record.provider === "claude"
      ? "claude.initialize"
      : "codex.model/list", timestamp),
  },
});

const fakeResolveModel = async (
  tool: Route["tool"],
  route: Route,
): Promise<string> => {
  const configured = route[tool].model;
  if (tool === "claude" && configured === "best") {
    return "claude-fable-5";
  }
  if (configured === "default") {
    return tool === "claude" ? "claude-fable-5[1m]" : "gpt-5.6-sol";
  }
  return configured;
};

/** A holder that has closed, and whose name is therefore legal to reissue. */
function closedAgent(name: string, closedAt: string): AgentRecord {
  return { ...agent(name, "done"), closedAt, lastEventAt: closedAt };
}

/** True when one insertion, deletion, or substitution turns `a` into `b`. */
function editDistanceWithin1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (short.length === long.length) i += 1;
    j += 1;
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

function agent(
  name: string,
  status: AgentRecord["status"] = "working",
): AgentRecord {
  return {
    id: `agent-${name}`,
    name,
    tool: "codex",
    model: "gpt-test",
    tier: "standard",
    status,
    taskDescription: "Test task",
    worktreePath: `/tmp/${name}`,
    branch: `hive/${name}-test`,
    tmuxSession: `hive-${name}`,
    contextPct: 0,
    createdAt: timestamp,
    lastEventAt: timestamp,
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    writeRevoked: false,
    channelsEnabled: false,
  };
}

function makeControlQuota(root: string): {
  db: HiveDatabase;
  quota: QuotaService;
} {
  const db = new HiveDatabase(join(root, "control-quota.db"));
  return {
    db,
    quota: new QuotaService(
      new QuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    ),
  };
}

function controlMessage(id: string, epoch = 1): AgentMessage {
  return {
    id,
    from: "orchestrator",
    to: "maya",
    body: "Pause before coding.",
    createdAt: timestamp,
    deliveredAt: null,
    priority: "critical",
    intent: "pause",
    state: "queued",
    injectedAt: null,
    acknowledgedAt: null,
    appliedAt: null,
    deadlineAt: timestamp,
    alertAt: null,
    sequence: 1,
    idempotencyKey: null,
    capabilityEpoch: epoch,
  };
}

class FakeStore {
  readonly agents: AgentRecord[];
  readonly reservations = new Set<string>();
  /** The real approvals queue, in memory: the spend guard asks through it. */
  readonly approvals = new Map<string, Approval>();

  constructor(agents: AgentRecord[] = []) {
    this.agents = [...agents];
  }

  getApproval(id: string): Approval | null {
    return this.approvals.get(id) ?? null;
  }

  insertApproval(approval: Approval): Approval {
    this.approvals.set(approval.id, approval);
    return approval;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents];
  }

  getAgentById(id: string): AgentRecord | null {
    return this.agents.find((candidate) => candidate.id === id) ?? null;
  }

  getLiveAgentByName(name: string): AgentRecord | null {
    return this.agents.find(
      (candidate) => candidate.name === name && isLiveAgent(candidate),
    ) ?? null;
  }

  reserveAgentName(name: string): boolean {
    if (this.reservations.has(name)) {
      return false;
    }
    this.reservations.add(name);
    return true;
  }

  releaseAgentName(name: string): boolean {
    return this.reservations.delete(name);
  }

  insertAgent(record: AgentRecord): AgentRecord {
    const index = this.agents.findIndex((candidate) =>
      candidate.id === record.id
    );
    if (index === -1) {
      this.agents.push(record);
    } else {
      this.agents[index] = record;
    }
    return record;
  }

  attachTerminalHandle(
    id: string,
    handle: TerminalHandle,
  ): AgentRecord | null {
    const record = this.getAgentById(id);
    if (
      record === null || record.status === "dead" || record.status === "done" ||
      record.status === "failed"
    ) {
      return null;
    }
    return this.insertAgent({ ...record, terminalHandle: handle });
  }
}

/** The hardened readiness monitor treats poll exhaustion with no positive
 * signal as a failed launch, so every success-path spawn must show proof of
 * life. This sleep stands in for the agent's first hook event: each poll tick
 * promotes any still-"spawning" agent to "working", exactly what the daemon
 * does when a session-start or turn-start event arrives. Failure-path tests
 * keep a plain `async () => {}` sleep so exhaustion stays signal-free. */
/**
 * The brief no longer rides the tmux command line — it would not fit — so the
 * launch shell reads it from a file. Follow the same path the shell takes to see
 * what the agent was actually handed.
 */
async function deliveredPrompt(command: string): Promise<string> {
  const path = /\$\(cat '([^']+)'\)/.exec(command)?.[1];
  if (path === undefined) {
    throw new Error(`launch command carries no prompt file: ${command}`);
  }
  return await readFile(path, "utf8");
}

function signalReadiness(store: FakeStore): () => Promise<void> {
  return async () => {
    for (const current of store.listAgents()) {
      if (current.status === "spawning") {
        store.insertAgent({ ...current, status: "working" });
      }
    }
  };
}

/** Control restarts never sit in "spawning" — their monitor proves life by a
 * lastEventAt advance — so the stand-in hook event moves the clock instead. */
function signalControlReadiness(store: FakeStore): () => Promise<void> {
  return async () => {
    for (const current of store.listAgents()) {
      store.insertAgent({
        ...current,
        lastEventAt: new Date(Date.now() + 60_000).toISOString(),
      });
    }
  };
}

class FakeTmux {
  readonly sessions: Array<[string, string, string]> = [];
  readonly active = new Set<string>();
  readonly killed: string[] = [];
  hasSessionCalls = 0;
  capturePaneCalls = 0;

  constructor(readonly pane = "") {}

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    this.sessions.push([name, cwd, command]);
    this.active.add(name);
  }

  async hasSession(name: string): Promise<boolean> {
    this.hasSessionCalls += 1;
    return this.active.has(name);
  }

  async capturePane(_name: string): Promise<string> {
    this.capturePaneCalls += 1;
    return this.pane;
  }

  /** No fake session has real processes in it, and readiness is told exactly
   * that: unknown, which it never mistakes for life. */
  async listPanePids(_name: string): Promise<number[]> {
    return [];
  }

  async killSession(name: string): Promise<void> {
    this.killed.push(name);
    this.active.delete(name);
  }
}

class FakeTerminal implements TerminalAdapter {
  readonly windows: Array<[string, string]> = [];
  readonly closed: TerminalHandle[] = [];

  constructor(private readonly onOpen: () => void = () => {}) {}

  async openWindow(
    session: string,
    title: string,
  ): Promise<TerminalHandle> {
    this.windows.push([session, title]);
    this.onOpen();
    return { app: "iterm2", sessionId: `session-${session}` };
  }

  async closeWindow(handle: TerminalHandle): Promise<void> {
    this.closed.push(handle);
  }
}

class FlakyCaptureTmux extends FakeTmux {
  override async capturePane(name: string): Promise<string> {
    this.capturePaneCalls += 1;
    if (this.capturePaneCalls === 1) {
      throw new Error(`capture failed for ${name}`);
    }
    return this.pane;
  }
}

class FailingTerminal implements TerminalAdapter {
  async openWindow(
    _session: string,
    _title: string,
  ): Promise<TerminalHandle> {
    throw new Error("viewer unavailable");
  }

  async closeWindow(_handle: TerminalHandle): Promise<void> {}
}

// Claude spawns pre-accept folder trust in ~/.claude.json, and every launch now
// writes its brief under HIVE_HOME. Point both at throwaway directories so the
// suite never writes to the operator's real config.
let previousHome: string | undefined;
let previousHiveHome: string | undefined;
let claudeHomeRoot = "";

beforeAll(async () => {
  claudeHomeRoot = await mkdtemp(join(tmpdir(), "hive-spawner-home-"));
  previousHome = Bun.env.HOME;
  previousHiveHome = Bun.env.HIVE_HOME;
  Bun.env.HOME = claudeHomeRoot;
  Bun.env.HIVE_HOME = claudeHomeRoot;
});

afterAll(async () => {
  if (previousHome === undefined) {
    delete Bun.env.HOME;
  } else {
    Bun.env.HOME = previousHome;
  }
  if (previousHiveHome === undefined) {
    delete Bun.env.HIVE_HOME;
  } else {
    Bun.env.HIVE_HOME = previousHiveHome;
  }
  if (claudeHomeRoot !== "") {
    await rm(claudeHomeRoot, { recursive: true, force: true });
  }
});

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

describe("HiveSpawner name pool", () => {
  test("restarts both providers in a fresh read-only control process", async () => {
    for (const tool of ["claude", "codex"] as const) {
      const root = await mkdtemp(join(tmpdir(), `hive-control-${tool}-`));
      tempRoots.push(root);
      // The model has to belong to the tool that runs it. Pairing a Codex model
      // name with the Claude CLI is an identity that cannot exist, and the quota
      // ledger now refuses to bill one vendor's model to the other's meter.
      const model = tool === "claude" ? "claude-test" : "gpt-test";
      const controlled = {
        ...agent("maya", "control-paused"),
        tool,
        model,
        worktreePath: root,
        capabilityEpoch: 1,
        writeRevoked: true,
        executionIdentity: tool === "claude"
          ? { tool, model, effort: "high" }
          : { tool, model, effort: "high" },
      } satisfies AgentRecord;
      const controlQuota = makeControlQuota(root);
      const store = new FakeStore([controlled]);
      const tmux = new FakeTmux();
      const spawner = new HiveSpawner({
        db: store,
        repoRoot: root,
        port: 4317,
        config: { terminal: "auto", headless: true },
        routing: async () => {
          throw new Error("changed routing table must not be consulted");
        },
        tmux,
        terminal: new FakeTerminal(),
        sleep: signalControlReadiness(store),
        resolveModel: fakeResolveModel,
        quota: controlQuota.quota,
      });
      const message = {
        id: `control-${tool}`,
        from: "orchestrator",
        to: "maya",
        body: "Pause before coding.",
        createdAt: timestamp,
        deliveredAt: null,
        priority: "critical",
        intent: "pause",
        state: "queued",
        injectedAt: null,
        acknowledgedAt: null,
        appliedAt: null,
        deadlineAt: timestamp,
        alertAt: null,
        sequence: 1,
        idempotencyKey: null,
        capabilityEpoch: 1,
      } satisfies AgentMessage;
      await spawner.restartForControl(controlled, message);
      const command = tmux.sessions[0]?.[2] ?? "";
      // The order itself travels in the prompt file; the flags stay on the argv.
      const order = await deliveredPrompt(command);
      expect(order).toContain("CRITICAL HIVE CONTROL");
      expect(order).toContain("This process is read-only");
      expect(command).toContain(tool === "claude"
        ? "--permission-mode"
        : "--sandbox");
      expect(command).toContain(tool === "claude" ? "default" : "read-only");
      expect(command).toContain(model);
      expect(command).toContain("high");
      const restarted = store.getAgentById(controlled.id)!;
      expect(restarted.controlQuotaReservationId).toBeString();
      expect(
        controlQuota.quota.ledger.getReservation(
          restarted.controlQuotaReservationId!,
        ),
      ).toMatchObject({
        purpose: "control",
        controlMessageId: message.id,
        status: "active",
      });
      controlQuota.db.close();
    }
  });

  test("control restart swaps the stale viewer for a fresh one and re-tiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-viewer-"));
    tempRoots.push(root);
    const staleHandle: TerminalHandle = {
      app: "iterm2",
      sessionId: "stale-viewer",
    };
    const controlled = {
      ...agent("maya", "working"),
      worktreePath: root,
      terminalHandle: staleHandle,
      executionIdentity: {
        tool: "codex",
        model: "gpt-test",
        effort: "medium",
      },
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const terminal = new FakeTerminal();
    let layoutRequests = 0;
    const controlQuota = makeControlQuota(root);
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal,
      sleep: signalControlReadiness(store),
      resolveModel: fakeResolveModel,
      onTerminalsChanged: () => {
        layoutRequests += 1;
      },
      quota: controlQuota.quota,
    });
    const restarted = await spawner.restartForControl(controlled, {
      id: "control-viewer",
      from: "orchestrator",
      to: "maya",
      body: "Pause before coding.",
      createdAt: timestamp,
      deliveredAt: null,
      priority: "critical",
      intent: "pause",
      state: "queued",
      injectedAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      deadlineAt: timestamp,
      alertAt: null,
      sequence: 1,
      idempotencyKey: null,
      capabilityEpoch: 1,
    });
    // The old lens pointed at the killed session; only the fresh one remains.
    expect(terminal.closed).toEqual([staleHandle]);
    expect(terminal.windows).toHaveLength(1);
    expect(terminal.windows[0]?.[0]).toEqual("hive-maya");
    expect(terminal.windows[0]?.[1]).toContain("maya");
    expect(restarted.terminalHandle).toEqual({
      app: "iterm2",
      sessionId: "session-hive-maya",
    });
    expect(layoutRequests).toEqual(1);
    controlQuota.db.close();
  });

  test("fails closed when the recorded model cannot launch and removes only its stale viewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-unavailable-"));
    tempRoots.push(root);
    const staleHandle = { app: "iterm2", sessionId: "stale" } as const;
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      capabilityEpoch: 1,
      writeRevoked: true,
      terminalHandle: staleHandle,
      executionIdentity: {
        tool: "codex",
        model: "removed-model",
        effort: "high",
      },
      model: "removed-model",
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux("Error: model not supported");
    const terminal = new FakeTerminal();
    const controlQuota = makeControlQuota(root);
    let layouts = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.cheap,
      tmux,
      terminal,
      sleep: async () => {},
      quota: controlQuota.quota,
      onTerminalsChanged: () => layouts += 1,
    });

    await expect(spawner.restartForControl(
      controlled,
      controlMessage("unavailable"),
    )).rejects.toThrow("removed-model could not be launched");
    const failed = store.getAgentById(controlled.id)!;
    expect(failed).toMatchObject({
      status: "control-paused",
      writeRevoked: true,
      controlMessageId: "unavailable",
    });
    expect(failed.failureReason).toContain("model not supported");
    expect(failed.terminalHandle).toBeUndefined();
    expect(terminal.closed).toEqual([staleHandle]);
    expect(terminal.windows).toEqual([]);
    expect(layouts).toEqual(1);
    expect(
      controlQuota.quota.ledger.getReservation(
        failed.controlQuotaReservationId!,
      )?.status,
    ).toEqual("released");
    controlQuota.db.close();
  });

  test("legacy rows without immutable launch fields remain revoked and visibly pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-legacy-"));
    tempRoots.push(root);
    const staleHandle = { app: "iterm2", sessionId: "legacy-viewer" } as const;
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      writeRevoked: true,
      capabilityEpoch: 1,
      terminalHandle: staleHandle,
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const terminal = new FakeTerminal();
    let routeReads = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => {
        routeReads += 1;
        return DEFAULT_ROUTING.standard;
      },
      tmux: new FakeTmux(),
      terminal,
    });

    await expect(spawner.restartForControl(
      controlled,
      controlMessage("legacy"),
    )).rejects.toThrow("legacy/unresolved row");
    expect(routeReads).toEqual(0);
    expect(store.getAgentById(controlled.id)).toMatchObject({
      status: "control-paused",
      writeRevoked: true,
      controlMessageId: "legacy",
    });
    expect(store.getAgentById(controlled.id)?.failureReason).toContain(
      "legacy or unresolved-default",
    );
    expect(terminal.closed).toEqual([staleHandle]);
  });

  test("insufficient control quota never launches or changes the recorded model", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-exhausted-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({
        estimates: { deep: 20, standard: 10, cheap: 4, review: 8 },
        limits: [{
          provider: "codex",
          pool: "codex",
          models: ["gpt-test"],
          fiveHourAllowance: 5,
          weeklyAllowance: 5,
        }],
      }),
      () => new Date(timestamp),
    );
    const staleHandle = { app: "iterm2", sessionId: "exhausted" } as const;
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      writeRevoked: true,
      capabilityEpoch: 1,
      terminalHandle: staleHandle,
      executionIdentity: {
        tool: "codex",
        model: "gpt-test",
        effort: "xhigh",
      },
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux();
    const terminal = new FakeTerminal();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => ({
        ...DEFAULT_ROUTING.standard,
        tool: "claude",
        codex: { model: "different-model", effort: "minimal" },
      }),
      tmux,
      terminal,
      quota,
    });

    await expect(spawner.restartForControl(
      controlled,
      controlMessage("exhausted"),
    )).rejects.toThrow("Insufficient quota");
    expect(tmux.sessions).toHaveLength(0);
    expect(terminal.windows).toHaveLength(0);
    expect(terminal.closed).toEqual([staleHandle]);
    expect(store.getAgentById(controlled.id)).toMatchObject({
      model: "gpt-test",
      executionIdentity: controlled.executionIdentity,
      status: "control-paused",
      writeRevoked: true,
      controlMessageId: "exhausted",
    });
    expect(store.getAgentById(controlled.id)?.failureReason).toContain(
      "will not switch models",
    );
    quotaDb.close();
  });

  test("reserves the orchestrator destination from agent assignment", () => {
    expect(() => resolveAgentName("orchestrator", [])).toThrow(
      'Agent name "orchestrator" is reserved',
    );
  });

  test("prefers a never-used name over a closed one", () => {
    // david and sam are closed and their names are legal to reuse, but a name
    // this Hive has never issued is always the better answer.
    expect(selectAgentName([
      agent("maya"),
      agent("david", "dead"),
      agent("sam", "done"),
    ])).toEqual("john");
  });

  test("the pool is large, typeable, and mutually unconfusable", () => {
    expect(NAME_POOL.length).toBeGreaterThanOrEqual(300);
    expect(new Set(NAME_POOL).size).toEqual(NAME_POOL.length);
    // Names that would be ambiguous when spoken to the orchestrator: the
    // reserved destination, the tools, and the human running the Hive.
    for (const reserved of ["orchestrator", "claude", "codex", "hive", "scott"]) {
      expect(NAME_POOL).not.toContain(reserved);
    }
    for (const name of NAME_POOL) {
      // Short, lowercase letters only: no digits anywhere, so no name in the
      // pool can be mistaken for a maya-2 style suffix.
      expect(name).toMatch(/^[a-z]{3,10}$/);
    }

    const offenders: string[] = [];
    for (let i = 0; i < NAME_POOL.length; i += 1) {
      for (let j = i + 1; j < NAME_POOL.length; j += 1) {
        const a = NAME_POOL[i]!;
        const b = NAME_POOL[j]!;
        if (a.startsWith(b) || b.startsWith(a)) offenders.push(`prefix ${a}/${b}`);
        else if (editDistanceWithin1(a, b)) offenders.push(`one edit ${a}/${b}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("reuses the least-recently-closed name once no fresh name is left", () => {
    // Every pool name has been used. maya closed first, so maya comes back —
    // and only maya; reuse is by closure order, never by pool order.
    const agents = NAME_POOL.map((name, index) =>
      closedAgent(name, `2026-07-09T12:${String(index % 60).padStart(2, "0")}:00.000Z`)
    );
    agents[0] = closedAgent("maya", "2026-07-01T00:00:00.000Z");
    expect(selectAgentName(agents)).toEqual("maya");
  });

  test("never reuses a name whose holder is still spawning or recovering", () => {
    // maya is the oldest holder by clock, but she is spawning, not closed.
    // A spawning agent owns its name exactly as a working one does.
    const agents = NAME_POOL.map((name, index) =>
      closedAgent(name, `2026-07-09T12:${String(index % 60).padStart(2, "0")}:00.000Z`)
    );
    agents[0] = { ...agent("maya", "spawning"), lastEventAt: "2026-07-01T00:00:00.000Z" };
    agents[1] = closedAgent("david", "2026-07-02T00:00:00.000Z");

    expect(selectAgentName(agents)).toEqual("david");
  });

  test("a closed name is never reissued while a live holder already has it", () => {
    // maya was reused: an old closed holder and the current live one coexist.
    // The name is taken, so the next spawn must look elsewhere.
    const agents = NAME_POOL.map((name, index) =>
      closedAgent(name, `2026-07-09T12:${String(index % 60).padStart(2, "0")}:00.000Z`)
    );
    agents[0] = closedAgent("maya", "2026-07-01T00:00:00.000Z");
    agents.push({ ...agent("maya", "working"), id: "maya-second-holder" });
    agents[1] = closedAgent("david", "2026-07-02T00:00:00.000Z");

    expect(selectAgentName(agents)).toEqual("david");
  });

  test("refuses the spawn when every name has a live holder", () => {
    // No suffixing, no stealing a live name: an honest refusal naming the fix.
    expect(() => selectAgentName(NAME_POOL.map((name) => agent(name))))
      .toThrow("name pool exhausted");
    expect(() => selectAgentName(NAME_POOL.map((name) => agent(name))))
      .toThrow("never appends a numeric suffix");
    expect(() => selectAgentName(NAME_POOL.map((name) => agent(name))))
      .toThrow("expand NAME_POOL");
  });

  test("an explicitly requested name is refused while its holder is live", () => {
    expect(() => resolveAgentName("maya", [agent("maya", "working")]))
      .toThrow('"maya" is already assigned to a live agent');
    expect(() => resolveAgentName("maya", [agent("maya", "spawning")]))
      .toThrow('"maya" is already assigned to a live agent');
  });

  test("an explicitly requested name is allowed once its holder has closed", () => {
    expect(resolveAgentName("maya", [agent("maya", "dead")])).toEqual("maya");
  });

  test("concurrent spawns never receive the same name", async () => {
    const store = new FakeStore();
    let releaseRouting!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRouting = resolve;
    });
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: "/tmp/hive-concurrent-names",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => {
        await gate;
        return DEFAULT_ROUTING.standard;
      },
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      // Fail after the name is claimed: the claim is what this test is about.
      createWorktree: async () => {
        throw new Error("stop after routing");
      },
      sleep: async () => {},
      resolveModel: fakeResolveModel,
    });

    // Every spawn is in flight at once, before any of them writes an agent row,
    // so only the reservation table can keep their names apart.
    const spawns = Array.from({ length: 8 }, (_, index) =>
      spawner.spawn({ task: `Task ${index}`, tier: "standard" })
    );
    const claimed = [...store.reservations];
    expect(claimed.length).toEqual(8);
    expect(new Set(claimed).size).toEqual(8);
    expect(claimed).toEqual(NAME_POOL.slice(0, 8) as unknown as string[]);

    releaseRouting();
    await Promise.allSettled(spawns);
    expect(store.reservations.size).toEqual(0);
  });

  test("reserves a requested name before asynchronous spawn setup", async () => {
    const store = new FakeStore();
    let continueRouting!: () => void;
    const routingGate = new Promise<void>((resolve) => {
      continueRouting = resolve;
    });
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: "/tmp/hive-reservation-race",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => {
        await routingGate;
        return DEFAULT_ROUTING.standard;
      },
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        throw new Error("stop after routing");
      },
      sleep: async () => {},
      resolveModel: fakeResolveModel,
    });

    const first = spawner.spawn({
      task: "First task",
      tier: "standard",
      name: "cara",
    });
    expect(store.reservations.has("cara")).toEqual(true);
    await expect(spawner.spawn({
      task: "Conflicting task",
      tier: "standard",
      name: "cara",
    })).rejects.toThrow('"cara" is already being assigned');

    continueRouting();
    await expect(first).rejects.toThrow("stop after routing");
    expect(store.reservations.has("cara")).toEqual(false);
  });

  test("reports exhaustion when every pool name is live", () => {
    expect(() => selectAgentName(NAME_POOL.map((name) => agent(name))))
      .toThrow("name pool exhausted");
  });

  test("fails from the fake database before creating a worktree when exhausted", async () => {
    const store = new FakeStore(NAME_POOL.map((name) => agent(name)));
    let attemptedWorktree = false;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: "/tmp/hive-exhausted",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({ task: "One task too many", tier: "deep" }))
      .rejects.toThrow("name pool exhausted");
    expect(attemptedWorktree).toEqual(false);
  });

  test("rejects an invalid requested name before creating a worktree", async () => {
    let attemptedWorktree = false;
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: "/tmp/hive-invalid-name",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Bad name",
      tier: "standard",
      name: "1Maya",
    })).rejects.toThrow("must match /^[a-z][a-z0-9-]{1,20}$/");
    expect(attemptedWorktree).toEqual(false);
  });

  test("rejects a requested name held by a live agent", async () => {
    const spawner = new HiveSpawner({
      db: new FakeStore([agent("maya")]),
      repoRoot: "/tmp/hive-collision",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        throw new Error("worktree must not be created");
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Duplicate name",
      tier: "standard",
      name: "MAYA",
    })).rejects.toThrow('"maya" is already assigned to a live agent');
  });

  test("rejects the reserved orchestrator name before creating a worktree", async () => {
    let attemptedWorktree = false;
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: "/tmp/hive-reserved-name",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Impersonate the boss",
      tier: "standard",
      name: "Orchestrator",
    })).rejects.toThrow('"orchestrator" is reserved');
    expect(attemptedWorktree).toEqual(false);
  });
});

describe("HiveSpawner wiring", () => {
  test("launches the interactive Codex TUI by default even when app-server is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-tui-default-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const store = new FakeStore();
    let probedAppServer = false;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({
        ...DEFAULT_ROUTING.standard,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
      codexAppServer: {
        isAvailable: async () => {
          probedAppServer = true;
          return true;
        },
        buildHostCommand: () => ["hive", "codex-app-server-host"],
        startAgent: async () => {},
        disconnect: () => undefined,
      },
    });

    await spawner.spawn({ task: "Visible interactive task", tier: "standard" });
    expect(probedAppServer).toEqual(false);
    expect(tmux.sessions).toHaveLength(1);
    expect(tmux.sessions[0]?.[2]).toContain("'codex'");
    expect(tmux.sessions[0]?.[2]).toContain("--dangerously-bypass-hook-trust");
    expect(tmux.sessions[0]?.[2]).toContain("features.hooks=true");
    expect(await deliveredPrompt(tmux.sessions[0]?.[2] ?? "")).toContain(
      "Visible interactive task",
    );
    expect(tmux.sessions[0]?.[2]).not.toContain("codex-app-server-host");
  });

  test("launches Codex through the app-server host and delivers the assignment with turn/start", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-app-server-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const starts: Array<{ name: string; prompt: string; effort: string }> = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: {
        terminal: "auto",
        headless: true,
        codex: { driver: "app-server" },
      },
      routing: async () => ({
        ...DEFAULT_ROUTING.standard,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      codexAppServer: {
        isAvailable: async () => true,
        buildHostCommand: (value) => [
          "hive",
          "codex-app-server-host",
          "--agent",
          value.name,
        ],
        startAgent: async (value, prompt, _readOnly, effort) => {
          starts.push({ name: value.name, prompt, effort });
          store.insertAgent({ ...value, status: "working" });
        },
        disconnect: () => undefined,
      },
    });

    const spawned = await spawner.spawn({
      task: "Implement native control",
      tier: "standard",
    });
    expect(tmux.sessions[0]?.[2]).toContain("'codex-app-server-host'");
    expect(tmux.sessions[0]?.[2]).not.toContain("Implement native control");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ name: "maya", effort: "high" });
    expect(starts[0]?.prompt).toContain("Implement native control");
    expect(spawned.status).toEqual("working");
  });

  test("automatically replaces a failed app-server handshake with the tmux TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-app-fallback-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const disconnected: string[] = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: {
        terminal: "auto",
        headless: true,
        codex: { driver: "app-server" },
      },
      routing: async () => ({
        ...DEFAULT_ROUTING.standard,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      // The fallback TUI launch must still prove life on its own.
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
      codexAppServer: {
        isAvailable: async () => true,
        buildHostCommand: () => ["hive", "codex-app-server-host"],
        startAgent: async () => {
          throw new Error("handshake failed");
        },
        disconnect: (name) => {
          disconnected.push(name);
        },
      },
    });

    await spawner.spawn({ task: "Fallback task", tier: "standard" });
    expect(disconnected).toEqual(["maya"]);
    expect(tmux.killed).toEqual([agentTmuxSession("maya")]);
    expect(tmux.sessions).toHaveLength(2);
    expect(tmux.sessions[1]?.[2]).toContain("'codex'");
    expect(tmux.sessions[1]?.[2]).toContain("--dangerously-bypass-hook-trust");
    expect(tmux.sessions[1]?.[2]).toContain("features.hooks=true");
    expect(await deliveredPrompt(tmux.sessions[1]?.[2] ?? "")).toContain(
      "Fallback task",
    );
  });

  test("reserves quota before worktree creation and launches the selected fallback model", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-quota-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({
        reserveFiveHourPct: 0,
        reserveWeeklyPct: 0,
        limits: [
          {
            provider: "claude",
            account: "default",
            pool: "claude",
            models: ["claude-fable-5"],
            fiveHourAllowance: 20,
            weeklyAllowance: 20,
          },
          {
            provider: "codex",
            account: "default",
            pool: "codex",
            models: ["gpt-5.6-sol"],
            fiveHourAllowance: 100,
            weeklyAllowance: 100,
          },
        ],
      }),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
      quota,
    });

    const spawned = await spawner.spawn({ task: "Deep task", tier: "deep" });
    expect(spawned.tool).toEqual("codex");
    expect(spawned.model).toEqual("gpt-5.6-sol");
    expect(spawned.quotaReservationId).toBeString();
    expect(tmux.sessions[0]?.[2]).toContain("'codex'");
    expect(
      quota.ledger.getReservation(spawned.quotaReservationId!)?.startedAt,
    ).not.toEqual(null);
    quotaDb.close();
  });

  test("filters capability before quota and reserves the selected effort triple", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-quota-effort-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({}),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const probes: Array<"claude" | "codex"> = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      routingPins: async () => ({}),
      discoverCapabilities: async (provider) => {
        probes.push(provider);
        return discovery(
          provider === "claude"
            ? capabilityRecord("claude", "claude-opus-4-8", ["low", "high"])
            : capabilityRecord("codex", "gpt-5.6-sol", ["low", "ultra"]),
        );
      },
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: async (tool) =>
        tool === "claude" ? "claude-opus-4-8" : "gpt-5.6-sol",
      quota,
    });

    const spawned = await spawner.spawn({
      task: "Route only among effort-eligible candidates",
      tier: "deep",
      effort: "ultra",
    });
    expect(probes.sort()).toEqual(["claude", "codex"]);
    expect(spawned.executionIdentity).toEqual({
      tool: "codex",
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(quota.ledger.getReservation(spawned.quotaReservationId!))
      .toMatchObject({
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: "ultra",
      });
    expect(tmux.sessions[0]?.[2]).toContain("model_reasoning_effort=ultra");
    quotaDb.close();
  });

  test("routes a deep-tier Claude spawn to Opus 4.8 when Fable's pool is under quota pressure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-quota-opus-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({
        reserveFiveHourPct: 0,
        reserveWeeklyPct: 0,
        limits: [
          {
            // Deliberately under the deep-tier estimate (20): every
            // reservation attempt against Fable's pool must fail.
            provider: "claude",
            account: "default",
            pool: "claude-fable",
            models: ["claude-fable-5"],
            fiveHourAllowance: 10,
            weeklyAllowance: 10,
          },
          {
            provider: "claude",
            account: "default",
            pool: "claude-opus",
            models: ["claude-opus-4-8"],
            fiveHourAllowance: 100,
            weeklyAllowance: 100,
          },
          {
            provider: "codex",
            account: "default",
            pool: "codex",
            models: ["gpt-5.6-sol"],
            fiveHourAllowance: 100,
            weeklyAllowance: 100,
          },
        ],
      }),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      // Deep tier's default route still resolves "best" to Fable before the
      // 2026-07-12 auto-routing cutoff; the release valve to Opus 4.8 is
      // quota-pressure-driven and applies independently of that date.
      routing: async () => DEFAULT_ROUTING.deep,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
      quota,
    });

    const spawned = await spawner.spawn({ task: "Deep task", tier: "deep" });
    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("claude-opus-4-8");
    expect(spawned.quotaReservationId).toBeString();
    expect(
      quota.ledger.getReservation(spawned.quotaReservationId!)?.pool,
    ).toEqual("claude-opus");
    quotaDb.close();
  });

  test("launches an explicit request model verbatim on the route's preferred tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-explicit-model-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    const spawned = await spawner.spawn({
      task: "Open an Opus terminal",
      tier: "deep",
      model: "claude-opus-4-8",
    });
    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("claude-opus-4-8");
    expect(spawned.executionIdentity).toEqual({
      tool: "claude",
      model: "claude-opus-4-8",
    });
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'claude-opus-4-8'");
  });

  test("rejects an effort the selected model positively excludes before creating a worktree", async () => {
    let created = false;
    const record = capabilityRecord(
      "claude",
      "claude-opus-4-8",
      ["low", "medium", "high"],
    );
    const spawner = new HiveSpawner({
      db: new FakeStore(),
      repoRoot: "/tmp/hive-effort-reject",
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      routingPins: async () => ({}),
      discoverCapabilities: async () => discovery(record),
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async () => {
        created = true;
        return { path: "/tmp/unused", branch: "hive/unused" };
      },
    });

    await expect(spawner.spawn({
      task: "Reject invalid effort",
      tier: "deep",
      model: "claude-opus-4-8",
      effort: "max",
    })).rejects.toThrow(
      "supported effort levels are low, medium, high",
    );
    expect(created).toBe(false);
  });

  test("passes and persists explicit Claude effort on the real spawn path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-effort-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const record = capabilityRecord(
      "claude",
      "claude-opus-4-8",
      ["low", "medium", "high"],
    );
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      routingPins: async () => ({}),
      discoverCapabilities: async () => discovery(record),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    const spawned = await spawner.spawn({
      task: "Launch explicit effort",
      tier: "deep",
      model: "claude-opus-4-8",
      effort: "low",
    });
    expect(spawned.executionIdentity).toEqual({
      tool: "claude",
      model: "claude-opus-4-8",
      effort: "low",
    });
    expect(tmux.sessions[0]?.[2]).toContain("'--effort' 'low'");
  });

  test("passes and persists explicit Codex effort on the real spawn path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-codex-effort-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const record = capabilityRecord(
      "codex",
      "gpt-test",
      ["low", "medium", "high", "ultra"],
    );
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      routingPins: async () => ({}),
      discoverCapabilities: async () => discovery(record),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    const spawned = await spawner.spawn({
      task: "Launch explicit Codex effort",
      tier: "standard",
      tool: "codex",
      model: "gpt-test",
      effort: "ultra",
    });
    expect(spawned.executionIdentity).toEqual({
      tool: "codex",
      model: "gpt-test",
      effort: "ultra",
    });
    expect(tmux.sessions[0]?.[2]).toContain("model_reasoning_effort=ultra");
  });

  test("an explicit claude model forces the claude tool off a codex-routed tier", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-vendor-force-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      // The field failure: tier=standard routes tool=codex, and the explicit
      // claude model used to ride onto the Codex TUI verbatim.
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    const spawned = await spawner.spawn({
      task: "Open an Opus terminal",
      tier: "standard",
      model: "claude-opus-4-8",
    });
    expect(spawned.tool).toEqual("claude");
    expect(spawned.executionIdentity).toEqual({
      tool: "claude",
      model: "claude-opus-4-8",
    });
  });

  test("an explicit model conflicting with an explicit tool refuses the spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-vendor-conflict-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
      resolveModel: fakeResolveModel,
    });

    await expect(spawner.spawn({
      task: "Impossible identity",
      tier: "standard",
      tool: "codex",
      model: "claude-opus-4-8",
    })).rejects.toThrow(/claude model.*tool="codex"/s);
    // The refused spawn must not leave a live agent row behind.
    expect(store.agents.filter((agent) => agent.status !== "failed"))
      .toHaveLength(0);
  });

  test("never substitutes another model for an explicit request model under quota pressure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-explicit-quota-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({
        reserveFiveHourPct: 0,
        reserveWeeklyPct: 0,
        limits: [
          {
            // Deliberately under the deep-tier estimate (20): the explicit
            // Fable request cannot be reserved.
            provider: "claude",
            account: "default",
            pool: "claude-fable",
            models: ["claude-fable-5"],
            fiveHourAllowance: 10,
            weeklyAllowance: 10,
          },
          {
            // The release valve target has plenty of headroom — but a
            // user-named model must fail rather than silently become Opus.
            provider: "claude",
            account: "default",
            pool: "claude-opus",
            models: ["claude-opus-4-8"],
            fiveHourAllowance: 100,
            weeklyAllowance: 100,
          },
        ],
      }),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      quota,
    });

    await expect(
      spawner.spawn({
        task: "Deep task",
        tier: "deep",
        model: "claude-fable-5",
      }),
    ).rejects.toThrow(/Quota pressure makes this spawn unsafe/);
    expect(tmux.sessions).toHaveLength(0);
    quotaDb.close();
  });

  test("writes tool configs, starts named sessions, opens viewers, and inserts records", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const terminal = new FakeTerminal();
    const routes: Record<"deep" | "standard", Route> = {
      deep: DEFAULT_ROUTING.deep,
      standard: {
        ...DEFAULT_ROUTING.standard,
        codex: { model: "gpt-test", effort: "medium" },
      },
    };
    const routing = async (tier: RoutingTier): Promise<Route> => {
      if (tier === "deep" || tier === "standard") {
        return routes[tier];
      }
      throw new Error(`Unexpected tier: ${tier}`);
    };
    const createWorktree = async (
      _repoRoot: string,
      name: string,
      slug: string,
    ) => {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      const skillPath = join(path, ".hive", "skills", "test-skill");
      await mkdir(skillPath, { recursive: true });
      await Bun.write(join(skillPath, "SKILL.md"), "# Test skill\n");
      return { path, branch: `hive/${name}-${slug}` };
    };
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing,
      tmux,
      terminal,
      createWorktree,
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    const claude = await spawner.spawn({ task: "Build auth API", tier: "deep" });
    const codex = await spawner.spawn({
      task: "Add route tests",
      tier: "standard",
    });

    expect(claude.name).toEqual("maya");
    // The stand-in hook event promoted the proven launch out of "spawning".
    expect(claude.status).toEqual("working");
    // A fresh agent's context is UNKNOWN, not empty. It used to spawn at 0, which
    // reads as "plenty of room" to the orchestrator's reuse rule and was never
    // corrected for any agent whose telemetry Hive could not read.
    expect(claude.contextPct).toBeNull();
    expect(codex.name).toEqual("david");
    expect(claude.terminalHandle).toEqual({
      app: "iterm2",
      sessionId: `session-${agentTmuxSession("maya")}`,
    });
    expect(codex.terminalHandle).toEqual({
      app: "iterm2",
      sessionId: `session-${agentTmuxSession("david")}`,
    });
    expect(store.agents).toEqual([claude, codex]);
    expect(tmux.sessions.map(([name]) => name)).toEqual([
      agentTmuxSession("maya"),
      agentTmuxSession("david"),
    ]);
    expect(tmux.sessions[0]?.[2]).toContain(
      "'--model' 'claude-fable-5'",
    );
    // An unattended agent can never answer the development-channels warning
    // dialog that this flag raises, so it must never appear in a spawn argv.
    expect(tmux.sessions[0]?.[2]).not.toContain(CLAUDE_CHANNELS_FLAG);
    expect(tmux.sessions[0]?.[2]).not.toContain("server:hive-channel");
    const mayaPrompt = await deliveredPrompt(tmux.sessions[0]?.[2] ?? "");
    expect(mayaPrompt).toContain("You are maya");
    // Every writer agent carries the landing protocol for its own branch.
    expect(mayaPrompt).toContain(`hive_land`);
    expect(tmux.sessions[1]?.[2]).toContain("'codex'");
    expect(tmux.sessions[1]?.[2]).toContain("--dangerously-bypass-hook-trust");
    expect(tmux.sessions[1]?.[2]).toContain("features.hooks=true");
    expect(await deliveredPrompt(tmux.sessions[1]?.[2] ?? "")).toContain(
      "You are david",
    );
    expect(claude.model).toEqual("claude-fable-5");
    expect(claude.executionIdentity).toEqual({
      tool: "claude",
      model: "claude-fable-5",
    });
    expect(codex.executionIdentity).toEqual({
      tool: "codex",
      model: "gpt-test",
      effort: "medium",
    });
    expect(terminal.windows).toEqual([
      [agentTmuxSession("maya"), "maya — claude-fable-5"],
      [agentTmuxSession("david"), "david — gpt-test"],
    ]);
    for (const [, title] of terminal.windows) {
      // Routing aliases must never surface: the title carries the concrete
      // model the tool actually runs.
      expect(title).not.toContain("best");
      expect(title).not.toContain("default");
      expect(title).not.toContain("hive-");
      expect(title).not.toContain("Build auth API");
      expect(title).not.toContain("Add route tests");
      expect(title).not.toContain(root);
      expect(title).not.toContain("deep");
      expect(title).not.toContain("standard");
      expect(title).not.toContain("tmux");
    }

    const claudeSettings = await readFile(
      join(root, "maya", ".claude", "settings.local.json"),
      "utf8",
    );
    const codexConfig = await readFile(
      join(root, "david", ".codex", "config.toml"),
      "utf8",
    );
    expect(claudeSettings).toContain("acceptEdits");
    expect(claudeSettings).toContain("hive event session-start --agent maya");
    expect(codexConfig).toContain("http://127.0.0.1:4317/mcp");
    expect(
      await realpath(join(root, "maya", ".claude", "skills", "test-skill")),
    ).toEqual(
      await realpath(join(root, "maya", ".hive", "skills", "test-skill")),
    );
    expect(
      await realpath(join(root, "david", ".agents", "skills", "test-skill")),
    ).toEqual(
      await realpath(join(root, "david", ".hive", "skills", "test-skill")),
    );
  });

  test("injects the merged repo+global memory index into a freshly spawned agent's prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-memory-"));
    tempRoots.push(root);
    const globalHome = await mkdtemp(join(tmpdir(), "hive-spawner-memory-home-"));
    tempRoots.push(globalHome);
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = globalHome;
    try {
      const worktreePath = join(root, "maya");
      const repoMemory = join(worktreePath, ".hive", "memory");
      await mkdir(repoMemory, { recursive: true });
      await Bun.write(
        join(repoMemory, "flaky-login-test.md"),
        "---\ntitle: The login test is flaky\ndate: 2026-06-01\ntags: [testing]\n---\n\nRace condition in session setup.\n",
      );
      const globalMemory = join(globalHome, "memory");
      await mkdir(globalMemory, { recursive: true });
      await Bun.write(
        join(globalMemory, "cli-distribution.md"),
        "---\ntitle: Python has a bad CLI distribution story\ndate: 2026-05-12\ntags: []\n---\n\nUse Bun instead.\n",
      );

      const store = new FakeStore();
      const tmux = new FakeTmux();
      const spawner = new HiveSpawner({
        db: store,
        repoRoot: root,
        port: 4317,
        config: { terminal: "auto", headless: true },
        routing: async () => DEFAULT_ROUTING.standard,
        tmux,
        terminal: new FakeTerminal(),
        createWorktree: async () => ({
          path: worktreePath,
          branch: "hive/maya-memory",
        }),
        resolveModel: fakeResolveModel,
        sleep: signalReadiness(store),
      });

      await spawner.spawn({ task: "Fix the flaky test", tier: "standard" });

      const launched = await deliveredPrompt(tmux.sessions[0]?.[2] ?? "");
      expect(launched).toContain("Hive memory index");
      expect(launched).toContain(
        "[repo] flaky-login-test (2026-06-01): The login test is flaky",
      );
      expect(launched).toContain(
        "[global] cli-distribution (2026-05-12): Python has a bad CLI distribution story",
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HIVE_HOME;
      } else {
        process.env.HIVE_HOME = previousHome;
      }
    }
  });

  test("short-circuits readiness when the persisted status leaves spawning", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-ready-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const tmux = new FakeTmux();
    let polls = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-ready",
      }),
      resolveModel: fakeResolveModel,
      sleep: async () => {
        polls += 1;
        const current = store.listAgents()[0];
        if (current !== undefined) {
          store.insertAgent({ ...current, status: "working" });
        }
      },
    });

    const spawned = await spawner.spawn({
      task: "Become ready during polling",
      tier: "standard",
    });

    expect(spawned.status).toEqual("working");
    expect(polls).toEqual(1);
    expect(tmux.hasSessionCalls).toEqual(0);
    expect(tmux.capturePaneCalls).toEqual(0);
    expect(tmux.killed).toEqual([]);
  });

  test("honors requested names and applies cross-vendor tool overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-override-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const createWorktree = async (
      _repoRoot: string,
      name: string,
      slug: string,
    ) => {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      return { path, branch: `hive/${name}-${slug}` };
    };
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async (tier) => DEFAULT_ROUTING[tier],
      tmux,
      terminal: new FakeTerminal(),
      createWorktree,
      claudeExecutable: "/daemon/native/claude",
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    const claude = await spawner.spawn({
      task: "Use Claude",
      tier: "standard",
      name: "Quinn-2",
      tool: "claude",
    });
    const codex = await spawner.spawn({
      task: "Use Codex",
      tier: "deep",
      name: "Riley",
      tool: "codex",
    });

    expect(claude.name).toEqual("quinn-2");
    expect(claude.tool).toEqual("claude");
    expect(claude.model).toEqual("sonnet");
    expect(tmux.sessions[0]?.[2]).toContain(
      "'/daemon/native/claude' '--model' 'sonnet'",
    );
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'sonnet'");
    expect(codex.name).toEqual("riley");
    expect(codex.tool).toEqual("codex");
    expect(codex.model).toEqual("gpt-5.6-sol");
    expect(tmux.sessions[1]?.[2]).toContain(
      "'model_reasoning_effort=high'",
    );
    expect(tmux.sessions[1]?.[2]).not.toContain("'model=default'");
  });

  test("uses the cheap Claude model for an explicit Claude override", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-cheap-claude-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.cheap,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Use cheap Claude",
      tier: "cheap",
      tool: "claude",
    });

    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("haiku");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'haiku'");
  });

  test("uses the tier's configured tool and its model without an override", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-configured-route-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.review,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Use configured review route",
      tier: "review",
    });

    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("sonnet");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'sonnet'");
  });

  test("marks pane errors failed, cleans up, and never opens a viewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-failed-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const pane = [
      ...Array.from({ length: 16 }, (_, index) => `startup line ${index + 1}`),
      "Error: model not supported for this account",
    ].join("\n");
    const store = new FakeStore();
    const tmux = new FakeTmux(pane);
    const terminal = new FakeTerminal();
    const removals: Array<[string, string]> = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-failing-launch",
      }),
      removeWorktree: async (repoRoot, path) => {
        removals.push([repoRoot, path]);
      },
      resolveModel: fakeResolveModel,
      sleep: async () => {},
    });

    const failed = await spawner.spawn({
      task: "Fail at startup",
      tier: "standard",
    });

    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("Error: model not supported");
    expect(failed.failureReason).not.toContain("startup line 1\n");
    expect(failed.failedAt).toBeDefined();
    expect(store.agents).toEqual([failed]);
    expect(tmux.killed).toEqual([agentTmuxSession("maya")]);
    expect(removals).toEqual([[root, worktreePath]]);
    expect(terminal.windows).toEqual([]);
  });

  test("reports a short-lived process exit marker instead of a raw tmux exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-exit-status-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const tmux = new FakeTmux([
      "The provider CLI could not initialize.",
      "[hive] process exited with status 1",
    ].join("\n"));
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-short-lived-launch",
      }),
      resolveModel: fakeResolveModel,
      sleep: async () => {},
    });

    const failed = await spawner.spawn({
      task: "Fail before readiness",
      tier: "standard",
    });

    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("provider CLI could not initialize");
    expect(failed.failureReason).toContain("process exited with status 1");
    expect(failed.failureReason).not.toEqual("tmux session exited");
  });

  test("does not treat incidental error text as a launch failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-error-text-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const tmux = new FakeTmux([
      "Task: fix the error handling",
      "typecheck complete: 2 errors found",
    ].join("\n"));
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-error-handling",
      }),
      resolveModel: fakeResolveModel,
      // The signal arrives a few ticks in, so the earlier iterations read the
      // pane and must shrug at the incidental error text rather than call it a
      // launch failure.
      sleep: (() => {
        let ticks = 0;
        return async () => {
          ticks += 1;
          if (ticks < 5) return;
          const current = store.listAgents()[0];
          if (current !== undefined) {
            store.insertAgent({ ...current, status: "working" });
          }
        };
      })(),
    });

    const spawned = await spawner.spawn({
      task: "Fix the error handling",
      tier: "standard",
    });

    expect(spawned.status).toEqual("working");
    expect(tmux.capturePaneCalls).toEqual(4);
    expect(tmux.killed).toEqual([]);
  });

  test("tolerates transient pane capture and viewer failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-transient-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const tmux = new FlakyCaptureTmux();
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FailingTerminal(),
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-transient",
      }),
      resolveModel: fakeResolveModel,
      // The signal arrives only on the final poll tick, so the transient
      // capture failure has to be survived, not shortcut around.
      sleep: (() => {
        let ticks = 0;
        return async () => {
          ticks += 1;
          if (ticks < 5) return;
          const current = store.listAgents()[0];
          if (current !== undefined) {
            store.insertAgent({ ...current, status: "working" });
          }
        };
      })(),
    });

    const spawned = await spawner.spawn({
      task: "Survive cosmetic failures",
      tier: "standard",
    });

    expect(spawned.status).toEqual("working");
    expect(tmux.capturePaneCalls).toEqual(4);
    expect(tmux.killed).toEqual([]);
  });

  test("fresh codex rollout activity is proof of life when no hook event ever arrives", async () => {
    // Native SessionStart is primary, but policy can disable hooks and hook
    // execution can fail. The rollout mtime must remain a readiness fallback.
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-codex-rollout-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const probed: string[] = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({
        ...DEFAULT_ROUTING.standard,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      // No hook event ever arrives: the DB row stays "spawning" throughout.
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      readCodexActivity: async (worktreePath) => {
        probed.push(worktreePath);
        return new Date(Date.now() + 60_000).toISOString();
      },
    });

    const spawned = await spawner.spawn({
      task: "Prove life through the rollout file",
      tier: "standard",
    });

    expect(spawned.status).toEqual("spawning");
    expect(probed).toEqual([join(root, "maya")]);
    expect(tmux.killed).toEqual([]);
    expect(tmux.hasSessionCalls).toEqual(0);
  });

  test("a spawn with no readiness signal at all fails and is torn down", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-no-signal-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({
        ...DEFAULT_ROUTING.standard,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      removeWorktree: async () => {},
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({
      task: "Hang at launch forever",
      tier: "standard",
    });

    // Exhausting the poll budget with no positive signal is a failed launch,
    // not a silent success left in "spawning" forever.
    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("no sign of life");
    expect(failed.failedAt).toBeDefined();
    expect(tmux.killed).toEqual([agentTmuxSession("maya")]);
  });

  test("a failed spawn never deletes a worktree that holds work", async () => {
    // The false-death case, and the one that actually destroyed an agent's work:
    // Hive decided the launch had failed while the agent was alive and writing.
    // The verdict is fallible; `git worktree remove --force` + `branch -D` is not
    // reversible. Those two must never be wired together.
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-keepwork-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    let removed = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      removeWorktree: async () => {
        removed += 1;
      },
      assessStrandedWork: async () => ({
        dirtyFiles: ["src/thing.ts"],
        unmergedCommits: 2,
      }),
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({ task: "Hang at launch", tier: "standard" });

    expect(failed.status).toEqual("failed");
    expect(removed).toEqual(0);
    expect(failed.failureReason).toContain("Kept the worktree");
    expect(failed.failureReason).toContain("2 unmerged commit(s)");
  });

  test("a failed spawn still cleans up a worktree with nothing in it", async () => {
    // A genuinely dead launch wrote nothing, and leaving debris behind for every
    // failed spawn would be its own bug. Only work survives.
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-cleanempty-"));
    tempRoots.push(root);
    const store = new FakeStore();
    let removed = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      removeWorktree: async () => {
        removed += 1;
      },
      assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({ task: "Hang at launch", tier: "standard" });
    expect(failed.status).toEqual("failed");
    expect(removed).toEqual(1);
  });

  test("a worktree whose contents cannot be checked is kept, not guessed away", async () => {
    // Guessing wrong toward "keep" costs a stale directory. Guessing wrong the
    // other way costs the work itself.
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-unknownwork-"));
    tempRoots.push(root);
    const store = new FakeStore();
    let removed = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      removeWorktree: async () => {
        removed += 1;
      },
      assessStrandedWork: async () => {
        throw new Error("git is unavailable");
      },
      sleep: async () => {},
      resolveModel: fakeResolveModel,
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({ task: "Hang at launch", tier: "standard" });
    expect(failed.status).toEqual("failed");
    expect(removed).toEqual(0);
    expect(failed.failureReason).toContain("could not be checked");
  });

  test("workspace presence suppresses spawn viewers until the lease lapses", async () => {
    // While the Workspace app is the viewer, a spawn opens no external window
    // — same effect as `headless`, but it reverts on its own when the lease
    // does. The static config is untouched: this spawner is headless: false.
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-presence-"));
    tempRoots.push(root);
    const worktreePath = join(root, "worktree");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const terminal = new FakeTerminal();
    let present = true;
    let layouts = 0;
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal,
      workspacePresent: () => present,
      onTerminalsChanged: () => {
        layouts += 1;
      },
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/presence-test",
      }),
      resolveModel: fakeResolveModel,
      sleep: signalReadiness(store),
    });

    const suppressed = await spawner.spawn({
      task: "Spawn while the app watches",
      tier: "standard",
    });
    expect(suppressed.status).toEqual("working");
    expect(terminal.windows).toEqual([]);
    expect(suppressed.terminalHandle).toBeUndefined();
    expect(layouts).toEqual(0);

    // The lease lapsed (app quit or crashed): external viewers come back.
    present = false;
    const visible = await spawner.spawn({
      task: "Spawn after the app is gone",
      tier: "standard",
    });
    expect(terminal.windows).toHaveLength(1);
    expect(terminal.windows[0]?.[0]).toEqual(visible.tmuxSession);
    expect(layouts).toEqual(1);
  });

  test("workspace presence suppresses the control-restart viewer too", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-presence-"));
    tempRoots.push(root);
    const staleHandle: TerminalHandle = {
      app: "iterm2",
      sessionId: "stale-viewer",
    };
    const controlled = {
      ...agent("maya", "working"),
      worktreePath: root,
      terminalHandle: staleHandle,
      executionIdentity: {
        tool: "codex",
        model: "gpt-test",
        effort: "medium",
      },
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const terminal = new FakeTerminal();
    const controlQuota = makeControlQuota(root);
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal,
      workspacePresent: () => true,
      sleep: signalControlReadiness(store),
      resolveModel: fakeResolveModel,
      quota: controlQuota.quota,
    });
    const restarted = await spawner.restartForControl(
      controlled,
      controlMessage("control-presence"),
    );
    // The stale lens still closes — it pointed at a killed session — but no
    // replacement window opens while the app holds the lease.
    expect(terminal.closed).toEqual([staleHandle]);
    expect(terminal.windows).toEqual([]);
    expect(restarted.terminalHandle).toBeUndefined();
    controlQuota.db.close();
  });

  test("closes a viewer that races with the agent being marked dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-viewer-race-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const store = new FakeStore();
    const terminal = new FakeTerminal(() => {
      const current = store.listAgents()[0];
      if (current !== undefined) {
        store.insertAgent({ ...current, status: "dead" });
      }
    });
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: false },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux: new FakeTmux(),
      terminal,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-viewer-race",
      }),
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Race terminal launch with kill",
      tier: "standard",
    });

    const handle = {
      app: "iterm2",
      sessionId: `session-${agentTmuxSession("maya")}`,
    } as const;
    expect(spawned.status).toEqual("dead");
    expect(spawned.terminalHandle).toBeUndefined();
    expect(terminal.closed).toEqual([handle]);
    expect(store.getAgentById(spawned.id)?.terminalHandle).toBeUndefined();
  });

  test("announces terminal changes only after a viewer is attached", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-layout-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    let terminalsChanged = 0;
    const terminalErrors: string[] = [];
    const makeSpawner = (
      terminal: TerminalAdapter,
      store: FakeStore,
    ): HiveSpawner =>
      new HiveSpawner({
        db: store,
        repoRoot: root,
        port: 4317,
        config: { terminal: "auto", headless: false },
        routing: async () => DEFAULT_ROUTING.standard,
        tmux: new FakeTmux(),
        terminal,
        createWorktree: async () => ({
          path: worktreePath,
          branch: "hive/maya-layout",
        }),
        resolveModel: fakeResolveModel,
        sleep: signalReadiness(store),
        onTerminalsChanged: () => {
          terminalsChanged += 1;
        },
        onTerminalError: (message) => terminalErrors.push(message),
      });

    const spawned = await makeSpawner(new FakeTerminal(), new FakeStore())
      .spawn({ task: "Announce the new viewer", tier: "standard" });
    expect(spawned.terminalHandle).toBeDefined();
    expect(terminalsChanged).toEqual(1);

    // A viewer that never opened leaves the wall untouched.
    await makeSpawner(new FailingTerminal(), new FakeStore())
      .spawn({ task: "Fail to open a viewer", tier: "standard" });
    expect(terminalsChanged).toEqual(1);
    expect(terminalErrors).toHaveLength(1);
    expect(terminalErrors[0]).toContain("could not open viewer for maya");

    // A viewer that lost the attach race was closed, not added.
    const racingStore = new FakeStore();
    const racingTerminal = new FakeTerminal(() => {
      const current = racingStore.listAgents()[0];
      if (current !== undefined) {
        racingStore.insertAgent({ ...current, status: "dead" });
      }
    });
    await makeSpawner(racingTerminal, racingStore)
      .spawn({ task: "Lose the attach race", tier: "standard" });
    expect(terminalsChanged).toEqual(1);
  });
});

describe("agent landing protocol", () => {
  const worktree = {
    path: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-auth-api",
  };

  test("is part of every writer agent prompt", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo");
    expect(prompt).toContain("You are maya");
    expect(prompt).toContain(buildLandingProtocol(worktree.branch, "/repo"));
  });

  test("appends the merged memory index only when it is non-empty", () => {
    const bare = buildAgentPrompt("maya", "Build auth API", worktree, "/repo");
    expect(bare).not.toContain("Hive memory index");

    const withIndex = buildAgentPrompt(
      "maya",
      "Build auth API",
      worktree,
      "/repo",
      "Hive memory index — durable facts from past runs.\n- [repo] flaky-login-test (2026-06-01): login flaky test",
    );
    expect(withIndex).toContain("Hive memory index");
    expect(withIndex).toContain("flaky-login-test");
  });

  test("spells out rebase, retest, ff-only merge, and cleanup ownership", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("git rebase main");
    expect(protocol).toContain("Re-run the tests on the rebased branch");
    expect(protocol).toContain("Red tests never merge");
    expect(protocol).toContain(
      "call `hive_land` with agent `maya` and capabilityEpoch `0`",
    );
    expect(protocol).not.toContain("git -C /repo merge");
    expect(protocol).toContain("Do not delete your branch or worktree");
  });

  test("lets a docs-only rebase skip the retest, but not the merge gate", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("git diff --name-only ORIG_HEAD..HEAD");
    // The escape hatch is bounded: only `.md` files, only when untested, and
    // it skips the rerun — never the fast-forward gate or the red-tests rule.
    expect(protocol).toContain("only when");
    expect(protocol).toContain("nothing but `.md` files that no test reads");
    expect(protocol).toContain("go straight to step 4");
    expect(protocol).toContain("Red tests never merge");
  });

  // `bun test` does not typecheck. A branch whose suite is green can still
  // carry a type error onto main — which is how two agents who each added a
  // version module landed a duplicate `HIVE_VERSION` import that no test could
  // see. The landing gate verifies both, or it verifies nothing — and names the
  // repo's concrete commands (SPEC §14), not a hardcoded guess.
  test("requires a typecheck, not just green tests, and names the profile's commands", () => {
    const protocol = buildLandingProtocol(
      worktree.branch, "/repo", "main", "maya", 0, false,
      { test: "bun test", typecheck: "bun run typecheck" },
    );
    expect(protocol).toContain("bun run typecheck");
    expect(protocol).toContain("Re-run the tests (`bun test`)");
    expect(protocol).toContain("`bun test` does not typecheck");
    expect(protocol).toContain("neither do type errors");
  });

  // In a repo whose profile discovered no commands, the gate keeps the rule but
  // invents no command — it must never tell an agent to run a command that does
  // not exist in this repo.
  test("falls back to generic wording when the profile knows no commands", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("Re-run the tests on the rebased branch");
    expect(protocol).toContain("your typechecker");
    expect(protocol).not.toContain("bunx tsc --noEmit");
    expect(protocol).toContain("neither do type errors");
  });

  test("tells the agent to scope its reading and escalate instead of grinding", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo");
    expect(prompt).toContain("Read only what the task needs");
    expect(prompt).toContain("instead of reading large files whole");
    expect(prompt).toContain("substantially larger than briefed");
    // The tripwire must route to the orchestrator, not to a silent stop.
    expect(prompt).toContain(
      'stop and report to "orchestrator" rather than grinding',
    );
  });

  test("bounds retries and escalates conflicts to the orchestrator", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("git rebase --abort");
    expect(protocol).toContain(`After ${LANDING_MAX_ATTEMPTS} failed attempts`);
    const escalations = protocol.match(/"orchestrator"/g) ?? [];
    expect(escalations.length).toBeGreaterThanOrEqual(2);
    expect(protocol).toContain("never force");
  });

  // Two agents made opposite calls on the same situation: one landed past a
  // red test it had proven was already red on main, the other refused to land
  // at all. "Red tests never merge" alone does not say which failures are
  // "yours" to fix — this carve-out does.
  test("clarifies that only a red proven identical on unmodified main blocks nothing, and any other red still blocks", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("Red tests never merge");
    expect(protocol).toContain("proven identical on unmodified main");
    expect(protocol).toContain("is pre-existing, not yours to fix, and does not block");
    expect(protocol).toContain("Any other red");
    expect(protocol).toContain("blocks like any other");
  });
});

describe("spawn prompt diet", () => {
  const worktree = {
    path: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-auth-api",
  };
  const prompt = (tier?: "deep" | "standard" | "cheap" | "review"): string =>
    buildAgentPrompt("maya", "Rename a flag", worktree, "/repo", "", { tier });

  test("cheap tier is materially shorter than the full prompt", () => {
    expect(prompt("cheap").length).toBeLessThan(prompt("standard").length * 0.8);
  });

  test("every other tier keeps the full prompt verbatim", () => {
    const full = buildAgentPrompt("maya", "Rename a flag", worktree, "/repo");
    for (const tier of ["deep", "standard", "review"] as const) {
      expect(prompt(tier)).toBe(full);
    }
  });

  // The landing protocol is Hive's safety stack. The cheap prompt rewrites its
  // prose but may never drop a rule: a small model is the one that would have
  // to infer the missing step.
  test("the concise landing protocol keeps every safety rule", () => {
    const concise = buildLandingProtocol(
      worktree.branch,
      "/repo",
      "main",
      "maya",
      0,
      true,
      { test: "bun test", typecheck: "bun run typecheck" },
    );
    expect(concise).toContain("git rebase main");
    expect(concise).toContain("git rebase --abort");
    expect(concise).toContain("Red tests never merge");
    expect(concise).toContain("proven identical on unmodified main");
    expect(concise).toContain("bun run typecheck");
    expect(concise).toContain("neither do type errors");
    expect(concise).toContain("git diff --name-only ORIG_HEAD..HEAD");
    expect(concise).toContain(
      "`hive_land` with agent `maya`, capabilityEpoch `0`",
    );
    expect(concise).toContain("Never merge into the primary checkout");
    expect(concise).toContain(`at most ${LANDING_MAX_ATTEMPTS} attempts`);
    expect(concise).toContain("merge commit hash");
    expect(concise).toContain("Leave your branch and worktree in place");
    expect(concise).toContain("Never force");
    expect((concise.match(/"orchestrator"/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
    expect(concise.length).toBeLessThan(
      buildLandingProtocol(worktree.branch, "/repo").length,
    );
  });

  test("cheap tier still carries the read-scoping and escalation tripwire", () => {
    expect(prompt("cheap")).toContain("Read only what the task names");
    expect(prompt("cheap")).toContain("stop and report rather than grinding");
    expect(prompt("cheap")).toContain("hive_send");
  });

  // Idle-with-work is the mirror of grind-past-scope: both waste a live
  // session, and every tier gets the clause because every tier can idle.
  test("every tier is told to continue after reporting a landing", () => {
    for (const tier of ["deep", "standard", "cheap", "review"] as const) {
      expect(prompt(tier)).toContain(
        "immediately continue with the next authorized piece",
      );
      expect(prompt(tier)).toContain("Stop only for a genuine blocker");
    }
  });

  test("an omitted tier keeps today's prompt exactly", () => {
    expect(buildAgentPrompt("maya", "Rename a flag", worktree, "/repo")).toBe(
      prompt(undefined),
    );
  });
});

describe("scoped brief in the spawn prompt", () => {
  const worktree = {
    path: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-auth-api",
  };

  test("is embedded when the task names a doc", () => {
    const prompt = buildAgentPrompt(
      "maya",
      "Rework SPEC §6",
      worktree,
      "/repo",
      "",
      { brief: "--- SPEC.md:97-126 ---\n### 6. Who picks the model" },
    );
    expect(prompt).toContain("--- SPEC.md:97-126 ---");
    expect(prompt).toContain("### 6. Who picks the model");
  });

  test("adds nothing when the task names no doc", () => {
    const bare = buildAgentPrompt("maya", "Rename a flag", worktree, "/repo");
    expect(
      buildAgentPrompt("maya", "Rename a flag", worktree, "/repo", "", {
        brief: "",
      }),
    ).toBe(bare);
  });

  test("the memory index still comes last, after the brief", () => {
    const prompt = buildAgentPrompt(
      "maya",
      "Rework SPEC §6",
      worktree,
      "/repo",
      "Hive memory index — durable facts",
      { brief: "SCOPED BRIEF BODY" },
    );
    expect(prompt.indexOf("SCOPED BRIEF BODY")).toBeLessThan(
      prompt.indexOf("Hive memory index"),
    );
  });
});

/**
 * The karpathy guidelines are a *guarantee*, not an offer.
 *
 * They used to live only in the progressively-disclosed `karpathy-guidelines`
 * skill, which an agent had to elect to open — and measured across every agent
 * spawned on 2026-07-11 that was offered it, only 5 of 23 did (21% claude, 22%
 * codex). An agent that declined never learned the rules and nothing failed.
 * These tests are what makes the silence loud: they assert the rules are in the
 * prompt Hive actually hands the vendor, on every launch path and every tier, so
 * no agent can start without them.
 */
describe("coding guidelines are guaranteed in context at spawn", () => {
  const RULES = [
    // karpathy guidelines
    "Think before coding",
    "Simplicity first",
    "Surgical changes",
    "Goal-driven execution",
    // hive protocol — memory-only until now, so a fresh install was blind to them
    "Urgent is a turn kill",
    "Sent is not stopped",
    "An absent field is unknown, never false",
    "Measure, do not infer",
  ];

  const worktree = { path: "/tmp/wt", branch: "hive/maya-build-auth" };

  test("every rule is in the prompt, and it is not framed as optional", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo");
    for (const rule of RULES) expect(prompt).toContain(rule);
    expect(prompt).toContain("these are not optional");
  });

  test("the cheap tier is not exempt — a small model needs the rules most", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo", "", {
      tier: "cheap",
    });
    for (const rule of RULES) expect(prompt).toContain(rule);
  });

  test("the rules reach a launched CLAUDE agent's argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-guidelines-claude-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({ ...DEFAULT_ROUTING.standard, tool: "claude" }),
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
    });

    await spawner.spawn({ task: "Build auth API", tier: "standard" });
    const command = tmux.sessions[0]?.[2] ?? "";
    // The executable resolves to an absolute path on a real machine.
    expect(command).toMatch(/^'[^']*claude'/);
    // The rules ride the prompt the vendor receives, not the pipe that carries
    // it: the brief outgrew the tmux command line and now travels in a file.
    const launched = await deliveredPrompt(command);
    for (const rule of RULES) expect(launched).toContain(rule);
  });

  test("the rules reach a launched CODEX agent — both the TUI argv and the app-server turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-guidelines-codex-"));
    tempRoots.push(root);
    const starts: string[] = [];
    const codexSpawner = (driver: "tui" | "app-server", tmux: FakeTmux) =>
      new HiveSpawner({
        db: new FakeStore(),
        repoRoot: root,
        port: 4317,
        config: {
          terminal: "auto",
          headless: true,
          ...(driver === "app-server" ? { codex: { driver } } : {}),
        },
        routing: async () => ({
          ...DEFAULT_ROUTING.standard,
          tool: "codex",
          codex: { model: "gpt-test", effort: "high" },
        }),
        tmux,
        terminal: new FakeTerminal(),
        createWorktree: async (_repoRoot, name, slug) => {
          const path = join(root, `${driver}-${name}`);
          await mkdir(path, { recursive: true });
          return { path, branch: `hive/${name}-${slug}` };
        },
        sleep: async () => {},
        resolveModel: fakeResolveModel,
        codexAppServer: {
          isAvailable: async () => true,
          buildHostCommand: () => ["hive", "codex-app-server-host"],
          startAgent: async (_value, prompt) => {
            starts.push(prompt);
          },
          disconnect: () => undefined,
        },
      });

    // Codex has no --append-system-prompt; the prompt IS the carrier, on both drivers.
    const tuiTmux = new FakeTmux();
    await codexSpawner("tui", tuiTmux).spawn({ task: "Build auth API", tier: "standard" });
    const tuiCommand = tuiTmux.sessions[0]?.[2] ?? "";
    expect(tuiCommand).toContain("'codex'");
    const tuiLaunched = await deliveredPrompt(tuiCommand);
    for (const rule of RULES) expect(tuiLaunched).toContain(rule);

    const hostTmux = new FakeTmux();
    await codexSpawner("app-server", hostTmux).spawn({
      task: "Build auth API",
      tier: "standard",
    });
    expect(starts).toHaveLength(1);
    for (const rule of RULES) expect(starts[0]).toContain(rule);
  });

  test("the two blocks between them carry every rule (they are what the prompt splices in)", () => {
    const blocks = `${CODING_GUIDELINES}\n${HIVE_PROTOCOL_RULES}`;
    for (const rule of RULES) expect(blocks).toContain(rule);
  });
});

/**
 * The spawn prompt travels out-of-band, and a failure to carry it is not a
 * verdict on the model.
 *
 * Two defects, one launch. tmux hands a command to its server in a single imsg
 * and rejects anything much past 16KB with "command too long" — measured
 * against tmux 3.7b, which takes 16000 bytes and refuses 20000, far below the
 * 1MB ARG_MAX the design assumed. Hive's briefs embed extracted doc sections
 * with file:line pointers, so they cross that line by design. The second defect
 * is what Hive concluded from the first: the spawn error was recorded against
 * the *route*, quarantining a model that was never contacted.
 */
describe("HiveSpawner launch prompt transport", () => {
  const hugeBrief = `Rewrite the router. ${"context ".repeat(6_000)}`;
  let savedHiveHome: string | undefined;

  beforeAll(async () => {
    savedHiveHome = process.env.HIVE_HOME;
    const home = await mkdtemp(join(tmpdir(), "hive-prompt-home-"));
    tempRoots.push(home);
    process.env.HIVE_HOME = home;
  });

  afterAll(() => {
    if (savedHiveHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = savedHiveHome;
  });

  /** Real tmux refuses an over-long command rather than truncating it. */
  class LimitedTmux extends FakeTmux {
    override async newSession(
      name: string,
      cwd: string,
      command: string,
    ): Promise<void> {
      if (Buffer.byteLength(command) > 16_384) {
        throw new Error("tmux new-session failed: command too long");
      }
      await super.newSession(name, cwd, command);
    }
  }

  /** Every tmux command fails, whatever its length: a transport that is simply
   * broken on this machine. The model is never reached. */
  class BrokenTmux extends FakeTmux {
    override async newSession(): Promise<void> {
      throw new Error("tmux new-session failed: no server running");
    }
  }

  function makeQuota(root: string): { db: HiveDatabase; quota: QuotaService } {
    const db = new HiveDatabase(join(root, "spawn-quota.db"));
    return {
      db,
      quota: new QuotaService(
        new QuotaLedger(db),
        QuotaConfigSchema.parse({
          discovery: false,
          limits: [{
            provider: "claude",
            pool: "claude",
            models: ["claude-opus-4-8"],
            fiveHourAllowance: 500,
            weeklyAllowance: 500,
          }],
        }),
        () => new Date(timestamp),
      ),
    };
  }

  function makeSpawner(
    root: string,
    tmux: FakeTmux,
    quota: QuotaService,
    store: FakeStore,
    sleep: () => Promise<void>,
  ): HiveSpawner {
    return new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.standard,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      resolveModel: fakeResolveModel,
      quota,
      sleep,
    });
  }

  test("a brief far past the tmux command limit still spawns", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-prompt-long-"));
    tempRoots.push(root);
    const tmux = new LimitedTmux();
    const { db, quota } = makeQuota(root);
    const store = new FakeStore();
    const spawner = makeSpawner(
      root,
      tmux,
      quota,
      store,
      signalReadiness(store),
    );

    const spawned = await spawner.spawn({
      task: hugeBrief,
      tier: "standard",
      model: "claude-opus-4-8",
    });

    expect(spawned.status).toEqual("working");
    const command = tmux.sessions[0]?.[2] ?? "";
    // The brief is not on the command line at all, and what is left is small.
    expect(command).not.toContain("Rewrite the router");
    expect(Buffer.byteLength(command)).toBeLessThan(4_096);
    // It reached the agent intact, through a file outside the user's repo.
    const promptPath = /\$\(cat '([^']+)'\)/.exec(command)?.[1] ?? "";
    expect(promptPath).toStartWith(process.env.HIVE_HOME!);
    expect(promptPath).not.toStartWith(root);
    expect(await readFile(promptPath, "utf8")).toContain(hugeBrief);
    db.close();
  });

  test("a transport failure never marks the model unhealthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-prompt-transport-"));
    tempRoots.push(root);
    const { db, quota } = makeQuota(root);
    const spawner = makeSpawner(
      root,
      new BrokenTmux(),
      quota,
      new FakeStore(),
      async () => {},
    );

    const failed = await spawner.spawn({
      task: "Ship the thing",
      tier: "standard",
      model: "claude-opus-4-8",
    });

    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("tmux");
    // tmux broke. The model was never contacted, so it has nothing to answer
    // for: quarantining it here is how one bad launch downgrades every later
    // spawn for half an hour.
    expect(quota.ledger.routeHealth("claude", "claude-opus-4-8")).toBeNull();
    db.close();
  });

  test("a binary that never executed never marks the model unhealthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-prompt-exec-"));
    tempRoots.push(root);
    const { db, quota } = makeQuota(root);
    // The pane died because the CLI is not on this machine. tmux carried the
    // command; the shell could not run it. The model was still never contacted.
    const tmux = new FakeTmux("zsh: command not found: claude");
    const spawner = makeSpawner(
      root,
      tmux,
      quota,
      new FakeStore(),
      async () => {},
    );

    const failed = await spawner.spawn({
      task: "Ship the thing",
      tier: "standard",
      model: "claude-opus-4-8",
    });

    expect(failed.status).toEqual("failed");
    expect(quota.ledger.routeHealth("claude", "claude-opus-4-8")).toBeNull();
    db.close();
  });

  test("a genuine model failure still marks the model unhealthy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-prompt-model-"));
    tempRoots.push(root);
    const { db, quota } = makeQuota(root);
    // The process launched and the model itself refused: real evidence.
    const tmux = new FakeTmux("Error: model not supported");
    const spawner = makeSpawner(
      root,
      tmux,
      quota,
      new FakeStore(),
      async () => {},
    );

    const failed = await spawner.spawn({
      task: "Ship the thing",
      tier: "standard",
      model: "claude-opus-4-8",
    });

    expect(failed.status).toEqual("failed");
    const health = quota.ledger.routeHealth("claude", "claude-opus-4-8");
    expect(health?.consecutiveFailures).toEqual(1);
    expect(health?.lastFailureReason).toContain("model not supported");
    db.close();
  });
});

describe("shadow mode observes and cannot alter", () => {
  /** One spawn, with shadow either wired or absent. Everything else identical. */
  async function spawnOnce(
    root: string,
    recordShadowRoute?: (spawn: ShadowSpawn) => Promise<unknown>,
  ) {
    const tmux = new FakeTmux();
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux,
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
      ...(recordShadowRoute === undefined ? {} : { recordShadowRoute }),
    });
    const record = await spawner.spawn({
      task: "A task that must launch identically",
      tier: "deep",
    });
    return { tmux, record };
  }

  test("a shadowed spawn launches byte-for-byte identically to an unshadowed one", async () => {
    const plain = await mkdtemp(join(tmpdir(), "hive-shadow-off-"));
    const shadowed = await mkdtemp(join(tmpdir(), "hive-shadow-on-"));
    tempRoots.push(plain, shadowed);

    const observed: ShadowSpawn[] = [];
    const off = await spawnOnce(plain);
    const on = await spawnOnce(shadowed, async (spawn) => {
      observed.push(spawn);
    });

    // The launch command is what actually reaches the machine. It must not differ
    // by a single byte -- the agent name and worktree root are the only things
    // that legitimately vary between two spawns, so they are normalized away.
    const launch = (
      sessions: Array<[string, string, string]>,
      name: string,
      root: string,
    ) =>
      sessions.map(([session, cwd, command]) =>
        [session, cwd, command]
          .join(" ")
          .replaceAll(name, "AGENT")
          .replaceAll(root, "ROOT")
      );

    expect(launch(on.tmux.sessions, on.record.name, shadowed))
      .toEqual(launch(off.tmux.sessions, off.record.name, plain));
    // Same identity, same model, same tool. Shadow changed nothing.
    expect(on.record.executionIdentity).toEqual(off.record.executionIdentity!);
    expect(on.record.model).toBe(off.record.model);
    // And it observed the launch it did not touch.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      tier: "deep",
      tool: "claude",
      model: "claude-fable-5",
      userPinned: false,
      outcome: "launched",
      failureReason: null,
    });
  });

  test("a shadow recorder that throws does not fail the spawn", async () => {
    // An observer that can kill the thing it observes is not an observer.
    const root = await mkdtemp(join(tmpdir(), "hive-shadow-throws-"));
    tempRoots.push(root);
    const { record } = await spawnOnce(root, async () => {
      throw new Error("shadow log is on fire");
    });
    expect(record.status).toBe("working");
    expect(record.model).toBe("claude-fable-5");
  });

  test("a user-pinned spawn model is recorded AS pinned", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-shadow-pinned-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const observed: ShadowSpawn[] = [];
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: fakeResolveModel,
      recordShadowRoute: async (spawn) => {
        observed.push(spawn);
      },
    });
    await spawner.spawn({
      task: "Pinned",
      tier: "deep",
      model: "claude-opus-4-8",
    });
    expect(observed[0]).toMatchObject({
      model: "claude-opus-4-8",
      userPinned: true,
    });
  });
});

describe("the release valve follows the provider's metering, not a model name", () => {
  // MEASURED 2026-07-12 (get_usage): Fable draws the SHARED five-hour pool (+2%
  // under a Fable-only burst) AND is capped separately in `model_scoped`. Both.
  // The valve's rationale is real — but the vendor can rearrange it without
  // telling us, so the trigger reads the metering rather than the name.
  const billing = (metered: Record<string, number>): AccountBilling => ({
    creditsEnabled: known(false, "claude.get_usage", timestamp),
    disabledReason: null,
    generalUtilization: known(20, "claude.get_usage", timestamp),
    modelUtilization: metered,
  });

  const discovery = (): CapabilityDiscoveryResult => ({
    status: "ok",
    records: [
      {
        ...capabilityRecord("claude", "claude-fable-5", ["low", "high"]),
        displayName: "Fable",
      },
      {
        ...capabilityRecord("claude", "claude-opus-4-8", ["low", "high"]),
        displayName: "Opus",
      },
    ],
    effectiveDefault: {
      provider: "claude",
      model: known("claude-opus-4-8", "claude.initialize", timestamp),
      effort: unknown("surface-silent", "claude.initialize", timestamp),
    },
  });

  async function candidatesFor(
    root: string,
    options: {
      claudeModel: string;
      metered: Record<string, number>;
      withMeasurement: boolean;
    },
  ): Promise<string[]> {
    const seen: string[] = [];
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => DEFAULT_ROUTING.deep,
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: async (tool) =>
        tool === "claude" ? options.claudeModel : "gpt-5.6-sol",
      ...(options.withMeasurement
        ? {
          discoverCapabilities: async (provider: "claude" | "codex") =>
            provider === "claude"
              ? discovery()
              : {
                status: "ok" as const,
                records: [{
                  ...capabilityRecord("codex", "gpt-5.6-sol", ["medium"]),
                  displayName: "GPT-5.6-Sol",
                }],
                effectiveDefault: {
                  provider: "codex" as const,
                  model: known(
                    "gpt-5.6-sol",
                    "codex.config/read",
                    timestamp,
                  ),
                  effort: known("medium", "codex.config/read", timestamp),
                },
              },
          readBilling: async (provider: "claude" | "codex") =>
            provider === "claude"
              ? billing(options.metered)
              : accountBillingFromCodexRateLimits({
                rateLimits: {
                  primary: { usedPercent: 20 },
                  secondary: { usedPercent: 10 },
                  credits: {
                    hasCredits: false,
                    unlimited: false,
                    balance: "0",
                  },
                },
              }, timestamp),
        }
        : {}),
      quota: {
        config: { enabled: true },
        routeAndReserve: async (request: { candidates: { tool: string; model: string }[] }) => {
          seen.push(...request.candidates.map((c) => `${c.tool}:${c.model}`));
          const first = request.candidates[0]!;
          return {
            tool: first.tool,
            model: first.model,
            reservation: { id: "r1" },
          };
        },
        markStarted: () => {},
        cancel: async () => {},
        recordRouteFailure: () => {},
      } as never,
    });
    await spawner.spawn({ task: "valve", tier: "deep" });
    return seen;
  }

  test("a separately-metered primary gets the account's default as a valve", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-valve-metered-"));
    tempRoots.push(root);
    const candidates = await candidatesFor(root, {
      claudeModel: "claude-fable-5",
      metered: { fable: 15 },
      withMeasurement: true,
    });
    // Opus is offered AFTER Fable: ties keep the primary, and only real pressure
    // on Fable's pool lets quota pick the alternative on headroom.
    expect(candidates).toEqual([
      "claude:claude-fable-5",
      "claude:claude-opus-4-8",
      "codex:gpt-5.6-sol",
    ]);
  });

  test("the SAME model gets NO valve once the vendor stops metering it separately", async () => {
    // This is the whole point. The old `=== CLAUDE_BEST_MODEL` check could never
    // notice this change; it would have gone on diverting deep work away from a
    // model the provider no longer treats as heavy, forever, and silently.
    const root = await mkdtemp(join(tmpdir(), "hive-valve-unmetered-"));
    tempRoots.push(root);
    const candidates = await candidatesFor(root, {
      claudeModel: "claude-fable-5",
      metered: {},
      withMeasurement: true,
    });
    expect(candidates).toEqual([
      "claude:claude-fable-5",
      "codex:gpt-5.6-sol",
    ]);
  });

  test("a model the vendor DOES meter separately gets the valve, whatever it is called", async () => {
    // No name is privileged. If the provider gives some future model a dedicated
    // pool, the valve applies to it without anyone editing a constant.
    const root = await mkdtemp(join(tmpdir(), "hive-valve-other-"));
    tempRoots.push(root);
    const candidates = await candidatesFor(root, {
      claudeModel: "claude-opus-4-8",
      metered: { opus: 40 },
      withMeasurement: true,
    });
    expect(candidates[0]).toBe("claude:claude-opus-4-8");
    // Opus IS the account's default here, so there is no other model to offer:
    // a valve that offers the model it is relieving is not a valve.
    expect(candidates).not.toContain("claude:claude-opus-4-8_alt");
  });

  test("with no live reading it falls back to the one model measurement has shown", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-valve-blind-"));
    tempRoots.push(root);
    const candidates = await candidatesFor(root, {
      claudeModel: "claude-fable-5",
      metered: {},
      withMeasurement: false,
    });
    expect(candidates).toEqual([
      "claude:claude-fable-5",
      "claude:claude-opus-4-8",
      "codex:gpt-5.6-sol",
    ]);
  });
});

describe("the spend guard is consulted by the LIVE spawn path", () => {
  // The guard already governed the derived table and `hive routing`. Neither of
  // those launches anything. These tests are about the connection, not the rule:
  // a guard that is correct, tested, green and never consulted is
  // indistinguishable from one that works, until the day it matters.
  const billing = (
    creditsOn: boolean,
    fableUsed: number,
  ): AccountBilling => ({
    creditsEnabled: known(creditsOn, "claude.get_usage", timestamp),
    disabledReason: null,
    generalUtilization: known(20, "claude.get_usage", timestamp),
    modelUtilization: { fable: fableUsed },
  });

  const claudeDiscovery = (): CapabilityDiscoveryResult => ({
    status: "ok",
    records: [
      {
        ...capabilityRecord("claude", "claude-fable-5", ["low", "high"]),
        displayName: "Fable",
      },
      {
        ...capabilityRecord("claude", "claude-opus-4-8", ["low", "high"]),
        displayName: "Opus",
      },
    ],
    effectiveDefault: {
      provider: "claude",
      model: known("claude-opus-4-8", "claude.initialize", timestamp),
      effort: unknown("surface-silent", "claude.initialize", timestamp),
    },
  });

  async function spawnWith(
    root: string,
    options: {
      billing: AccountBilling;
      model?: string;
      approve?: string;
    },
  ) {
    const store = new FakeStore();
    if (options.approve !== undefined) {
      store.insertApproval({
        id: `cost-consent:${options.approve}`,
        agentName: "router",
        description: "approved in a previous turn",
        status: "approved",
        createdAt: timestamp,
        resolvedAt: timestamp,
      });
    }
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      // The deep tier's Claude column, with no quota configured at all — so the
      // ONLY thing that can stop a charge here is the guard itself.
      routing: async () => ({
        ...DEFAULT_ROUTING.deep,
        tool: "claude",
      }),
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: async () => "claude-fable-5",
      discoverCapabilities: async () => claudeDiscovery(),
      readBilling: async () => options.billing,
    });
    const record = await spawner.spawn({
      task: "does the launch path consult the guard",
      tier: "deep",
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    return { record, store };
  }

  test("credits OFF: it does NOT fire, and the agent launches — today's state", async () => {
    // If it nags him today it is broken: he cannot be charged, and he would learn
    // to click through the prompt long before the day it counts.
    const root = await mkdtemp(join(tmpdir(), "hive-guard-off-"));
    tempRoots.push(root);
    // Every pool exhausted, and it STILL must not fire: with credits off a
    // request past the plan is refused, not billed.
    const { record, store } = await spawnWith(root, {
      billing: billing(false, 100),
    });
    expect(record.model).toBe("claude-fable-5");
    expect(record.status).toBe("working");
    expect([...store.approvals.values()]).toEqual([]);
  });

  test("credits ON + pool spent: the LIVE spawn is refused and he is asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-guard-on-"));
    tempRoots.push(root);
    let failure = "";
    const store = new FakeStore();
    try {
      await spawnWith(root, { billing: billing(true, 100) });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain("would spend your money");
    expect(failure).toContain("approvals queue");
  });

  test("credits ON + pool spent: the request lands in the approvals queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-guard-queue-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({ ...DEFAULT_ROUTING.deep, tool: "claude" }),
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: async () => "claude-fable-5",
      discoverCapabilities: async () => claudeDiscovery(),
      readBilling: async () => billing(true, 100),
    });
    await spawner.spawn({ task: "ask me first", tier: "deep" }).catch(() => {});
    const asked = [...store.approvals.values()];
    expect(asked).toHaveLength(1);
    expect(asked[0]!.id).toBe("cost-consent:claude-fable-5");
    expect(asked[0]!.status).toBe("pending");
    expect(asked[0]!.description).toContain("SPEND REAL MONEY");
  });

  test("an approved request lets the live spawn through", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-guard-approved-"));
    tempRoots.push(root);
    const { record } = await spawnWith(root, {
      billing: billing(true, 100),
      approve: "claude-fable-5",
    });
    expect(record.model).toBe("claude-fable-5");
    expect(record.status).toBe("working");
  });

  test("an EXPLICIT model is his own instruction and is never gated", async () => {
    // The guard governs Hive's choices, not his. He asked for this model by name.
    const root = await mkdtemp(join(tmpdir(), "hive-guard-pinned-"));
    tempRoots.push(root);
    const { record, store } = await spawnWith(root, {
      billing: billing(true, 100),
      model: "claude-fable-5",
    });
    expect(record.model).toBe("claude-fable-5");
    expect(record.status).toBe("working");
    expect([...store.approvals.values()]).toEqual([]);
  });

  test("an unreadable bill never authorizes an automatic spawn", async () => {
    // A probe that failed is not evidence that a charge is impossible. Automatic
    // routing stops and asks; an explicit pin remains the escape hatch.
    const root = await mkdtemp(join(tmpdir(), "hive-guard-blind-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({ ...DEFAULT_ROUTING.deep, tool: "claude" }),
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: async () => "claude-fable-5",
      discoverCapabilities: async () => claudeDiscovery(),
      readBilling: async () => null,
    });
    let failure = "";
    try {
      await spawner.spawn({ task: "blind", tier: "deep" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain("could not read claude plan or billing state");
    expect([...store.approvals.values()]).toHaveLength(1);
  });
});

describe("the Codex spend reader drives the SAME live spawn guard", () => {
  const codexDiscovery = (): CapabilityDiscoveryResult => ({
    status: "ok",
    records: [{
      ...capabilityRecord("codex", "gpt-5.6-sol", ["medium", "xhigh"]),
      displayName: "GPT-5.6-Sol",
    }],
    effectiveDefault: {
      provider: "codex",
      model: known("gpt-5.6-sol", "codex.config/read", timestamp),
      effort: known("xhigh", "codex.config/read", timestamp),
    },
  });

  const codexBilling = (
    usedPercent: number,
    credits: { hasCredits: boolean; unlimited: boolean; balance: string },
  ): AccountBilling => accountBillingFromCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent, windowDurationMins: 300, resetsAt: 1 },
      secondary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 2 },
      credits,
      individualLimit: null,
      planType: "prolite",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {},
  }, timestamp);

  async function spawnCodex(
    root: string,
    billing: AccountBilling,
    model?: string,
  ) {
    const store = new FakeStore();
    const spawner = new HiveSpawner({
      db: store,
      repoRoot: root,
      port: 4317,
      config: { terminal: "auto", headless: true },
      routing: async () => ({ ...DEFAULT_ROUTING.deep, tool: "codex" }),
      tmux: new FakeTmux(),
      terminal: new FakeTerminal(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      resolveModel: async () => "gpt-5.6-sol",
      discoverCapabilities: async () => codexDiscovery(),
      readBilling: async (provider) => provider === "codex" ? billing : null,
    });
    try {
      const record = await spawner.spawn({
        task: "drive the real Codex spawn gate",
        tier: "deep",
        ...(model === undefined ? {} : { model }),
      });
      return { record, store, failure: null };
    } catch (error) {
      return {
        record: null,
        store,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  }

  test("A: today's 41%/23% state launches and files zero consent requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-guard-headroom-"));
    tempRoots.push(root);
    const { record, store } = await spawnCodex(
      root,
      codexBilling(41, { hasCredits: false, unlimited: false, balance: "0" }),
    );
    expect(record).toMatchObject({
      tool: "codex",
      model: "gpt-5.6-sol",
      status: "working",
    });
    expect([...store.approvals.values()]).toEqual([]);
  });

  test("B: exhausted + credits present refuses the spawn and queues consent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-guard-credits-"));
    tempRoots.push(root);
    const billing = codexBilling(100, {
      hasCredits: true,
      unlimited: false,
      balance: "100",
    });
    const { failure, store } = await spawnCodex(root, billing);
    expect(failure).toContain("would spend your money");
    const asked: Approval[] = [...store.approvals.values()];
    expect(asked).toHaveLength(1);
    expect(asked[0]!.description).toContain("SPEND REAL MONEY");
  });

  test("C: exhausted + zero credits asks and names unobservable auto-top-up", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-guard-topup-"));
    tempRoots.push(root);
    const { failure, store } = await spawnCodex(
      root,
      codexBilling(100, {
        hasCredits: false,
        unlimited: false,
        balance: "0",
      }),
    );
    expect(failure).toContain("auto-top-up");
    expect(failure).toContain("may purchase credits");
    const asked = [...store.approvals.values()];
    expect(asked).toHaveLength(1);
    expect(asked[0]!.description).toContain("auto-top-up");
    expect(asked[0]!.description).toContain("may purchase credits");
  });

  test("D: an explicit Codex model pin launches even when the pool is spent", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-guard-pinned-"));
    tempRoots.push(root);
    const { record, store } = await spawnCodex(
      root,
      codexBilling(100, { hasCredits: true, unlimited: false, balance: "100" }),
      "gpt-5.6-sol",
    );
    expect(record?.status).toBe("working");
    expect([...store.approvals.values()]).toEqual([]);
  });
});
