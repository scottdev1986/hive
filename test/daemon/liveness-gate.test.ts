import { afterAll, describe, expect, test } from "bun:test";
import type { CapabilityProvider } from "../../src/schemas/provider";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queenBootCapsules } from "../../src/daemon/queen-provider-service/queen-boot-capsule-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon, type HiveDaemonOptions } from "../../src/daemon/server";
import { definedFields } from "../../src/shared/defined-fields";
import { HiveTerminalHostAdapter } from "../../src/daemon/session-host/hive-terminal-host";
import { EpisodicStore } from "../../src/memory-service/episodic";
import { MemoryJobStore, startMemoryJob } from "../../src/memory-service/jobs";
import {
  discoverMemoryFacts,
  listMemoryFacts,
  writeMemoryFact,
} from "../../src/memory-service/memory-store";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../../src/schemas/agent";
import type {
  MemoryJobKind,
  MemoryJobReceipt,
} from "../../src/schemas/memory-projections";
import type { ProviderRun } from "../../src/schemas/provider-run";
import type { RunOutcome } from "../../src/schemas/run-outcome";
import { assertSpawnMemoryIndexAccounting } from "../support/spawner-memory-index-liveness";

const roots: string[] = [];
const unusedSpawner = {
  spawn: async (): Promise<never> => {
    throw new Error("not exercised by the liveness gate");
  },
};

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function agent(id: string): AgentRecord {
  const at = "2026-08-11T12:00:00.000Z";
  return {
    id,
    name: id,
    tool: "codex",
    model: "gpt-5.6-sol",
    category: "complex_coding",
    status: "working",
    taskDescription: "Exercise the production run ledger",
    worktreePath: null,
    branch: null,
    contextPct: null,
    createdAt: at,
    lastEventAt: at,
    capabilityEpoch: 0,
    readOnly: false,
    writeRevoked: false,
  };
}

function providerRun(agentId: string): ProviderRun {
  return {
    runId: "019ff0b1-da05-78aa-a6ba-cd1d89d48470",
    agentId,
    terminal: {
      schemaVersion: 1,
      instanceId: "liveness-instance",
      subject: { kind: "agent", agentId },
      generation: 1,
      sessionId: "ses_019ff0b1-da05-78aa-a6ba-cd1d89d48470",
      hostKind: "sessiond",
      engineBuildId: "liveness-engine",
    },
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    conversationId: null,
    capabilityEpoch: 0,
    launchGrantId: "grant-liveness",
    startedAt: "2026-08-11T12:00:00.000Z",
    endedAt: null,
    adapterChild: null,
    protocolReceipt: null,
    state: "running",
    exitReason: null,
  };
}

function providerRunWithChild(agentId: string): ProviderRun {
  return {
    ...providerRun(agentId),
    adapterChild: {
      pid: 41_000,
      startToken: "original-process",
      processGroupId: 41_000,
      observedAt: "2026-08-11T12:00:00.000Z",
    },
  };
}

function insertProviderRun(db: HiveDatabase): ProviderRun {
  const source = agent("agent-liveness");
  const run = providerRunWithChild(source.id);
  db.insertAgent(source);
  db.insertProviderRun(run);
  return run;
}

function completeTerminalBinding(db: HiveDatabase, run: ProviderRun): void {
  const visibility = {
    workspaceSessionId: "workspace-liveness",
    workspacePid: 40_000,
    workspaceStartToken: "workspace-process",
    openTerminalRevision: "1",
  };
  db.bindTerminalHostSession({ locator: run.terminal, visibility });
  db.completeTerminalHostSession(run.terminal, {
    expectedExecutable: "/bin/zsh",
    executableVerified: true,
    verifiedShellRoot: null,
    geometry: {
      columns: 80,
      rows: 24,
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
    },
    visibility: {
      state: "visible",
      workspaceSessionId: visibility.workspaceSessionId,
      openTerminalRevision: visibility.openTerminalRevision,
      expiresAt: "2026-08-11T13:00:00.000Z",
    },
  });
}

