import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_PROVIDERS,
  forEachProvider,
  type AgentRecord,
  type CapabilityProvider,
} from "../schemas";
import { QuotaConfigSchema, type QuotaLimit } from "../schemas";
import { HiveDatabase } from "./db";
import { QuotaLedger } from "./quota-ledger";
import { QuotaService } from "./quota";
import { authorizeForQuotaTest } from "./authorized-launch.test-support";
import { CrashRecovery } from "./recovery";
import { countGraphifyCallLines, readGraphifyCalls } from "./tool-telemetry";
import { knownBillings } from "./usage-credits";

/**
 * Hive knows a closed vendor set, and for a long time it said so only by
 * implication: `tool === "claude" ? claudeThing : codexThing`. A third vendor
 * would have compiled, run, and been treated as Codex everywhere — its
 * transcript parsed by Codex's parser, its crash resumed with Codex's flags,
 * its adoption counted off a rollout file it never wrote. Every number would
 * have been wrong and plausible, which is the worst thing a number can be.
 *
 * These tests assert the property, not the shape. Each one drives a converted
 * site with a vendor Hive does not know and asserts two things: it fails, and
 * it fails loudly enough to name the vendor. Each also asserts that Codex's
 * machinery was never touched — so a switch that quietly defaulted back to
 * codex would fail here rather than pass. Asserting only "it threw" would not
 * distinguish the two; asserting "a switch statement exists" would test
 * nothing at all.
 *
 * The vendor is cast in, because the whole point of the refactor is that the
 * compiler no longer permits it. `AgentRecordSchema` rejects it on the way
 * into the database too — these casts reach past both walls on purpose, to
 * prove the innermost one holds.
 */
const UNKNOWN = "future-vendor" as unknown as CapabilityProvider;

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hive-vendor-dispatch-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// A Codex rollout line that the Codex counter would happily count. If an
// unknown vendor fell through to the Codex branch, the counters below would
// return 1 instead of throwing.
const CODEX_GRAPHIFY_LINE = JSON.stringify({
  payload: {
    type: "mcp_tool_call_end",
    invocation: { server: "graphify", tool: "query_graph" },
  },
});

test("counting graphify calls for an unknown vendor throws, and does not count it as codex", () => {
  expect(countGraphifyCallLines(CODEX_GRAPHIFY_LINE, "codex")).toBe(1);

  expect(() => countGraphifyCallLines(CODEX_GRAPHIFY_LINE, UNKNOWN)).toThrow(
    /unknown vendor "future-vendor"/,
  );
});

test("an unknown vendor with nothing to read still throws, rather than reporting zero", () => {
  // The dangerous shape: a per-line switch would never reach its default on an
  // empty transcript and would report a confident, wrong zero.
  expect(() => countGraphifyCallLines("", UNKNOWN)).toThrow(
    /unknown vendor "future-vendor"/,
  );
});

test("reading graphify calls for an unknown vendor throws instead of hunting a codex rollout", async () => {
  await expect(
    readGraphifyCalls(UNKNOWN, join(home, "worktree"), "session-1", undefined, home),
  ).rejects.toThrow(/unknown vendor "future-vendor"/);
});

test("crash recovery refuses to resolve an unknown vendor's session with the codex resolver", async () => {
  const db = new HiveDatabase(join(home, "resolve.db"));
  const tmux = new FakeTmux();
  let codexResolves = 0;
  const recovery = new CrashRecovery({
    authorizeLaunch: async (identity) =>
      (await authorizeForQuotaTest([identity]))[0]!,
    ...deps(db, tmux),
    resolveClaudeSessionId: async () => "claude-session",
    resolveCodexSessionId: async () => {
      codexResolves += 1;
      return "codex-session";
    },
  });

  const outcomes = await unknownVendorSweep(db, recovery, {
    toolSessionId: undefined,
  });

  expect(outcomes[0]?.action).toBe("skipped");
  expect(outcomes[0]?.reason).toMatch(/unknown vendor "future-vendor"/);
  // The discriminating assertion: a silent fallthrough would have resolved a
  // Codex session id here and gone on to resume the agent.
  expect(codexResolves).toBe(0);
  expect(tmux.created).toEqual([]);
  db.close();
});

test("crash recovery refuses to resume an unknown vendor with codex's config and flags", async () => {
  const db = new HiveDatabase(join(home, "resume.db"));
  const tmux = new FakeTmux();
  let codexConfigs = 0;
  const recovery = new CrashRecovery({
    authorizeLaunch: async (identity) =>
      (await authorizeForQuotaTest([identity]))[0]!,
    ...deps(db, tmux),
    writeCodexConfig: async () => {
      codexConfigs += 1;
    },
  });

  // A known session id skips the resolver, so the resume dispatch itself is
  // what this exercises.
  const outcomes = await unknownVendorSweep(db, recovery, {
    toolSessionId: "session-1",
  });

  expect(outcomes[0]?.action).toBe("skipped");
  expect(outcomes[0]?.reason).toMatch(/unknown vendor "future-vendor"/);
  // A silent fallthrough would have written a Codex agent config and launched
  // `codex resume` in the worktree.
  expect(codexConfigs).toBe(0);
  expect(tmux.created).toEqual([]);
  db.close();
});

