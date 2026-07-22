// HiveMemory HM-2 WP4: the memory_digest MCP tool (read + drill-down +
// absent-vs-empty + budget clamp) and the daemon's digest compile triggers
// (agent session end/kill and landing/completion events), including their
// failure isolation from the lifecycle paths that fire them.
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../schemas";
import { HiveDatabase } from "./db";
import type { TmuxSender } from "./delivery";
import { compileDigest, MEMORY_DIGEST_DEFAULT_BUDGET } from "./episodic-digest";
import { EpisodicStore } from "./episodic-store";
import { HiveDaemon } from "./server";
import { actingAs, type AuthorizedFetch, submitPaste } from "./testing";
import type { SpawnRequest, Spawner } from "./spawner";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T11:00:00.000Z";

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
  const home = await mkdtemp(join(tmpdir(), "hive-memory-digest-home-"));
  tempRoots.push(home);
  process.env.HIVE_HOME = home;
  return home;
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-digest-repo-"));
  tempRoots.push(root);
  return root;
}

class UnusedSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("not exercised by memory_digest tests");
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
  taskDescription: "memory_digest fixture",
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

interface DigestEnvelope {
  state: "ok" | "empty" | "absent";
  detail: string | null;
  budget: number;
  tokens: number;
  truncated: boolean;
  digest: {
    id: number;
    agent: string | null;
    sessionId: string | null;
    compiledAt: string;
    body: string;
    provenance: { eventIds?: number[] };
  } | null;
  events: Array<{ id: number; type: string; summary: string }>;
}

function envelope(result: Awaited<ReturnType<Client["callTool"]>>): DigestEnvelope {
  const content = (result as {
    content: Array<{ type: string; text?: string }>;
  }).content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool content");
  }
  return JSON.parse(content.text) as DigestEnvelope;
}

async function connectedClient(fetch: AuthorizedFetch): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch },
  );
  const client = new Client({ name: "hive-memory-digest-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function readDigest(
  client: Client,
  args: Record<string, unknown>,
): Promise<DigestEnvelope> {
  const result = await client.callTool({ name: "memory_digest", arguments: args });
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

describe("memory_digest MCP tool", () => {
  test("reads a digest by id and by agent name, with provenance", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("maya")],
    });
    episodic.appendEvent({
      ts: T0,
      agent: "agent-maya",
      type: "agent.branch-landed",
      summary: "Landed the digest compiler",
    });
    const compiled = compileDigest(episodic, {
      agent: "agent-maya",
      sessionId: "session-1",
      compiledAt: T1,
    })!;

    const client = await connectedClient(actingAs(daemon, "operator", "operator"));
    try {
      const byId = await readDigest(client, { digestId: compiled.id });
      expect(byId.state).toBe("ok");
      expect(byId.digest!.id).toBe(compiled.id);
      expect(byId.digest!.sessionId).toBe("session-1");
      expect(byId.digest!.body).toContain("hint-not-authority");
      expect(byId.digest!.provenance.eventIds).toHaveLength(1);

      // The caller-facing agent name resolves to the daemon's agent id.
      const byName = await readDigest(client, { agent: "maya" });
      expect(byName.state).toBe("ok");
      expect(byName.digest!.id).toBe(compiled.id);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("drills down from a digest pointer to the exact source event row", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("maya")],
    });
    const landed = episodic.appendEvent({
      ts: T0,
      agent: "agent-maya",
      type: "agent.branch-landed",
      summary: "Landed tip 0123456789abcdef0123456789abcdef01234567",
    });
    const compiled = compileDigest(episodic, {
      agent: "agent-maya",
      sessionId: null,
      compiledAt: T1,
    })!;

    const client = await connectedClient(actingAs(daemon, "maya", "writer"));
    try {
      const result = await readDigest(client, {
        digestId: compiled.id,
        eventId: landed.id,
      });
      expect(result.state).toBe("ok");
      expect(result.digest!.id).toBe(compiled.id);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        id: landed.id,
        type: "agent.branch-landed",
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("absent without an episodic store, empty when nothing matches", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const without = daemonFixture({ repoRoot, episodic: null, agents: [] });
    const clientWithout = await connectedClient(
      actingAs(without.daemon, "operator", "operator"),
    );
    try {
      const absent = await readDigest(clientWithout, { digestId: 1 });
      expect(absent.state).toBe("absent");
      expect(absent.detail).toContain("episodic");
    } finally {
      await clientWithout.close().catch(() => undefined);
    }

    const episodic = new EpisodicStore(":memory:");
    const withStore = daemonFixture({ repoRoot, episodic, agents: [] });
    const clientWith = await connectedClient(
      actingAs(withStore.daemon, "operator", "operator"),
    );
    try {
      const empty = await readDigest(clientWith, { digestId: 99 });
      expect(empty.state).toBe("empty");
      expect(empty.detail).toContain("digest with id 99");
      // Positive control: a digest that exists is visible before any
      // negative is trusted (S3.7 DoD 11).
      episodic.appendEvent({
        ts: T0,
        agent: "agent-maya",
        type: "agent.status-reported",
        summary: "did work",
      });
      const compiled = compileDigest(episodic, {
        agent: "agent-maya",
        sessionId: null,
        compiledAt: T1,
      })!;
      const ok = await readDigest(clientWith, { digestId: compiled.id });
      expect(ok.state).toBe("ok");
    } finally {
      await clientWith.close().catch(() => undefined);
    }
  });

  test("a caller budget may only lower the server ceiling", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon } = daemonFixture({
      repoRoot,
      episodic,
      agents: [agent("maya")],
    });
    episodic.appendEvent({
      ts: T0,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "did work",
    });
    const compiled = compileDigest(episodic, {
      agent: "agent-maya",
      sessionId: null,
      compiledAt: T1,
    })!;

    const client = await connectedClient(actingAs(daemon, "operator", "operator"));
    try {
      const inflated = await readDigest(client, {
        digestId: compiled.id,
        budget: 999_999,
      });
      expect(inflated.budget).toBe(MEMORY_DIGEST_DEFAULT_BUDGET);
      expect(inflated.truncated).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

// --- Daemon compile triggers -------------------------------------------------

class SilentTmuxSender implements TmuxSender {
  constructor(private readonly db: HiveDatabase) {}
  async sendMessage(session: string): Promise<void> {
    submitPaste(this.db, session);
  }
}

const offlineRootProtocol = {
  isLive: () => false,
  async deliverMessage(): Promise<boolean> {
    return false;
  },
};

function lifecycleDaemon(options: {
  repoRoot: string;
  episodic: EpisodicStore;
}): { daemon: HiveDaemon; db: HiveDatabase } {
  const db = new HiveDatabase(":memory:");
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    db,
    spawner: new UnusedSpawner(),
    tmuxSender: new SilentTmuxSender(db),
    rootProtocol: offlineRootProtocol,
    tmux: new NoopTmux(),
    repoRoot: options.repoRoot,
    episodicStore: options.episodic,
    lifecycle: { idleReap: true, idleReapMinutes: 10 },
    removeWorktree: async () => {},
    assessStrandedWork: async () => ({ dirtyFiles: [], unmergedCommits: 0 }),
  });
  daemons.push(daemon);
  return { daemon, db };
}

