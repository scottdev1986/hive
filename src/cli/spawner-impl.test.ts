import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountBillingFromCodexRateLimits,
  type AccountBilling,
} from "../daemon/usage-credits";
import type { Approval } from "../daemon/db";
import {
  QuotaConfigSchema,
  isLiveAgent,
  known,
  unknown,
} from "../schemas";
import type {
  AgentRecord,
  AgentMessage,
  CapabilityRecord,
  ChainEntry,
  ModelEnablementDecision,
  QuotaPoolStatus,
  RoutingCategory,
  RoutingPolicy,
} from "../schemas";
import {
  buildAgentPrompt,
  buildLandingProtocol,
  CODING_GUIDELINES,
  HIVE_PROTOCOL_RULES,
  HiveSpawner,
  type HiveSpawnerDependencies,
  LANDING_MAX_ATTEMPTS,
  SEARCH_HYGIENE,
  NAME_POOL,
  resolveAgentName,
  selectAgentName,
} from "../daemon/spawner-impl";
import { HiveDatabase } from "../daemon/db";
import {
  policyModelEnablement,
  RoutingPolicyStore,
} from "../daemon/routing-policy-store";
import { QuotaLedger } from "../daemon/quota-ledger";
import { QuotaService } from "../daemon/quota";
import { agentTmuxSession } from "../daemon/tmux-sessions";
import type { CapabilityDiscoveryResult } from "../daemon/capability-discovery";
import type { StopAgentSession } from "../daemon/teardown";

const positivelyVerifiedStop: StopAgentSession = async () => ({
  killed: [],
  survivors: [],
});

function newTestSpawner(
  dependencies: Omit<HiveSpawnerDependencies, "stopSession"> & {
    stopSession?: StopAgentSession;
  },
): HiveSpawner {
  return new HiveSpawner({
    ...dependencies,
    stopSession: dependencies.stopSession ?? positivelyVerifiedStop,
  });
}

type TestRoute = {
  tool: "claude" | "codex" | "grok";
  claude?: { model: string; effort?: string };
  codex?: { model: string; effort?: string };
  grok?: { model: string; effort?: string };
};

function policyFromRoute(route: TestRoute): RoutingPolicy {
  const target = route[route.tool];
  if (target === undefined) throw new Error(`missing ${route.tool} fixture route`);
  return {
    schemaVersion: 2,
    revision: 1,
    updatedAt: timestamp,
    provisional: false,
    providers: {},
    models: [],
    chains: {
      default: [{
        provider: route.tool,
        model: target.model,
        effort: target.effort === undefined
          ? { mode: "provider-controlled" }
          : { mode: "exact", value: target.effort },
      }],
    },
    selection: { global: "choice", categories: {} },
  };
}

function policyWithChain(
  entries: ChainEntry[],
  selection: "auto" | "choice" = "choice",
): RoutingPolicy {
  return {
    ...policyFromRoute(CODEX_ROUTE),
    providers: Object.fromEntries(
      [...new Set(entries.map((entry) => entry.provider))].map((provider) =>
        [provider, "enabled" as const]
      ),
    ),
    models: entries.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      state: "enabled" as const,
      effort: entry.effort,
    })),
    chains: { default: entries },
    selection: { global: selection, categories: {} },
  };
}

const CLAUDE_ROUTE = {
  tool: "claude",
  claude: { model: "claude-fable-5" },
  codex: { model: "gpt-5.6-sol", effort: "high" },
} as const;
const CODEX_ROUTE = {
  tool: "codex",
  claude: { model: "sonnet" },
  codex: { model: "gpt-5.6-sol", effort: "medium" },
} as const;
const CHEAP_ROUTE = {
  tool: "codex",
  claude: { model: "haiku" },
  codex: { model: "gpt-5.6-sol", effort: "low" },
} as const;
const REVIEW_ROUTE = {
  tool: "claude",
  claude: { model: "sonnet" },
  codex: { model: "gpt-5.6-sol", effort: "medium" },
} as const;

const quotaSpreadPolicy = (): RoutingPolicy => {
  const entries: ChainEntry[] = [
  { provider: "codex", model: "gpt-5.6-sol", effort: { mode: "provider-controlled" } },
  { provider: "claude", model: "claude-fable-5", effort: { mode: "provider-controlled" } },
  ];
  const policy = policyWithChain(entries, "auto");
  return { ...policy, chains: { ...policy.chains, complex_coding: entries } };
};

const timestamp = "2026-07-09T12:00:00.000Z";
const tempRoots: string[] = [];

function capabilityRecord(
  provider: "claude" | "codex" | "grok",
  model: string,
  levels: string[],
): CapabilityRecord {
  const surface = provider === "claude"
    ? "claude.initialize" as const
    : provider === "codex"
      ? "codex.model/list" as const
      : "grok.models_cache" as const;
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
    category: "simple_coding",
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
    readOnly: false,
    writeRevoked: false,
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
      cataloguedQuotaLedger(db),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    ),
  };
}