test("every vendor Hive knows is read, so a new one cannot be silently skipped", async () => {
  const asked: CapabilityProvider[] = [];
  const read = await forEachProvider(async (provider) => {
    asked.push(provider);
    return provider;
  });

  // The property that protects the routing and inventory reads: the record is
  // total over the union, not a hand-written pair. A vendor added to the union
  // is probed and billed without an edit — never absent, which reads back as
  // "no quota" rather than as an error.
  expect(asked.toSorted()).toEqual([...CAPABILITY_PROVIDERS].toSorted());
  expect(Object.keys(read).toSorted()).toEqual(
    [...CAPABILITY_PROVIDERS].toSorted(),
  );
});

test("a vendor whose billing reads null is omitted, not invented", () => {
  const billing = {
    plan: "pro",
    poolResetsAt: null,
    overflowEnabled: null,
    overflowSpendUsd: null,
  } as unknown as NonNullable<
    Parameters<typeof knownBillings>[0][CapabilityProvider]
  >;

  const billings = knownBillings({ claude: billing, codex: null, grok: null });

  expect(billings.claude).toBe(billing);
  expect("codex" in billings).toBe(false);
});

test("a review of an unknown vendor is not silently handed to claude", async () => {
  const db = new HiveDatabase(join(home, "quota.db"));
  const ledger = new QuotaLedger(db);
  ledger.replaceModelCatalog("claude", [{
    provider: "claude",
    modelId: "claude-model",
    displayName: "claude-model",
    discoveredAt: "2026-07-09T12:00:00.000Z",
  }]);
  ledger.replaceModelCatalog("codex", [{
    provider: "codex",
    modelId: "codex-model",
    displayName: "codex-model",
    discoveredAt: "2026-07-09T12:00:00.000Z",
  }]);
  const service = new QuotaService(
    ledger,
    QuotaConfigSchema.parse({
      limits: [quotaLimit("claude"), quotaLimit("codex")],
      reserveFiveHourPct: 0,
      reserveWeeklyPct: 0,
      estimates: { deep: 20, standard: 10, cheap: 4, review: 8 },
    }),
    () => new Date("2026-07-09T12:00:00.000Z"),
  );
  const candidates = await authorizeForQuotaTest([
    { tool: "claude" as const, model: "claude-model" },
    { tool: "codex" as const, model: "codex-model" },
  ]);

  // Today's pairing is unambiguous, and must not change.
  const reviewOfClaude = await service.routeAndReserve({
    agentName: "maya",
    category: "code_review",
    selection: "strict",
    reviewOfTool: "claude",
    candidates,
  });
  expect(reviewOfClaude.tool).toBe("codex");

  // The old ternary's `: "claude"` fallback would have picked Claude to review
  // a vendor it had never been told how to pair with. There is no honest
  // default here, so the pairing must be stated, not guessed.
  await expect(
    service.routeAndReserve({
      agentName: "sam",
      category: "code_review",
      selection: "strict",
      reviewOfTool: UNKNOWN,
      candidates,
    }),
  ).rejects.toThrow(/unknown vendor "future-vendor"/);
  db.close();
});

test("a model no catalog claims cannot be billed to any vendor's pool", () => {
  const db = new HiveDatabase(join(home, "billing.db"));
  const ledger = new QuotaLedger(db);
  // Both vendors' catalogs are READ. Nothing in them is this model. That is a
  // measurement — "nobody claims it" — and it is grounds to refuse. (With no
  // catalog at all the honest answer is "cannot tell", which is a different
  // state and must not refuse; that case is covered in quota-discovery.test.)
  ledger.replaceModelCatalog("claude", [{
    provider: "claude",
    modelId: "claude-opus-4-8",
    displayName: "Opus 4.8",
    discoveredAt: new Date("2026-07-09T12:00:00.000Z").toISOString(),
  }]);
  ledger.replaceModelCatalog("codex", [{
    provider: "codex",
    modelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    discoveredAt: new Date("2026-07-09T12:00:00.000Z").toISOString(),
  }]);
  ledger.replaceModelCatalog("grok", [{
    provider: "grok",
    modelId: "fixture-grok-model",
    displayName: "Fixture Grok Model",
    discoveredAt: new Date("2026-07-09T12:00:00.000Z").toISOString(),
  }]);

  expect(ledger.modelVendorFromCatalog("claude-opus-4-8")).toEqual({
    state: "claimed",
    provider: "claude",
  });
  expect(ledger.modelVendorFromCatalog("grok-4-fast")).toEqual({
    state: "unclaimed",
  });

  // The defect: modelVendor("grok-4-fast") is null, null was read as "no
  // provable contradiction", and the spend was billed as asked. Restore that
  // and this reservation succeeds against the Claude pool.
  expect(() => reserve(ledger, "claude", "grok-4-fast")).toThrow(
    /Refusing to bill unidentifiable model "grok-4-fast" to the claude meter/,
  );
  expect(() => reserve(ledger, "codex", "grok-4-fast")).toThrow(
    /Refusing to bill unidentifiable model "grok-4-fast" to the codex meter/,
  );

  // Positive control: the catalog's own models still book, and a model billed
  // to the wrong vendor's meter still refuses. If either breaks, the guard is
  // not doing what it says.
  expect(reserve(ledger, "claude", "claude-opus-4-8").ok).toBe(true);
  expect(() => reserve(ledger, "codex", "claude-opus-4-8")).toThrow(
    /Refusing to bill claude model/,
  );
  db.close();
});

