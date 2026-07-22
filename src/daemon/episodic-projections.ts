// The read side of the per-project episodic store (HiveMemory HM-1 WP2):
// L0 typed projections over the daemon's status/token/episodic stores, an L1
// bounded-excerpt FTS index over episodic events + facts, and the
// `memory_query` class dispatcher every MCP caller goes through.
//
// Every projection is a maintained query — SQL or a left-fold over rows the
// stores already hold; no LLM, no ranking, no journal scans. Each row carries
// its own source/freshness labels and an `asOf` anchor, per the S3.6 sketch.
//
// Two disciplines are enforced here, not in the transport:
//  - Token ceilings: every class has a server-side default budget; a caller
//    `budget` can only lower it. Over-budget results are cut with loud
//    in-band markers (`truncated: true, omitted: N`).
//  - Absent-vs-empty: every class distinguishes "the surface is not built"
//    (no episodic store, no wiki) from "the surface exists and has no
//    matches" via the envelope `state` discriminator.
import { Database } from "bun:sqlite";
import { z } from "zod";
import { listMemoryFacts } from "../adapters/memory";
import type { EpisodicStore } from "./episodic-store";
import type { MemoryIndex } from "./memory-index";
import type { StatusStore } from "./status-store";
import { fuseAgentStatus, type StatusFreshness } from "./status-fusion";
import type { TokenUsageStore } from "./token-usage";

export const MEMORY_QUERY_CLASSES = [
  "agent-now",
  "agent-history",
  "fleet-summary",
  "what-landed",
  "who-blocked",
  "token-spend",
  "point-search",
  "my-history",
  "pitfall-check",
] as const;
export const MemoryQueryClassSchema = z.enum(MEMORY_QUERY_CLASSES);
export type MemoryQueryClass = z.infer<typeof MemoryQueryClassSchema>;

export const MemoryQueryInputSchema = z.object({
  class: MemoryQueryClassSchema,
  /** Agent NAME for agent-now/agent-history/token-spend. Ignored by
   * my-history, which always scopes to the caller's own identity. There is
   * deliberately no project parameter: the query runs against the daemon's
   * own project store and nothing else. */
  agent: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  /** May only lower the class's server-enforced ceiling; larger values are
   * clamped to the default. */
  budget: z.number().int().positive().optional(),
});
export type MemoryQueryInput = z.infer<typeof MemoryQueryInputSchema>;

/** Server-enforced per-class token ceilings. Chars/4 estimation — the same
 * order as graphify's token_budget accounting, deterministic in tests. */
export const DEFAULT_CLASS_BUDGETS: Record<MemoryQueryClass, number> = {
  "agent-now": 400,
  "agent-history": 800,
  "fleet-summary": 1200,
  "what-landed": 800,
  "who-blocked": 600,
  "token-spend": 600,
  "point-search": 1000,
  "my-history": 800,
  "pitfall-check": 600,
};

export const estimateTokens = (value: unknown): number =>
  Math.max(1, Math.ceil(JSON.stringify(value).length / 4));

export interface MemoryQueryEnvelope {
  class: MemoryQueryClass;
  /** ok = matches returned; empty = surface built, zero matches; absent =
   * the surface this class reads is not built (store/wiki not present). */
  state: "ok" | "empty" | "absent";
  /** Why the state is empty/absent; null on ok. */
  detail: string | null;
  /** The ceiling actually enforced (after clamping any caller budget). */
  budget: number;
  /** Estimated tokens of the returned rows. */
  tokens: number;
  truncated: boolean;
  omitted: number;
  /** Freshness anchor: the newest observation behind these rows. */
  asOf: string | null;
  /** Which stores these rows were projected from. */
  source: string[];
  results: unknown[];
}

export interface MemoryQueryDeps {
  episodic: EpisodicStore | null;
  status: StatusStore | null;
  tokenUsage: TokenUsageStore | null;
  memory: MemoryIndex | null;
  repoRoot: string | null;
  /** Maps a caller-visible agent name to the daemon's agent id; null when
   * the name is not a known agent. */
  resolveAgentId: (name: string) => string | null;
}

