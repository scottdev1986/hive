import { afterEach, describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { StatusService } from "../../src/daemon/status-service/status-projection-service";
import { EpisodicStore } from "../../src/memory-service/episodic";
import {
  DEFAULT_CLASS_BUDGETS,
  type MemoryQueryDeps,
  runMemoryQuery,
} from "../../src/memory-service/query";
import { TokenUsageStore } from "../../src/usage-service/token-usage";
import { required } from "../required";
import type { JsonObject } from "../../src/shared/json";

const T0 = "2026-07-22T10:00:00.000Z";
const T1 = "2026-07-22T11:00:00.000Z";
const T2 = "2026-07-22T11:30:00.000Z";
const T3 = "2026-07-22T11:40:00.000Z";
const NOW = new Date("2026-07-22T11:45:00.000Z");

const dbs: HiveDatabase[] = [];
const stores: EpisodicStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of dbs.splice(0)) db.close();
});

function harness(options: { episodic?: boolean } = {}) {
  const db = new HiveDatabase(":memory:");
  dbs.push(db);
  const status = StatusService.create(db, "inst-test");
  const tokenUsage = new TokenUsageStore(db);
  const episodic =
    options.episodic === false ? null : track(new EpisodicStore(":memory:"));
  const deps: MemoryQueryDeps = {
    episodic,
    status,
    tokenUsage,
    memory: null,
    repoRoot: null,
    resolveAgentId: (name) =>
      name.startsWith("agent-") ? name : `agent-${name}`,
  };
  return { db, status, tokenUsage, episodic, deps };
}

function track<T extends EpisodicStore>(store: T): T {
  stores.push(store);
  return store;
}

let requestCounter = 0;

function report(
  status: StatusService,
  agentId: string,
  input: {
    phase: "implementing" | "blocked" | "complete";
    summary: string;
    blocker?: string | null;
    at: string;
  },
) {
  const assignment =
    status.currentAssignment(agentId) ?? status.openAssignment(agentId, T0);
  requestCounter += 1;
  return status.appendAgentReport(
    {
      subject: agentId,
      agentId,
      role: "writer",
      incarnationGeneration: 1,
      capabilityEpoch: 0,
      toolSessionId: null,
    },
    {
      requestId: `req_018f1e90-7b5a-7cc0-8000-${String(requestCounter).padStart(
        12,
        "0",
      )}`,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: assignment.assignmentGeneration,
      phase: input.phase,
      summary: input.summary,
      blocker: input.blocker ?? null,
      evidenceRefs: [],
      freshForSeconds: 600,
    },
    new Date(input.at),
  );
}

