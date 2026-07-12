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
import { HiveDatabase } from "./db";
import { CrashRecovery } from "./recovery";
import { countGraphifyCallLines, readGraphifyCalls } from "./tool-telemetry";
import { knownBillings } from "./usage-credits";

/**
 * Hive knows exactly two vendors, and for a long time it said so only by
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
const UNKNOWN = "grok" as unknown as CapabilityProvider;

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
    /unknown vendor "grok"/,
  );
});

test("an unknown vendor with nothing to read still throws, rather than reporting zero", () => {
  // The dangerous shape: a per-line switch would never reach its default on an
  // empty transcript and would report a confident, wrong zero.
  expect(() => countGraphifyCallLines("", UNKNOWN)).toThrow(
    /unknown vendor "grok"/,
  );
});

test("reading graphify calls for an unknown vendor throws instead of hunting a codex rollout", async () => {
  await expect(
    readGraphifyCalls(UNKNOWN, join(home, "worktree"), "session-1", undefined, home),
  ).rejects.toThrow(/unknown vendor "grok"/);
});

test("crash recovery refuses to resolve an unknown vendor's session with the codex resolver", async () => {
  const db = new HiveDatabase(join(home, "resolve.db"));
  const tmux = new FakeTmux();
  let codexResolves = 0;
  const recovery = new CrashRecovery({
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

  expect(outcomes[0]?.action).toBe("marked-dead");
  expect(outcomes[0]?.reason).toMatch(/unknown vendor "grok"/);
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

  expect(outcomes[0]?.action).toBe("marked-dead");
  expect(outcomes[0]?.reason).toMatch(/unknown vendor "grok"/);
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

  const billings = knownBillings({ claude: billing, codex: null });

  expect(billings.claude).toBe(billing);
  expect("codex" in billings).toBe(false);
});

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
    tier: "standard",
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
    writeRevoked: false,
    channelsEnabled: false,
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
    closeTerminal: async () => {},
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