function cataloguedQuotaLedger(db: HiveDatabase): QuotaLedger {
  const ledger = new QuotaLedger(db);
  ledger.replaceModelCatalog("claude", [
    {
      provider: "claude",
      modelId: "claude-test",
      displayName: "Claude Test",
      discoveredAt: timestamp,
    },
    {
      provider: "claude",
      modelId: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      discoveredAt: timestamp,
    },
  ]);
  ledger.replaceModelCatalog("codex", [
    {
      provider: "codex",
      modelId: "removed-model",
      displayName: "Removed Model",
      discoveredAt: timestamp,
    },
    {
      provider: "codex",
      modelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      discoveredAt: timestamp,
    },
  ]);
  return ledger;
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

class FlakyCaptureTmux extends FakeTmux {
  override async capturePane(name: string): Promise<string> {
    this.capturePaneCalls += 1;
    if (this.capturePaneCalls === 1) {
      throw new Error(`capture failed for ${name}`);
    }
    return this.pane;
  }
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
      const model = tool === "claude" ? "claude-test" : "gpt-5.6-sol";
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
      const spawner = newTestSpawner({
        isModelEnabled: async () => true,
        db: store,
        repoRoot: root,
        port: 4317,
        config: {},
        readRoutingPolicy: () => {
          throw new Error("changed routing table must not be consulted");
        },
        tmux,
        sleep: signalControlReadiness(store),
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

  test("fails closed when the recorded model cannot launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-unavailable-"));
    tempRoots.push(root);
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      capabilityEpoch: 1,
      writeRevoked: true,
      executionIdentity: {
        tool: "codex",
        model: "removed-model",
        effort: "high",
      },
      model: "removed-model",
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux("Error: model not supported");
    const controlQuota = makeControlQuota(root);
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CHEAP_ROUTE),
      tmux,
      sleep: async () => {},
      quota: controlQuota.quota,
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
    expect(
      controlQuota.quota.ledger.getReservation(
        failed.controlQuotaReservationId!,
      )?.status,
    ).toEqual("released");
    controlQuota.db.close();
  });

  test("an unverified failed control stop stays stuck and holds its quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-unverified-stop-"));
    tempRoots.push(root);
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      capabilityEpoch: 1,
      writeRevoked: true,
      executionIdentity: {
        tool: "codex",
        model: "removed-model",
        effort: "high",
      },
      model: "removed-model",
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux("Error: model not supported");
    const controlQuota = makeControlQuota(root);
    let stopAttempts = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CHEAP_ROUTE),
      tmux,
      stopSession: async () => {
        stopAttempts += 1;
        throw new Error("verified stop could not prove process exit");
      },
      sleep: async () => {},
      quota: controlQuota.quota,
    });

    await expect(spawner.restartForControl(
      controlled,
      controlMessage("unverified-stop"),
    )).rejects.toThrow();

    const stuck = store.getAgentById(controlled.id)!;
    expect(stopAttempts).toBeGreaterThanOrEqual(1);
    expect(stuck).toMatchObject({
      status: "stuck",
      writeRevoked: true,
      controlMessageId: "unverified-stop",
    });
    expect(stuck.failureReason).toContain("verified stop could not prove process exit");
    expect(tmux.killed).toEqual([]);
    expect(
      controlQuota.quota.ledger.getReservation(
        stuck.controlQuotaReservationId!,
      )?.status,
    ).toEqual("active");
    controlQuota.db.close();
  });

  test("legacy rows without immutable launch fields remain revoked and visibly pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-legacy-"));
    tempRoots.push(root);
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      writeRevoked: true,
      capabilityEpoch: 1,
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    let routeReads = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => {
        routeReads += 1;
        return policyFromRoute(CODEX_ROUTE);
      },
      tmux: new FakeTmux(),
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
  });

  test("insufficient control quota never launches or changes the recorded model", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-exhausted-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      cataloguedQuotaLedger(quotaDb),
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
    const controlled = {
      ...agent("maya", "control-paused"),
      worktreePath: root,
      writeRevoked: true,
      capabilityEpoch: 1,
      executionIdentity: {
        tool: "codex",
        model: "gpt-test",
        effort: "xhigh",
      },
    } satisfies AgentRecord;
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "claude",
        codex: { model: "different-model", effort: "minimal" },
      }),
      tmux,
      quota,
    });

    await expect(spawner.restartForControl(
      controlled,
      controlMessage("exhausted"),
    )).rejects.toThrow("Insufficient quota");
    expect(tmux.sessions).toHaveLength(0);
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: "/tmp/hive-concurrent-names",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      discoverCapabilities: async () => {
        await gate;
        return discovery(capabilityRecord("codex", "gpt-5.6-sol", ["medium"]));
      },
      tmux: new FakeTmux(),
      // Fail after the name is claimed: the claim is what this test is about.
      createWorktree: async () => {
        throw new Error("stop after routing");
      },
      sleep: async () => {},
    });

    // Every spawn is in flight at once, before any of them writes an agent row,
    // so only the reservation table can keep their names apart.
    const spawns = Array.from({ length: 8 }, (_, index) =>
      spawner.spawn({ task: `Task ${index}`, category: "simple_coding" })
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: "/tmp/hive-reservation-race",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      discoverCapabilities: async () => {
        await routingGate;
        return discovery(capabilityRecord("codex", "gpt-5.6-sol", ["medium"]));
      },
      tmux: new FakeTmux(),
      createWorktree: async () => {
        throw new Error("stop after routing");
      },
      sleep: async () => {},
    });

    const first = spawner.spawn({
      task: "First task",
      category: "simple_coding",
      name: "cara",
    });
    expect(store.reservations.has("cara")).toEqual(true);
    await expect(spawner.spawn({
      task: "Conflicting task",
      category: "simple_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: "/tmp/hive-exhausted",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({ task: "One task too many", category: "complex_coding" }))
      .rejects.toThrow("name pool exhausted");
    expect(attemptedWorktree).toEqual(false);
  });

  test("rejects an invalid requested name before creating a worktree", async () => {
    let attemptedWorktree = false;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: "/tmp/hive-invalid-name",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Bad name",
      category: "simple_coding",
      name: "1Maya",
    })).rejects.toThrow("must match /^[a-z][a-z0-9-]{1,20}$/");
    expect(attemptedWorktree).toEqual(false);
  });

  test("rejects a requested name held by a live agent", async () => {
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore([agent("maya")]),
      repoRoot: "/tmp/hive-collision",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        throw new Error("worktree must not be created");
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Duplicate name",
      category: "simple_coding",
      name: "MAYA",
    })).rejects.toThrow('"maya" is already assigned to a live agent');
  });

  test("rejects the reserved orchestrator name before creating a worktree", async () => {
    let attemptedWorktree = false;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: "/tmp/hive-reserved-name",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        attemptedWorktree = true;
        return { path: "/tmp/unused", branch: "hive/unused-task" };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Impersonate the boss",
      category: "simple_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
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

    await spawner.spawn({ task: "Visible interactive task", category: "simple_coding" });
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {
        codex: { driver: "app-server" },
      },
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
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
      category: "simple_coding",
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
    const stopped: string[] = [];
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {
        codex: { driver: "app-server" },
      },
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      stopSession: async (agent) => {
        stopped.push(agent.tmuxSession);
        return { killed: [], survivors: [] };
      },
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      // The fallback TUI launch must still prove life on its own.
      sleep: signalReadiness(store),
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

    await spawner.spawn({ task: "Fallback task", category: "simple_coding" });
    expect(disconnected).toEqual(["maya"]);
    expect(stopped).toEqual([agentTmuxSession("maya")]);
    expect(tmux.sessions).toHaveLength(2);
    expect(tmux.sessions[1]?.[2]).toContain("'codex'");
    expect(tmux.sessions[1]?.[2]).toContain("--dangerously-bypass-hook-trust");
    expect(tmux.sessions[1]?.[2]).toContain("features.hooks=true");
    expect(await deliveredPrompt(tmux.sessions[1]?.[2] ?? "")).toContain(
      "Fallback task",
    );
  });

  test("does not launch a TUI fallback when the app-server stop is unverified", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-app-stop-failed-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const disconnected: string[] = [];
    let stopAttempts = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: { codex: { driver: "app-server" } },
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      stopSession: async () => {
        stopAttempts += 1;
        throw new Error("verified stop could not prove app-server exit");
      },
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
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

    const stuck = await spawner.spawn({
      task: "Do not fallback over an unverified stop",
      category: "simple_coding",
    });

    expect(stopAttempts).toBeGreaterThanOrEqual(1);
    expect(stuck.status).toEqual("stuck");
    expect(disconnected).toEqual(["maya"]);
    expect(tmux.killed).toEqual([]);
    expect(tmux.sessions).toHaveLength(1);
    expect(tmux.sessions[0]?.[2]).toContain("codex-app-server-host");
    expect(tmux.sessions.some(([, , command]) => command.includes("'codex'")))
      .toBeFalse();
  });

  test("reserves quota before worktree creation and launches the selected fallback model", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-quota-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      cataloguedQuotaLedger(quotaDb),
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: quotaSpreadPolicy,
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    const spawned = await spawner.spawn({ task: "Deep task", category: "complex_coding" });
    expect(spawned.tool).toEqual("codex");
    expect(spawned.model).toEqual("gpt-5.6-sol");
    expect(spawned.quotaReservationId).toBeString();
    expect(tmux.sessions[0]?.[2]).toContain("'codex'");
    expect(
      quota.ledger.getReservation(spawned.quotaReservationId!)?.startedAt,
    ).not.toEqual(null);
    quotaDb.close();
  });

  /**
   * The window between the quota booking and the agent row.
   *
   * A spawn books capacity before it writes the row that remembers the booking,
   * so a throw in between leaves a reservation no agent owns — and the
   * dead-agent sweep deliberately skips a reservation with no row, reading it as
   * a spawn still in flight. Nothing then reclaims it until its six-hour TTL,
   * while `reserved` counts it the whole time and can refuse a spawn Hive has
   * room for.
   *
   * These assert the EFFECT, through the same surface the daemon and the CLI
   * read: `statuses()`. A cancel that was called but settled nothing would pass
   * a "was cancel invoked" test and fail these.
   */
  function strandingQuota(root: string): { db: HiveDatabase; quota: QuotaService } {
    const db = new HiveDatabase(join(root, "quota.db"));
    return {
      db,
      quota: new QuotaService(
        cataloguedQuotaLedger(db),
        QuotaConfigSchema.parse({
          discovery: false,
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
      ),
    };
  }

  /** What a reader of `hive quota` would see held against the routed pool. */
  function reservedOnCodex(quota: QuotaService): number {
    const status = quota.statuses().find((entry): entry is QuotaPoolStatus =>
      "pool" in entry && entry.pool === "codex"
    );
    if (status === undefined) {
      throw new Error("codex pool is absent from statuses() — the reader is blind");
    }
    if (status.fiveHour.reserved === null) {
      throw new Error("codex five-hour window is not metered");
    }
    return status.fiveHour.reserved;
  }

  test("a live spawn's booking is visible as reserved capacity", async () => {
    // The positive control. Every assertion below is that `reserved` came back
    // to 0; that is only evidence if this reader can show a booking it is
    // holding. An all-zero reader would pass the leak tests while blind.
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-reserved-seen-"));
    tempRoots.push(root);
    const { db: quotaDb, quota } = strandingQuota(root);
    const store = new FakeStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: quotaSpreadPolicy,
      tmux: new FakeTmux(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    await spawner.spawn({ task: "Deep task", category: "complex_coding" });
    expect(reservedOnCodex(quota)).toBeGreaterThan(0);
    expect(quota.ledger.activeReservations()).toHaveLength(1);
    quotaDb.close();
  });

  test("a spawn whose memory index fails after booking holds no quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-strand-memory-"));
    tempRoots.push(root);
    const { db: quotaDb, quota } = strandingQuota(root);
    const store = new FakeStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: quotaSpreadPolicy,
      tmux: new FakeTmux(),
      // A worktree path that is a regular file, not a directory. buildMemoryIndex
      // walks it and dies on ENOTDIR — the real rejection, not a mocked one, and
      // the one promise in that Promise.all with no `.catch` of its own.
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, `${name}-not-a-directory`);
        await writeFile(path, "worktree path is a file");
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    await expect(spawner.spawn({ task: "Deep task", category: "complex_coding" })).rejects
      .toThrow();
    expect(store.listAgents()).toEqual([]);
    expect(reservedOnCodex(quota)).toEqual(0);
    expect(quota.ledger.activeReservations()).toEqual([]);
    quotaDb.close();
  });

  test("a spawn whose agent-row write fails after booking holds no quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-strand-insert-"));
    tempRoots.push(root);
    const { db: quotaDb, quota } = strandingQuota(root);
    // The second throw site in the same window, and the one a `.catch` on
    // buildMemoryIndex would have left leaking.
    class RefusingStore extends FakeStore {
      override insertAgent(record: AgentRecord): AgentRecord {
        if (record.status === "spawning") {
          throw new Error("agents table write failed");
        }
        return super.insertAgent(record);
      }
    }
    const store = new RefusingStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: quotaSpreadPolicy,
      tmux: new FakeTmux(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    await expect(spawner.spawn({ task: "Deep task", category: "complex_coding" })).rejects
      .toThrow("agents table write failed");
    expect(store.listAgents()).toEqual([]);
    expect(reservedOnCodex(quota)).toEqual(0);
    expect(quota.ledger.activeReservations()).toEqual([]);
    quotaDb.close();
  });

  // modelVendor() used to decide a model's vendor by regex over its NAME, and
  // return null for anything it could not place — which both of its guards read
  // as permission. A model no vendor can run was waved onto whatever tool the
  // router had picked. The vendor is a fact the catalog knows; it is read from
  // there now, and a model nobody claims is refused. Restoring the permissive
  // `!== null` fails this test: the spawn succeeds on the Claude CLI.
  test("refuses a model no vendor's catalog claims, instead of launching it on the routed tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-unclaimed-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({}),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
      // Both vendors answer, and neither lists this model. That is a
      // measurement, not a gap — the grounds to refuse.
      discoverCapabilities: async (provider) =>
        discovery(
          provider === "claude"
            ? capabilityRecord("claude", "claude-opus-4-8", ["low", "high"])
            : capabilityRecord("codex", "gpt-5.6-sol", ["low", "ultra"]),
        ),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    await expect(
      spawner.spawn({
        task: "Run on a model nobody has",
        category: "complex_coding",
        tool: "claude",
        model: "grok-4-fast",
      }),
    ).rejects.toThrow(/no vendor's catalog lists model "grok-4-fast"/);
    // Nothing launched, nothing booked: the old code kept the routed tool and
    // opened a TUI on a model that CLI can never run.
    expect(tmux.sessions).toEqual([]);
    expect(store.listAgents()).toEqual([]);
    expect(quota.ledger.activeReservations()).toEqual([]);

    // Positive control — the same guard must not touch a real model. If this
    // stops spawning, the refusal above is too broad.
    const spawned = await spawner.spawn({
      task: "A model the catalog does claim",
      category: "complex_coding",
      tool: "claude",
      model: "claude-opus-4-8",
    });
    expect(spawned.executionIdentity).toMatchObject({
      tool: "claude",
      model: "claude-opus-4-8",
    });
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
    const probes: Array<"claude" | "codex" | "grok"> = [];
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => ({
        ...policyFromRoute(CLAUDE_ROUTE),
        chains: { default: [
          { provider: "claude", model: "claude-opus-4-8", effort: { mode: "provider-controlled" } },
          { provider: "codex", model: "gpt-5.6-sol", effort: { mode: "provider-controlled" } },
        ] },
      }),
      discoverCapabilities: async (provider) => {
        probes.push(provider);
        return provider === "grok"
          ? { status: "unavailable", reason: "not in fixture" }
          : discovery(
            provider === "claude"
              ? capabilityRecord("claude", "claude-opus-4-8", ["low", "high"])
              : capabilityRecord("codex", "gpt-5.6-sol", ["low", "ultra"]),
          );
      },
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    const spawned = await spawner.spawn({
      task: "Route only among effort-eligible candidates",
      category: "complex_coding",
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

  test("a profiling run is attributed to its own category in the quota ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-profiling-quota-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({}),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => ({
        ...policyFromRoute(CODEX_ROUTE),
        chains: { profiling: [
          { provider: "codex", model: "gpt-5.6-sol", effort: { mode: "provider-controlled" } },
        ] },
      }),
      // Quota refuses to bill a model no catalog has vouched for, so the pool
      // this run is attributed to is a read one, not an assumed one.
      discoverCapabilities: async (provider) =>
        provider === "codex"
          ? discovery(capabilityRecord("codex", "gpt-5.6-sol", ["low", "medium"]))
          : { status: "unavailable", reason: "not in fixture" },
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      quota,
    });

    const spawned = await spawner.spawn({
      task: "Profile this project",
      category: "profiling",
    });

    // The reservation row's category is parsed back through the routing-category
    // enum: a profiling run is spend attributed to profiling, charged the
    // profiling estimate — never dropped, and never bucketed as something else.
    expect(quota.ledger.getReservation(spawned.quotaReservationId!)).toMatchObject({
      agentName: spawned.name,
      provider: "codex",
      category: "profiling",
      estimatedUnits: QuotaConfigSchema.parse({}).estimates.profiling,
    });
    expect(store.listAgents()[0]).toMatchObject({ category: "profiling" });
    quotaDb.close();
  });

  test("launches an explicit request model verbatim on the route's preferred tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-explicit-model-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Open an Opus terminal",
      category: "complex_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: "/tmp/hive-effort-reject",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
      discoverCapabilities: async () => discovery(record),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        created = true;
        return { path: "/tmp/unused", branch: "hive/unused" };
      },
    });

    await expect(spawner.spawn({
      task: "Reject invalid effort",
      category: "complex_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
      discoverCapabilities: async () => discovery(record),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Launch explicit effort",
      category: "complex_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      discoverCapabilities: async () => discovery(record),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Launch explicit Codex effort",
      category: "simple_coding",
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

  test("a read-only spawn gets reader authority and the real Codex filesystem sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-reader-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const issued: Array<[string, string, number]> = [];
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      issueCredential: (name, role, epoch) => {
        issued.push([name, role, epoch]);
        return "test-capability";
      },
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Audit only",
      category: "simple_coding",
      tool: "codex",
      readOnly: true,
    });

    expect(spawned.readOnly).toBeTrue();
    expect(spawned.writeRevoked).toBeFalse();
    expect(issued).toEqual([[spawned.name, "reader", 0]]);
    const shell = tmux.sessions[0]?.[2] ?? "";
    expect(shell).toContain("'--sandbox' 'read-only'");
    expect(await deliveredPrompt(shell)).not.toContain("hive_land");
  });

  test("a read-only spawn refuses before creating a worktree when reader authority cannot be established", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-reader-refuse-"));
    tempRoots.push(root);
    let worktrees = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        worktrees += 1;
        throw new Error("must not create");
      },
    });

    await expect(spawner.spawn({
      task: "Audit only",
      category: "simple_coding",
      readOnly: true,
    })).rejects.toThrow("reader capability issuance is unavailable");
    expect(worktrees).toEqual(0);
  });

  test("launches Grok with catalog identity, project MCP config, and compatibility isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-grok-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const record = capabilityRecord(
      "grok",
      "catalog-model",
      ["low", "medium", "high"],
    );
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      discoverCapabilities: async (provider) =>
        provider === "grok"
          ? discovery(record)
          : { status: "unavailable", reason: "not in fixture" },
      grokIdentity: () => ({
        version: "test-version",
        buildHash: "test-build",
        channel: "stable",
      }),
      issueCredential: () => "test-capability",
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Launch the catalog model",
      category: "simple_coding",
      tool: "grok",
      model: "catalog-model",
      effort: "high",
    });
    expect(spawned.executionIdentity).toEqual({
      tool: "grok",
      model: "catalog-model",
      effort: "high",
      cliVersion: "test-version",
      cliBuildHash: "test-build",
    });
    const shell = tmux.sessions[0]?.[2] ?? "";
    expect(shell).toContain("GROK_CLAUDE_SKILLS_ENABLED=false");
    expect(shell).toContain("'grok' '-m' 'catalog-model'");
    expect(shell).toContain("'--reasoning-effort' 'high'");
    expect(shell).toContain("'--always-approve'");
    const config = await readFile(join(spawned.worktreePath!, ".grok", "config.toml"), "utf8");
    expect(config).toContain('Authorization = "Bearer test-capability"');
    expect(await Bun.file(join(
      spawned.worktreePath!,
      ".agents",
      "skills",
      "hive-grok",
      "SKILL.md",
    )).exists()).toBe(true);
  });

  test("an explicit claude model forces the claude tool off a codex-routed category", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-vendor-force-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      // The field failure: the category routes to Codex, and the explicit
      // claude model used to ride onto the Codex TUI verbatim.
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Open an Opus terminal",
      category: "simple_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Impossible identity",
      category: "simple_coding",
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
            // Deliberately under the complex-coding estimate (20): the explicit
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
      quota,
    });

    await expect(
      spawner.spawn({
        task: "Deep task",
        category: "complex_coding",
        model: "claude-fable-5",
      }),
    ).rejects.toThrow(/Quota pressure makes this spawn unsafe/);
    expect(tmux.sessions).toHaveLength(0);
    quotaDb.close();
  });

  test("writes tool configs, starts named sessions, and inserts records", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const policy: RoutingPolicy = {
      ...policyFromRoute(CODEX_ROUTE),
      chains: {
        complex_coding: [{ provider: "claude", model: "claude-fable-5", effort: { mode: "provider-controlled" } }],
        simple_coding: [{ provider: "codex", model: "gpt-test", effort: { mode: "exact", value: "medium" } }],
      },
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
    let daemonPort = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      // The production daemon is constructed with the same pre-bind sentinel.
      // Resolving this during construction would either throw or write port 0.
      port: () => daemonPort,
      config: {},
      readRoutingPolicy: () => policy,
      tmux,
      createWorktree,
      sleep: signalReadiness(store),
    });

    daemonPort = 4317;
    const claude = await spawner.spawn({ task: "Build auth API", category: "complex_coding" });
    const codex = await spawner.spawn({
      task: "Add route tests",
      category: "simple_coding",
    });

    expect(claude.name).toEqual("maya");
    // The stand-in hook event promoted the proven launch out of "spawning".
    expect(claude.status).toEqual("working");
    // A fresh agent's context is UNKNOWN, not empty. It used to spawn at 0, which
    // reads as "plenty of room" to the orchestrator's reuse rule and was never
    // corrected for any agent whose telemetry Hive could not read.
    expect(claude.contextPct).toBeNull();
    expect(codex.name).toEqual("david");
    expect(store.agents).toEqual([claude, codex]);
    expect(tmux.sessions.map(([name]) => name)).toEqual([
      agentTmuxSession("maya"),
      agentTmuxSession("david"),
    ]);
    expect(tmux.sessions[0]?.[2]).toContain(
      "'--model' 'claude-fable-5'",
    );
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

    const claudeSettings = await readFile(
      join(root, "maya", ".claude", "settings.local.json"),
      "utf8",
    );
    const codexConfig = await readFile(
      join(root, "david", ".codex", "config.toml"),
      "utf8",
    );
    expect(claudeSettings).toContain("acceptEdits");
    expect(claudeSettings).toContain(" event session-start --agent maya");
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
      const spawner = newTestSpawner({
        isModelEnabled: async () => true,
        db: store,
        repoRoot: root,
        port: 4317,
        config: {},
        readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
        tmux,
        createWorktree: async () => ({
          path: worktreePath,
          branch: "hive/maya-memory",
        }),
        sleep: signalReadiness(store),
      });

      await spawner.spawn({ task: "Fix the flaky test", category: "simple_coding" });

      const launched = await deliveredPrompt(tmux.sessions[0]?.[2] ?? "");
      expect(launched).toContain("Hive memory index");
      expect(launched).toContain(
        "[repo/testing] flaky-login-test (2026-06-01) [unverified]: The login test is flaky",
      );
      expect(launched).toContain(
        "[global/general] cli-distribution (2026-05-12) [unverified]: Python has a bad CLI distribution story",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-ready",
      }),
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
      category: "simple_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => ({
        ...policyFromRoute(CODEX_ROUTE),
        chains: { default: [
          { provider: "claude", model: "sonnet", effort: { mode: "provider-controlled" } },
          { provider: "codex", model: "gpt-5.6-sol", effort: { mode: "exact", value: "medium" } },
        ] },
      }),
      tmux,
      createWorktree,
      claudeExecutable: "/daemon/native/claude",
      sleep: signalReadiness(store),
    });

    const claude = await spawner.spawn({
      task: "Use Claude",
      category: "simple_coding",
      name: "Quinn-2",
      tool: "claude",
    });
    const codex = await spawner.spawn({
      task: "Use Codex",
      category: "complex_coding",
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
      "'model_reasoning_effort=medium'",
    );
    expect(tmux.sessions[1]?.[2]).not.toContain("'model=default'");
  });

  test("uses the cheap Claude model for an explicit Claude override", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-cheap-claude-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const store = new FakeStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyWithChain([
        { provider: "codex", model: "gpt-5.6-sol", effort: { mode: "exact", value: "low" } },
        { provider: "claude", model: "haiku", effort: { mode: "provider-controlled" } },
      ]),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Use cheap Claude",
      category: "summarization",
      tool: "claude",
    });

    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("haiku");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'haiku'");
  });

  test("uses the category's configured tool and model without an override", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-configured-route-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    const store = new FakeStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(REVIEW_ROUTE),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Use configured review route",
      category: "code_review",
    });

    expect(spawned.tool).toEqual("claude");
    expect(spawned.model).toEqual("sonnet");
    expect(tmux.sessions[0]?.[2]).toContain("'--model' 'sonnet'");
  });

  test("marks pane errors failed and cleans up", async () => {
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
    const removals: Array<[string, string]> = [];
    const stopped: string[] = [];
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      stopSession: async (agent) => {
        stopped.push(agent.tmuxSession);
        return { killed: [], survivors: [] };
      },
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-failing-launch",
      }),
      removeWorktree: async (repoRoot, path) => {
        removals.push([repoRoot, path]);
      },
      sleep: async () => {},
    });

    const failed = await spawner.spawn({
      task: "Fail at startup",
      category: "simple_coding",
    });

    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("Error: model not supported");
    expect(failed.failureReason).not.toContain("startup line 1\n");
    expect(failed.failedAt).toBeDefined();
    expect(store.agents).toEqual([failed]);
    expect(stopped).toEqual([agentTmuxSession("maya")]);
    expect(removals).toEqual([[root, worktreePath]]);
  });

  test("an unverified failed spawn stop stays stuck and preserves work and quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-unverified-stop-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      cataloguedQuotaLedger(quotaDb),
      QuotaConfigSchema.parse({
        discovery: false,
        limits: [{
          provider: "codex",
          pool: "codex",
          models: ["gpt-5.6-sol"],
          fiveHourAllowance: 500,
          weeklyAllowance: 500,
        }],
      }),
      () => new Date(timestamp),
    );
    const store = new FakeStore();
    const tmux = new FakeTmux("Error: model not supported for this account");
    let removals = 0;
    let stopAttempts = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      stopSession: async () => {
        stopAttempts += 1;
        throw new Error("verified stop could not prove process exit");
      },
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-unverified-stop",
      }),
      assessStrandedWork: async () => ({
        dirtyFiles: [],
        unmergedCommits: 0,
      }),
      removeWorktree: async () => {
        removals += 1;
      },
      sleep: async () => {},
      quota,
    });

    const stuck = await spawner.spawn({
      task: "Fail without proving the process stopped",
      category: "simple_coding",
    });

    expect(stopAttempts).toBeGreaterThanOrEqual(1);
    expect(stuck).toMatchObject({
      status: "stuck",
      writeRevoked: true,
      worktreePath,
    });
    expect(store.getAgentById(stuck.id)).toEqual(stuck);
    expect(stuck.failureReason).toContain("verified stop could not prove process exit");
    expect(removals).toEqual(0);
    expect(tmux.killed).toEqual([]);
    expect(quota.ledger.getReservation(stuck.quotaReservationId!)?.status)
      .toEqual("active");
    quotaDb.close();
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-short-lived-launch",
      }),
      sleep: async () => {},
    });

    const failed = await spawner.spawn({
      task: "Fail before readiness",
      category: "simple_coding",
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-error-handling",
      }),
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
      category: "simple_coding",
    });

    expect(spawned.status).toEqual("working");
    expect(tmux.capturePaneCalls).toEqual(4);
    expect(tmux.killed).toEqual([]);
  });

  test("tolerates a transient pane capture failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-transient-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    const tmux = new FlakyCaptureTmux();
    const store = new FakeStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async () => ({
        path: worktreePath,
        branch: "hive/maya-transient",
      }),
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
      category: "simple_coding",
    });

    expect(spawned.status).toEqual("working");
    expect(tmux.capturePaneCalls).toEqual(4);
    expect(tmux.killed).toEqual([]);
  });

  test("a codex spawn without an exact rollout id proves life through its pane and process", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-codex-rollout-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new class extends FakeTmux {
      override async capturePane(_name: string): Promise<string> {
        this.capturePaneCalls += 1;
        return `Working (${this.capturePaneCalls}s)`;
      }

      override async listPanePids(_name: string): Promise<number[]> {
        return [700];
      }
    }();
    let rolloutReads = 0;
    let processReads = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: async () => {},
      readCodexActivity: async () => {
        rolloutReads += 1;
        return null;
      },
      ps: async () => {
        processReads += 1;
        return [
          "700 1 1024 /bin/zsh -c wrapper",
          "701 700 2048 /usr/local/bin/codex -c model=gpt-test",
        ].join("\n");
      },
    });

    const spawned = await spawner.spawn({
      task: "Prove life without borrowing another rollout",
      category: "simple_coding",
    });

    // A process-backed screen heartbeat is positive launch proof. Even if the
    // hook channel is degraded, that result must close the spawning phase.
    expect(spawned.status).toEqual("working");
    expect(rolloutReads).toBe(0);
    expect(processReads).toBeGreaterThanOrEqual(4);
    expect(tmux.capturePaneCalls).toBeGreaterThanOrEqual(4);
    expect(tmux.killed).toEqual([]);
  });

  test("a spawn with no readiness signal at all fails and is torn down", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-no-signal-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const stopped: string[] = [];
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "medium" },
      }),
      tmux,
      stopSession: async (agent) => {
        stopped.push(agent.tmuxSession);
        return { killed: [], survivors: [] };
      },
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      removeWorktree: async () => {},
      sleep: async () => {},
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({
      task: "Hang at launch forever",
      category: "simple_coding",
    });

    // Exhausting the poll budget with no positive signal is a failed launch,
    // not a silent success left in "spawning" forever.
    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("no sign of life");
    expect(failed.failedAt).toBeDefined();
    expect(stopped).toEqual([agentTmuxSession("maya")]);
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
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
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({ task: "Hang at launch", category: "simple_coding" });

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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
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
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({ task: "Hang at launch", category: "simple_coding" });
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
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux: new FakeTmux(),
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
      readCodexActivity: async () => null,
    });

    const failed = await spawner.spawn({ task: "Hang at launch", category: "simple_coding" });
    expect(failed.status).toEqual("failed");
    expect(removed).toEqual(0);
    expect(failed.failureReason).toContain("could not be checked");
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
 * prompt Hive actually hands the vendor, on every launch path and category, so
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
    // search hygiene — the 2026-07-12 OOM loop: warned by hand, per-brief, until now
    "Search hygiene",
    "never re-run it wider",
  ];

  const worktree = { path: "/tmp/wt", branch: "hive/maya-build-auth" };

  test("every rule is in the prompt, and it is not framed as optional", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo");
    for (const rule of RULES) expect(prompt).toContain(rule);
    expect(prompt).toContain("these are not optional");
  });

  test("a concise category is not exempt — a small model needs the rules most", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo", "", {
      category: "summarization",
    });
    for (const rule of RULES) expect(prompt).toContain(rule);
  });

  test("the rules reach a launched CLAUDE agent's argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-guidelines-claude-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute({ ...CODEX_ROUTE, tool: "claude" }),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    await spawner.spawn({ task: "Build auth API", category: "simple_coding" });
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
      newTestSpawner({
        isModelEnabled: async () => true,
        db: new FakeStore(),
        repoRoot: root,
        port: 4317,
        config: {
          ...(driver === "app-server" ? { codex: { driver } } : {}),
        },
        readRoutingPolicy: () => policyFromRoute({
          ...CODEX_ROUTE,
          tool: "codex",
          codex: { model: "gpt-test", effort: "high" },
        }),
        tmux,
        createWorktree: async (_repoRoot, name, slug) => {
          const path = join(root, `${driver}-${name}`);
          await mkdir(path, { recursive: true });
          return { path, branch: `hive/${name}-${slug}` };
        },
        sleep: async () => {},
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
    await codexSpawner("tui", tuiTmux).spawn({ task: "Build auth API", category: "simple_coding" });
    const tuiCommand = tuiTmux.sessions[0]?.[2] ?? "";
    expect(tuiCommand).toContain("'codex'");
    const tuiLaunched = await deliveredPrompt(tuiCommand);
    for (const rule of RULES) expect(tuiLaunched).toContain(rule);

    const hostTmux = new FakeTmux();
    await codexSpawner("app-server", hostTmux).spawn({
      task: "Build auth API",
      category: "simple_coding",
    });
    expect(starts).toHaveLength(1);
    for (const rule of RULES) expect(starts[0]).toContain(rule);
  });

  test("the blocks between them carry every rule (they are what the prompt splices in)", () => {
    const blocks = `${CODING_GUIDELINES}\n${HIVE_PROTOCOL_RULES}\n${SEARCH_HYGIENE}`;
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
        cataloguedQuotaLedger(db),
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
    return newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
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
      category: "simple_coding",
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
      category: "simple_coding",
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
      category: "simple_coding",
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
      category: "simple_coding",
      model: "claude-opus-4-8",
    });

    expect(failed.status).toEqual("failed");
    const health = quota.ledger.routeHealth("claude", "claude-opus-4-8");
    expect(health?.consecutiveFailures).toEqual(1);
    expect(health?.lastFailureReason).toContain("model not supported");
    db.close();
  });
});