describe("L0 projections", () => {
  test("agent-now returns the fused report with source/freshness/asOf labels", async () => {
    const { status, deps } = harness();
    report(status, "agent-maya", {
      phase: "implementing",
      summary: "Halfway through WP2",
      at: T3,
    });
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "agent-now",
        agent: "maya",
      },
      NOW,
    );
    expect(result.state).toBe("ok");
    expect(result.truncated).toBe(false);
    expect(result.budget).toBe(DEFAULT_CLASS_BUDGETS["agent-now"]);
    // SAFETY: The test owns this value and its fields.
    const row = result.results[0] as JsonObject;
    expect(row).toMatchObject({
      agent: "agent-maya",
      phase: "implementing",
      summary: "Halfway through WP2",
      blocker: null,
      asOf: T3,
      freshness: "fresh",
      confidence: "authoritative",
    });
    expect(String(row.source)).toContain("agent-report");
    expect(result.asOf).toBe(T3);
  });

  test("agent-now falls back to the latest episodic event when no report exists", async () => {
    const { episodic, deps } = harness();
    required(episodic).appendEvent({
      ts: T3,
      agent: "agent-lena",
      type: "agent.status-reported",
      summary: "Rebased the stack",
    });
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "agent-now",
        agent: "lena",
      },
      NOW,
    );
    expect(result.state).toBe("ok");
    // SAFETY: The test owns this value and its fields.
    const row = result.results[0] as JsonObject;
    expect(row).toMatchObject({
      agent: "agent-lena",
      summary: "Rebased the stack",
      source: "episodic",
      freshness: "fresh",
      asOf: T3,
    });
  });

  test("fleet-summary folds every known agent and counts the blocked ones", async () => {
    const { status, deps } = harness();
    report(status, "agent-maya", {
      phase: "implementing",
      summary: "Working",
      at: T1,
    });
    report(status, "agent-lena", {
      phase: "blocked",
      summary: "Needs the API key",
      blocker: "No API key",
      at: T2,
    });
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "fleet-summary",
      },
      NOW,
    );
    expect(result.state).toBe("ok");
    // SAFETY: The test owns this value and its fields.
    const summary = result.results[0] as {
      agents: number;
      blocked: number;
      rows: Array<{ agent: string }>;
    };
    expect(summary.agents).toBe(2);
    expect(summary.blocked).toBe(1);
    expect(summary.rows.map((row) => row.agent).sort()).toEqual([
      "agent-lena",
      "agent-maya",
    ]);
  });

  test("what-landed returns landing/completion events newest-first with since filter", async () => {
    const { episodic, deps } = harness();
    required(episodic).appendEvent({
      ts: T0,
      agent: "agent-maya",
      type: "agent.landed",
      summary: "WP1 landed",
    });
    required(episodic).appendEvent({
      ts: T1,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "Still going",
    });
    required(episodic).appendEvent({
      ts: T2,
      agent: "agent-lena",
      type: "task.completed",
      summary: "WP2 done",
    });
    const all = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "what-landed",
      },
      NOW,
    );
    expect(all.state).toBe("ok");
    expect(
      // SAFETY: The test owns this value and its fields.
      (all.results as Array<{ summary: string }>).map((row) => row.summary),
    ).toEqual(["WP2 done", "WP1 landed"]);

    const since = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "what-landed",
        since: T2,
      },
      NOW,
    );
    expect(
      // SAFETY: The test owns this value and its fields.
      (since.results as Array<{ summary: string }>).map((row) => row.summary),
    ).toEqual(["WP2 done"]);
  });

  test("who-blocked lists only agents whose latest state is blocked/waiting", async () => {
    const { status, deps } = harness();
    report(status, "agent-maya", {
      phase: "implementing",
      summary: "Working",
      at: T1,
    });
    report(status, "agent-lena", {
      phase: "blocked",
      summary: "Waiting on quota reset",
      blocker: "Quota exhausted",
      at: T2,
    });
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "who-blocked",
      },
      NOW,
    );
    expect(result.state).toBe("ok");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      agent: "agent-lena",
      blocker: "Quota exhausted",
    });
  });

  test("token-spend totals come from the token usage store, filterable by agent and since", async () => {
    const { db, deps } = harness();
    const sessionId = crypto.randomUUID();
    db.database
      .query(
        `
      INSERT INTO token_usage_sessions (id, repoRoot, startedAt)
      VALUES (?, '/repo', ?)
    `,
      )
      .run(sessionId, T0);
    const subjectA = crypto.randomUUID();
    const subjectB = crypto.randomUUID();
    db.database
      .query(
        `
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, cwd, startedAt
      ) VALUES (?, ?, 'agent-maya', 'maya', 'worker', 'claude', '/repo', ?)
    `,
      )
      .run(subjectA, sessionId, T0);
    db.database
      .query(
        `
      INSERT INTO token_usage_subjects (
        id, sessionId, agentId, name, role, provider, cwd, startedAt
      ) VALUES (?, ?, 'agent-lena', 'lena', 'worker', 'codex', '/repo', ?)
    `,
      )
      .run(subjectB, sessionId, T0);
    db.database
      .query(
        `
      INSERT INTO token_usage_events (
        subjectId, eventKey, inputTokens, outputTokens, observedAt, source
      ) VALUES (?, 'm1', 1000, 250, ?, 'claude-transcript')
    `,
      )
      .run(subjectA, T1);
    db.database
      .query(
        `
      INSERT INTO token_usage_events (
        subjectId, eventKey, inputTokens, outputTokens, observedAt, source
      ) VALUES (?, 'm2', 2000, 500, ?, 'claude-transcript')
    `,
      )
      .run(subjectA, T2);
    db.database
      .query(
        `
      INSERT INTO token_usage_events (
        subjectId, eventKey, inputTokens, outputTokens, observedAt, source
      ) VALUES (?, 'm1', 5000, 100, ?, 'codex-rollout')
    `,
      )
      .run(subjectB, T2);

    const all = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "token-spend",
      },
      NOW,
    );
    expect(all.state).toBe("ok");
    // SAFETY: The test owns this value and its fields.
    const rows = all.results as Array<{
      agentId: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      source: string;
    }>;
    expect(rows).toHaveLength(2);
    const maya = required(rows.find((row) => row.agentId === "agent-maya"));
    expect(maya).toMatchObject({
      inputTokens: 3000,
      outputTokens: 750,
      totalTokens: 3750,
      source: "token-usage",
    });

    const filtered = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "token-spend",
        agent: "lena",
        since: T2,
      },
      NOW,
    );
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]).toMatchObject({
      agentId: "agent-lena",
      totalTokens: 5100,
    });
  });
});

