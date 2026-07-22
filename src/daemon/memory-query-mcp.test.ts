import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import { EpisodicStore } from "./episodic-store";
import { DEFAULT_CLASS_BUDGETS } from "./episodic-projections";
import { projectStateDir } from "./project-state";
import { HiveDaemon } from "./server";
import { actingAs, type AuthorizedFetch } from "./testing";
import type { SpawnRequest, Spawner } from "./spawner";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T11:00:00.000Z";
const NONCE_A = "NONCEALPHA7q2z";
const NONCE_B = "NONCEBRAVO9w4x";

const tempRoots: string[] = [];
const daemons: HiveDaemon[] = [];
const previousHome = process.env.HIVE_HOME;

afterEach(async () => {
  process.env.HIVE_HOME = previousHome;
  for (const daemon of daemons.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-memory-query-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  return home;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-query-repo-"));
  tempRoots.push(root);
  return root;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory_query tests");
  }
}

class NoopTmux {
  async hasSession(_session: string): Promise<boolean> {
    return false;
  }
  async capturePane(_session: string): Promise<string> {
    return "";
  }
  async killSession(_session: string): Promise<void> {}
  async newSession(
    _name: string,
    _cwd: string,
    _command: string,
  ): Promise<void> {}
}

const agent = (name: string): AgentRecord => ({
  id: `agent-${name}`,
  name,
  tool: "codex",
  model: "gpt-5-codex",
  category: "simple_coding",
  status: "working",
  taskDescription: "memory_query fixture",
  worktreePath: `/tmp/hive-${name}`,
  branch: `hive/${name}`,
  tmuxSession: `hive-${name}`,
  contextPct: null,
  createdAt: T0,
  lastEventAt: T0,
  recoveryAttempts: 0,
  capabilityEpoch: 0,
  readOnly: false,
  writeRevoked: false,
});

interface Envelope {
  class: string;
  state: "ok" | "empty" | "absent";
  detail: string | null;
  budget: number;
  tokens: number;
  truncated: boolean;
  omitted: number;
  asOf: string | null;
  source: string[];
  results: unknown[];
}

function envelope(result: Awaited<ReturnType<Client["callTool"]>>): Envelope {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as Envelope;
}

async function connectedClient(
  fetch: AuthorizedFetch,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch },
  );
  const client = new Client({ name: "hive-memory-query-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function query(
  client: Client,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const result = await client.callTool({ name: "memory_query", arguments: args });
  expect(result.isError).not.toBe(true);
  return envelope(result);
}

function daemonFixture(options: {
  repoRoot: string;
  episodic: EpisodicStore | null;
  agents?: AgentRecord[];
}): { daemon: HiveDaemon; db: HiveDatabase } {
  const db = new HiveDatabase(":memory:");
  for (const record of options.agents ?? []) db.insertAgent(record);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: new UnusedSpawner(),
    db,
    tmux: new NoopTmux(),
    repoRoot: options.repoRoot,
    ...(options.episodic === null
      ? {}
      : { episodicStore: options.episodic }),
  });
  daemons.push(daemon);
  return { daemon, db };
}

function seedTokenRows(db: HiveDatabase, agentId: string): void {
  const sessionId = crypto.randomUUID();
  db.database.query(`
    INSERT INTO token_usage_sessions (id, repoRoot, startedAt)
    VALUES (?, '/repo', ?)
  `).run(sessionId, T0);
  const subjectId = crypto.randomUUID();
  db.database.query(`
    INSERT INTO token_usage_subjects (
      id, sessionId, agentId, name, role, provider, cwd, startedAt
    ) VALUES (?, ?, ?, ?, 'worker', 'claude', '/repo', ?)
  `).run(subjectId, sessionId, agentId, agentId, T0);
  db.database.query(`
    INSERT INTO token_usage_events (
      subjectId, eventKey, inputTokens, outputTokens, observedAt, source
    ) VALUES (?, 'm1', 1234, 321, ?, 'claude-transcript')
  `).run(subjectId, T1);
}

async function fileBytesContain(root: string, needle: string): Promise<boolean> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.includes(needle)) return true;
  }
  return false;
}