const BLOCKED_PATTERN = /blocked|waiting|stuck/i;
const LANDED_PATTERN = /land|complete/i;

const ageFreshness = (observedAt: string, now: Date): StatusFreshness =>
  now.getTime() - Date.parse(observedAt) <= 15 * 60 * 1_000
    ? "fresh"
    : "stale";

// ---------------------------------------------------------------------------
// L1 — bounded-excerpt point search over episodic events + facts.
// A disposable in-memory FTS5 index, rebuilt on open and whenever a write
// moved the store's row counts (the same disposable-index discipline as
// memory-index.ts: the stores are authoritative, this is reproducible).
// ---------------------------------------------------------------------------
export class EpisodicSearchIndex {
  private readonly database: Database;
  private indexed = { events: -1, facts: -1 };

  constructor() {
    this.database = new Database(":memory:");
    this.database.exec(`
      CREATE VIRTUAL TABLE episodic_fts USING fts5(
        kind UNINDEXED, ref UNINDEXED, agent UNINDEXED, ts UNINDEXED, text,
        tokenize = 'porter'
      )
    `);
  }

  /** Rebuild when the store moved. Count-keyed: appends and new facts are
   * caught; a bare invalidation leaves the old fact searchable until the
   * next write, which point search tolerates (results name their source). */
  sync(store: EpisodicStore): void {
    const counts = store.rowCounts();
    if (
      counts.events === this.indexed.events && counts.facts === this.indexed.facts
    ) return;
    const events = store.eventsFor();
    const facts = store.currentFacts();
    this.database.transaction(() => {
      this.database.exec("DELETE FROM episodic_fts");
      const insert = this.database.query(`
        INSERT INTO episodic_fts (kind, ref, agent, ts, text)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        insert.run(
          "event",
          String(event.id),
          event.agent,
          event.ts,
          `${event.type} ${event.summary}`,
        );
      }
      for (const fact of facts) {
        insert.run(
          "fact",
          fact.id,
          null,
          fact.validAt,
          `${fact.topic} ${fact.title} ${fact.body}`,
        );
      }
    })();
    this.indexed = counts;
  }

  search(
    query: string,
    filter: { agent?: string; since?: string; limit?: number } = {},
  ): Array<{
    kind: "event" | "fact";
    ref: string;
    agent: string | null;
    ts: string;
    snippet: string;
    source: string;
    asOf: string;
  }> {
    const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((token) => `"${token}"`).join(" AND ");
    const clauses = ["episodic_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];
    if (filter.agent !== undefined) {
      clauses.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(filter.since);
    }
    params.push(filter.limit ?? 25);
    const rows = this.database.query(`
      SELECT kind, ref, agent, ts,
        snippet(episodic_fts, 4, '[', ']', '…', 12) AS snippet
      FROM episodic_fts
      WHERE ${clauses.join(" AND ")}
      ORDER BY rank LIMIT ?
    `).all(...params);
    return z.object({
      kind: z.enum(["event", "fact"]),
      ref: z.string(),
      agent: z.string().nullable(),
      ts: z.string(),
      snippet: z.string(),
    }).array().parse(rows).map((row) => ({
      ...row,
      source: "episodic-fts",
      asOf: row.ts,
    }));
  }
}

// ---------------------------------------------------------------------------
// L0 projections.
// ---------------------------------------------------------------------------
interface AgentNowRow {
  agent: string;
  phase: string | null;
  summary: string | null;
  blocker: string | null;
  turnState: string | null;
  attention: string | null;
  asOf: string;
  freshness: StatusFreshness;
  confidence: string;
  source: string;
}

/** The "what is X doing now" fold: the fused status report when the status
 * store has one, the latest episodic event otherwise. Returns null when no
 * surface knows the agent. */
function agentNow(
  deps: Pick<MemoryQueryDeps, "episodic" | "status">,
  agentId: string,
  now: Date,
): { row: AgentNowRow; blocked: boolean } | null {
  const fused = deps.status === null
    ? null
    : (() => {
        const events = deps.status.listEventsForAgent(agentId);
        return events.length === 0
          ? null
          : fuseAgentStatus(
            deps.status.listEvents(),
            { agentId, incarnationGeneration: null },
            now,
          );
      })();
  const latest = deps.episodic?.eventsFor({ agent: agentId }).at(-1) ?? null;
  const report = fused?.report ?? null;
  if (report === null && latest === null && fused === null) return null;
  const turnState = fused?.turnState?.value ?? null;
  const row: AgentNowRow = {
    agent: agentId,
    phase: report?.phase ?? null,
    summary: report?.summary ?? latest?.summary ?? null,
    blocker: report?.blocker ?? null,
    turnState,
    attention: fused?.attention?.value ?? null,
    asOf: report?.observedAt ?? latest?.ts ?? now.toISOString(),
    freshness: report?.freshness ??
      (latest === null ? "unknown" : ageFreshness(latest.ts, now)),
    confidence: report?.confidence ?? "low",
    source: report === null
      ? "episodic"
      : `status:${report.source.kind}`,
  };
  const blocked = report !== null
    ? report.blocker !== null || report.phase === "blocked"
    : turnState === "stuck" ||
      (latest !== null &&
        BLOCKED_PATTERN.test(`${latest.type} ${latest.summary}`));
  return { row, blocked };
}

function fleetAgents(
  deps: Pick<MemoryQueryDeps, "episodic" | "status">,
): string[] {
  const agents = new Set<string>();
  if (deps.status !== null) {
    for (const event of deps.status.listEvents()) {
      const agentId = event.entity.kind === "agent"
        ? event.entity.id
        : typeof event.data.agentId === "string"
        ? event.data.agentId
        : null;
      if (agentId !== null) agents.add(agentId);
    }
  }
  if (deps.episodic !== null) {
    for (const event of deps.episodic.eventsFor()) {
      if (event.agent !== null) agents.add(event.agent);
    }
  }
  return [...agents].sort();
}

// ---------------------------------------------------------------------------
// Class dispatch.
// ---------------------------------------------------------------------------
interface ClassOutcome {
  state: "ok" | "empty" | "absent";
  detail: string | null;
  rows: unknown[];
  asOf: string | null;
  source: string[];
}

const absent = (detail: string, source: string[]): ClassOutcome => ({
  state: "absent",
  detail,
  rows: [],
  asOf: null,
  source,
});

const finish = (
  rows: Array<Record<string, unknown>>,
  emptyDetail: string,
  source: string[],
): ClassOutcome => ({
  state: rows.length === 0 ? "empty" : "ok",
  detail: rows.length === 0 ? emptyDetail : null,
  rows,
  asOf: rows.reduce<string | null>(
    (latest, row) => {
      const asOf = typeof row.asOf === "string" ? row.asOf : null;
      return asOf !== null && (latest === null || asOf > latest)
        ? asOf
        : latest;
    },
    null,
  ),
  source,
});

async function runClass(
  deps: MemoryQueryDeps,
  caller: { subject: string },
  input: MemoryQueryInput,
  now: Date,
): Promise<ClassOutcome> {
  const episodicSurface = ["episodic", "status"] as const;
  switch (input.class) {
    case "agent-now": {
      if (input.agent === undefined) {
        throw new Error("memory_query class agent-now requires 'agent'");
      }
      if (deps.episodic === null && deps.status === null) {
        return absent(
          "episodic and status stores are not open on this daemon",
          [...episodicSurface],
        );
      }
      const agentId = deps.resolveAgentId(input.agent) ?? input.agent;
      const now2 = agentNow(deps, agentId, now);
      return finish(
        now2 === null ? [] : [now2.row as unknown as Record<string, unknown>],
        `no status or episodic rows for agent ${input.agent}`,
        [...episodicSurface],
      );
    }
    case "agent-history": {
      if (input.agent === undefined) {
        throw new Error("memory_query class agent-history requires 'agent'");
      }
      if (deps.episodic === null) {
        return absent("episodic store is not open on this daemon", ["episodic"]);
      }
      const agentId = deps.resolveAgentId(input.agent) ?? input.agent;
      const events = deps.episodic.eventsFor({
        agent: agentId,
        ...(input.since === undefined ? {} : { since: input.since }),
      });
      const rows = [...events].reverse().map((event) => ({
        ts: event.ts,
        agent: event.agent,
        type: event.type,
        summary: event.summary,
        source: "episodic",
        asOf: event.ts,
      }));
      return finish(rows, `no episodic events for agent ${input.agent}`, [
        "episodic",
      ]);
    }
    case "my-history": {
      // Identity comes from the caller's capability subject, never from the
      // input: an `agent` field in the request is ignored on purpose.
      if (deps.episodic === null) {
        return absent("episodic store is not open on this daemon", ["episodic"]);
      }
      const agentId = deps.resolveAgentId(caller.subject) ?? caller.subject;
      const events = deps.episodic.eventsFor({
        agent: agentId,
        ...(input.since === undefined ? {} : { since: input.since }),
      });
      const rows = [...events].reverse().map((event) => ({
        ts: event.ts,
        agent: event.agent,
        type: event.type,
        summary: event.summary,
        source: "episodic",
        asOf: event.ts,
      }));
      return finish(rows, `no episodic events for caller ${caller.subject}`, [
        "episodic",
      ]);
    }
    case "fleet-summary": {
      if (deps.episodic === null && deps.status === null) {
        return absent(
          "episodic and status stores are not open on this daemon",
          [...episodicSurface],
        );
      }
      const agents = fleetAgents(deps);
      const rows: Array<Record<string, unknown>> = [];
      let blockedCount = 0;
      for (const agentId of agents) {
        const now2 = agentNow(deps, agentId, now);
        if (now2 === null) continue;
        if (now2.blocked) blockedCount += 1;
        rows.push(now2.row as unknown as Record<string, unknown>);
      }
      return finish(
        rows.length === 0
          ? []
          : [{
            agents: rows.length,
            blocked: blockedCount,
            rows,
            source: "status+episodic",
            asOf: now.toISOString(),
          }],
        "no agents have reported anything yet",
        [...episodicSurface],
      );
    }
    case "what-landed": {
      if (deps.episodic === null) {
        return absent("episodic store is not open on this daemon", ["episodic"]);
      }
      const events = deps.episodic.eventsFor(
        input.since === undefined ? {} : { since: input.since },
      );
      const rows = events
        .filter((event) => LANDED_PATTERN.test(event.type))
        .reverse()
        .map((event) => ({
          ts: event.ts,
          agent: event.agent,
          type: event.type,
          summary: event.summary,
          source: "episodic",
          asOf: event.ts,
        }));
      return finish(rows, "no landing or completion events recorded", [
        "episodic",
      ]);
    }
    case "who-blocked": {
      if (deps.episodic === null && deps.status === null) {
        return absent(
          "episodic and status stores are not open on this daemon",
          [...episodicSurface],
        );
      }
      const rows: Array<Record<string, unknown>> = [];
      for (const agentId of fleetAgents(deps)) {
        const now2 = agentNow(deps, agentId, now);
        if (now2?.blocked === true) {
          rows.push(now2.row as unknown as Record<string, unknown>);
        }
      }
      return finish(rows, "no agent's latest state is blocked or waiting", [
        ...episodicSurface,
      ]);
    }
    case "token-spend": {
      if (deps.tokenUsage === null) {
        return absent("token usage store is not open on this daemon", [
          "token-usage",
        ]);
      }
      const agentId = input.agent === undefined
        ? undefined
        : deps.resolveAgentId(input.agent) ?? input.agent;
      const rows = deps.tokenUsage.spendTotals({
        ...(agentId === undefined ? {} : { agentId }),
        ...(input.since === undefined ? {} : { since: input.since }),
      }).map((row) => ({
        ...row,
        source: "token-usage",
        asOf: row.lastObservedAt ?? now.toISOString(),
      }));
      return finish(rows, "no measured token usage recorded", ["token-usage"]);
    }
    case "point-search": {
      if (input.query === undefined) {
        throw new Error("memory_query class point-search requires 'query'");
      }
      if (deps.episodic === null) {
        return absent("episodic store is not open on this daemon", ["episodic"]);
      }
      const index = indexFor(deps.episodic);
      index.sync(deps.episodic);
      const rows = index.search(input.query, {
        ...(input.agent === undefined
          ? {}
          : { agent: deps.resolveAgentId(input.agent) ?? input.agent }),
        ...(input.since === undefined ? {} : { since: input.since }),
      });
      return finish(
        rows.map((row) => ({ ...row }) as Record<string, unknown>),
        `no episodic events or facts match "${input.query}"`,
        ["episodic-fts"],
      );
    }
    case "pitfall-check": {
      if (input.query === undefined) {
        throw new Error("memory_query class pitfall-check requires 'query'");
      }
      if (deps.memory === null || deps.repoRoot === null) {
        return absent("memory wiki surface is not available on this daemon", [
          "wiki",
        ]);
      }
      const facts = await listMemoryFacts(deps.repoRoot);
      if (facts.length === 0) {
        return absent("no memory wiki articles exist yet", ["wiki"]);
      }
      const pitfalls = new Set(
        facts.filter((fact) => fact.kind === "pitfall").map((fact) =>
          `${fact.scope}:${fact.id}`
        ),
      );
      const rows = deps.memory.search(input.query, { limit: 8 })
        .filter((hit) => pitfalls.has(`${hit.scope}:${hit.id}`))
        .map((hit) => ({
          scope: hit.scope,
          id: hit.id,
          title: hit.title,
          status: hit.status,
          snippet: hit.snippet,
          source: "wiki",
          asOf: hit.date,
        }));
      return finish(rows, `no pitfall articles match "${input.query}"`, [
        "wiki",
      ]);
    }
  }
}

/** The `memory_query` entry point: runs the declared class against the
 * daemon's own stores and enforces the class's token ceiling. Caller's
 * identity (`caller.subject`) is the only scoping input for my-history. */
export async function runMemoryQuery(
  deps: MemoryQueryDeps,
  caller: { subject: string },
  rawInput: MemoryQueryInput,
  now = new Date(),
): Promise<MemoryQueryEnvelope> {
  const input = MemoryQueryInputSchema.parse(rawInput);
  const ceiling = DEFAULT_CLASS_BUDGETS[input.class];
  const budget = Math.min(input.budget ?? ceiling, ceiling);
  const outcome = await runClass(deps, caller, input, now);
  const kept: unknown[] = [];
  let tokens = 0;
  for (const row of outcome.rows) {
    const cost = estimateTokens(row);
    if (tokens + cost > budget) break;
    kept.push(row);
    tokens += cost;
  }
  return {
    class: input.class,
    state: outcome.state,
    detail: outcome.detail,
    budget,
    tokens,
    truncated: kept.length < outcome.rows.length,
    omitted: outcome.rows.length - kept.length,
    asOf: outcome.asOf,
    source: outcome.source,
    results: kept,
  };
}

// The L1 index is disposable per-store state: rebuilt from the project store
// whenever its row counts move, so each store gets exactly one index instance
// and two same-sized stores can never share rows.
const INDEXES = new WeakMap<EpisodicStore, EpisodicSearchIndex>();

function indexFor(store: EpisodicStore): EpisodicSearchIndex {
  const existing = INDEXES.get(store);
  if (existing !== undefined) return existing;
  const created = new EpisodicSearchIndex();
  INDEXES.set(store, created);
  return created;
}