describe("L1 point search", () => {
  test("finds bounded excerpts across episodic events", async () => {
    const { episodic, deps } = harness();
    required(episodic).appendEvent({
      ts: T1,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "Touched the quota tables during the rebase",
    });
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "point-search",
        query: "quota",
      },
      NOW,
    );
    expect(result.state).toBe("ok");
    // SAFETY: The test owns this value and its fields.
    const kinds = (result.results as Array<{ kind: string }>)
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["event"]);
    // SAFETY: The test owns this value and its fields.
    for (const row of result.results as Array<{ snippet: string }>) {
      expect(row.snippet.toLowerCase()).toContain("quota");
    }
  });

  // Two events that between them cover every query token, neither of which
  // covers all of them — the shape an ordinary multi-word question meets.
  function seedPartialOverlapHistory(episodic: EpisodicStore): void {
    episodic.appendEvent({
      ts: T1,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "The quota tables were touched during a long migration",
    });
    episodic.appendEvent({
      ts: T1,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "Rebase dropped a commit and nobody noticed for an hour",
    });
  }

  test("a multi-word question no single event covers in full still returns its parts", async () => {
    const { episodic, deps } = harness();
    seedPartialOverlapHistory(required(episodic));
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      { class: "point-search", query: "quota rebase commit" },
      NOW,
    );
    expect(result.state).toBe("ok");
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("a single-word question still returns the event carrying it", async () => {
    const { episodic, deps } = harness();
    seedPartialOverlapHistory(required(episodic));
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      { class: "point-search", query: "quota" },
      NOW,
    );
    expect(result.results).toHaveLength(1);
  });
});