describe("memory_query MCP tool", () => {
  test("agent-now and fleet-summary answer through the MCP surface with envelope discipline", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("maya")],
    });
    const assignment = daemon.status.currentAssignment("agent-maya")!;
    daemon.status.appendAgentReport({
      subject: "maya",
      agentId: "agent-maya",
      role: "writer",
      incarnationGeneration: 1,
      capabilityEpoch: 0,
      toolSessionId: null,
    }, {
      requestId: "req_018f1e90-7b5a-7cc0-8000-0000000000a1",
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "implementing",
      summary: "Wiring memory_query",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 600,
    }, new Date(T1));

    const client = await connectedClient(actingAs(daemon, "operator", "operator"));
    try {
      const now = await query(client, { class: "agent-now", agent: "maya" });
      expect(now.state).toBe("ok");
      expect(now.budget).toBe(DEFAULT_CLASS_BUDGETS["agent-now"]);
      expect(now.truncated).toBe(false);
      expect(now.results[0]).toMatchObject({
        agent: "agent-maya",
        phase: "implementing",
        summary: "Wiring memory_query",
      });
      expect(now.asOf).toBe(T1);
      expect(now.source.length).toBeGreaterThan(0);

      const fleet = await query(client, { class: "fleet-summary" });
      expect(fleet.state).toBe("ok");
      const summary = fleet.results[0] as {
        agents: number;
        rows: Array<{ agent: string }>;
      };
      expect(summary.agents).toBe(1);
      expect(summary.rows[0]!.agent).toBe("agent-maya");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("the token ceiling is enforced in-band and a larger caller budget is clamped", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("maya")],
    });
    for (let index = 0; index < 20; index += 1) {
      episodic.appendEvent({
        ts: T1,
        agent: "agent-maya",
        type: "agent.status-reported",
        summary: `Note ${index}: ${"n".repeat(380)}`,
      });
    }
    const client = await connectedClient(actingAs(daemon, "maya", "writer"));
    try {
      const inflated = await query(client, {
        class: "my-history",
        budget: 999_999,
      });
      expect(inflated.budget).toBe(DEFAULT_CLASS_BUDGETS["my-history"]);
      expect(inflated.truncated).toBe(true);
      expect(inflated.omitted).toBeGreaterThan(0);
      expect(inflated.omitted + inflated.results.length).toBe(20);
      expect(inflated.tokens).toBeLessThanOrEqual(inflated.budget);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("my-history scopes to the caller identity, never the input agent field", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("maya"), agent("lena")],
    });
    episodic.appendEvent({
      ts: T1,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "Maya's private note",
    });
    episodic.appendEvent({
      ts: T1,
      agent: "agent-lena",
      type: "agent.status-reported",
      summary: "Lena's private note",
    });

    const maya = await connectedClient(actingAs(daemon, "maya", "writer"));
    const lena = await connectedClient(actingAs(daemon, "lena", "writer"));
    try {
      const mayaResult = await query(maya, {
        class: "my-history",
        agent: "lena",
      });
      expect(mayaResult.results).toHaveLength(1);
      expect(mayaResult.results[0]).toMatchObject({
        agent: "agent-maya",
        summary: "Maya's private note",
      });

      const lenaResult = await query(lena, {
        class: "my-history",
        agent: "maya",
      });
      expect(lenaResult.results).toHaveLength(1);
      expect(lenaResult.results[0]).toMatchObject({
        agent: "agent-lena",
        summary: "Lena's private note",
      });
    } finally {
      await maya.close().catch(() => undefined);
      await lena.close().catch(() => undefined);
    }
  });

  test("absent vs empty is reported through the tool envelope", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const without = daemonFixture({ repoRoot, episodic: null, agents: [] });
    const clientWithout = await connectedClient(
      actingAs(without.daemon, "operator", "operator"),
    );
    try {
      const absent = await query(clientWithout, {
        class: "agent-history",
        agent: "maya",
      });
      expect(absent.state).toBe("absent");
      expect(absent.detail).toContain("episodic");
    } finally {
      await clientWithout.close().catch(() => undefined);
    }

    const withStore = daemonFixture({
      repoRoot,
      episodic: new EpisodicStore(":memory:"),
      agents: [],
    });
    const clientWith = await connectedClient(
      actingAs(withStore.daemon, "operator", "operator"),
    );
    try {
      const empty = await query(clientWith, {
        class: "agent-history",
        agent: "maya",
      });
      expect(empty.state).toBe("empty");
      expect(empty.detail).toContain("maya");
      expect(empty.results).toEqual([]);
    } finally {
      await clientWith.close().catch(() => undefined);
    }
  });

  test("pitfall-check finds pitfall-kind wiki articles via the FTS index", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const { daemon } = daemonFixture({
      repoRoot,
      episodic: new EpisodicStore(":memory:"),
      agents: [],
    });
    const client = await connectedClient(actingAs(daemon, "operator", "operator"));
    try {
      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          kind: "pitfall",
          title: "A green rebase run proves nothing",
          body: "The rebase script exits zero even when it dropped a commit.",
          source: "agent",
          evidence: "Incident replay in the MCP test",
          status: "verified",
          supersedes: [],
          date: "2026-07-22",
          verified: "2026-07-22",
        },
      });
      // A non-pitfall article matching the same terms must NOT surface.
      await client.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          title: "Rebase scripts are handy",
          body: "The rebase script saves ten minutes a day.",
          source: "agent",
          evidence: "Daily use",
          status: "verified",
          supersedes: [],
          date: "2026-07-22",
          verified: "2026-07-22",
        },
      });

      const found = await query(client, {
        class: "pitfall-check",
        query: "rebase",
      });
      expect(found.state).toBe("ok");
      expect(found.results).toHaveLength(1);
      expect(found.results[0]).toMatchObject({
        title: "A green rebase run proves nothing",
        source: "wiki",
      });

      const missing = await query(client, {
        class: "pitfall-check",
        query: "kubernetes",
      });
      expect(missing.state).toBe("empty");
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("two-way nonce isolation with positive controls", () => {
  test("projects A and B cannot see each other's nonces through any class or on disk", async () => {
    const home = await makeHome();
    const rootA = await makeRepo();
    const rootB = await makeRepo();
    const storeA = EpisodicStore.forProjectRoot(rootA);
    const storeB = EpisodicStore.forProjectRoot(rootB);
    const a = daemonFixture({
      repoRoot: rootA,
      episodic: storeA,
      agents: [agent("ada")],
    });
    const b = daemonFixture({
      repoRoot: rootB,
      episodic: storeB,
      agents: [agent("beth")],
    });

    // Plant NONCE_A everywhere in A: episodic events (status + landing +
    // blocked), a current fact, a wiki pitfall, and token rows.
    storeA.appendEvent({
      ts: T0,
      agent: "agent-ada",
      type: "agent.status-reported",
      summary: `Started the task for ${NONCE_A}`,
    });
    storeA.appendEvent({
      ts: T1,
      agent: "agent-ada",
      type: "agent.landed",
      summary: `Landed the ${NONCE_A} branch`,
    });
    storeA.appendEvent({
      ts: T1,
      agent: "agent-blocked-a",
      type: "agent.status-reported",
      summary: `blocked on the ${NONCE_A} quota`,
    });
    storeA.recordFact({
      topic: "billing",
      title: `decision ${NONCE_A}`,
      body: `The ${NONCE_A} quota resets at midnight`,
      source: "test",
      validAt: T0,
    });
    seedTokenRows(a.db, "agent-ada");

    const queenA = await connectedClient(actingAs(a.daemon, "operator", "operator"));
    const adaA = await connectedClient(actingAs(a.daemon, "ada", "writer"));
    const queenB = await connectedClient(actingAs(b.daemon, "operator", "operator"));
    const adaB = await connectedClient(actingAs(b.daemon, "ada", "writer"));
    try {
      await queenA.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          kind: "pitfall",
          title: `Burned by ${NONCE_A}`,
          body: `Retrying ${NONCE_A} mid-rebase drops commits.`,
          source: "agent",
          evidence: "Isolation fixture",
          status: "verified",
          supersedes: [],
          date: "2026-07-22",
          verified: "2026-07-22",
        },
      });

      // Positive control: in A, every query class finds NONCE_A.
      const positiveInA: Envelope[] = [];
      positiveInA.push(await query(queenA, { class: "agent-now", agent: "ada" }));
      positiveInA.push(
        await query(queenA, { class: "agent-history", agent: "ada" }),
      );
      positiveInA.push(await query(queenA, { class: "fleet-summary" }));
      positiveInA.push(await query(queenA, { class: "what-landed" }));
      positiveInA.push(await query(queenA, { class: "who-blocked" }));
      positiveInA.push(
        await query(queenA, { class: "point-search", query: NONCE_A }),
      );
      positiveInA.push(
        await query(queenA, { class: "pitfall-check", query: NONCE_A }),
      );
      positiveInA.push(await query(adaA, { class: "my-history" }));
      for (const [index, result] of positiveInA.entries()) {
        expect(
          JSON.stringify(result.results),
          `class #${index} (${result.class}) must find its own nonce`,
        ).toContain(NONCE_A);
      }
      // token-spend has no free text to plant a nonce in: its positive
      // control is that A's measured rows exist at all.
      const spendA = await query(queenA, { class: "token-spend" });
      expect(spendA.state).toBe("ok");
      expect(spendA.results).toHaveLength(1);
      expect(spendA.results[0]).toMatchObject({
        agentId: "agent-ada",
        totalTokens: 1555,
      });

      // Isolation: in B, every query class returns zero hits for NONCE_A.
      const negativeInB: Envelope[] = [];
      negativeInB.push(await query(queenB, { class: "agent-now", agent: "ada" }));
      negativeInB.push(
        await query(queenB, { class: "agent-history", agent: "ada" }),
      );
      negativeInB.push(await query(queenB, { class: "fleet-summary" }));
      negativeInB.push(await query(queenB, { class: "what-landed" }));
      negativeInB.push(await query(queenB, { class: "who-blocked" }));
      negativeInB.push(await query(queenB, { class: "token-spend" }));
      negativeInB.push(
        await query(queenB, { class: "point-search", query: NONCE_A }),
      );
      negativeInB.push(
        await query(queenB, { class: "pitfall-check", query: NONCE_A }),
      );
      negativeInB.push(await query(adaB, { class: "my-history" }));
      for (const result of negativeInB) {
        expect(
          JSON.stringify(result.results),
          `class ${result.class} leaked project A's nonce into project B`,
        ).not.toContain(NONCE_A);
        expect(result.results).toEqual([]);
      }

      // Storage asserted separately from query: B's store holds nothing of
      // A's, and no file anywhere in B's scope carries NONCE_A bytes.
      expect(JSON.stringify(storeB.eventsFor())).not.toContain(NONCE_A);
      expect(JSON.stringify(storeB.currentFacts())).not.toContain(NONCE_A);
      expect(JSON.stringify(storeA.eventsFor())).toContain(NONCE_A);
      expect(JSON.stringify(storeA.currentFacts())).toContain(NONCE_A);
      expect(await fileBytesContain(projectStateDir(rootB), NONCE_A)).toBe(false);
      expect(await fileBytesContain(rootB, NONCE_A)).toBe(false);

      // Mirror: plant NONCE_B in B, B finds it, A sees none of it.
      storeB.appendEvent({
        ts: T1,
        agent: "agent-beth",
        type: "agent.landed",
        summary: `Landed the ${NONCE_B} branch`,
      });
      storeB.appendEvent({
        ts: T1,
        agent: "agent-blocked-b",
        type: "agent.status-reported",
        summary: `blocked on the ${NONCE_B} quota`,
      });
      storeB.recordFact({
        topic: "billing",
        title: `decision ${NONCE_B}`,
        body: `The ${NONCE_B} quota resets at midnight`,
        source: "test",
        validAt: T0,
      });
      await queenB.callTool({
        name: "memory_write",
        arguments: {
          scope: "repo",
          topic: "testing",
          kind: "pitfall",
          title: `Burned by ${NONCE_B}`,
          body: `Retrying ${NONCE_B} mid-rebase drops commits.`,
          source: "agent",
          evidence: "Isolation fixture",
          status: "verified",
          supersedes: [],
          date: "2026-07-22",
          verified: "2026-07-22",
        },
      });
      const pointB = await query(queenB, {
        class: "point-search",
        query: NONCE_B,
      });
      expect(JSON.stringify(pointB.results)).toContain(NONCE_B);
      const pitfallB = await query(queenB, {
        class: "pitfall-check",
        query: NONCE_B,
      });
      expect(JSON.stringify(pitfallB.results)).toContain(NONCE_B);
      const landedB = await query(queenB, { class: "what-landed" });
      expect(JSON.stringify(landedB.results)).toContain(NONCE_B);
      const blockedB = await query(queenB, { class: "who-blocked" });
      expect(JSON.stringify(blockedB.results)).toContain(NONCE_B);

      const pointA = await query(queenA, {
        class: "point-search",
        query: NONCE_B,
      });
      expect(pointA.results).toEqual([]);
      const pitfallA = await query(queenA, {
        class: "pitfall-check",
        query: NONCE_B,
      });
      expect(pitfallA.results).toEqual([]);
      const landedA = await query(queenA, { class: "what-landed" });
      expect(JSON.stringify(landedA.results)).not.toContain(NONCE_B);
      expect(JSON.stringify(storeA.eventsFor())).not.toContain(NONCE_B);
      expect(await fileBytesContain(projectStateDir(rootA), NONCE_B)).toBe(false);
      expect(await fileBytesContain(rootA, NONCE_B)).toBe(false);

      // The stores really are two files under two project identities.
      expect(storeA.path).not.toBe(storeB.path);
      expect(storeA.path).toContain(home);
      expect(storeB.path).toContain(home);
    } finally {
      await queenA.close().catch(() => undefined);
      await adaA.close().catch(() => undefined);
      await queenB.close().catch(() => undefined);
      await adaB.close().catch(() => undefined);
    }
  });
});
