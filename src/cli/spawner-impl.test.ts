import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalAdapter } from "../adapters/terminal";
import { DEFAULT_ROUTING, QuotaConfigSchema } from "../schemas";
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

  test("selects the first name not held by a live agent", () => {
    expect(selectAgentName([
      agent("maya"),
      agent("david", "dead"),
      agent("sam", "done"),
    ])).toEqual("david");
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
      "'claude' '--model' 'claude-fable-5'",
    );
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
    expect(tmux.sessions[0]?.[2]).toContain("'claude'");
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

  test("bounds retries and escalates conflicts to the orchestrator", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("git rebase --abort");
    expect(protocol).toContain(`After ${LANDING_MAX_ATTEMPTS} failed attempts`);
    const escalations = protocol.match(/"orchestrator"/g) ?? [];
    expect(escalations.length).toBeGreaterThanOrEqual(2);
    expect(protocol).toContain("never force");
  });
});
