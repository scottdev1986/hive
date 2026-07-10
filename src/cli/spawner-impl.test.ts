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
import { CLAUDE_CHANNELS_FLAG } from "../adapters/tools/claude";
import { DEFAULT_ROUTING, QuotaConfigSchema, isLiveAgent } from "../schemas";
import type {
  AgentRecord,
  AgentMessage,
  Route,
  RoutingTier,
  TerminalHandle,
} from "../schemas";
import {
  buildAgentPrompt,
  buildLandingProtocol,
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

const timestamp = "2026-07-09T12:00:00.000Z";
const tempRoots: string[] = [];

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

  constructor(agents: AgentRecord[] = []) {
    this.agents = [...agents];
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

// Claude spawns pre-accept folder trust in ~/.claude.json. Point HOME at a
// throwaway directory so the suite never writes to the operator's real config.
let previousHome: string | undefined;
let claudeHomeRoot = "";

beforeAll(async () => {
  claudeHomeRoot = await mkdtemp(join(tmpdir(), "hive-spawner-home-"));
  previousHome = Bun.env.HOME;
  Bun.env.HOME = claudeHomeRoot;
});

afterAll(async () => {
  if (previousHome === undefined) {
    delete Bun.env.HOME;
  } else {
    Bun.env.HOME = previousHome;
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
      const controlled = {
        ...agent("maya", "control-paused"),
        tool,
        worktreePath: root,
        capabilityEpoch: 1,
        writeRevoked: true,
        executionIdentity: tool === "claude"
          ? { tool, model: "gpt-test" }
          : { tool, model: "gpt-test", effort: "high" },
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
        sleep: async () => {},
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
      expect(command).toContain("CRITICAL HIVE CONTROL");
      expect(command).toContain("This process is read-only");
      expect(command).toContain(tool === "claude"
        ? "--permission-mode"
        : "--sandbox");
      expect(command).toContain(tool === "claude" ? "default" : "read-only");
      expect(command).toContain("gpt-test");
      if (tool === "codex") expect(command).toContain("high");
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
      sleep: async () => {},
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
    let probedAppServer = false;
    const spawner = new HiveSpawner({
      db: new FakeStore(),
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
      sleep: async () => {},
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
    expect(tmux.sessions[0]?.[2]).toContain("notify=");
    expect(tmux.sessions[0]?.[2]).toContain("Visible interactive task");
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
      sleep: async () => {},
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
    expect(tmux.sessions[1]?.[2]).toContain("notify=");
    expect(tmux.sessions[1]?.[2]).toContain("Fallback task");
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
      sleep: async () => {},
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
      sleep: async () => {},
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
      sleep: async () => {},
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
      sleep: async () => {},
      resolveModel: fakeResolveModel,
    });

    const claude = await spawner.spawn({ task: "Build auth API", tier: "deep" });
    const codex = await spawner.spawn({
      task: "Add route tests",
      tier: "standard",
    });

    expect(claude.name).toEqual("maya");
    expect(claude.status).toEqual("spawning");
    expect(claude.contextPct).toEqual(0);
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
    expect(tmux.sessions[0]?.[2]).toContain("You are maya");
    // Every writer agent carries the landing protocol for its own branch.
    expect(tmux.sessions[0]?.[2]).toContain(
      `hive_land`,
    );
    expect(tmux.sessions[1]?.[2]).toContain("'codex'");
    expect(tmux.sessions[1]?.[2]).toContain("notify=");
    expect(tmux.sessions[1]?.[2]).toContain("You are david");
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
        sleep: async () => {},
      });

      await spawner.spawn({ task: "Fix the flaky test", tier: "standard" });

      const launched = tmux.sessions[0]?.[2] ?? "";
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
      sleep: async () => {},
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
    const spawner = new HiveSpawner({
      db: new FakeStore(),
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
      sleep: async () => {},
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
    const spawner = new HiveSpawner({
      db: new FakeStore(),
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
      sleep: async () => {},
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
      sleep: async () => {},
    });

    const spawned = await spawner.spawn({
      task: "Fix the error handling",
      tier: "standard",
    });

    expect(spawned.status).toEqual("spawning");
    expect(tmux.capturePaneCalls).toEqual(15);
    expect(tmux.killed).toEqual([]);
  });

  test("tolerates transient pane capture and viewer failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-transient-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const tmux = new FlakyCaptureTmux();
    const spawner = new HiveSpawner({
      db: new FakeStore(),
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
      sleep: async () => {},
    });

    const spawned = await spawner.spawn({
      task: "Survive cosmetic failures",
      tier: "standard",
    });

    expect(spawned.status).toEqual("spawning");
    expect(tmux.capturePaneCalls).toEqual(15);
    expect(tmux.killed).toEqual([]);
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
      sleep: async () => {},
    });

    const suppressed = await spawner.spawn({
      task: "Spawn while the app watches",
      tier: "standard",
    });
    expect(suppressed.status).toEqual("spawning");
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
      sleep: async () => {},
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
      sleep: async () => {},
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
        sleep: async () => {},
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
