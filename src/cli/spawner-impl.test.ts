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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountBillingFromCodexRateLimits,
  type AccountBilling,
} from "../daemon/usage-credits";
import {
  agentStateCas,
  type AgentStateCas,
  type Approval,
  type ConditionalAgentUpdate,
  type RouteAudit,
} from "../daemon/db";
import { CODEX_WRITER_CONTAINMENT_REASON } from "../daemon/codex-containment";
import {
  QuotaConfigSchema,
  isLiveAgent,
  isTerminalAgentStatus,
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
  buildAgentPromptParts,
  buildLandingProtocol,
  CODING_GUIDELINES,
  GROK_SAFETY_DIRECTIVE,
  HIVE_PROTOCOL_RULES,
  HiveSpawner,
  type AgentPromptOptions,
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
import {
  codexDeveloperPromptPath,
  readCodexDeveloperInstructions,
  writeCodexSessionBootstrap,
} from "../daemon/launch-prompt";
import type { CodexSessionBootstrap } from "../adapters/tools/codex";

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
    // A default credential issuer so read-only Codex spawns (the allowed
    // surface after the Codex-writer containment) work without every test
    // wiring one; the two tests that assert credential behavior pass their own.
    issueCredential: () => ({ token: "test-capability", rollback: () => {} }),
    codexVersion: dependencies.codexVersion ?? (async () => "0.144.4"),
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

const routeAuditCatalog = async (
  provider: "claude" | "codex" | "grok",
): Promise<CapabilityDiscoveryResult> =>
  discovery(
    provider === "claude"
      ? capabilityRecord("claude", "claude-opus-4-8", ["low", "high"])
      : provider === "codex"
        ? capabilityRecord("codex", "gpt-5.6-sol", ["medium", "high"])
        : capabilityRecord("grok", "grok-4.5", ["high"]),
  );

function routeAuditTestSpawner(
  store: FakeStore,
  overrides: Partial<HiveSpawnerDependencies> = {},
): HiveSpawner {
  return newTestSpawner({
    isModelEnabled: async () => true,
    repoRoot: "/tmp/hive-route-audit-matrix",
    port: 4317,
    config: {},
    readRoutingPolicy: () => policyFromRoute(CLAUDE_ROUTE),
    discoverCapabilities: routeAuditCatalog,
    tmux: new FakeTmux(),
    createWorktree: async () => {
      throw new Error("stop after routing");
    },
    sleep: async () => {},
    ...overrides,
    db: store,
  });
}

async function captureRouteAudit(
  request: Parameters<HiveSpawner["spawn"]>[0],
  overrides: Partial<HiveSpawnerDependencies> = {},
): Promise<{ audit: RouteAudit; error: Error }> {
  const store = new FakeStore();
  let caught: unknown;
  try {
    await routeAuditTestSpawner(store, overrides).spawn(request);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(store.routeAudits).toHaveLength(1);
  const audit = store.routeAudits[0]!;
  expect(JSON.stringify(audit)).not.toContain(request.task);
  return { audit, error: caught as Error };
}

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
  readonly routeAudits: RouteAudit[] = [];

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

  insertRouteAudit(audit: RouteAudit): RouteAudit {
    this.routeAudits.push(audit);
    return audit;
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

  updateAgentIfCurrent(
    expected: AgentStateCas,
    updates: ConditionalAgentUpdate,
  ): AgentRecord | null {
    const current = this.getAgentById(expected.id);
    if (
      current === null ||
      JSON.stringify(agentStateCas(current)) !== JSON.stringify(expected)
    ) {
      return null;
    }
    return this.insertAgent({ ...current, ...updates });
  }

  beginAgentProcess(
    expected: AgentStateCas,
    startedAt: string,
    sessionId: string | null,
    recoveryAttempts: number,
    options: {
      status: Exclude<AgentRecord["status"], "done" | "dead" | "failed">;
      codexDriver?: AgentRecord["codexDriver"];
    },
  ): AgentRecord | null {
    return this.updateAgentIfCurrent(expected, {
      status: options.status,
      toolSessionId: sessionId ?? undefined,
      processIncarnation: expected.processIncarnation + 1,
      processStartedAt: startedAt,
      recoveryAttempts,
      lastEventAt: startedAt,
      identityState: undefined,
      observedIdentity: undefined,
      liveModel: undefined,
      liveEffort: undefined,
      ...("codexDriver" in options ? { codexDriver: options.codexDriver } : {}),
    });
  }

  markAgentTerminal(
    agentId: string,
    timestamp: string,
    status: "dead" | "failed" | "done",
    options: { failureReason?: string; failedAt?: string } = {},
  ): AgentRecord | null {
    const current = this.getAgentById(agentId);
    if (current === null) return null;
    return this.insertAgent({
      ...current,
      status,
      writeRevoked: true,
      capabilityEpoch: current.capabilityEpoch + 1,
      failureReason: options.failureReason ?? current.failureReason,
      failedAt: options.failedAt ??
        (status === "failed" ? timestamp : current.failedAt),
      lastEventAt: timestamp,
      closedAt: current.closedAt ?? timestamp,
      pauseCapture: undefined,
      controlMessageId: undefined,
    });
  }

  markAgentTerminalIfCurrent(
    expected: AgentStateCas,
    timestamp: string,
    status: "dead" | "failed" | "done",
    options: { failureReason?: string; failedAt?: string } = {},
  ): AgentRecord | null {
    if (isTerminalAgentStatus(expected.status)) return null;
    const current = this.getAgentById(expected.id);
    if (
      current === null ||
      JSON.stringify(agentStateCas(current)) !== JSON.stringify(expected)
    ) {
      return null;
    }
    return this.markAgentTerminal(current.id, timestamp, status, options);
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

async function codexDeveloperPrompt(command: string): Promise<string> {
  const path = /\$\(cat '([^']+\.developer\.toml)'\)/.exec(command)?.[1];
  if (path === undefined) {
    throw new Error(`launch command carries no Codex developer artifact: ${command}`);
  }
  return await readCodexDeveloperInstructions(path);
}

async function codexUserPrompt(command: string): Promise<string> {
  const path = /\$\(cat '([^']+\.user\.txt)'\)/.exec(command)?.[1];
  if (path === undefined) {
    throw new Error(`launch command carries no Codex user artifact: ${command}`);
  }
  return await readFile(path, "utf8");
}

async function seedCodexDeveloperArtifact(agent: AgentRecord): Promise<void> {
  await writeCodexSessionBootstrap(agent.tmuxSession, {
    developerInstructions: `Durable Hive rules for ${agent.name}`,
  });
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
      if (tool === "codex") await seedCodexDeveloperArtifact(controlled);
      await spawner.restartForControl(controlled, message);
      const command = tmux.sessions[0]?.[2] ?? "";
      // The order itself travels in the prompt file; the flags stay on the argv.
      const order = tool === "codex"
        ? await codexUserPrompt(command)
        : await deliveredPrompt(command);
      expect(order).toContain("CRITICAL HIVE CONTROL");
      expect(order).toContain("This process is read-only");
      expect(command).toContain(tool === "claude"
        ? "--permission-mode"
        : "--sandbox");
      expect(command).toContain(tool === "claude" ? "default" : "read-only");
      expect(command).toContain(model);
      expect(command).toContain("high");
      const restarted = store.getAgentById(controlled.id)!;
      expect(restarted.processIncarnation).toBe(
        (controlled.processIncarnation ?? 0) + 1,
      );
      expect(restarted.processStartedAt).toBeString();
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

  test("a native Codex control restart exports its replacement reader credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-codex-app-server-"));
    tempRoots.push(root);
    const controlled = {
      ...agent("maya", "control-paused"),
      tool: "codex",
      model: "gpt-5.6-sol",
      worktreePath: root,
      capabilityEpoch: 1,
      writeRevoked: true,
      // The prior incarnation ran the TUI; the config has since selected
      // app-server. The restart must record the driver IT launches with.
      codexDriver: "tui",
      executionIdentity: {
        tool: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    } satisfies AgentRecord;
    const controlQuota = makeControlQuota(root);
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux();
    const starts: Array<{
      bootstrap: CodexSessionBootstrap;
      readOnly: boolean;
    }> = [];
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: { codex: { driver: "app-server" } },
      readRoutingPolicy: () => {
        throw new Error("control restart must use its recorded identity");
      },
      tmux,
      sleep: signalControlReadiness(store),
      quota: controlQuota.quota,
      issueCredential: () => ({
        token: "control-reader-secret",
        rollback: () => {},
      }),
      codexAppServer: {
        isAvailable: async () => true,
        buildHostCommand: () => ["hive", "codex-app-server-host"],
        startAgent: async (record, bootstrap) => {
          starts.push({ bootstrap, readOnly: record.readOnly });
        },
        disconnect: () => undefined,
      },
    });
    const message = controlMessage("app-server-control");

    await seedCodexDeveloperArtifact(controlled);
    await spawner.restartForControl(controlled, message);

    const command = tmux.sessions[0]?.[2] ?? "";
    expect(command).toContain("'codex-app-server-host'");
    expect(command).toContain(
      `HIVE_CAPABILITY_TOKEN="$(cat ${root}/.codex/capability-token)"`,
    );
    expect(command).not.toContain("control-reader-secret");
    expect(await readFile(join(root, ".codex", "capability-token"), "utf8"))
      .toEqual("control-reader-secret");
    expect(starts).toEqual([{
      bootstrap: {
        developerInstructions: "Durable Hive rules for maya",
        initialUserPrompt: expect.stringContaining("hive_ack_message"),
      },
      readOnly: true,
    }]);
    // The driver is per-incarnation: the replacement launched on app-server
    // and the row must say so, not repeat the prior incarnation's TUI.
    expect(store.listAgents()[0]?.codexDriver).toBe("app-server");
    controlQuota.db.close();
  });

  test("a Codex critical restart fails closed without its developer artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-control-codex-missing-"));
    tempRoots.push(root);
    const controlled = {
      ...agent("maya", "control-paused"),
      tool: "codex",
      model: "gpt-5.6-sol",
      worktreePath: root,
      capabilityEpoch: 1,
      writeRevoked: true,
      executionIdentity: {
        tool: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
      },
    } satisfies AgentRecord;
    await rm(codexDeveloperPromptPath(controlled.tmuxSession), { force: true });
    const controlQuota = makeControlQuota(root);
    const store = new FakeStore([controlled]);
    const tmux = new FakeTmux();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: root,
      port: 4317,
      config: {},
      tmux,
      quota: controlQuota.quota,
    });

    await expect(spawner.restartForControl(
      controlled,
      controlMessage("missing-developer-artifact"),
    )).rejects.toThrow("developer-instruction artifact is missing or invalid");
    expect(tmux.sessions).toEqual([]);
    expect(store.getAgentById(controlled.id)).toMatchObject({
      status: "control-paused",
      writeRevoked: true,
      controlMessageId: "missing-developer-artifact",
    });
    expect(controlQuota.quota.ledger.activeReservations()).toEqual([]);
    controlQuota.db.close();
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

    await seedCodexDeveloperArtifact(controlled);
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

    await seedCodexDeveloperArtifact(controlled);
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

    await seedCodexDeveloperArtifact(controlled);
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

    await seedCodexDeveloperArtifact(controlled);
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
    expect(() => resolveAgentName("queen", [])).toThrow(
      'Agent name "queen" is reserved',
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
    // Names that would be ambiguous when spoken to the root: preferred and
    // synonym destinations, the tools, and the human running the Hive.
    for (const reserved of ["queen", "orchestrator", "claude", "codex", "hive", "scott"]) {
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

  test("a routing decision is recorded as a structured route audit", async () => {
    const store = new FakeStore();
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: store,
      repoRoot: "/tmp/hive-route-audit",
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      discoverCapabilities: async () =>
        discovery(capabilityRecord("codex", "gpt-5.6-sol", ["medium"])),
      tmux: new FakeTmux(),
      // Stop just after routing: the audit is persisted before the worktree is
      // created, so this isolates the decision and its structured record.
      createWorktree: async () => {
        throw new Error("stop after routing");
      },
      sleep: async () => {},
    });
    await expect(
      spawner.spawn({
        task: "Do the thing",
        category: "simple_coding",
        readOnly: true,
      }),
    ).rejects.toThrow("stop after routing");

    expect(store.routeAudits).toHaveLength(1);
    const audit = store.routeAudits[0]!;
    expect(audit.category).toEqual("simple_coding");
    expect(audit.selectedTool).toEqual("codex");
    expect(audit.selectedModel).toEqual("gpt-5.6-sol");
    expect(audit.selectedEffort).toEqual("medium");
    expect(typeof audit.policyRevision).toEqual("number");
    expect(Array.isArray(audit.attempts)).toBe(true);
  });

  test("vendor resolution refusals each write one prompt-free audit", async () => {
    const unclaimed = await captureRouteAudit({
      task: "SECRET unclaimed prompt",
      category: "simple_coding",
      model: "model-no-provider-publishes",
    });
    expect(unclaimed.error.message).toContain("no vendor's catalog lists model");
    expect(unclaimed.audit.attempts.join("\n")).toContain("no vendor's catalog lists model");
    expect(unclaimed.audit.selectedTool).toBeNull();

    const unreadable = await captureRouteAudit({
      task: "SECRET unreadable prompt",
      category: "simple_coding",
      model: "model-with-unknown-vendor",
    }, {
      discoverCapabilities: async () => {
        throw new Error("catalog offline");
      },
    });
    expect(unreadable.error.message).toContain("no vendor's catalog could be read");
    expect(unreadable.audit.attempts.join("\n")).toContain("no vendor's catalog could be read");
    expect(unreadable.audit.selectedTool).toBeNull();

    const mismatch = await captureRouteAudit({
      task: "SECRET mismatch prompt",
      category: "simple_coding",
      tool: "codex",
      model: "claude-opus-4-8",
    });
    expect(mismatch.error.message).toMatch(/claude model.*tool="codex"/s);
    expect(mismatch.audit.attempts.join("\n")).toContain("tool=\"codex\"");
    expect(mismatch.audit.selectedTool).toBeNull();
  });

  test("early vendor resolution exceptions write one audit and preserve the error", async () => {
    const vendorError = new Error("vendor resolution exploded");
    const failure = await captureRouteAudit({
      task: "SECRET vendor exception prompt",
      category: "simple_coding",
      model: "vendor-resolution-test",
    }, {
      discoverCapabilities: async () => ({
        status: "ok",
        get records(): CapabilityRecord[] {
          throw vendorError;
        },
      } as unknown as CapabilityDiscoveryResult),
    });

    expect(failure.error).toBe(vendorError);
    expect(failure.audit.attempts).toEqual(["refused: vendor resolution exploded"]);
    expect(failure.audit.selectedTool).toBeNull();
  });

  test("thrown billing and capability-catalog guards each write one audit", async () => {
    const billingError = new Error("billing guard exploded");
    const billing = await captureRouteAudit({
      task: "SECRET billing exception prompt",
      category: "simple_coding",
      model: "claude-opus-4-8",
    }, {
      readBilling: async () => {
        throw billingError;
      },
    });
    expect(billing.error).toBe(billingError);
    expect(billing.audit.attempts).toEqual(["refused: billing guard exploded"]);
    expect(billing.audit.selectedTool).toBeNull();

    const catalogError = new Error("capability catalog replacement exploded");
    const root = await mkdtemp(join(tmpdir(), "hive-route-audit-catalog-error-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    quota.replaceCapabilityCatalog = () => {
      throw catalogError;
    };
    const catalog = await captureRouteAudit({
      task: "SECRET capability catalog prompt",
      category: "simple_coding",
      model: "claude-opus-4-8",
    }, { quota });
    expect(catalog.error).toBe(catalogError);
    expect(catalog.audit.attempts).toEqual([
      "refused: capability catalog replacement exploded",
    ]);
    expect(catalog.audit.selectedTool).toBeNull();
    quotaDb.close();
  });

  test("a later thrown catalog dependency preserves every earlier link attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-route-audit-late-catalog-error-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const replaceCatalog = quota.replaceCapabilityCatalog.bind(quota);
    const catalogError = new Error("second-link catalog replacement exploded");
    quota.replaceCapabilityCatalog = (provider, records) => {
      if (provider === "codex") throw catalogError;
      replaceCatalog(provider, records);
    };
    const chain = [
      {
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      },
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: { mode: "provider-controlled" },
      },
    ] satisfies ChainEntry[];

    try {
      const failure = await captureRouteAudit({
        task: "SECRET later dependency prompt",
        category: "simple_coding",
        readOnly: true,
      }, {
        quota,
        readRoutingPolicy: () => policyWithChain(chain),
        isModelEnabled: async (provider) => provider !== "claude",
      });
      expect(failure.error).toBe(catalogError);
      expect(failure.audit.attempts.some((attempt) =>
        attempt.includes("claude/claude-opus-4-8") &&
        attempt.includes("not enabled")
      )).toBeTrue();
      expect(failure.audit.attempts.at(-1)).toEqual(
        "refused: second-link catalog replacement exploded",
      );
      expect(failure.audit.selectedTool).toBeNull();
    } finally {
      quotaDb.close();
    }
  });

  test("audit insertion failure never masks or retries the routing error", async () => {
    const store = new FakeStore();
    const routingError = new Error("original routing failure");
    let insertions = 0;
    store.insertRouteAudit = () => {
      insertions += 1;
      throw new Error("route audit store unavailable");
    };

    let caught: unknown;
    try {
      await routeAuditTestSpawner(store, {
        readBilling: async () => {
          throw routingError;
        },
      }).spawn({
        task: "SECRET failed audit prompt",
        category: "simple_coding",
        model: "claude-opus-4-8",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(routingError);
    expect(insertions).toEqual(1);
    expect(store.routeAudits).toHaveLength(0);
  });

  test("gate, independence, and quota refusals each write one truthful audit", async () => {
    const gate = await captureRouteAudit({
      task: "SECRET gate prompt",
      category: "simple_coding",
      model: "claude-opus-4-8",
    }, {
      isModelEnabled: async () => false,
    });
    expect(gate.error.message).toContain("not enabled");
    expect(gate.audit.attempts).toEqual([
      expect.stringContaining("refused claude/claude-opus-4-8 — enablement"),
    ]);

    const sameProvider = await captureRouteAudit({
      task: "SECRET same-provider prompt",
      category: "code_review",
      model: "claude-opus-4-8",
      reviewOfTool: "claude",
    });
    expect(sameProvider.error.message).toContain("refuses same-provider candidate");
    expect(sameProvider.audit.reviewOfTool).toEqual("claude");
    expect(sameProvider.audit.attempts).toEqual([
      expect.stringContaining("eligible claude/claude-opus-4-8"),
      expect.stringContaining("excluded same-provider"),
      expect.stringContaining("no independent route"),
    ]);

    const root = await mkdtemp(join(tmpdir(), "hive-route-audit-quota-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const quota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({
        reserveFiveHourPct: 0,
        reserveWeeklyPct: 0,
        limits: [{
          provider: "claude",
          account: "default",
          pool: "claude-opus",
          models: ["claude-opus-4-8"],
          fiveHourAllowance: 1,
          weeklyAllowance: 1,
        }],
      }),
      () => new Date(timestamp),
    );
    const quotaRefusal = await captureRouteAudit({
      task: "SECRET quota prompt",
      category: "complex_coding",
      model: "claude-opus-4-8",
    }, { quota });
    expect(quotaRefusal.audit.attempts).toEqual([
      expect.stringContaining("eligible claude/claude-opus-4-8"),
      expect.stringContaining("quota refused"),
    ]);
    expect(quotaRefusal.audit.selectedTool).toBeNull();
    quotaDb.close();
  });

  test("an explicit Codex request fails closed on compatibility without substitution", async () => {
    const failure = await captureRouteAudit({
      task: "SECRET incompatible explicit Codex prompt",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5.6-sol",
      readOnly: true,
    }, {
      codexVersion: async () => "0.144.3",
    });

    expect(failure.error.message).toContain("compatibility refused");
    expect(failure.error.message).toContain("Codex CLI 0.144.3 is unsupported");
    expect(failure.audit.attempts).toEqual([
      expect.stringContaining("explicit: refused codex/gpt-5.6-sol — compatibility"),
    ]);
    expect(failure.audit.selectedTool).toBeNull();
  });

  test("a routed incompatible Codex link leaves the next provider eligible", async () => {
    const entries = [
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        effort: { mode: "provider-controlled" },
      },
      {
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      },
    ] satisfies ChainEntry[];
    const selected = await captureRouteAudit({
      task: "SECRET routed compatibility prompt",
      category: "simple_coding",
      readOnly: true,
    }, {
      readRoutingPolicy: () => policyWithChain(entries),
      codexVersion: async () => "0.144.3",
    });

    expect(selected.error.message).toEqual("stop after routing");
    expect(selected.audit.attempts).toEqual([
      expect.stringContaining("default: codex/gpt-5.6-sol — compatibility"),
      "default: claude/claude-opus-4-8 — eligible",
      "selected claude/claude-opus-4-8 (quota disabled/absent)",
    ]);
    expect(selected.audit.selectedTool).toEqual("claude");
  });

  test("one route decision probes Codex once across several Codex links", async () => {
    let probes = 0;
    const entries = [
      {
        provider: "codex",
        model: "gpt-first",
        effort: { mode: "provider-controlled" },
      },
      {
        provider: "codex",
        model: "gpt-second",
        effort: { mode: "provider-controlled" },
      },
      {
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      },
    ] satisfies ChainEntry[];
    const selected = await captureRouteAudit({
      task: "SECRET memoized compatibility prompt",
      category: "simple_coding",
      readOnly: true,
    }, {
      readRoutingPolicy: () => policyWithChain(entries),
      codexVersion: async () => (probes += 1, "0.144.3"),
    });

    expect(selected.error.message).toEqual("stop after routing");
    expect(probes).toEqual(1);
    expect(selected.audit.attempts.filter((attempt) =>
      attempt.includes("— compatibility")
    )).toHaveLength(2);
  });

  test("Claude-only authorization never probes Codex", async () => {
    const selected = await captureRouteAudit({
      task: "SECRET Claude-only compatibility prompt",
      category: "simple_coding",
      readOnly: true,
    }, {
      readRoutingPolicy: () => policyWithChain([{
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      }]),
      codexVersion: async () => { throw new Error("must not probe Codex"); },
    });

    expect(selected.error.message).toEqual("stop after routing");
    expect(selected.audit.selectedTool).toEqual("claude");
  });

  test("adapter revalidation includes the Codex compatibility guard", async () => {
    const spawner = newTestSpawner({
      db: new FakeStore(),
      repoRoot: "/tmp/hive-compatibility-revalidation",
      port: 4317,
      config: {},
      tmux: new FakeTmux(),
      isModelEnabled: async () => true,
      codexVersion: async () => "0.144.3",
      discoverCapabilities: async () => {
        throw new Error("resolution must not run before compatibility");
      },
    });

    await expect(spawner.authorizeLaunch({
      tool: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
    })).rejects.toThrow("compatibility refused");
  });

  test("never-configured, empty, and total exhaustion each write one refusal audit", async () => {
    const base = policyFromRoute(CLAUDE_ROUTE);
    const never = await captureRouteAudit({
      task: "SECRET never prompt",
      category: "simple_coding",
    }, {
      readRoutingPolicy: () => ({
        ...base,
        selection: { global: "never-configured", categories: {} },
      }),
    });
    expect(never.audit.attempts).toEqual([
      "refused: preference for simple_coding is never-configured",
    ]);

    const empty = await captureRouteAudit({
      task: "SECRET empty prompt",
      category: "simple_coding",
    }, {
      readRoutingPolicy: () => ({
        ...base,
        models: [],
        chains: { default: [] },
        selection: { global: "choice", categories: {} },
      }),
    });
    expect(empty.audit.attempts).toEqual([
      "refused: category simple_coding has no chain and global default is empty",
    ]);

    const total = await captureRouteAudit({
      task: "SECRET total prompt",
      category: "simple_coding",
    }, {
      readRoutingPolicy: () => policyWithChain([{
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      }]),
      isModelEnabled: async () => false,
    });
    expect(total.audit.attempts).toEqual([
      expect.stringContaining("default: claude/claude-opus-4-8 — enablement"),
      "refused: total chain exhaustion",
    ]);
    expect(total.audit.selectedTool).toBeNull();
  });

  test("audits every link and selects only after containment", async () => {
    const first = capabilityRecord("claude", "claude-first", ["high"]);
    const second = capabilityRecord("claude", "claude-second", ["high"]);
    const entries: ChainEntry[] = [
      { provider: "claude", model: first.canonicalId, effort: { mode: "provider-controlled" } },
      { provider: "claude", model: second.canonicalId, effort: { mode: "provider-controlled" } },
    ];
    const perLink = await captureRouteAudit({
      task: "SECRET per-link prompt",
      category: "simple_coding",
    }, {
      readRoutingPolicy: () => policyWithChain(entries),
      discoverCapabilities: async (provider) => ({
        ...await routeAuditCatalog(provider),
        ...(provider === "claude" ? { records: [first, second] } : {}),
      }),
      isModelEnabled: async (_provider, model) => model === second.canonicalId,
    });
    expect(perLink.error.message).toEqual("stop after routing");
    expect(perLink.audit.attempts).toEqual([
      expect.stringContaining("default: claude/claude-first — enablement"),
      "default: claude/claude-second — eligible",
      "selected claude/claude-second (quota disabled/absent)",
    ]);
    expect(perLink.audit.selectedTool).toEqual("claude");
    expect(perLink.audit.selectedModel).toEqual("claude-second");

    const containment = await captureRouteAudit({
      task: "SECRET containment prompt",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-5.6-sol",
    });
    expect(containment.error.message).toContain(CODEX_WRITER_CONTAINMENT_REASON);
    expect(containment.audit.attempts.at(-1)).toContain("containment: refused codex writer");
    expect(containment.audit.selectedTool).toBeNull();
    expect(containment.audit.selectedModel).toBeNull();
  });

  test("absent and disabled quota both audit the rank-order selection", async () => {
    const absent = await captureRouteAudit({
      task: "SECRET absent-quota prompt",
      category: "simple_coding",
    }, {
      readRoutingPolicy: () => policyWithChain([{
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      }]),
    });
    expect(absent.error.message).toEqual("stop after routing");
    expect(absent.audit.attempts.at(-1)).toContain("quota disabled/absent");
    expect(absent.audit.selectedTool).toEqual("claude");

    const root = await mkdtemp(join(tmpdir(), "hive-route-audit-disabled-quota-"));
    tempRoots.push(root);
    const quotaDb = new HiveDatabase(join(root, "quota.db"));
    const disabledQuota = new QuotaService(
      new QuotaLedger(quotaDb),
      QuotaConfigSchema.parse({ enabled: false }),
      () => new Date(timestamp),
    );
    const disabled = await captureRouteAudit({
      task: "SECRET disabled-quota prompt",
      category: "simple_coding",
    }, {
      readRoutingPolicy: () => policyWithChain([{
        provider: "claude",
        model: "claude-opus-4-8",
        effort: { mode: "provider-controlled" },
      }]),
      quota: disabledQuota,
    });
    expect(disabled.error.message).toEqual("stop after routing");
    expect(disabled.audit.attempts.at(-1)).toContain("quota disabled/absent");
    expect(disabled.audit.selectedTool).toEqual("claude");
    quotaDb.close();
  });

  test("unreadable audit metadata never masks an explicit routing result", async () => {
    const selected = await captureRouteAudit({
      task: "SECRET metadata prompt",
      category: "simple_coding",
      model: "claude-opus-4-8",
    }, {
      readRoutingPolicy: () => {
        throw new Error("policy revision store unavailable");
      },
    });
    expect(selected.error.message).toEqual("stop after routing");
    expect(selected.audit.policyRevision).toEqual(0);
    expect(selected.audit.attempts).toContain(
      "audit metadata: policy revision unavailable — policy revision store unavailable",
    );
    expect(selected.audit.selectedTool).toEqual("claude");
    expect(selected.audit.selectedModel).toEqual("claude-opus-4-8");
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
      readOnly: true,
    });
    expect(store.reservations.has("cara")).toEqual(true);
    await expect(spawner.spawn({
      task: "Conflicting task",
      category: "simple_coding",
      name: "cara",
      readOnly: true,
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

    await spawner.spawn({ task: "Visible interactive task", category: "simple_coding", readOnly: true });
    expect(probedAppServer).toEqual(false);
    expect(tmux.sessions).toHaveLength(1);
    expect(tmux.sessions[0]?.[2]).toContain("'codex'");
    expect(tmux.sessions[0]?.[2]).toContain("--dangerously-bypass-hook-trust");
    expect(tmux.sessions[0]?.[2]).toContain("features.hooks=true");
    expect(await codexUserPrompt(tmux.sessions[0]?.[2] ?? "")).toEqual(
      "Visible interactive task",
    );
    expect(await codexDeveloperPrompt(tmux.sessions[0]?.[2] ?? ""))
      .toContain("You are maya");
    expect(tmux.sessions[0]?.[2]).not.toContain("codex-app-server-host");
  });

  test("launches Codex through the app-server host and delivers the assignment with turn/start", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-app-server-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const starts: Array<{
      name: string;
      bootstrap: CodexSessionBootstrap;
      effort: string;
    }> = [];
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
        startAgent: async (value, bootstrap, effort) => {
          starts.push({ name: value.name, bootstrap, effort });
          store.insertAgent({ ...value, status: "working" });
        },
        disconnect: () => undefined,
      },
    });

    const spawned = await spawner.spawn({
      task: "Implement native control",
      category: "simple_coding",
      readOnly: true,
    });
    const hostCommand = tmux.sessions[0]?.[2] ?? "";
    expect(hostCommand).toContain("'codex-app-server-host'");
    expect(hostCommand).toContain(
      `HIVE_CAPABILITY_TOKEN="$(cat ${spawned.worktreePath}/.codex/capability-token)"`,
    );
    expect(hostCommand).not.toContain("test-capability");
    expect(hostCommand).not.toContain("Implement native control");
    expect(await readFile(
      join(spawned.worktreePath!, ".codex", "capability-token"),
      "utf8",
    )).toEqual("test-capability");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ name: "maya", effort: "high" });
    expect(starts[0]?.bootstrap.initialUserPrompt).toEqual(
      "Implement native control",
    );
    expect(starts[0]?.bootstrap.developerInstructions).toContain("You are maya");
    expect(starts[0]?.bootstrap.developerInstructions).not.toContain(
      "Implement native control",
    );
    expect(spawned.status).toEqual("working");
  });

  test("automatically replaces a failed app-server handshake with the tmux TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-app-fallback-"));
    tempRoots.push(root);
    const store = new FakeStore();
    const tmux = new FakeTmux();
    const disconnected: string[] = [];
    const stopped: string[] = [];
    const issued: Array<{ token: string; processIncarnation: number }> = [];
    const rolledBack: string[] = [];
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
      issueCredential: (record) => {
        const token = `holder-${record.processIncarnation ?? 0}`;
        issued.push({
          token,
          processIncarnation: record.processIncarnation ?? 0,
        });
        return {
          token,
          rollback: () => {
            rolledBack.push(token);
          },
        };
      },
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

    const spawned = await spawner.spawn({
      task: "Fallback task",
      category: "simple_coding",
      readOnly: true,
    });
    expect(disconnected).toEqual(["maya"]);
    expect(stopped).toEqual([agentTmuxSession("maya")]);
    expect(tmux.sessions).toHaveLength(2);
    expect(tmux.sessions[1]?.[2]).toContain("'codex'");
    expect(tmux.sessions[1]?.[2]).toContain("--dangerously-bypass-hook-trust");
    expect(tmux.sessions[1]?.[2]).toContain("features.hooks=true");
    expect(await codexUserPrompt(tmux.sessions[1]?.[2] ?? "")).toEqual(
      "Fallback task",
    );
    expect(await codexDeveloperPrompt(tmux.sessions[1]?.[2] ?? ""))
      .toContain("You are maya");
    expect(store.listAgents()[0]).toMatchObject({
      processIncarnation: 2,
      status: "working",
      // The driver is a per-incarnation launch fact: the replacement process
      // runs the TUI, and a row still claiming app-server would be skipped by
      // telemetry/identity maintenance forever.
      codexDriver: "tui",
    });
    expect(issued).toEqual([
      { token: "holder-1", processIncarnation: 1 },
      { token: "holder-2", processIncarnation: 2 },
    ]);
    expect(rolledBack).toEqual(["holder-1"]);
    expect(await readFile(
      join(spawned.worktreePath!, ".codex", "capability-token"),
      "utf8",
    )).toEqual("holder-2");
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
      readOnly: true,
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

    const spawned = await spawner.spawn({ task: "Deep task", category: "complex_coding", readOnly: true });
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

    await spawner.spawn({ task: "Deep task", category: "complex_coding", readOnly: true });
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

    await expect(spawner.spawn({ task: "Deep task", category: "complex_coding", readOnly: true })).rejects
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

    await expect(spawner.spawn({ task: "Deep task", category: "complex_coding", readOnly: true })).rejects
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
      readOnly: true,
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
      readOnly: true,
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
      issueCredential: (agent, role) => {
        issued.push([agent.name, role, agent.capabilityEpoch]);
        return { token: "test-capability", rollback: () => {} };
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
    expect(await codexDeveloperPrompt(shell)).not.toContain("hive_land");
    expect(await codexUserPrompt(shell)).toEqual("Audit only");
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
      // This test proves the reader-authority refusal, so it must NOT inherit
      // the harness default credential issuer.
      issueCredential: undefined,
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
      issueCredential: () => ({ token: "test-capability", rollback: () => {} }),
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
    expect(shell).toContain(
      `'grok' '--cwd' '${spawned.worktreePath}' '--trust' '-m' 'catalog-model'`,
    );
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
      readOnly: true,
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
    expect(await codexDeveloperPrompt(tmux.sessions[1]?.[2] ?? "")).toContain(
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

      await spawner.spawn({ task: "Fix the flaky test", category: "simple_coding", readOnly: true });

      const launched = await codexDeveloperPrompt(tmux.sessions[0]?.[2] ?? "");
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
    });

    expect(failed.status).toEqual("failed");
    expect(failed.failureReason).toContain("Error: model not supported");
    expect(failed.failureReason).not.toContain("startup line 1\n");
    expect(failed.failedAt).toBeDefined();
    expect(store.agents).toEqual([failed]);
    expect(stopped).toEqual([agentTmuxSession("maya")]);
    expect(removals).toEqual([[root, worktreePath]]);
  });

  test("terminalization between preserve read and CAS wins over stuck spawn bookkeeping", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-spawner-terminal-race-"));
    tempRoots.push(root);
    const worktreePath = join(root, "maya");
    await mkdir(worktreePath, { recursive: true });
    class TerminalizingStore extends FakeStore {
      terminalized = false;

      override updateAgentIfCurrent(
        expected: AgentStateCas,
        updates: ConditionalAgentUpdate,
      ): AgentRecord | null {
        if (!this.terminalized && updates.status === "stuck") {
          this.terminalized = true;
          this.markAgentTerminal(
            expected.id,
            "2026-07-09T12:05:00.000Z",
            "dead",
            { failureReason: "operator terminalization won" },
          );
        }
        return super.updateAgentIfCurrent(expected, updates);
      }
    }
    const store = new TerminalizingStore();
    const tmux = new FakeTmux("Error: model not supported for this account");
    let removals = 0;
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
        branch: "hive/maya-terminal-race",
      }),
      removeWorktree: async () => {
        removals += 1;
      },
      sleep: async () => {},
    });

    const result = await spawner.spawn({
      task: "Fail while an operator terminalizes the holder",
      category: "simple_coding",
      readOnly: true,
    });

    expect(store.terminalized).toBe(true);
    expect(result).toMatchObject({
      status: "dead",
      writeRevoked: true,
      capabilityEpoch: 1,
      failureReason: "operator terminalization won",
      closedAt: "2026-07-09T12:05:00.000Z",
    });
    expect(store.getAgentById(result.id)).toEqual(result);
    expect(removals).toBe(0);
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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

    const failed = await spawner.spawn({ task: "Hang at launch", category: "simple_coding", readOnly: true });

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

    const failed = await spawner.spawn({ task: "Hang at launch", category: "simple_coding", readOnly: true });
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

    const failed = await spawner.spawn({ task: "Hang at launch", category: "simple_coding", readOnly: true });
    expect(failed.status).toEqual("failed");
    expect(removed).toEqual(0);
    expect(failed.failureReason).toContain("could not be checked");
  });

});

