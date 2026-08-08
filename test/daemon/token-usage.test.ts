import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { HiveDaemon } from "../../src/daemon/server";
import type { TokenUsageEventIngest } from "../../src/schemas/token-usage-schema";
import { TokenUsageStore } from "../../src/usage-service/token-usage";
import { required } from "../required";
import { tempRoot } from "../temp-root";

const at = "2026-07-13T12:00:00.000Z";

function reading(
  key: string,
  counts: TokenUsageEventIngest["counts"],
  options: { cumulative?: boolean; observedAt?: string; source?: string } = {},
): TokenUsageEventIngest {
  return {
    key,
    counts,
    observedAt: options.observedAt ?? at,
    source: options.source ?? "protocol-test",
    ...(options.cumulative === true ? { cumulative: true } : {}),
  };
}

describe("TokenUsageStore", () => {
  test("attributes protocol readings from Claude, Codex, and Grok without double counting", async () => {
    const home = tempRoot("hive-token-usage-");
    const repo = join(home, "repo");
    mkdirSync(repo);
    const store = new TokenUsageStore(new HiveDatabase(":memory:"));
    const session = await store.startSession(repo, at);

    const codex = store.startOrchestrator(session, "codex", repo, at);
    store.recordProtocolUsage(codex, [
      reading(
        "cumulative",
        {
          inputTokens: 100,
          cachedInputTokens: 70,
          cacheCreationInputTokens: null,
          outputTokens: 20,
          reasoningTokens: 5,
        },
        { cumulative: true, source: "codex-app-server" },
      ),
    ]);
    // A later cumulative reading replaces the earlier total, not adds to it.
    store.recordProtocolUsage(codex, [
      reading(
        "cumulative",
        {
          inputTokens: 150,
          cachedInputTokens: 90,
          cacheCreationInputTokens: null,
          outputTokens: 30,
          reasoningTokens: 8,
        },
        {
          cumulative: true,
          observedAt: "2026-07-13T12:01:00.000Z",
          source: "codex-app-server",
        },
      ),
    ]);
    await store.endSubject(codex);

    const claude = store.startOrchestrator(session, "claude", repo, at);
    store.recordProtocolUsage(claude, [
      reading(
        "message:message-1",
        {
          inputTokens: 60,
          cachedInputTokens: 30,
          cacheCreationInputTokens: 20,
          outputTokens: 6,
          reasoningTokens: null,
        },
        { source: "claude-stream-json" },
      ),
    ]);
    // Replaying the same key is a reconnect — totals must not grow.
    store.recordProtocolUsage(claude, [
      reading(
        "message:message-1",
        {
          inputTokens: 60,
          cachedInputTokens: 30,
          cacheCreationInputTokens: 20,
          outputTokens: 6,
          reasoningTokens: null,
        },
        {
          observedAt: "2026-07-13T12:02:00.000Z",
          source: "claude-stream-json",
        },
      ),
    ]);
    await store.endSubject(claude);

    const grok = store.startOrchestrator(session, "grok", repo, at);
    store.recordProtocolUsage(grok, [
      reading(
        "turn:prompt-1",
        {
          inputTokens: 40,
          cachedInputTokens: 25,
          cacheCreationInputTokens: null,
          outputTokens: 9,
          reasoningTokens: 3,
        },
        { source: "grok-acp" },
      ),
    ]);
    await store.endSubject(grok);

    const snapshot = await store.snapshot(repo);
    const current = required(snapshot.sessions[0]);
    expect(current.complete).toBe(true);
    expect(current.hiveControl.counts).toEqual({
      inputTokens: 250,
      cachedInputTokens: 145,
      cacheCreationInputTokens: null,
      outputTokens: 45,
      reasoningTokens: null,
      totalTokens: 295,
    });
    expect(
      current.subjects.map((subject) => [
        subject.provider,
        subject.reading.state === "measured"
          ? subject.reading.counts.totalTokens
          : null,
      ]),
    ).toEqual([
      ["codex", 180],
      ["claude", 66],
      ["grok", 49],
    ]);
  });

  test("without a protocol reading the subject stays unknown, never zero", async () => {
    const home = tempRoot("hive-token-unknown-");
    const repo = join(home, "repo");
    mkdirSync(repo);
    const store = new TokenUsageStore(new HiveDatabase(":memory:"));
    const session = await store.startSession(repo, at);
    store.startOrchestrator(session, "claude", repo, at);

    const readingState = (await store.snapshot(repo)).sessions[0]?.subjects[0]
      ?.reading;
    expect(readingState).toEqual({
      state: "unknown",
      reason: "No provider token reading has been observed",
    });
  });

  test("protocol ingestion is the only write path — any provider shape works", async () => {
    const repo = "/tmp/hive-opencode-token-test";
    const store = new TokenUsageStore(new HiveDatabase(":memory:"));
    const session = await store.startSession(repo, at);
    const subject = store.startOrchestrator(session, "opencode", repo, at);
    store.recordProtocolUsage(subject, [
      reading("turn-1", {
        inputTokens: 12,
        cachedInputTokens: null,
        cacheCreationInputTokens: null,
        outputTokens: 3,
        reasoningTokens: null,
      }),
    ]);

    const snapshot = await store.snapshot(repo);
    expect(snapshot.sessions[0]?.subjects[0]?.provider).toBe("opencode");
    expect(snapshot.sessions[0]?.fleet.counts?.totalTokens).toBe(15);
  });

  test("backup orchestrators and workers stay in one fleet session with separate buckets", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-generation-token-test";
    const store = new TokenUsageStore(db);
    const session = await store.startSession(repo, at);
    const first = store.startOrchestrator(session, "codex", repo, at);
    store.recordProtocolUsage(first, [
      reading(
        "cumulative",
        {
          inputTokens: 10,
          cachedInputTokens: 5,
          cacheCreationInputTokens: null,
          outputTokens: 2,
          reasoningTokens: 1,
        },
        { cumulative: true },
      ),
    ]);
    await store.endSubject(first, "2026-07-13T12:01:00.000Z");
    const second = store.startOrchestrator(
      session,
      "codex",
      repo,
      "2026-07-13T12:01:01.000Z",
    );
    store.recordProtocolUsage(second, [
      reading(
        "cumulative",
        {
          inputTokens: 10,
          cachedInputTokens: 5,
          cacheCreationInputTokens: null,
          outputTokens: 2,
          reasoningTokens: 1,
        },
        { cumulative: true },
      ),
    ]);
    db.insertAgent({
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "complex_coding",
      status: "working",
      taskDescription: "Build token accounting",
      worktreePath: join(repo, ".hive", "worktrees", "maya"),
      branch: "hive/maya-token-accounting",
      contextPct: 1,
      createdAt: "2026-07-13T12:00:30.000Z",
      lastEventAt: "2026-07-13T12:00:30.000Z",
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
      toolSessionId: "worker-codex-session",
    });
    await store.refreshSession(session);
    const workerId = required(store.subjectIdForAgent("agent-maya", repo));
    store.recordProtocolUsage(workerId, [
      reading(
        "cumulative",
        {
          inputTokens: 10,
          cachedInputTokens: 5,
          cacheCreationInputTokens: null,
          outputTokens: 2,
          reasoningTokens: 1,
        },
        { cumulative: true },
      ),
    ]);

    const snapshot = await store.snapshot(repo);
    const current = required(snapshot.sessions[0]);
    expect(current.subjects.map((subject) => subject.role)).toEqual([
      "orchestrator",
      "worker",
      "orchestrator",
    ]);
    expect(current.hiveControl.counts?.totalTokens).toBe(24);
    expect(current.workerSessions.counts?.totalTokens).toBe(12);
    expect(current.fleet.counts?.totalTokens).toBe(36);
  });

  test("missing protocol evidence is unknown and never fabricated as zero", async () => {
    const repo = "/tmp/hive-quiet-token-test";
    const store = new TokenUsageStore(new HiveDatabase(":memory:"));
    const session = await store.startSession(repo, at);
    store.startOrchestrator(session, "quiet-cli", repo, at);

    const snapshot = await store.snapshot(repo);
    expect(snapshot.sessions[0]?.complete).toBe(false);
    expect(snapshot.sessions[0]?.fleet.counts).toBeNull();
    expect(snapshot.sessions[0]?.unknownSubjects).toEqual([
      "Orchestrator (quiet-cli)",
    ]);
    expect(snapshot.sessions[0]?.subjects[0]?.reading).toEqual({
      state: "unknown",
      reason: "No provider token reading has been observed",
    });
  });

  test("the daemon lifecycle and read API are capability gated", async () => {
    const db = new HiveDatabase(":memory:");
    const tokenUsage = new TokenUsageStore(db);
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      tokenUsage,
      repoRoot: "/tmp/hive-token-api",
      spawner: {
        spawn: async () => {
          throw new Error("unused");
        },
      },
    });
    const user = daemon.capabilities.mint("user-test", "user", {
      epoch: 0,
    }).token;
    const orchestrator = daemon.capabilities.mint(
      "orchestrator",
      "orchestrator",
      { epoch: 0 },
    ).token;
    const request = (path: string, token: string, body?: unknown) =>
      daemon.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    const denied = await request("/token-usage/sessions", orchestrator, {
      repoRoot: "/tmp/hive-token-api",
    });
    expect(denied.status).toBe(403);

    const started = await request("/token-usage/sessions", user, {
      repoRoot: "/tmp/hive-token-api",
    });
    expect(started.status).toBe(200);
    const sessionId = ((await started.json()) as { sessionId: string })
      .sessionId;
    const read = await request(
      `/token-usage?repoRoot=${encodeURIComponent("/tmp/hive-token-api")}`,
      orchestrator,
    );
    expect(read.status).toBe(200);
    expect(
      ((await read.json()) as { currentSessionId: string }).currentSessionId,
    ).toBe(sessionId);
  });

  test("a profiling-era database migrates: profiler rows and their events are dropped, legacy rows survive", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-token-migrate-test";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const legacyId = "22222222-2222-4222-8222-222222222222";
    const profilerId = "33333333-3333-4333-8333-333333333333";
    db.database.exec(`
      CREATE TABLE token_usage_sessions (
        id TEXT PRIMARY KEY, repoRoot TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT
      );
      CREATE TABLE token_usage_subjects (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES token_usage_sessions(id),
        agentId TEXT, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('orchestrator', 'worker', 'profiler')),
        provider TEXT NOT NULL, model TEXT, cwd TEXT NOT NULL, providerSessionId TEXT,
        profileRunId TEXT, startedAt TEXT NOT NULL, endedAt TEXT, unknownReason TEXT
      );
      CREATE UNIQUE INDEX token_usage_one_profiler_per_run
        ON token_usage_subjects(sessionId, profileRunId) WHERE profileRunId IS NOT NULL;
      CREATE TABLE token_usage_artifacts (
        subjectId TEXT NOT NULL REFERENCES token_usage_subjects(id),
        path TEXT NOT NULL, cursorBytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(subjectId, path)
      );
      CREATE TABLE token_usage_events (
        subjectId TEXT NOT NULL REFERENCES token_usage_subjects(id),
        eventKey TEXT NOT NULL, cumulative INTEGER NOT NULL DEFAULT 0,
        inputTokens INTEGER NOT NULL, cachedInputTokens INTEGER,
        cacheCreationInputTokens INTEGER, outputTokens INTEGER NOT NULL,
        reasoningTokens INTEGER, observedAt TEXT NOT NULL, source TEXT NOT NULL,
        PRIMARY KEY(subjectId, eventKey)
      );
    `);
    db.database
      .query(
        "INSERT INTO token_usage_sessions (id, repoRoot, startedAt, endedAt) VALUES (?, ?, ?, NULL)",
      )
      .run(sessionId, repo, at);
    db.database
      .query(`
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, model, cwd,
        providerSessionId, profileRunId, startedAt, endedAt, unknownReason
      ) VALUES (?, ?, NULL, 'Orchestrator', 'orchestrator', 'claude', NULL, ?, NULL, NULL, ?, NULL, NULL)
    `)
      .run(legacyId, sessionId, repo, at);
    db.database
      .query(`
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, model, cwd,
        providerSessionId, profileRunId, startedAt, endedAt, unknownReason
      ) VALUES (?, ?, NULL, 'Profiler', 'profiler', 'claude', NULL, ?, NULL, 'run-1', ?, NULL, NULL)
    `)
      .run(profilerId, sessionId, repo, at);
    db.database
      .query(`
      INSERT INTO token_usage_events (
        subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
        cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
      ) VALUES (?, 'legacy', 0, 10, NULL, NULL, 2, NULL, ?, 'legacy')
    `)
      .run(legacyId, at);
    db.database
      .query(`
      INSERT INTO token_usage_events (
        subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
        cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
      ) VALUES (?, 'profiler', 0, 99, NULL, NULL, 1, NULL, ?, 'profiler')
    `)
      .run(profilerId, at);

    new TokenUsageStore(db);

    const roles = db.database
      .query("SELECT role FROM token_usage_subjects ORDER BY name")
      .all() as Array<{ role: string }>;
    expect(roles).toEqual([{ role: "orchestrator" }]);
    const events = db.database
      .query("SELECT subjectId FROM token_usage_events")
      .all() as Array<{ subjectId: string }>;
    expect(events).toEqual([{ subjectId: legacyId }]);
  });
});