function reserve(
  ledger: QuotaLedger,
  provider: "claude" | "codex",
  model: string,
): { ok: boolean } {
  const now = new Date("2026-07-09T12:00:00.000Z");
  return ledger.tryReserveGroup([{
    id: `r-${provider}-${model}`,
    agentName: "maya",
    provider,
    account: "personal",
    pool: `${provider}-premium`,
    model,
    category: "simple_coding",
    estimatedUnits: 4,
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    fiveHourStart: now.toISOString(),
    weeklyStart: now.toISOString(),
    supplementalFiveHourUsed: 0,
    supplementalWeeklyUsed: 0,
    fiveHourAllowance: 100,
    weeklyAllowance: 100,
    fiveHourFloor: 0,
    weeklyFloor: 0,
  }]);
}

function quotaLimit(provider: "claude" | "codex"): QuotaLimit {
  return {
    provider,
    account: "personal",
    pool: `${provider}-premium`,
    models: [`${provider}-model`],
    fiveHourAllowance: 100,
    weeklyAllowance: 1000,
    weeklyWindow: "rolling",
    timezone: "UTC",
    resetWeekday: 1,
    resetHour: 0,
    resetMinute: 0,
    observationMaxAgeMinutes: 60,
  };
}

/**
 * A database whose agent reads report a vendor Hive does not know. The row
 * itself is a real, schema-valid Codex agent — `AgentRecordSchema` would
 * reject the unknown vendor on the way in — so everything the recovery does by
 * id still works, while the record it dispatches on carries the vendor under
 * test.
 */
function unknownVendorSweep(
  db: HiveDatabase,
  recovery: CrashRecovery,
  overrides: Partial<AgentRecord>,
): Promise<{ action: string; reason?: string }[]> {
  const record: AgentRecord = {
    id: "agent-maya",
    name: "maya",
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "simple_coding",
    status: "working",
    taskDescription: "Build the server",
    worktreePath: join(home, "worktree"),
    branch: "hive/maya-server",
    tmuxSession: "hive-maya",
    contextPct: 40,
    createdAt: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    recoveryAttempts: 0,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
    ...overrides,
  };
  db.insertAgent(record);
  const unknown = { ...record, tool: UNKNOWN };
  db.listAgents = () => [unknown];
  db.getAgentById = () => unknown;
  // `upsertAgent` schema-parses, so it is the outer wall: it would reject this
  // vendor before the dispatch ever saw it. That wall is real, and it is not
  // the one under test — a schema that lists the vendor (which is exactly what
  // adding one does) leaves the dispatch as the only thing standing between an
  // unknown vendor and Codex's resume path. Reaching past it here is the whole
  // point: it proves the inner wall holds on its own.
  const write = db.upsertAgent.bind(db);
  db.upsertAgent = (value: AgentRecord) =>
    value.tool === UNKNOWN ? value : write(value);
  return recovery.sweep();
}

function deps(db: HiveDatabase, tmux: FakeTmux) {
  return {
    db,
    tmux: tmux as unknown as ConstructorParameters<typeof CrashRecovery>[0]["tmux"],
    port: 4483,
    send: async () => {},
    settleQuota: async () => {},
    flushQueued: () => {},
    worktreeExists: () => true,
    sleep: async () => {},
    seedClaudeTrust: async () => {},
    writeClaudeConfig: async () => {},
    writeCodexConfig: async () => {},
  } as unknown as ConstructorParameters<typeof CrashRecovery>[0];
}

class FakeTmux {
  readonly created: { name: string; cwd: string; command: string }[] = [];

  async hasSession(): Promise<boolean> {
    return false;
  }

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    this.created.push({ name, cwd, command });
  }

  async killSession(): Promise<void> {}

  async capturePane(): Promise<string> {
    return "";
  }
}