async function reapToKill(daemon: HiveDaemon, db: HiveDatabase): Promise<void> {
  // The idle-reap two-step drives killAgentTeardown, the session-end hook.
  await daemon.reapIdleAgents();
  const warning = db.listMessages().find((message) => message.to === "maya");
  db.transitionMessage(warning!.id, "applied", new Date().toISOString());
  await daemon.reapIdleAgents();
}

const idleMaya = (): AgentRecord => ({
  ...agent("maya"),
  status: "idle",
  lastEventAt: new Date(Date.now() - 15 * 60_000).toISOString(),
});

describe("daemon digest compile triggers", () => {
  test("an agent session end (kill) compiles a session digest", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon, db } = lifecycleDaemon({ repoRoot, episodic });
    db.insertAgent(idleMaya());
    episodic.appendEvent({
      ts: T0,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "work awaiting the session-end digest",
    });

    await reapToKill(daemon, db);
    expect(db.getAgentByName("maya")?.status).toBe("dead");

    // The compile is synchronous inside killAgentTeardown: the digest
    // already exists and cites the pre-kill event.
    const digest = episodic.digestFor({ agent: "agent-maya" });
    expect(digest).not.toBeNull();
    expect(digest!.body).toContain("work awaiting the session-end digest");
    expect(digest!.body).toContain("hint-not-authority");
  });

  test("a completion status report re-synthesizes the rolling digest", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const episodic = new EpisodicStore(":memory:");
    const { daemon, db } = daemonFixture({
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
      summary: "Mid-task, no digest yet",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 600,
    }, new Date(T0));
    // A non-boundary event does not compile.
    expect(episodic.digestFor({ agent: "agent-maya" })).toBeNull();

    daemon.status.appendAgentReport({
      subject: "maya",
      agentId: "agent-maya",
      role: "writer",
      incarnationGeneration: 1,
      capabilityEpoch: 0,
      toolSessionId: null,
    }, {
      requestId: "req_018f1e90-7b5a-7cc0-8000-0000000000a2",
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: "complete",
      summary: "Task complete, digest me",
      blocker: null,
      evidenceRefs: [],
      freshForSeconds: 600,
    }, new Date(T1));

    const digest = episodic.digestFor({ agent: "agent-maya" });
    expect(digest).not.toBeNull();
    expect(digest!.sessionId).toBe(assignment.assignmentId);
    expect(digest!.body).toContain("Task complete, digest me");
    expect(db.getAgentByName("maya")?.status).toBe("working");
  });

  test("a failing episodic store does not break the kill that triggers a compile", async () => {
    await makeHome();
    const repoRoot = await makeRepo();
    const repo2 = await makeRepo();
    const episodic = new EpisodicStore(join(repo2, "episodic.db"));
    const { daemon, db } = lifecycleDaemon({ repoRoot, episodic });
    db.insertAgent(idleMaya());
    // Every projection and the compile now throw; the kill must still land.
    episodic.close();

    await reapToKill(daemon, db);
    expect(db.getAgentByName("maya")?.status).toBe("dead");
  });
});