describe("a refusal names the reason it actually refused for", () => {
  const grokDiscovery = (): CapabilityDiscoveryResult => ({
    status: "ok",
    records: [{
      ...capabilityRecord("grok", "grok-4.5", ["low", "high"]),
      displayName: "Grok 4.5",
    }],
    effectiveDefault: {
      provider: "grok",
      model: known("grok-4.5", "grok.models", timestamp),
      effort: unknown("surface-silent", "grok.models", timestamp),
    },
  });

  const claudeDiscovery = (): CapabilityDiscoveryResult => ({
    status: "ok",
    records: [{
      ...capabilityRecord("claude", "claude-opus-4-8", ["low", "high"]),
      displayName: "Opus",
    }],
    effectiveDefault: {
      provider: "claude",
      model: known("claude-opus-4-8", "claude.initialize", timestamp),
      effort: unknown("surface-silent", "claude.initialize", timestamp),
    },
  });

  const codexDiscovery = (): CapabilityDiscoveryResult => ({
    status: "ok",
    records: [{
      ...capabilityRecord("codex", "gpt-5.6-sol", ["low", "medium", "high"]),
      displayName: "GPT-5.6 Sol",
    }],
    effectiveDefault: {
      provider: "codex",
      model: known("gpt-5.6-sol", "codex.model/list", timestamp),
      effort: known("medium", "codex.model/list", timestamp),
    },
  });

  const claudeBilling = (): AccountBilling => ({
    creditsEnabled: known(false, "claude.get_usage", timestamp),
    disabledReason: null,
    generalUtilization: known(20, "claude.get_usage", timestamp),
    modelUtilization: {},
  });

  async function spawnGrok(
    root: string,
    grokModel: string | null,
    enabled: ModelEnablementDecision | undefined | ((
      provider: "claude" | "codex" | "grok",
      model: string,
    ) => ModelEnablementDecision | Promise<ModelEnablementDecision>),
    options: {
      policy?: RoutingPolicy;
      claudeAllowance?: number;
      category?: RoutingCategory;
    } = {},
  ): Promise<{ failure: string; store: FakeStore; tmux: FakeTmux }> {
    const store = new FakeStore();
    const db = new HiveDatabase(join(root, "refusal-quota.db"));
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      ...(enabled === undefined
        ? {}
        : {
          isModelEnabled: async (provider: "claude" | "codex" | "grok", model: string) =>
            typeof enabled === "function" ? await enabled(provider, model) : enabled,
        }),
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => options.policy ?? (grokModel === null
        ? { ...policyFromRoute(CLAUDE_ROUTE), chains: {} }
        : policyFromRoute({ tool: "grok", grok: { model: grokModel } })),
      quota: new QuotaService(
        new QuotaLedger(db),
        QuotaConfigSchema.parse({
          discovery: false,
          limits: [{
            provider: "claude",
            pool: "claude",
            models: ["claude-opus-4-8"],
            fiveHourAllowance: options.claudeAllowance ?? 500,
            weeklyAllowance: options.claudeAllowance ?? 500,
          }],
        }),
        () => new Date(timestamp),
      ),
      tmux,
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
      discoverCapabilities: async (provider) =>
        provider === "grok"
          ? grokDiscovery()
          : provider === "codex"
            ? codexDiscovery()
            : claudeDiscovery(),
      // Grok's billing surface is unreadable. Enablement is the user's standing
      // consent now, so billing never opens an approval prompt.
      readBilling: async (provider) =>
        provider === "claude" ? claudeBilling() : null,
      grokIdentity: () => ({
        version: "0.1.0",
        buildHash: "test-build",
        channel: "stable",
      }),
    });
    let failure = "";
    try {
      await spawner.spawn({
        task: "the spawn that was refused for a route that existed",
        category: options.category ?? "simple_coding",
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    db.close();
    return { failure, store, tmux };
  }

  test("a disabled model refuses with the model and Model Control Center remedy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-refusal-consent-"));
    tempRoots.push(root);
    const { failure, store, tmux } = await spawnGrok(root, "grok-4.5", false);

    expect(tmux.sessions).toEqual([]);
    expect(failure).not.toContain("no route");
    expect(failure).toContain("grok-4.5 is not enabled");
    expect(failure).toContain("Model Control Center");
    expect([...store.approvals.values()]).toEqual([]);
  });

  test("an unreadable enablement row refuses rather than becoming permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-refusal-unreadable-"));
    tempRoots.push(root);
    const { failure, tmux } = await spawnGrok(root, "grok-4.5", null);
    expect(failure).toContain("grok-4.5 is not enabled");
    expect(failure).toContain("Model Control Center");
    expect(tmux.sessions).toEqual([]);
  });

  test("a missing enablement reader refuses rather than becoming permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-refusal-missing-policy-"));
    tempRoots.push(root);
    const { failure, tmux } = await spawnGrok(root, "grok-4.5", undefined);
    expect(failure).toContain("grok-4.5 is not enabled");
    expect(failure).toContain("Model Control Center");
    expect(tmux.sessions).toEqual([]);
  });

  test("an enabled model launches without filing an approval even when billing is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-enabled-unknown-billing-"));
    tempRoots.push(root);
    const { failure, store, tmux } = await spawnGrok(root, "grok-4.5", true);
    expect(failure).toBe("");
    expect([...store.approvals.values()]).toEqual([]);
    expect(tmux.sessions).toHaveLength(1);
  });

  test("an exhausted category falls through to the global default chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-category-global-fallback-"));
    tempRoots.push(root);
    const policy = {
      ...policyFromRoute(CLAUDE_ROUTE),
      chains: {
        simple_coding: [{ provider: "claude", model: "claude-opus-4-8", effort: { mode: "provider-controlled" } }],
        default: [{ provider: "grok", model: "grok-4.5", effort: { mode: "provider-controlled" } }],
      },
    } satisfies RoutingPolicy;
    const { failure, store, tmux } = await spawnGrok(
      root,
      "grok-4.5",
      true,
      { policy, claudeAllowance: 1 },
    );
    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({ tool: "grok", model: "grok-4.5" });
    expect(tmux.sessions[0]?.[2]).toContain("'grok' '-m' 'grok-4.5'");
  });

  // PROFILING: a routing category like any other. It routes through the user's
  // configured chain, falls back to the default chain, and when nothing is
  // launchable it produces the same per-link refusal evidence every other
  // category produces — the caller records those reasons on the failed profile
  // rather than reaching for a fallback model nobody chose.
  test("a profiling spawn routes to the user's configured profiling chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-profiling-chain-"));
    tempRoots.push(root);
    const policy = {
      ...policyFromRoute(CLAUDE_ROUTE),
      chains: {
        profiling: [{
          provider: "grok",
          model: "grok-4.5",
          effort: { mode: "provider-controlled" },
        }],
        default: [{
          provider: "codex",
          model: "gpt-5.6-sol",
          effort: { mode: "provider-controlled" },
        }],
      },
    } satisfies RoutingPolicy;
    const { failure, store } = await spawnGrok(root, "grok-4.5", true, {
      policy,
      category: "profiling",
    });

    expect(failure).toBe("");
    // The profiling chain wins over the default chain, exactly as a category
    // chain does anywhere else.
    expect(store.listAgents()[0]).toMatchObject({
      tool: "grok",
      model: "grok-4.5",
      category: "profiling",
    });
  });

  test("a profiling category with no chain falls back to the global default chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-profiling-default-fallback-"));
    tempRoots.push(root);
    const policy = {
      ...policyFromRoute(CLAUDE_ROUTE),
      chains: {
        default: [{
          provider: "grok",
          model: "grok-4.5",
          effort: { mode: "provider-controlled" },
        }],
      },
    } satisfies RoutingPolicy;
    const { failure, store } = await spawnGrok(root, "grok-4.5", true, {
      policy,
      category: "profiling",
    });

    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({
      tool: "grok",
      model: "grok-4.5",
      category: "profiling",
    });
  });

  test("a profiling spawn with no eligible model refuses with per-link evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-profiling-refusal-"));
    tempRoots.push(root);
    const policy = {
      ...policyFromRoute(CLAUDE_ROUTE),
      chains: {
        profiling: [{
          provider: "grok",
          model: "grok-4.5",
          effort: { mode: "provider-controlled" },
        }],
        default: [{
          provider: "claude",
          model: "claude-opus-4-8",
          effort: { mode: "provider-controlled" },
        }],
      },
    } satisfies RoutingPolicy;
    const { failure, store, tmux } = await spawnGrok(root, "grok-4.5", false, {
      policy,
      category: "profiling",
    });

    // Every link that refused says which link it was and why: the evidence the
    // caller records on the failed profile. No agent, and no invented fallback.
    expect(tmux.sessions).toEqual([]);
    expect(store.listAgents()).toEqual([]);
    expect(failure).toContain("every link of the profiling chain");
    expect(failure).toContain("profiling: grok/grok-4.5");
    expect(failure).toContain("default: claude/claude-opus-4-8");
    expect(failure).toContain("grok-4.5 is not enabled");
    expect(failure).toContain("claude-opus-4-8 is not enabled");
    expect(failure).toContain("Model Control Center");
  });

  test("choice honors the authored order while the first link is launchable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-choice-first-link-"));
    tempRoots.push(root);
    const authored: ChainEntry[] = [
      { provider: "grok", model: "grok-4.5", effort: { mode: "provider-controlled" } },
      { provider: "claude", model: "claude-opus-4-8", effort: { mode: "provider-controlled" } },
    ];
    const policy = {
      ...policyWithChain([...authored, {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: { mode: "provider-controlled" },
      }]),
      chains: { simple_coding: authored },
    } satisfies RoutingPolicy;
    const { failure, store } = await spawnGrok(root, "grok-4.5", true, { policy });

    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({ tool: "grok", model: "grok-4.5" });
  });

  test("choice tries the next authored link before an unranked model", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-choice-next-link-"));
    tempRoots.push(root);
    const authored: ChainEntry[] = [
      { provider: "claude", model: "claude-opus-4-8", effort: { mode: "provider-controlled" } },
      { provider: "codex", model: "gpt-5.6-sol", effort: { mode: "provider-controlled" } },
    ];
    const policy = {
      ...policyWithChain([...authored, {
        provider: "grok",
        model: "grok-4.5",
        effort: { mode: "provider-controlled" },
      }]),
      chains: { simple_coding: authored },
    } satisfies RoutingPolicy;
    const { failure, store } = await spawnGrok(
      root,
      "grok-4.5",
      true,
      { policy, claudeAllowance: 1 },
    );

    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({ tool: "codex", model: "gpt-5.6-sol" });
  });

  test("choice falls through exhausted authored chains to remaining enabled models", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-choice-enabled-fallback-"));
    tempRoots.push(root);
    const category: ChainEntry = {
      provider: "grok",
      model: "grok-4.5",
      effort: { mode: "provider-controlled" },
    };
    const globalDefault: ChainEntry = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "provider-controlled" },
    };
    const fallback: ChainEntry = {
      provider: "claude",
      model: "claude-opus-4-8",
      effort: { mode: "provider-controlled" },
    };
    const policy = {
      ...policyWithChain([category, globalDefault, fallback]),
      chains: { simple_coding: [category], default: [globalDefault] },
    } satisfies RoutingPolicy;
    const { failure, store } = await spawnGrok(
      root,
      "grok-4.5",
      (provider) => provider === "claude",
      { policy },
    );

    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({ tool: "claude", model: "claude-opus-4-8" });
  });

  test("choice fallback never reaches a disabled model even when it is all that remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-choice-disabled-fallback-"));
    tempRoots.push(root);
    const authored: ChainEntry = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "provider-controlled" },
    };
    const disabled: ChainEntry = {
      provider: "claude",
      model: "claude-opus-4-8",
      effort: { mode: "provider-controlled" },
    };
    const base = policyWithChain([authored, disabled]);
    const policy = {
      ...base,
      models: base.models.map((row) =>
        row.provider === "claude" ? { ...row, state: "disabled" as const } : row
      ),
      chains: { simple_coding: [authored] },
    } satisfies RoutingPolicy;
    const checked: string[] = [];
    const { failure, tmux } = await spawnGrok(
      root,
      "grok-4.5",
      (provider, model) => {
        checked.push(`${provider}/${model}`);
        return provider === "claude";
      },
      { policy },
    );

    expect(failure).toContain("every link");
    expect(checked).not.toContain("claude/claude-opus-4-8");
    expect(tmux.sessions).toEqual([]);
  });

  test("choice fallback excludes unknown quota instead of reading it as permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-choice-unknown-fallback-"));
    tempRoots.push(root);
    const authored: ChainEntry = {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "provider-controlled" },
    };
    const unknownQuota: ChainEntry = {
      provider: "grok",
      model: "grok-4.5",
      effort: { mode: "provider-controlled" },
    };
    const knownQuota: ChainEntry = {
      provider: "claude",
      model: "claude-opus-4-8",
      effort: { mode: "provider-controlled" },
    };
    const policy = {
      ...policyWithChain([authored, unknownQuota, knownQuota]),
      chains: { simple_coding: [authored] },
    } satisfies RoutingPolicy;
    const { failure, store } = await spawnGrok(
      root,
      "grok-4.5",
      (provider) => provider !== "codex",
      { policy },
    );

    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({ tool: "claude", model: "claude-opus-4-8" });
  });

  test("a fully refused category and default name every link and the remedy", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-chain-all-refused-"));
    tempRoots.push(root);
    const policy = {
      ...policyFromRoute(CLAUDE_ROUTE),
      chains: {
        simple_coding: [{ provider: "grok", model: "grok-4.5", effort: { mode: "provider-controlled" } }],
        default: [{ provider: "claude", model: "claude-opus-4-8", effort: { mode: "provider-controlled" } }],
      },
    } satisfies RoutingPolicy;
    const { failure, tmux } = await spawnGrok(root, "grok-4.5", false, { policy });
    expect(failure).toContain("simple_coding: grok/grok-4.5 — enablement");
    expect(failure).toContain("default: claude/claude-opus-4-8 — enablement");
    expect(failure).toContain("Model Control Center");
    expect(tmux.sessions).toEqual([]);
  });

  test("an unconfigured provider cannot promote enabled child rows into launch authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-provider-unconfigured-"));
    tempRoots.push(root);
    const policyDb = new HiveDatabase(":memory:");
    const policyStore = new RoutingPolicyStore(policyDb);
    let policy = policyStore.apply(
      {
        op: "set-model",
        expectedRevision: 0,
        provider: "grok",
        model: "grok-4.5",
        state: "enabled",
      },
      "unsafe-seed-regression",
    );
    policy = policyStore.apply(
      {
        op: "set-model",
        expectedRevision: 1,
        provider: "claude",
        model: "claude-opus-4-8",
        state: "enabled",
      },
      "unsafe-seed-regression",
    );
    policy = policyStore.apply(
      {
        op: "set-chain",
        expectedRevision: 2,
        category: "simple_coding",
        entries: [{
          provider: "grok",
          model: "grok-4.5",
          effort: { mode: "provider-controlled" },
        }],
      },
      "unsafe-seed-regression",
    );
    policy = policyStore.apply(
      {
        op: "set-chain",
        expectedRevision: 3,
        category: "default",
        entries: [{
          provider: "claude",
          model: "claude-opus-4-8",
          effort: { mode: "provider-controlled" },
        }],
      },
      "unsafe-seed-regression",
    );

    const { failure, tmux } = await spawnGrok(
      root,
      "grok-4.5",
      policyModelEnablement(policyStore),
      { policy },
    );
    policyDb.close();

    expect(failure).toContain(
      "simple_coding: grok/grok-4.5 — enablement: grok-4.5 cannot launch " +
        "because exact model consent is not enabled under provider grok; enable both in the Model Control Center",
    );
    expect(failure).toContain(
      "default: claude/claude-opus-4-8 — enablement: claude-opus-4-8 cannot launch " +
        "because exact model consent is not enabled under provider claude; enable both in the Model Control Center",
    );
    expect(tmux.sessions).toEqual([]);
  });

  test("a disabled chain link is skipped and never reaches launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-chain-disabled-skip-"));
    tempRoots.push(root);
    const checked: string[] = [];
    const policy = {
      ...policyFromRoute(CLAUDE_ROUTE),
      chains: {
        simple_coding: [
          { provider: "grok", model: "grok-4.5", effort: { mode: "provider-controlled" } },
          { provider: "claude", model: "claude-opus-4-8", effort: { mode: "provider-controlled" } },
        ],
      },
    } satisfies RoutingPolicy;
    const { failure, store, tmux } = await spawnGrok(
      root,
      "grok-4.5",
      (provider, model) => {
        checked.push(`${provider}/${model}`);
        return provider !== "grok";
      },
      { policy },
    );
    expect(failure).toBe("");
    expect(store.listAgents()[0]).toMatchObject({ tool: "claude", model: "claude-opus-4-8" });
    expect(checked[0]).toBe("grok/grok-4.5");
    expect(checked.filter((entry) => entry === "grok/grok-4.5")).toHaveLength(1);
    expect(checked).toContain("claude/claude-opus-4-8");
    expect(tmux.sessions[0]?.[2]).not.toContain("grok-4.5");
  });

  test("a route that is genuinely missing still reports a missing route", async () => {
    // A policy refusal when the route is genuinely gone would be no more honest
    // than a routing refusal over a disabled model. The cases stay distinct.
    const root = await mkdtemp(join(tmpdir(), "hive-refusal-noroute-"));
    tempRoots.push(root);
    const { failure, store } = await spawnGrok(root, null, undefined);

    expect(failure).toContain("has no chain");
    expect(failure).toContain("global default chain is empty");
    expect(failure).not.toContain("not enabled");
    expect([...store.approvals.values()]).toEqual([]);
  });
});