const authorized =
  (daemon: HiveDaemon, token: string) =>
  (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Host", "127.0.0.1");
    headers.set("Authorization", `Bearer ${token}`);
    return daemon.fetch(new Request(input, { ...init, headers }));
  };

async function callStatus(
  daemon: HiveDaemon,
  token: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const client = new Client({ name: "liveness-gate", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://hive/mcp"),
    { fetch: authorized(daemon, token) },
  );
  try {
    await client.connect(transport);
    return await client.callTool({ name: "hive_status", arguments: {} });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForMemoryJob(
  jobs: MemoryJobStore,
  id: string,
): Promise<MemoryJobReceipt> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const receipt = jobs.recent().find((candidate) => candidate.id === id);
    if (receipt !== undefined && receipt.state !== "running") return receipt;
    await Bun.sleep(10);
  }
  throw new Error(`memory job ${id} did not finish`);
}

async function startMemoryJobThroughHttp(
  daemon: HiveDaemon,
  token: string,
  jobs: MemoryJobStore,
  kind: MemoryJobKind,
): Promise<MemoryJobReceipt> {
  const response = await authorized(daemon, token)("http://hive/memory/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });
  expect(response.status).toBe(202);
  const started = (await response.json()) as MemoryJobReceipt;
  expect(started.kind).toBe(kind);
  return await waitForMemoryJob(jobs, started.id);
}

async function waitForRepoFacts(
  root: string,
  count: number,
  isReady: () => boolean,
): Promise<Awaited<ReturnType<typeof discoverMemoryFacts>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const facts = await discoverMemoryFacts(root, "repo");
    if (facts.length === count && isReady()) return facts;
    await Bun.sleep(10);
  }
  throw new Error(`repo memory did not reach ${count} article(s)`);
}

async function waitForAdmissionRejection(
  store: EpisodicStore,
): Promise<ReturnType<EpisodicStore["memoryAdmissionStats"]>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stats = store.memoryAdmissionStats();
    if (stats.rejectedTotal > 0) return stats;
    await Bun.sleep(10);
  }
  throw new Error("memory admission did not reject a first observation");
}

async function memoryRig(
  prefix: string,
  retention?: HiveDaemonOptions["retention"],
): Promise<{
  root: string;
  db: HiveDatabase;
  episodic: EpisodicStore;
  jobs: MemoryJobStore;
  daemon: HiveDaemon;
  token: string;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const db = new HiveDatabase(":memory:");
  const episodic = new EpisodicStore(join(root, "episodic.db"));
  const jobs = new MemoryJobStore(episodic);
  const daemon = new HiveDaemon({
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
    spawner: unusedSpawner,
    db,
    repoRoot: root,
    episodicStore: episodic,
    ...definedFields({ retention }),
    port: 0,
  });
  const token = daemon.capabilities.mint("user", "user").token;
  return {
    root,
    db,
    episodic,
    jobs,
    daemon,
    token,
    close: async () => {
      await daemon.stop();
      episodic.close();
      db.close();
    },
  };
}