describe("token ceilings", () => {
  test("an over-budget result is truncated with loud in-band markers", async () => {
    const { episodic, deps } = harness();
    for (let index = 0; index < 20; index += 1) {
      required(episodic).appendEvent({
        ts: T1,
        agent: "agent-maya",
        type: "agent.status-reported",
        summary: `Progress note ${index}: ${"x".repeat(380)}`,
      });
    }
    const result = await runMemoryQuery(
      deps,
      { subject: "maya" },
      {
        class: "my-history",
      },
      NOW,
    );
    expect(result.state).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.omitted + result.results.length).toBe(20);
    expect(result.tokens).toBeLessThanOrEqual(result.budget);
  });

  test("a caller budget larger than the ceiling is clamped; a lower one is honored", async () => {
    const { episodic, deps } = harness();
    for (let index = 0; index < 10; index += 1) {
      required(episodic).appendEvent({
        ts: T1,
        agent: "agent-maya",
        type: "agent.status-reported",
        summary: `Note ${index} ${"y".repeat(200)}`,
      });
    }
    const inflated = await runMemoryQuery(
      deps,
      { subject: "maya" },
      {
        class: "my-history",
        budget: 99_999,
      },
      NOW,
    );
    expect(inflated.budget).toBe(DEFAULT_CLASS_BUDGETS["my-history"]);

    const lowered = await runMemoryQuery(
      deps,
      { subject: "maya" },
      {
        class: "my-history",
        budget: 120,
      },
      NOW,
    );
    expect(lowered.budget).toBe(120);
    expect(lowered.tokens).toBeLessThanOrEqual(120);
    expect(lowered.truncated).toBe(true);
  });
});

describe("identity scoping", () => {
  test("my-history derives the agent from the caller subject and ignores input.agent", async () => {
    const { episodic, deps } = harness();
    required(episodic).appendEvent({
      ts: T1,
      agent: "agent-maya",
      type: "agent.status-reported",
      summary: "Maya's own note",
    });
    required(episodic).appendEvent({
      ts: T2,
      agent: "agent-lena",
      type: "agent.status-reported",
      summary: "Lena's own note",
    });
    const maya = await runMemoryQuery(
      deps,
      { subject: "maya" },
      {
        class: "my-history",
        // Hostile input: tries to read someone else's history.
        agent: "lena",
      },
      NOW,
    );
    expect(maya.results).toHaveLength(1);
    expect(maya.results[0]).toMatchObject({
      agent: "agent-maya",
      summary: "Maya's own note",
    });

    const lena = await runMemoryQuery(
      deps,
      { subject: "lena" },
      {
        class: "my-history",
        agent: "maya",
      },
      NOW,
    );
    expect(lena.results).toHaveLength(1);
    expect(lena.results[0]).toMatchObject({
      agent: "agent-lena",
      summary: "Lena's own note",
    });
  });
});

describe("absent-vs-empty discipline", () => {
  test("a class whose surface is not built reports absent, not empty", async () => {
    const { deps } = harness({ episodic: false });
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "agent-history",
        agent: "maya",
      },
      NOW,
    );
    expect(result.state).toBe("absent");
    expect(result.detail).toContain("episodic");
    expect(result.results).toEqual([]);
  });

  test("a built surface with no matches reports empty with a reason", async () => {
    const { deps } = harness();
    const history = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "agent-history",
        agent: "maya",
      },
      NOW,
    );
    expect(history.state).toBe("empty");
    expect(history.detail).toContain("maya");

    const search = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "point-search",
        query: "anything",
      },
      NOW,
    );
    expect(search.state).toBe("empty");

    const spend = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "token-spend",
      },
      NOW,
    );
    expect(spend.state).toBe("empty");
  });

  test("pitfall-check with no wiki surface is absent", async () => {
    const { deps } = harness();
    const result = await runMemoryQuery(
      deps,
      { subject: "user" },
      {
        class: "pitfall-check",
        query: "rebase",
      },
      NOW,
    );
    expect(result.state).toBe("absent");
  });
});

describe("input validation", () => {
  test("classes requiring agent or query fail loudly when they are missing", async () => {
    const { deps } = harness();
    await expect(
      runMemoryQuery(
        deps,
        { subject: "user" },
        {
          class: "agent-now",
        },
        NOW,
      ),
    ).rejects.toThrow("agent");
    await expect(
      runMemoryQuery(
        deps,
        { subject: "user" },
        {
          class: "point-search",
        },
        NOW,
      ),
    ).rejects.toThrow("query");
    await expect(
      runMemoryQuery(
        deps,
        { subject: "user" },
        {
          class: "pitfall-check",
        },
        NOW,
      ),
    ).rejects.toThrow("query");
  });
});