describe("worker prompt partition", () => {
  const worktree = {
    path: "/repo/.hive/worktrees/maya",
    branch: "hive/maya-golden",
  };
  const commonFullPreamble = [
    `Your file scope is your worktree at ${worktree.path}; do all code and file work there.`,
    "Use the Hive MCP tools hive_send, hive_inbox, and hive_status to message and coordinate with other named agents.",
    'Your orchestrator is named queen. Users and agents may address it as queen without quotation marks; the synonym "orchestrator" remains accepted. Send concise completion reports, blockers, and important findings to queen with hive_send; reference large artifacts instead of pasting them.',
    "Read only what the task needs: search for the lines that matter instead of reading large files whole, and reuse artifacts other agents already wrote instead of re-deriving them. If the task proves substantially larger than briefed, stop and report to queen rather than grinding.",
    "If the task exceeds your model — a genuine capability wall after at least two distinct failed approaches, not a scope surprise (that is a stop-and-report) — commit your WIP to your branch, then call hive_escalate once with the evidence (why, and what you tried) and a handoff (goal, done, remaining, decisions). Keep working until queen answers; it may respawn the task on a stronger model with your handoff or tell you to continue. Never grind on under-powered, and never quietly lower the quality bar instead. Escalations are recorded and measured.",
  ];
  const readOnlyProtocol =
    "This process is capability-enforced read-only: it may read the repo, run permitted read-only commands, use MCP tools, and report with hive_send. It cannot change the worktree or land its branch. Persist findings in durable Hive messages; do not attempt a commit.";
  const cases: {
    label: string;
    task: string;
    memoryIndex: string;
    options: AgentPromptOptions;
    bytes: number;
    sha256: string;
    expectedBlocks: readonly string[];
  }[] = [
    {
      label: "concise writer",
      task: "Summarize auth",
      memoryIndex: "MEMORY INDEX",
      options: {
        tool: "claude",
        category: "summarization",
        brief: "SCOPED BRIEF",
        graphBrief: "GRAPH BRIEF",
        graphifyTools: true,
      },
      bytes: 6_190,
      sha256: "d788ebca42be494a1dae4af678da69001bba178dd960f110ac0971ab46e49880",
      expectedBlocks: [
        "You are maya, a Hive writer agent.",
        `Work only inside your worktree at ${worktree.path}.`,
        'Your orchestrator is named queen. Report completion, blockers, and findings to queen with hive_send (hive_inbox and hive_status are also available; the synonym "orchestrator" is still accepted). Reference artifacts by path; never paste them.',
        "Read only what the task names. Search for the lines that matter rather than reading files whole. If the task is substantially bigger than briefed, stop and report rather than grinding.",
        "If the task exceeds your model — a genuine capability wall after at least two distinct failed approaches, not a scope surprise — commit your WIP, then call hive_escalate once with the evidence and a handoff. Keep working until queen answers. Never grind on under-powered, and never quietly lower the quality bar instead.",
        buildLandingProtocol(worktree.branch, "/repo", "main", "maya", 0, true),
      ],
    },
    {
      label: "full Grok writer",
      task: "Implement auth",
      memoryIndex: "MEMORY INDEX",
      options: {
        tool: "grok",
        brief: "SCOPED BRIEF",
        graphBrief: "GRAPH BRIEF",
        graphifyTools: true,
      },
      bytes: 8_480,
      sha256: "9778959f6a6d40fca9d52b148eab8ab6ad91d7eea1d4ae5b92fa4b32cbc02dad",
      expectedBlocks: [
        "You are maya, a Hive writer agent.",
        ...commonFullPreamble,
        buildLandingProtocol(worktree.branch, "/repo", "main", "maya", 0, false),
        GROK_SAFETY_DIRECTIVE,
      ],
    },
    {
      label: "full read-only agent",
      task: "Audit auth",
      memoryIndex: "MEMORY INDEX",
      options: {
        tool: "claude",
        readOnly: true,
        brief: "SCOPED BRIEF",
        graphBrief: "GRAPH BRIEF",
        graphifyTools: true,
      },
      bytes: 5_917,
      sha256: "13c9473e75196f3440a795e69bc04da0ebf4961fcd902ff55776c1ef3ef69af4",
      expectedBlocks: [
        "You are maya, a Hive read-only agent.",
        ...commonFullPreamble,
        readOnlyProtocol,
      ],
    },
  ];

  const occurrences = (text: string, block: string): number =>
    text.split(block).length - 1;

  test.each(cases)(
    "$label preserves the pre-partition Claude/Grok bytes and partitions Codex roles",
    ({ task, memoryIndex, options, bytes, sha256, expectedBlocks }) => {
      const parts = buildAgentPromptParts(
        "maya",
        task,
        worktree,
        "/repo",
        memoryIndex,
        options,
      );

      expect(Buffer.byteLength(parts.combinedPrompt)).toBe(bytes);
      expect(createHash("sha256").update(parts.combinedPrompt).digest("hex"))
        .toBe(sha256);
      expect(parts.combinedPrompt).toBe(
        buildAgentPrompt("maya", task, worktree, "/repo", memoryIndex, options),
      );
      expect(parts.userPrompt).toBe(task);
      expect(parts.developerInstructions).not.toContain(task);
      expect(parts.userPrompt).not.toContain("You are maya");
      expect(occurrences(parts.combinedPrompt, `Your task: ${task}`)).toBe(1);

      for (const block of [
        ...expectedBlocks,
        CODING_GUIDELINES,
        HIVE_PROTOCOL_RULES,
        SEARCH_HYGIENE,
        "SCOPED BRIEF",
        "GRAPH BRIEF",
        "This repo serves a graphify knowledge graph over MCP",
        "MEMORY INDEX",
      ]) {
        expect(occurrences(parts.developerInstructions, block)).toBe(1);
        expect(occurrences(parts.combinedPrompt, block)).toBe(1);
      }
    },
  );
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
  // see. The landing gate verifies both, or it verifies nothing. Hive no longer
  // detects this repo's concrete commands, so the gate names the rule in
  // repo-neutral wording and never invents a command that may not exist here.
  test("requires a typecheck, not just green tests, in repo-neutral wording", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("Re-run the tests on the rebased branch");
    expect(protocol).toContain("your typechecker");
    // Never a concrete command the repo may not have.
    expect(protocol).not.toContain("Re-run the tests (`");
    expect(protocol).not.toContain("bunx tsc --noEmit");
    expect(protocol).toContain("a passing test run does not typecheck");
    expect(protocol).toContain("neither do type errors");
  });

  test("tells the agent to scope its reading and escalate instead of grinding", () => {
    const prompt = buildAgentPrompt("maya", "Build auth API", worktree, "/repo");
    expect(prompt).toContain("Read only what the task needs");
    expect(prompt).toContain("instead of reading large files whole");
    expect(prompt).toContain("substantially larger than briefed");
    // The tripwire must route to queen (preferred root name), not a silent stop.
    expect(prompt).toContain("Your orchestrator is named queen");
    expect(prompt).toContain(
      "stop and report to queen rather than grinding",
    );
    // Compatibility synonym remains documented for agents and memories.
    expect(prompt).toContain('synonym "orchestrator" remains accepted');
  });

  test("bounds retries and escalates conflicts to the orchestrator", () => {
    const protocol = buildLandingProtocol(worktree.branch, "/repo");
    expect(protocol).toContain("git rebase --abort");
    expect(protocol).toContain(`After ${LANDING_MAX_ATTEMPTS} failed attempts`);
    const escalations = protocol.match(/\bqueen\b/g) ?? [];
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
    const starts: CodexSessionBootstrap[] = [];
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
          startAgent: async (_value, bootstrap) => {
            starts.push(bootstrap);
          },
          disconnect: () => undefined,
        },
      });

    // Codex receives durable setup as developer instructions on both drivers.
    const tuiTmux = new FakeTmux();
    await codexSpawner("tui", tuiTmux).spawn({ task: "Build auth API", category: "simple_coding", readOnly: true });
    const tuiCommand = tuiTmux.sessions[0]?.[2] ?? "";
    expect(tuiCommand).toContain("'codex'");
    const tuiLaunched = await codexDeveloperPrompt(tuiCommand);
    for (const rule of RULES) expect(tuiLaunched).toContain(rule);
    expect(await codexUserPrompt(tuiCommand)).toEqual("Build auth API");

    const hostTmux = new FakeTmux();
    await codexSpawner("app-server", hostTmux).spawn({
      task: "Build auth API",
      category: "simple_coding",
      readOnly: true,
    });
    expect(starts).toHaveLength(1);
    for (const rule of RULES) {
      expect(starts[0]?.developerInstructions).toContain(rule);
    }
    expect(starts[0]?.initialUserPrompt).toEqual("Build auth API");
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
      readOnly?: boolean;
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
        ...(options.readOnly ? { readOnly: true } : {}),
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
    expect(tmux.sessions[0]?.[2]).toContain(
      `'grok' '--cwd' '${store.listAgents()[0]!.worktreePath}' '--trust' '-m' 'grok-4.5'`,
    );
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
      { policy, claudeAllowance: 1, readOnly: true },
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