describe("production liveness evidence", () => {
  test("provider-run closure reaches the orchestrator through hive_status", async () => {
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: {
        spawn: async () => {
          throw new Error("not exercised by the liveness gate");
        },
      },
      db,
      port: 0,
    });
    try {
      const run = insertProviderRun(db);

      const terminalHost = new HiveTerminalHostAdapter(
        {} as never,
        db,
        "liveness-instance",
        {
          now: () => new Date("2026-08-11T12:01:00.000Z"),
          processIdentity: () => ({ startToken: "reused-process" }),
          processGroupState: () => "gone",
          providerRuns: db,
        },
      );
      expect(terminalHost.reconcileProviderRun(run.terminal)).toBeNull();

      const storedRun = db.getProviderRun(run.runId);
      expect(storedRun?.state).toBe("exited");
      expect(storedRun?.exitReason).toBe("provider-process-exited");

      const token = daemon.capabilities.mint(
        ORCHESTRATOR_NAME,
        "orchestrator",
      ).token;
      const result = await callStatus(daemon, token);
      const outcomes = (
        result.structuredContent as {
          recentRunOutcomes: RunOutcome[];
        }
      ).recentRunOutcomes;

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.providerRunId).toBe(run.runId);
      expect(outcomes[0]?.decisionId).toBe(run.launchGrantId);
      // insertProviderRun always writes a worker row (agentId set), so provider is never null here.
      expect(outcomes[0]?.provider).toBe(run.provider as CapabilityProvider);
      expect(outcomes[0]?.model).toBe("gpt-5.6-sol");
      expect(outcomes[0]?.taskCategory).toBe("complex_coding");
      expect(outcomes[0]?.outcome).toBe("crashed");
      expect(outcomes[0]?.handoffId).toBeNull();
      expect(outcomes[0]?.startedAt).toBe(run.startedAt);
      expect(outcomes[0]?.endedAt).toBe("2026-08-11T12:01:00.000Z");
    } finally {
      await daemon.stop();
      db.close();
    }
  });

  test("provider stop closes its run before reporting success", async () => {
    const db = new HiveDatabase(":memory:");
    try {
      const run = insertProviderRun(db);
      let processState: "running" | "gone" = "running";
      const terminalHost = new HiveTerminalHostAdapter(
        {} as never,
        db,
        "liveness-instance",
        {
          now: () => new Date("2026-08-11T12:02:00.000Z"),
          processIdentity: () => ({ startToken: "original-process" }),
          processGroupState: () => processState,
          signalProcessGroup: (_processGroupId, signal) => {
            if (signal === "SIGTERM") processState = "gone";
          },
          sleep: async () => undefined,
          providerRuns: db,
        },
      );

      expect(await terminalHost.stopProvider(run.terminal, run)).toBe(true);
      expect(db.getProviderRun(run.runId)?.state).toBe("exited");
      expect(db.getRunOutcome(run.runId)?.outcome).toBe("stopped");
      expect(db.getRunOutcome(run.runId)?.endedAt).toBe(
        "2026-08-11T12:02:00.000Z",
      );
    } finally {
      db.close();
    }
  });

  test("terminating an absent terminal closes its active provider run", async () => {
    const db = new HiveDatabase(":memory:");
    try {
      const run = insertProviderRun(db);
      completeTerminalBinding(db, run);
      const terminalHost = new HiveTerminalHostAdapter(
        {
          list: async () => [],
        } as never,
        db,
        "liveness-instance",
        { providerRuns: db },
      );

      const result = await terminalHost.terminate(run.terminal, {
        mode: "graceful",
        reason: "liveness probe",
        requestId: "req_019ff121-1111-7000-8000-000000000001",
      });
      expect(result.state).toBe("terminated");
      expect(db.getProviderRun(run.runId)?.exitReason).toBe("terminal-absent");
      expect(db.getRunOutcome(run.runId)?.outcome).toBe("stopped");
    } finally {
      db.close();
    }
  });

  test("terminating a reaped terminal closes its active provider run", async () => {
    const db = new HiveDatabase(":memory:");
    try {
      const run = insertProviderRun(db);
      completeTerminalBinding(db, run);
      const terminalHost = new HiveTerminalHostAdapter(
        {
          list: async () => [
            {
              session: {
                key: run.terminal.sessionId,
                incarnation: "liveness-incarnation",
              },
            },
          ],
          terminate: async () => ({
            state: "terminated",
            exit: null,
            reap: {
              authority: "direct-parent",
              reaped: true,
              status: null,
              completeness: "complete",
            },
            survivors: [],
            completeness: "complete",
            diagnostics: [],
          }),
        } as never,
        db,
        "liveness-instance",
        {
          now: () => new Date("2026-08-11T12:03:00.000Z"),
          providerRuns: db,
        },
      );

      const result = await terminalHost.terminate(run.terminal, {
        mode: "immediate",
        reason: "liveness probe",
        requestId: "req_019ff121-1111-7000-8000-000000000002",
      });
      expect(result.state).toBe("terminated");
      expect(db.getProviderRun(run.runId)?.exitReason).toBe("terminal-reaped");
      expect(db.getRunOutcome(run.runId)?.outcome).toBe("stopped");
    } finally {
      db.close();
    }
  });

  test("the startup reindex leaves a completed memory-job receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-liveness-"));
    roots.push(root);
    const db = new HiveDatabase(":memory:");
    const episodic = new EpisodicStore(join(root, "episodic.db"));
    const jobs = new MemoryJobStore(episodic);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: {
        spawn: async () => {
          throw new Error("not exercised by the liveness gate");
        },
      },
      db,
      repoRoot: root,
      episodicStore: episodic,
      port: 0,
    });
    const legacy = await writeMemoryFact(root, {
      scope: "repo",
      id: "legacy-single-occurrence-harvest",
      topic: "pitfalls",
      title: "Pitfall: legacy single occurrence",
      body: "Occurrences in session: 1",
      tags: ["pitfall", "harvest"],
      source: "orchestrator",
      evidence: "Harvested from 1 failure event(s)",
      status: "unverified",
      kind: "pitfall",
      supersedes: [],
      date: "2026-08-10",
      author: "retired-harvester",
    });
    await writeMemoryFact(root, {
      scope: "repo",
      id: "retained-deliberate-article",
      topic: "testing",
      title: "Retained deliberate article",
      body: "A deliberate write is not a legacy harvest article.",
      tags: ["testing"],
      source: "user",
      evidence: "Seeded as the selective-cleanup positive control",
      status: "unverified",
      kind: "article",
      supersedes: [],
      date: "2026-08-10",
      author: "user",
    });
    try {
      const receipt = await startMemoryJob(
        jobs,
        {
          repoRoot: root,
          index: daemon.memory,
          episodic,
          embeddingService: null,
          writeMemoryFact: (input) => daemon.writeMemoryFact(input),
          runRetentionSweep: () => daemon.runMemoryRetentionSweep(),
          rebuildMemoryIndex: () => daemon.rebuildMemoryIndex(),
          now: () => new Date("2026-08-11T12:00:00.000Z"),
        },
        "reindex",
        "daemon-startup",
      ).done;
      const persisted = jobs.recent();
      const allArticles = await listMemoryFacts(root);
      const repoArticles = await discoverMemoryFacts(root, "repo");

      expect(persisted).toHaveLength(1);
      expect(receipt.kind).toBe("reindex");
      expect(receipt.requestedBy).toBe("daemon-startup");
      expect(receipt.state).toBe("succeeded");
      expect(receipt.finishedAt).not.toBeNull();
      expect(receipt.error).toBeNull();
      expect(receipt.progress.step).toBe("reading back");
      expect(receipt.progress.total).not.toBeNull();
      expect(receipt.progress.done).toBe(receipt.progress.total as number);
      expect(receipt.readback?.wikiArticles).toBe(allArticles.length);
      expect(Number(receipt.readback?.ftsRows)).toBe(daemon.memory.count());
      expect(allArticles.length).toBeGreaterThan(0);
      expect(repoArticles.map((fact) => fact.id)).toEqual([
        "retained-deliberate-article",
      ]);
      expect(
        repoArticles.filter((fact) => fact.tags.includes("harvest")),
      ).toEqual([]);
      expect(await readFile(legacy.rawPath, "utf8")).toContain(
        "Harvested from 1 failure event(s)",
      );
    } finally {
      await daemon.stop();
      episodic.close();
      db.close();
    }
  });

  test("the authenticated job route reindexes the stores it reads back", async () => {
    const rig = await memoryRig("hive-liveness-reindex-");
    try {
      const receipt = await startMemoryJobThroughHttp(
        rig.daemon,
        rig.token,
        rig.jobs,
        "reindex",
      );

      expect(receipt.state).toBe("succeeded");
      expect(receipt.readback?.wikiArticles).toBe(
        (await listMemoryFacts(rig.root)).length,
      );
      expect(Number(receipt.readback?.ftsRows)).toBe(rig.daemon.memory.count());
    } finally {
      await rig.close();
    }
  });

  test("the authenticated job route runs retention against durable events", async () => {
    const rig = await memoryRig("hive-liveness-retention-", {
      events_hot_days: 1,
      stale_after_days: 90,
      sweep_interval_hours: 24,
    });
    rig.episodic.appendEvent({
      ts: "2000-01-01T00:00:00.000Z",
      agent: "agent-liveness",
      type: "status.turn",
      summary: "aged liveness fixture",
    });
    try {
      const receipt = await startMemoryJobThroughHttp(
        rig.daemon,
        rig.token,
        rig.jobs,
        "retention-sweep",
      );

      expect(receipt.state).toBe("succeeded");
      expect(receipt.readback?.events).toBe(rig.episodic.rowCounts().events);
      expect(rig.episodic.rowCounts().events).toBe(0);
      expect(receipt.summary).toContain("deleted 1 aged event");
    } finally {
      await rig.close();
    }
  });

  test("production landing boundaries reject once, then admit the repeated failure", async () => {
    const rig = await memoryRig("hive-liveness-harvest-");
    try {
      rig.daemon.status.appendSourceEvent({
        entity: { kind: "agent", id: "agent-first" },
        occurredAt: "2026-08-11T12:04:00.000Z",
        kind: "agent.status-reported",
        source: {
          kind: "agent-report",
          id: "failure-first",
          observedAt: "2026-08-11T12:04:00.000Z",
          confidence: "authoritative",
        },
        data: {
          agentId: "agent-first",
          phase: "blocked",
          blocker: "RangeError: liveness harvest overflow",
          error: "RangeError: liveness harvest overflow",
          tool: "sessiond",
        },
      });
      rig.daemon.status.appendSourceEvent({
        entity: { kind: "agent", id: "agent-first" },
        occurredAt: "2026-08-11T12:05:00.000Z",
        kind: "agent.branch-landed",
        source: {
          kind: "task",
          id: "landing-first",
          observedAt: "2026-08-11T12:05:00.000Z",
          confidence: "authoritative",
        },
        data: { agentId: "agent-first" },
      });

      const rejected = await waitForAdmissionRejection(rig.episodic);
      expect(rejected).toEqual({
        seenCandidates: 1,
        rejectedTotal: 1,
        lastRejectedAt: "2026-08-11T12:04:00.000Z",
      });
      expect(await discoverMemoryFacts(rig.root, "repo")).toEqual([]);
      expect(rig.daemon.memory.count()).toBe(0);

      rig.daemon.status.appendSourceEvent({
        entity: { kind: "agent", id: "agent-second" },
        occurredAt: "2026-08-11T12:06:00.000Z",
        kind: "agent.status-reported",
        source: {
          kind: "agent-report",
          id: "failure-second",
          observedAt: "2026-08-11T12:06:00.000Z",
          confidence: "authoritative",
        },
        data: {
          agentId: "agent-second",
          phase: "blocked",
          blocker: "RangeError: liveness harvest overflow",
          error: "RangeError: liveness harvest overflow",
          tool: "sessiond",
        },
      });
      rig.daemon.status.appendSourceEvent({
        entity: { kind: "agent", id: "agent-second" },
        occurredAt: "2026-08-11T12:07:00.000Z",
        kind: "agent.branch-landed",
        source: {
          kind: "task",
          id: "landing-second",
          observedAt: "2026-08-11T12:07:00.000Z",
          confidence: "authoritative",
        },
        data: { agentId: "agent-second" },
      });

      const facts = await waitForRepoFacts(
        rig.root,
        1,
        () =>
          rig.daemon.memory.count() === 1 &&
          Number(
            rig.episodic.readMeta("pitfall-harvest.high-water.agent-second"),
          ) === rig.episodic.rowCounts().events,
      );
      expect(facts[0]?.title).toContain("liveness harvest overflow");
      expect(facts[0]?.status).toBe("unverified");
      expect(facts[0]?.body).toContain(
        "Admission: signature repeated at a later session boundary",
      );
      expect(rig.daemon.memory.count()).toBe(facts.length);
      expect(rig.episodic.memoryAdmissionStats()).toEqual(rejected);
      for (const agentId of ["agent-first", "agent-second"]) {
        const events = rig.episodic.eventsFor({ agent: agentId });
        const lastEvent = events.at(-1);
        expect(lastEvent).toBeDefined();
        if (lastEvent === undefined) throw new Error("agent event is absent");
        expect(
          Number(
            rig.episodic.readMeta(`pitfall-harvest.high-water.${agentId}`),
          ),
        ).toBe(lastEvent.id);
      }
    } finally {
      await rig.close();
    }
  });

  test("the production spawn prompt accounts for every stored article", async () => {
    await assertSpawnMemoryIndexAccounting();
  });

  test("both automatic memory push call sites use renderMemoryIndex", () => {
    const worker = readFileSync(
      join(import.meta.dir, "../../src/daemon/spawn/agent-prompt.ts"),
      "utf8",
    );
    const queen = readFileSync(
      join(
        import.meta.dir,
        "../../src/daemon/queen-provider-service/queen-boot-capsule-service.ts",
      ),
      "utf8",
    );
    const workerCall = worker.slice(
      worker.indexOf("export function buildAgentPrompt"),
    );
    expect(workerCall).toContain("renderMemoryIndex(");
    expect(queen).toContain("renderMemoryIndex(");
    expect(queen).not.toContain('section("Knowledge index data"');
  });

  test("the production queen launch context uses the shared memory renderer", () => {
    const context = queenBootCapsules.composeLaunchContext({
      policy: "pinned queen policy",
      memoryIndex:
        "Hive memory index — compiled durable repo knowledge.\n- [repo/testing] liveness-article (2026-08-13)",
    });
    expect(context.text).toContain("## Knowledge index data");
    expect(context.text).toContain("liveness-article");
    expect(context.memoryEntries).toEqual({ total: 2, shown: 2 });
  });

  test("a vendor drain persists a handoff and its typed outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-liveness-handoff-"));
    roots.push(root);
    const db = new HiveDatabase(":memory:");
    const source = {
      ...agent("agent-liveness"),
      sessionLocator: providerRun("agent-liveness").terminal,
    };
    const run = providerRun(source.id);
    db.insertAgent(source);
    db.insertProviderRun(run);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      spawner: {
        spawn: async () => ({
          ...agent("agent-replacement"),
          id: "agent-replacement",
          name: "replacement",
        }),
      },
      db,
      repoRoot: root,
      port: 0,
    });
    const internal = daemon as unknown as {
      terminalHost: {
        pauseProvider: () => Promise<boolean>;
        inspect: () => Promise<never>;
      };
    };
    internal.terminalHost.pauseProvider = async () => false;
    internal.terminalHost.inspect = async () => {
      throw new Error("terminal readback unavailable in liveness fixture");
    };
    try {
      await daemon.onVendorDrainError(source, "429 quota exhausted");
      const handoff = db.getHandoffForSourceRun(run.runId);
      const outcome = db.getRunOutcome(run.runId);

      expect(handoff?.bundle.reason).toBe("quota-drain");
      expect(handoff?.bundle.runOutcome.providerRunId).toBe(run.runId);
      expect(outcome?.outcome).toBe("quota-drained");
      expect(outcome?.handoffId).toBe(handoff?.bundle.handoffId);
    } finally {
      await daemon.stop();
      db.close();
    }
  });
});