describe("graph context in the spawn prompt", () => {
  const worktree = {
    path: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-auth-api",
  };

  test("the digest and the tools directive ride their own options", () => {
    const prompt = buildAgentPrompt("maya", "Fix auth", worktree, "/repo", "", {
      graphBrief: "Graph context (graphify, advisory): NODE auth.ts",
      graphifyTools: true,
    });
    expect(prompt).toContain("Graph context (graphify, advisory)");
    // Layer 2: one directive, present only because the tools are attached.
    // Graph-first (product decision), with the concrete fallback criteria
    // that keep the mandate honest.
    expect(prompt).toContain("Work graph-first");
    expect(prompt).toContain("get_neighbors");
    expect(prompt).toContain("cannot answer");
    // The tool's own default budget provably returns zero edges; the
    // directive must carry the working number.
    expect(prompt).toContain("token_budget: 16000");
  });

  test("no opt-in means a bit-identical prompt", () => {
    const bare = buildAgentPrompt("maya", "Fix auth", worktree, "/repo");
    expect(
      buildAgentPrompt("maya", "Fix auth", worktree, "/repo", "", {}),
    ).toBe(bare);
    expect(bare).not.toContain("graphify");
  });

  test("the directive never advertises tools that are not attached", () => {
    const prompt = buildAgentPrompt("maya", "Fix auth", worktree, "/repo", "", {
      graphBrief: "Graph context: unavailable (graph not built yet); proceeding without it.",
    });
    expect(prompt).toContain("unavailable");
    expect(prompt).not.toContain("query_graph");
  });
});

test("Grok safety facts ride the spawn prompt, not skill uptake", () => {
  const worktree = { path: "/tmp/maya", branch: "hive/maya-task" };
  const prompt = buildAgentPrompt(
    "maya",
    "Fix auth",
    worktree,
    "/repo",
    "",
    { tool: "grok" },
  );
  expect(prompt).toContain("sandbox is not a write barrier");
  expect(prompt).toContain("still exits 0");
  expect(prompt).toContain("A --deny refusal is different");
  expect(prompt).toContain("CLAUDE.md");
  expect(buildAgentPrompt("maya", "Fix auth", worktree, "/repo"))
    .not.toContain("Grok safety facts");
});