describe("Codex writer containment", () => {
  test("refuses an explicit Codex writer before worktree or process launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-writer-refuse-"));
    tempRoots.push(root);
    let worktrees = 0;
    let sessions = 0;
    const tmux = new FakeTmux();
    const origNew = tmux.newSession.bind(tmux);
    tmux.newSession = async (...args: Parameters<FakeTmux["newSession"]>) => {
      sessions += 1;
      return origNew(...args);
    };
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: {},
      readRoutingPolicy: () => policyFromRoute(CODEX_ROUTE),
      tmux,
      createWorktree: async () => {
        worktrees += 1;
        throw new Error("must not create worktree for a contained writer");
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Write code with Codex",
      category: "simple_coding",
      tool: "codex",
      model: "gpt-test",
    })).rejects.toThrow(CODEX_WRITER_CONTAINMENT_REASON);
    expect(worktrees).toEqual(0);
    expect(sessions).toEqual(0);
    expect(tmux.sessions).toHaveLength(0);
  });

  test("refuses a routed Codex writer with no silent fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-routed-refuse-"));
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
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "Routed writer",
      category: "simple_coding",
    })).rejects.toThrow(CODEX_WRITER_CONTAINMENT_REASON);
    expect(worktrees).toEqual(0);
  });

  test("allows a Codex reader on the same routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-reader-allow-"));
    tempRoots.push(root);
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
      createWorktree: async (_repoRoot, name, slug) => {
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        return { path, branch: `hive/${name}-${slug}` };
      },
      sleep: signalReadiness(store),
    });

    const spawned = await spawner.spawn({
      task: "Review only",
      category: "simple_coding",
      tool: "codex",
      readOnly: true,
    });
    expect(spawned.tool).toEqual("codex");
    expect(spawned.readOnly).toBeTrue();
    expect(tmux.sessions).toHaveLength(1);
    expect(tmux.sessions[0]?.[2]).toContain("'--sandbox' 'read-only'");
  });

  // Launch regression for writer admission. Admission turns on the DRIVER and
  // nothing else — no version, no build, no schema hash. What keeps the
  // admitted writer safe is the read-only sandbox plus the per-mutation gate,
  // not a check performed here.
  test("refuses a Codex TUI writer before any worktree or launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-tui-writer-refuse-"));
    tempRoots.push(root);
    let worktrees = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      // The TUI driver: PreToolUse fails open and the writer owns its own hook
      // scripts, so this can never be a writer surface.
      config: { codex: { driver: "tui" } },
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        worktrees += 1;
        throw new Error("must not create");
      },
      sleep: async () => {},
    });

    await expect(spawner.spawn({
      task: "TUI writer",
      category: "simple_coding",
    })).rejects.toThrow(CODEX_WRITER_CONTAINMENT_REASON);
    expect(worktrees).toEqual(0);
  });

  test("refuses a Codex writer when the app-server is unavailable, rather than using the TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-noappserver-"));
    tempRoots.push(root);
    let worktrees = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: { codex: { driver: "app-server" } },
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux: new FakeTmux(),
      createWorktree: async () => {
        worktrees += 1;
        throw new Error("must not create");
      },
      sleep: async () => {},
      codexAppServer: {
        // Configured for the app-server, but the binary cannot host one. The
        // driver resolves to the TUI, so the writer is refused — it must never
        // quietly become a TUI writer just because the config asked nicely.
        isAvailable: async () => false,
        buildHostCommand: () => ["hive", "codex-app-server-host"],
        startAgent: async () => undefined,
        disconnect: () => undefined,
      },
    });

    await expect(spawner.spawn({
      task: "Writer without an app-server",
      category: "simple_coding",
    })).rejects.toThrow(CODEX_WRITER_CONTAINMENT_REASON);
    expect(worktrees).toEqual(0);
  });

  test("admits a Codex app-server writer, and never falls back to the TUI when its handshake fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-codex-app-writer-admit-"));
    tempRoots.push(root);
    const tmux = new FakeTmux();
    let hostStarts = 0;
    const spawner = newTestSpawner({
      isModelEnabled: async () => true,
      db: new FakeStore(),
      repoRoot: root,
      port: 4317,
      config: { codex: { driver: "app-server" } },
      readRoutingPolicy: () => policyFromRoute({
        ...CODEX_ROUTE,
        tool: "codex",
        codex: { model: "gpt-test", effort: "high" },
      }),
      tmux,
      sleep: async () => {},
      createWorktree: async () => ({
        path: root,
        branch: "hive/maya-task",
      }),
      codexAppServer: {
        isAvailable: async () => true,
        buildHostCommand: () => ["hive", "codex-app-server-host"],
        startAgent: async () => {
          hostStarts += 1;
          // The broker never came up. There is now no gate for this writer's
          // mutations, so the spawn must fail rather than silently degrade.
          throw new Error("handshake failed");
        },
        disconnect: () => undefined,
      },
    });

    // The writer was admitted (the driver was the app-server), so the launch
    // proceeds far enough to attempt the handshake...
    const record = await spawner.spawn({
      task: "App-server writer",
      category: "simple_coding",
    });
    expect(hostStarts).toEqual(1);
    // ...and when that handshake fails the agent ends up failed, not running.
    expect(record.status).toEqual("failed");
    // The decisive assertion: exactly one session was ever launched, and it is
    // the app-server host — no second, TUI session was started to replace it.
    // A fallback here would be an ungated Codex writer, the one outcome
    // containment exists to prevent.
    expect(tmux.sessions).toHaveLength(1);
    expect(tmux.sessions[0]?.[2] ?? "").toContain("codex-app-server-host");
  });
});
