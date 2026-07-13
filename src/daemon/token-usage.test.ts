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
      channelsEnabled: false,
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
});
