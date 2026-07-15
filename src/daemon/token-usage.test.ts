import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { claudeProjectDirectory } from "../adapters/tools/claude";
import { HiveDatabase } from "./db";
import { HiveDaemon } from "./server";
import {
  defaultTokenUsageAdapters,
  TokenUsageStore,
  type TokenUsageAdapter,
} from "./token-usage";

const at = "2026-07-13T12:00:00.000Z";

describe("TokenUsageStore", () => {
  test("normalizes real Claude, Codex, and Grok artifact shapes without double counting", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-token-usage-"));
    const repo = join(home, "repo");
    mkdirSync(repo);
    const store = new TokenUsageStore(
      new HiveDatabase(":memory:"),
      defaultTokenUsageAdapters(home),
    );
    const session = await store.startSession(repo, at);

    const codexDirectory = join(home, ".codex", "sessions", "2026", "07", "13");
    mkdirSync(codexDirectory, { recursive: true });
    const codexPath = join(codexDirectory, "rollout-test.jsonl");
    writeFileSync(codexPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd: resolve(repo) } }),
      JSON.stringify({
        timestamp: at,
        payload: {
          type: "token_count",
          info: { total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 70,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          } },
        },
      }),
    ].join("\n") + "\n");
    const codex = store.startOrchestrator(session, "codex", repo, at);
    store.registerOrchestratorProviderSession("codex-session", repo);
    await store.refreshSubject(codex);
    appendFileSync(codexPath, JSON.stringify({
      timestamp: "2026-07-13T12:01:00.000Z",
      payload: {
        type: "token_count",
        info: { total_token_usage: {
          input_tokens: 150,
          cached_input_tokens: 90,
          output_tokens: 30,
          reasoning_output_tokens: 8,
        } },
      },
    }) + "\n");
    await store.endSubject(codex);

    const claudeDirectory = claudeProjectDirectory(repo, home);
    mkdirSync(claudeDirectory, { recursive: true });
    const claudePath = join(claudeDirectory, "claude-session.jsonl");
    writeFileSync(claudePath, JSON.stringify({
      type: "assistant",
      uuid: "entry-1",
      timestamp: at,
      message: {
        id: "message-1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 4,
        },
      },
    }) + "\n");
    const claude = store.startOrchestrator(session, "claude", repo, at);
    store.registerOrchestratorProviderSession("claude-session", repo);
    await store.refreshSubject(claude);
    appendFileSync(claudePath, JSON.stringify({
      type: "assistant",
      uuid: "entry-2",
      timestamp: "2026-07-13T12:02:00.000Z",
      message: {
        id: "message-1",
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 6,
        },
      },
    }) + "\n");
    await store.endSubject(claude);

    const grokSession = "grok-session";
    const grokDirectory = join(
      home,
      ".grok",
      "sessions",
      encodeURIComponent(resolve(repo)),
      grokSession,
    );
    mkdirSync(grokDirectory, { recursive: true });
    writeFileSync(join(grokDirectory, "summary.json"), JSON.stringify({
      info: { id: grokSession, cwd: resolve(repo) },
      current_model_id: "grok-code-fast-1",
    }));
    writeFileSync(join(grokDirectory, "updates.jsonl"), JSON.stringify({
      timestamp: 1_752_408_000,
      params: { update: {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        usage: {
          inputTokens: 40,
          cachedReadTokens: 25,
          outputTokens: 9,
          reasoningTokens: 3,
        },
      } },
    }) + "\n");
    const grok = store.startOrchestrator(session, "grok", repo, at);
    store.registerOrchestratorProviderSession(grokSession, repo);
    await store.endSubject(grok);

    const snapshot = await store.snapshot(repo);
    const current = snapshot.sessions[0]!;
    expect(current.complete).toBe(true);
    expect(current.hiveControl.counts).toEqual({
      inputTokens: 250,
      cachedInputTokens: 145,
      cacheCreationInputTokens: null,
      outputTokens: 45,
      reasoningTokens: null,
      totalTokens: 295,
    });
    expect(current.subjects.map((subject) => [
      subject.provider,
      subject.reading.state === "measured" ? subject.reading.counts.totalTokens : null,
    ])).toEqual([
      ["codex", 180],
      ["claude", 66],
      ["grok", 49],
    ]);
  });

  test("a missing provider session id never aliases a predecessor's tokens", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-token-alias-"));
    const repo = join(home, "repo");
    mkdirSync(repo);
    const directory = claudeProjectDirectory(repo, home);
    mkdirSync(directory, { recursive: true });
    const assistant = (id: string, input: number, output: number) =>
      JSON.stringify({
        type: "assistant",
        uuid: id,
        timestamp: at,
        message: {
          id,
          usage: {
            input_tokens: input,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: output,
          },
        },
      }) + "\n";
    writeFileSync(
      join(directory, "dead-predecessor.jsonl"),
      assistant("predecessor-message", 1_000, 100),
    );

    const store = new TokenUsageStore(
      new HiveDatabase(":memory:"),
      defaultTokenUsageAdapters(home),
    );
    const session = await store.startSession(repo, at);
    const subject = store.startOrchestrator(session, "claude", repo, at);

    await store.refreshSubject(subject);
    let reading = (await store.snapshot(repo)).sessions[0]!.subjects[0]!.reading;
    expect(reading).toEqual({
      state: "unknown",
      reason: "claude provider session id has not been observed",
    });

    writeFileSync(
      join(directory, "current-session.jsonl"),
      assistant("current-message", 6, 1),
    );
    store.registerOrchestratorProviderSession("current-session", repo);
    await store.refreshSubject(subject);
    reading = (await store.snapshot(repo)).sessions[0]!.subjects[0]!.reading;
    expect(reading.state).toBe("measured");
    if (reading.state === "measured") {
      expect(reading.counts.totalTokens).toBe(7);
    }
  });

  test("a new CLI is one adapter, not a ledger or wire-schema change", async () => {
    const adapter: TokenUsageAdapter = {
      provider: "opencode",
      discover: async () => ({ paths: ["virtual://opencode/session"] }),
      read: async () => ({
        cursorBytes: 1,
        events: [{
          key: "turn-1",
          counts: {
            inputTokens: 12,
            cachedInputTokens: null,
            cacheCreationInputTokens: null,
            outputTokens: 3,
            reasoningTokens: null,
          },
          observedAt: at,
          source: "opencode-test",
        }],
      }),
    };
    const repo = "/tmp/hive-opencode-token-test";
    const store = new TokenUsageStore(new HiveDatabase(":memory:"), [adapter]);
    const session = await store.startSession(repo, at);
    store.startOrchestrator(session, "opencode", repo, at);
    store.registerOrchestratorProviderSession("opencode-session", repo);

    const snapshot = await store.snapshot(repo);
    expect(snapshot.sessions[0]!.subjects[0]!.provider).toBe("opencode");
    expect(snapshot.sessions[0]!.fleet.counts?.totalTokens).toBe(15);
  });

  test("backup orchestrators and workers stay in one fleet session with separate buckets", async () => {
    const adapter: TokenUsageAdapter = {
      provider: "codex",
      discover: async (subject) => ({ paths: [`virtual://${subject.id}`] }),
      read: async () => ({
        cursorBytes: 1,
        events: [{
          key: "cumulative",
          cumulative: true,
          counts: {
            inputTokens: 10,
            cachedInputTokens: 5,
            cacheCreationInputTokens: null,
            outputTokens: 2,
            reasoningTokens: 1,
          },
          observedAt: at,
          source: "codex-test",
        }],
      }),
    };
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-generation-token-test";
    const store = new TokenUsageStore(db, [adapter]);
    const session = await store.startSession(repo, at);
    const first = store.startOrchestrator(session, "codex", repo, at);
    store.registerOrchestratorProviderSession("first-codex-session", repo);
    await store.endSubject(first, "2026-07-13T12:01:00.000Z");
    store.startOrchestrator(session, "codex", repo, "2026-07-13T12:01:01.000Z");
    store.registerOrchestratorProviderSession("second-codex-session", repo);
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
      tmuxSession: "hive-maya",
      contextPct: 1,
      createdAt: "2026-07-13T12:00:30.000Z",
      lastEventAt: "2026-07-13T12:00:30.000Z",
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
      toolSessionId: "worker-codex-session",
    });

    const snapshot = await store.snapshot(repo);
    const current = snapshot.sessions[0]!;
    expect(current.subjects.map((subject) => subject.role)).toEqual([
      "orchestrator",
      "worker",
      "orchestrator",
    ]);
    expect(current.hiveControl.counts?.totalTokens).toBe(24);
    expect(current.workerSessions.counts?.totalTokens).toBe(12);
    expect(current.fleet.counts?.totalTokens).toBe(36);
  });

  test("missing provider evidence is unknown and never fabricated as zero", async () => {
    const adapter: TokenUsageAdapter = {
      provider: "quiet-cli",
      discover: async () => ({ paths: [] }),
      read: async () => ({ cursorBytes: 0, events: [] }),
    };
    const repo = "/tmp/hive-quiet-token-test";
    const store = new TokenUsageStore(new HiveDatabase(":memory:"), [adapter]);
    const session = await store.startSession(repo, at);
    store.startOrchestrator(session, "quiet-cli", repo, at);
    store.registerOrchestratorProviderSession("quiet-session", repo);

    const snapshot = await store.snapshot(repo);
    expect(snapshot.sessions[0]!.complete).toBe(false);
    expect(snapshot.sessions[0]!.fleet.counts).toBeNull();
    expect(snapshot.sessions[0]!.unknownSubjects).toEqual([
      "Orchestrator (quiet-cli)",
    ]);
    expect(snapshot.sessions[0]!.subjects[0]!.reading).toEqual({
      state: "unknown",
      reason: "quiet-cli has not produced a token artifact for this session",
    });
  });

  test("a failed refresh does not present an older subtotal as complete", async () => {
    let readable = true;
    const adapter: TokenUsageAdapter = {
      provider: "flaky-cli",
      discover: async () => ({ paths: ["virtual://flaky/session"] }),
      read: async () => {
        if (!readable) throw new Error("artifact disappeared");
        return {
          cursorBytes: 1,
          events: [{
            key: "turn",
            counts: {
              inputTokens: 4,
              cachedInputTokens: null,
              cacheCreationInputTokens: null,
              outputTokens: 1,
              reasoningTokens: null,
            },
            observedAt: at,
            source: "flaky-test",
          }],
        };
      },
    };
    const repo = "/tmp/hive-flaky-token-test";
    const store = new TokenUsageStore(new HiveDatabase(":memory:"), [adapter]);
    const session = await store.startSession(repo, at);
    const subject = store.startOrchestrator(session, "flaky-cli", repo, at);
    store.registerOrchestratorProviderSession("flaky-session", repo);
    await store.refreshSubject(subject);
    readable = false;

    const snapshot = await store.snapshot(repo);
    expect(snapshot.sessions[0]!.complete).toBe(false);
    expect(snapshot.sessions[0]!.fleet.counts).toBeNull();
    expect(snapshot.sessions[0]!.subjects[0]!.reading).toEqual({
      state: "unknown",
      reason: "Could not read flaky-cli token artifact: artifact disappeared",
    });
  });

  test("the daemon lifecycle and read API are capability gated", async () => {
    const db = new HiveDatabase(":memory:");
    const tokenUsage = new TokenUsageStore(db, []);
    const daemon = new HiveDaemon({
      db,
      tokenUsage,
      repoRoot: "/tmp/hive-token-api",
      spawner: { spawn: async () => { throw new Error("unused"); } },
    });
    const operator = daemon.capabilities.mint("operator-test", "operator", { epoch: 0 }).token;
    const orchestrator = daemon.capabilities.mint("orchestrator", "orchestrator", { epoch: 0 }).token;
    const request = (path: string, token: string, body?: unknown) => daemon.fetch(new Request(
      `http://127.0.0.1${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ));

    const denied = await request(
      "/token-usage/sessions",
      orchestrator,
      { repoRoot: "/tmp/hive-token-api" },
    );
    expect(denied.status).toBe(403);

    const started = await request(
      "/token-usage/sessions",
      operator,
      { repoRoot: "/tmp/hive-token-api" },
    );
    expect(started.status).toBe(200);
    const sessionId = (await started.json() as { sessionId: string }).sessionId;
    const read = await request(
      "/token-usage?repoRoot=%2Ftmp%2Fhive-token-api",
      orchestrator,
    );
    expect(read.status).toBe(200);
    expect((await read.json() as { currentSessionId: string }).currentSessionId)
      .toBe(sessionId);
  });

  test("a profiler is attributed to profilingSessions, never to workers, and tolerates null cache-creation", async () => {
    const adapter: TokenUsageAdapter = {
      provider: "codex",
      discover: async (subject) => ({ paths: [`virtual://${subject.id}`] }),
      read: async () => ({
        cursorBytes: 1,
        events: [{
          key: "cumulative",
          cumulative: true,
          counts: {
            inputTokens: 400,
            cachedInputTokens: 250,
            // Codex/Grok report reads but not cache-creation; the bucket must
            // survive with a live reads figure and an honest null here.
            cacheCreationInputTokens: null,
            outputTokens: 60,
            reasoningTokens: 20,
          },
          observedAt: at,
          source: "codex-test",
        }],
      }),
    };
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-profiler-bucket-test";
    const store = new TokenUsageStore(db, [adapter]);
    const session = await store.startSession(repo, at);

    store.startOrchestrator(session, "codex", repo, at);
    store.registerOrchestratorProviderSession("orchestrator-session", repo);
    db.insertAgent({
      id: "agent-maya",
      name: "maya",
      tool: "codex",
      model: "gpt-5.6-sol",
      category: "complex_coding",
      status: "working",
      taskDescription: "Task work",
      worktreePath: join(repo, ".hive", "worktrees", "maya"),
      branch: "hive/maya",
      tmuxSession: "hive-maya",
      contextPct: 1,
      createdAt: at,
      lastEventAt: at,
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      readOnly: false,
      writeRevoked: false,
      toolSessionId: "worker-session",
    });

    const profiler = store.startProfiler(
      session, "run-abc", "profile-run-1", "codex", "gpt-5.6-sol",
      join(repo, ".hive", "profile"), null, at,
    );
    store.registerProfilerProviderSession(profiler, "profiler-session");
    await store.refreshSubject(profiler);
    await store.endSubject(profiler); // terminal finalization records the reading

    const current = (await store.snapshot(repo)).sessions[0]!;
    expect(current.subjects.find((s) => s.id === profiler)!.role).toBe("profiler");
    expect(current.profilingSessions.subjectCount).toBe(1);
    expect(current.profilingSessions.counts).toEqual({
      inputTokens: 400,
      cachedInputTokens: 250,
      cacheCreationInputTokens: null,
      outputTokens: 60,
      reasoningTokens: 20,
      totalTokens: 460,
    });
    // The worker bucket holds only the worker; the fleet holds all three.
    expect(current.workerSessions.subjectCount).toBe(1);
    expect(current.fleet.subjectCount).toBe(3);
  });

  test("a profiler with no observed provider session is an honest unknown, not zero or failure", async () => {
    const adapter: TokenUsageAdapter = {
      provider: "codex",
      discover: async () => ({ paths: [] }),
      read: async () => ({ cursorBytes: 0, events: [] }),
    };
    const repo = "/tmp/hive-profiler-unknown-test";
    const store = new TokenUsageStore(new HiveDatabase(":memory:"), [adapter]);
    const session = await store.startSession(repo, at);
    const profiler = store.startProfiler(
      session, "run-x", "profile-run-1", "codex", "gpt-5.6-sol", repo, null, at,
    );
    // The provider session is never observed, so there is nothing to measure.
    const current = (await store.snapshot(repo)).sessions[0]!;
    expect(current.profilingSessions.counts).toBeNull();
    expect(current.profilingSessions.subjectCount).toBe(0);
    expect(current.complete).toBe(false);
    expect(current.unknownSubjects).toEqual(["profile-run-1 (codex)"]);
    expect(current.subjects.find((s) => s.id === profiler)!.reading).toEqual({
      state: "unknown",
      reason: "codex provider session id has not been observed",
    });
  });

  test("a pre-profiler database migrates: profiler rows insert and legacy rows survive", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-token-migrate-test";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const legacyId = "22222222-2222-4222-8222-222222222222";
    // The pre-profiler schema: the old role CHECK, no profileRunId column.
    db.database.exec(`
      CREATE TABLE token_usage_sessions (
        id TEXT PRIMARY KEY, repoRoot TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT
      );
      CREATE TABLE token_usage_subjects (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL REFERENCES token_usage_sessions(id),
        agentId TEXT, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('orchestrator', 'worker')),
        provider TEXT NOT NULL, model TEXT, cwd TEXT NOT NULL, providerSessionId TEXT,
        startedAt TEXT NOT NULL, endedAt TEXT, unknownReason TEXT
      );
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
    db.database.query(
      "INSERT INTO token_usage_sessions (id, repoRoot, startedAt, endedAt) VALUES (?, ?, ?, NULL)",
    ).run(sessionId, repo, at);
    db.database.query(`
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, model, cwd,
        providerSessionId, startedAt, endedAt, unknownReason
      ) VALUES (?, ?, NULL, 'Orchestrator', 'orchestrator', 'codex', NULL, ?, NULL, ?, NULL, NULL)
    `).run(legacyId, sessionId, repo, at);
    // A child event proves the rebuild preserves foreign-key-referenced rows.
    db.database.query(`
      INSERT INTO token_usage_events (
        subjectId, eventKey, cumulative, inputTokens, cachedInputTokens,
        cacheCreationInputTokens, outputTokens, reasoningTokens, observedAt, source
      ) VALUES (?, 'e1', 1, 10, 5, NULL, 2, NULL, ?, 'legacy')
    `).run(legacyId, at);

    // Constructing the store runs the migration.
    const store = new TokenUsageStore(db, []);

    const columns = db.database
      .query("PRAGMA table_info(token_usage_subjects)").all() as { name: string }[];
    expect(columns.some((c) => c.name === "profileRunId")).toBe(true);
    expect(
      db.database.query("SELECT name, role FROM token_usage_subjects WHERE id = ?").get(legacyId),
    ).toEqual({ name: "Orchestrator", role: "orchestrator" });
    expect(
      db.database.query("SELECT COUNT(*) AS n FROM token_usage_events WHERE subjectId = ?").get(legacyId),
    ).toEqual({ n: 1 });
    // A profiler now inserts where the old CHECK would have rejected it.
    const profiler = store.startProfiler(sessionId, "run-1", "profile-run-1", "codex", "gpt-5.6-sol", repo, null, at);
    expect(
      db.database.query("SELECT role, profileRunId FROM token_usage_subjects WHERE id = ?").get(profiler),
    ).toEqual({ role: "profiler", profileRunId: "run-1" });
    // Foreign-key enforcement is restored after the rebuild.
    expect(
      (db.database.query("PRAGMA foreign_keys").all() as { foreign_keys: number }[])[0]!.foreign_keys,
    ).toBe(1);
  });

  test("an unfinished profiler keeps its session live so a later start joins it", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-profiler-reuse-test";
    const store = new TokenUsageStore(db, []);
    // Profiling starts before the orchestrator, when no agent is live.
    const session = await store.startSession(repo, at);
    const profiler = store.startProfiler(session, "run-1", "profile-run-1", "codex", "gpt-5.6-sol", repo, null, at);
    expect(db.listAgents().length).toBe(0);
    // The orchestrator's later startSession must JOIN, not close-and-replace.
    const rejoined = await store.startSession(repo, "2026-07-13T12:05:00.000Z");
    expect(rejoined).toBe(session);
    // Once the profiler finishes and no agent is live, the session is disposable.
    await store.endSubject(profiler, "2026-07-13T12:06:00.000Z");
    const fresh = await store.startSession(repo, "2026-07-13T12:07:00.000Z");
    expect(fresh).not.toBe(session);
  });

  test("startProfiler is idempotent by run: a retry reacquires the same subject, never a duplicate or a throw", async () => {
    const db = new HiveDatabase(":memory:");
    const store = new TokenUsageStore(db, []);
    const repo = "/tmp/hive-profiler-dup-test";
    const session = await store.startSession(repo, at);
    const first = store.startProfiler(session, "run-1", "profile-run-1", "codex", "gpt-5.6-sol", repo, null, at);
    // A retry for the same run — even with different metadata — returns the same
    // durable subject instead of hitting the unique index.
    const second = store.startProfiler(session, "run-1", "profile-run-1-again", "grok", "grok-4.5", repo, null, at);
    expect(second).toBe(first);
    expect(
      db.database.query("SELECT COUNT(*) AS n FROM token_usage_subjects WHERE profileRunId = 'run-1'").get(),
    ).toEqual({ n: 1 });
  });

  test("a profiler subject is reacquirable by run identity so a crash-restart closes the orphan and rotates", async () => {
    const db = new HiveDatabase(":memory:");
    const repo = "/tmp/hive-profiler-recovery-test";
    const store = new TokenUsageStore(db, []);
    const session = await store.startSession(repo, at);
    const subjectId = store.startProfiler(session, "run-1", "profile-run-1", "codex", "gpt-5.6-sol", repo, null, at);
    // While unfinished and with no live agent, the profiler pins its session.
    expect(await store.startSession(repo, "2026-07-13T12:05:00.000Z")).toBe(session);

    // Daemon restart: a fresh store over the same database. The ephemeral
    // subjectId is treated as lost; recovery must find the row by the durable
    // identity (session, runId), not the UUID.
    const restarted = new TokenUsageStore(db, []);
    const recovered = restarted.profilerSubjectId(session, "run-1");
    expect(recovered).toBe(subjectId);
    // Retrying the SAME run reacquires rather than throwing on the unique index.
    expect(restarted.startProfiler(session, "run-1", "profile-run-1", "codex", "gpt-5.6-sol", repo, null, at))
      .toBe(subjectId);

    // Positive terminal evidence closes the orphan, and the session can rotate.
    await restarted.endSubject(recovered!, "2026-07-13T12:06:00.000Z");
    const fresh = await restarted.startSession(repo, "2026-07-13T12:07:00.000Z");
    expect(fresh).not.toBe(session);
  });
});
