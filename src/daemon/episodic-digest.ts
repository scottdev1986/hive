// Session digests — the L2 layer of the per-project episodic store
// (HiveMemory HM-2 WP4, board #72; planning/story-m3-s37-digests-lifecycle.md
// DoD 1-3, 9-11).
//
// DESIGN DECISION (ratified before this WP started, recorded here so later
// readers do not reopen it): the digest compiler is DETERMINISTIC and
// STRUCTURED — a pure fold over typed episodic records — not an LLM
// summarizer. The local 7-8B distiller of S3.7 DoD 8 stays a measured,
// gated upgrade (plan D-note: the distiller AC is exercised only when its
// floor-machine numbers exist). A deterministic fold is the stronger choice
// on the two axes this layer lives or dies by: provenance (every line is
// emitted from the row it cites, never "recalled") and drift-audit (the
// audit below is recompute-and-compare, which only works because
// compilation has no sampling noise). It also satisfies the "fresh
// summarizer, never the session's own agent, never on the hot path" rule
// trivially: the compiler is daemon code running at lifecycle boundaries.
//
// The digest is a navigation aid labeled hint-not-authority: every
// load-bearing line carries its [eN] event-id pointer, and exact values
// (SHAs, paths, error strings, exit codes) are extracted into a typed side
// table because prose provably drops them (S3.7 DoD 3). Persisted
// provenance is `{ eventIds: [...], sessionId, agent }` — the shape the WP3
// retention reference-check recognizes, so a digest pins its drill-down
// rows against the hot-tier sweep.
import { z } from "zod";
import { estimateTokens } from "./episodic-projections";
import type { EpisodicDigest, EpisodicEvent, EpisodicStore } from "./episodic-store";

/** Same landing/completion classification as the what-landed query class. */
const OUTCOME_PATTERN = /land|complete/i;
/** Failure rows feed the WP5 mistake harvester; keep the pattern deliberate. */
const FAILURE_PATTERN = /error|fail|blocked|kill/i;

// Bounds: a digest answers "catch me up" at O(hundreds of tokens), so the
// timeline is the activity boundaries (oldest + newest), not the full log.
const TIMELINE_HEAD = 3;
const TIMELINE_TAIL = 7;
const OPEN_THREADS_MAX = 5;
const EXACT_VALUES_MAX = 24;
const SUMMARY_MAX = 240;

/** Server-enforced token ceiling for `memory_digest`; a caller `budget` may
 * only lower it (clamp-only, same discipline as memory_query classes). */
export const MEMORY_DIGEST_DEFAULT_BUDGET = 1200;

export const MemoryDigestInputSchema = z.object({
  /** Agent NAME (resolved through the daemon registry) — the digest read is
   * scoped to the daemon's own project store; there is no project param. */
  agent: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  digestId: z.number().int().positive().optional(),
  /** Drill-down: also return the exact source event row(s) behind this
   * event-id pointer — the hint-to-authority path (S3.7 DoD 10). */
  eventId: z.number().int().positive().optional(),
  /** May only lower the server-enforced ceiling. */
  budget: z.number().int().positive().optional(),
});
export type MemoryDigestInput = z.infer<typeof MemoryDigestInputSchema>;

/** A landing/completion workspace event is a digest activity boundary
 * (S3.7 DoD 2): the daemon re-synthesizes the agent's rolling digest when
 * the ingested event kind says so, or a status report declares the work
 * complete. */
export function isDigestBoundaryEvent(
  kind: string,
  data: Record<string, unknown>,
): boolean {
  return OUTCOME_PATTERN.test(kind) || data.phase === "complete";
}

interface ExactValue {
  kind: "sha256" | "sha" | "path" | "exit-code" | "error" | "count";
  value: string;
  eventId: number;
}
export type { ExactValue };

// Exact-value extraction (S3.7 DoD 3): SHAs, file paths, error strings,
// exit codes, and typed counts are pulled out of the event's summary AND
// its provenance JSON into typed rows — never trusted to prose. Patterns
// are deliberately conservative: a false row costs a table line, a missed
// value costs a drill-down.
const SHA256_PATTERN = /\b[0-9a-f]{64}\b/g;
const SHA_PATTERN = /\b[0-9a-f]{40}\b/g;
const PATH_PATTERN = /\b(?:[\w@.~-]+\/)+[\w.@~-]+\b/g;
const EXIT_CODE_PATTERN = /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?[\s:=]\s*(\d{1,5})\b/gi;
const ERROR_PATTERN = /\b(\w*(?:Error|Exception))\s*:?\s*([^\n;.]{0,100})/g;
const COUNT_PATTERN = /\b(\d+)\s+(commits?|files?|tests?|events?)\b/g;

// Exported for the WP5 pitfall harvester: a candidate's exact-values table is
// extracted with the exact same patterns the digest side table uses, so a
// pitfall and its session digest never disagree about what the values were.
export function extractExactValues(event: EpisodicEvent, into: ExactValue[]): void {
  const text = `${event.summary} ${event.provenance}`;
  const push = (kind: ExactValue["kind"], value: string) => {
    const trimmed = value.trim();
    if (trimmed.length > 0) into.push({ kind, value: trimmed, eventId: event.id });
  };
  for (const match of text.matchAll(SHA256_PATTERN)) push("sha256", match[0]);
  for (const match of text.matchAll(SHA_PATTERN)) push("sha", match[0]);
  for (const match of text.matchAll(PATH_PATTERN)) {
    // URLs and similar are not file paths.
    if (!match[0].includes("://")) push("path", match[0]);
  }
  for (const match of text.matchAll(EXIT_CODE_PATTERN)) {
    push("exit-code", match[1]!);
  }
  for (const match of text.matchAll(ERROR_PATTERN)) {
    push("error", `${match[1]!}: ${match[2]!}`.replace(/:\s*$/, "").trim());
  }
  for (const match of text.matchAll(COUNT_PATTERN)) {
    push("count", `${match[1]!} ${match[2]!}`);
  }
}

function clipSummary(summary: string): string {
  const oneLine = summary.replace(/\s+/g, " ").trim();
  return oneLine.length <= SUMMARY_MAX
      ? oneLine
      : `${oneLine.slice(0, SUMMARY_MAX)}…`;
}

const eventLine = (event: EpisodicEvent): string =>
  `- [e${event.id}] ${event.ts} \`${event.type}\` — ${clipSummary(event.summary)}`;

interface RenderedDigest {
  body: string;
  eventIds: number[];
}

/** The deterministic fold: events in, Markdown digest out. Pure in its
 * inputs — the same rows always render the same body, which is what makes
 * the drift audit a string comparison. */
function renderDigest(input: {
  agent: string | null;
  sessionId: string | null;
  events: EpisodicEvent[];
}): RenderedDigest {
  const { agent, sessionId, events } = input;
  const eventIds = events.map((event) => event.id);
  const first = events[0]!;
  const last = events[events.length - 1]!;

  const outcomes = events.filter((event) =>
    OUTCOME_PATTERN.test(event.type)
  );
  const failures = events.filter((event) =>
    FAILURE_PATTERN.test(`${event.type} ${event.summary}`)
  );
  // Open threads: the latest event of each type that is neither an outcome
  // nor a failure — where each still-running thread left off.
  const latestByType = new Map<string, EpisodicEvent>();
  for (const event of events) {
    if (OUTCOME_PATTERN.test(event.type)) continue;
    if (FAILURE_PATTERN.test(`${event.type} ${event.summary}`)) continue;
    latestByType.set(event.type, event);
  }
  const openThreads = [...latestByType.values()]
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id)
    .slice(0, OPEN_THREADS_MAX);

  const exactValues: ExactValue[] = [];
  for (const event of events) extractExactValues(event, exactValues);
  const seen = new Set<string>();
  const exactRows = exactValues.filter((row) => {
    const key = `${row.kind}${row.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, EXACT_VALUES_MAX);

  const lines: string[] = [
    `# Session digest — ${agent ?? "unknown agent"}${
      sessionId === null ? "" : ` / session ${sessionId}`
    }`,
    "",
    `> hint-not-authority: compiled deterministically from ${events.length} ` +
    `typed episodic event(s) (${first.ts} → ${last.ts}). Every line carries ` +
    "its [eN] event pointer — drill down with `memory_digest { eventId }` " +
    "to the source rows before acting on any claim.",
    "",
    "## Timeline",
  ];
  if (events.length <= TIMELINE_HEAD + TIMELINE_TAIL) {
    for (const event of events) lines.push(eventLine(event));
  } else {
    for (const event of events.slice(0, TIMELINE_HEAD)) {
      lines.push(eventLine(event));
    }
    lines.push(
      `- … ${events.length - TIMELINE_HEAD - TIMELINE_TAIL} event(s) elided …`,
    );
    for (const event of events.slice(-TIMELINE_TAIL)) {
      lines.push(eventLine(event));
    }
  }

  lines.push("", "## Outcomes");
  lines.push(
    ...(outcomes.length === 0
      ? ["- none recorded"]
      : outcomes.map(eventLine)),
  );

  lines.push("", "## Failures");
  lines.push(
    ...(failures.length === 0
      ? ["- none recorded"]
      : failures.map(eventLine)),
  );

  lines.push("", "## Open threads");
  lines.push(
    ...(openThreads.length === 0
      ? ["- none recorded"]
      : openThreads.map(eventLine)),
  );

  lines.push("", "## Exact values");
  if (exactRows.length === 0) {
    lines.push("- none extracted");
  } else {
    lines.push("| kind | value | source |", "| --- | --- | --- |");
    for (const row of exactRows) {
      lines.push(`| ${row.kind} | \`${row.value}\` | e${row.eventId} |`);
    }
  }

  return { body: `${lines.join("\n")}\n`, eventIds };
}

/** Compile (or rolling-re-synthesize) the digest for one agent+session from
 * the typed record and persist it, REPLACING any prior row for that
 * agent+session — re-synthesis from source, never a merge of the previous
 * digest with a delta (naive merges drift). Returns null when the agent has
 * no events in range: an empty session earns no digest. */
export function compileDigest(
  store: EpisodicStore,
  options: {
    agent: string;
    sessionId: string | null;
    since?: string;
    compiledAt?: string;
  },
): EpisodicDigest | null {
  const events = store.eventsFor({
    agent: options.agent,
    ...(options.since === undefined ? {} : { since: options.since }),
  });
  if (events.length === 0) return null;
  const rendered = renderDigest({
    agent: options.agent,
    sessionId: options.sessionId,
    events,
  });
  return store.upsertDigest({
    agent: options.agent,
    sessionId: options.sessionId,
    ...(options.compiledAt === undefined
      ? {}
      : { compiledAt: options.compiledAt }),
    body: rendered.body,
    provenance: {
      eventIds: rendered.eventIds,
      sessionId: options.sessionId,
      agent: options.agent,
    },
  });
}

const DigestProvenanceSchema = z.object({
  eventIds: z.array(z.number().int().positive()),
  sessionId: z.string().min(1).nullable(),
  agent: z.string().min(1).nullable(),
}).loose();

export interface DigestDriftReport {
  ok: boolean;
  detail: string;
}

/** The digest-drift audit (S3.7 DoD 2): because compilation is a
 * deterministic fold, the stored digest must equal a fresh recompile from
 * the exact source rows its provenance names (compiled_at excepted — it is
 * metadata, not body). Any difference is drift: a tampered body, swept
 * source rows, or a compiler change that was not re-synthesized. */
export function auditDigestDrift(
  store: EpisodicStore,
  digestId: number,
): DigestDriftReport {
  const digest = store.digestById(digestId);
  if (digest === null) {
    return { ok: false, detail: `no digest with id ${digestId}` };
  }
  const parsed = DigestProvenanceSchema.safeParse(
    JSON.parse(digest.provenance),
  );
  if (!parsed.success) {
    return {
      ok: false,
      detail: `digest ${digestId} provenance does not parse: ${parsed.error.message}`,
    };
  }
  const provenance = parsed.data;
  const events = store.eventsByIds(provenance.eventIds);
  if (events.length !== provenance.eventIds.length) {
    const present = new Set(events.map((event) => event.id));
    const missing = provenance.eventIds.filter((id) => !present.has(id));
    return {
      ok: false,
      detail: `digest ${digestId} references source event(s) no longer in the store: ${
        missing.join(", ")
      }`,
    };
  }
  const recompiled = renderDigest({
    agent: provenance.agent,
    sessionId: provenance.sessionId,
    events,
  });
  if (recompiled.body !== digest.body) {
    return {
      ok: false,
      detail: `digest ${digestId} body does not match a fresh recompile from its ${events.length} source event(s)`,
    };
  }
  return {
    ok: true,
    detail: `digest ${digestId} matches a fresh recompile from its ${events.length} source event(s)`,
  };
}

export interface MemoryDigestEnvelope {
  /** ok = digest and/or drill-down rows returned; empty = store open, no
   * matching digest/event; absent = the episodic store is not open. */
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
    provenance: Record<string, unknown>;
  } | null;
  /** Drill-down rows: the exact source events behind the requested
   * event-id pointer(s). */
  events: EpisodicEvent[];
}

const TRUNCATION_MARKER =
  "\n…[truncated: digest body cut to fit the server token ceiling]\n";

/** The `memory_digest` read: one digest by id or agent(+session), plus
 * drill-down to the exact source event rows behind an event-id pointer.
 * Token ceiling is server-enforced and clamp-only; an over-budget body is
 * cut with a loud in-band marker. */
export function runMemoryDigest(
  deps: {
    episodic: EpisodicStore | null;
    /** Maps a caller-visible agent name to the daemon's agent id. */
    resolveAgentId: (name: string) => string | null;
  },
  rawInput: MemoryDigestInput,
): MemoryDigestEnvelope {
  const input = MemoryDigestInputSchema.parse(rawInput);
  const budget = Math.min(input.budget ?? MEMORY_DIGEST_DEFAULT_BUDGET,
    MEMORY_DIGEST_DEFAULT_BUDGET);
  if (deps.episodic === null) {
    return {
      state: "absent",
      detail: "episodic store is not open on this daemon",
      budget,
      tokens: 0,
      truncated: false,
      digest: null,
      events: [],
    };
  }
  const store = deps.episodic;

  let stored: EpisodicDigest | null = null;
  if (input.digestId !== undefined) {
    stored = store.digestById(input.digestId);
  } else if (input.agent !== undefined) {
    const agentId = deps.resolveAgentId(input.agent) ?? input.agent;
    stored = store.digestFor({
      agent: agentId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });
  }

  const events = input.eventId === undefined
    ? []
    : store.eventsByIds([input.eventId]);

  const digest = stored === null ? null : {
    id: stored.id,
    agent: stored.agent,
    sessionId: stored.sessionId,
    compiledAt: stored.compiledAt,
    body: stored.body,
    provenance: z.record(z.string(), z.unknown()).parse(
      JSON.parse(stored.provenance),
    ),
  };

  if (digest === null && events.length === 0) {
    const what = input.digestId !== undefined
      ? `digest with id ${input.digestId}`
      : input.agent !== undefined
      ? `digest for agent ${input.agent}`
      : `event with id ${input.eventId}`;
    return {
      state: "empty",
      detail: `no ${what} in this project's episodic store`,
      budget,
      tokens: 0,
      truncated: false,
      digest: null,
      events: [],
    };
  }

  let truncated = false;
  if (digest !== null) {
    const overhead = estimateTokens({ ...digest, body: "", events });
    const bodyTokens = estimateTokens(digest.body);
    if (overhead + bodyTokens > budget) {
      const allowedChars = Math.max(0, (budget - overhead) * 4);
      digest.body = digest.body.slice(
        0,
        Math.max(0, allowedChars - TRUNCATION_MARKER.length),
      ) + TRUNCATION_MARKER;
      truncated = true;
    }
  }
  let tokens = estimateTokens({ digest, events });
  // The chars/4 estimate drifts (JSON nesting, escapes), so correct once
  // against the real serialized size rather than trusting the first cut —
  // trimming the content side, never the loud marker.
  if (truncated && tokens > budget && digest !== null) {
    const content = digest.body.slice(
      0,
      digest.body.length - TRUNCATION_MARKER.length,
    );
    digest.body = content.slice(
      0,
      Math.max(0, content.length - (tokens - budget) * 4 - 8),
    ) + TRUNCATION_MARKER;
    tokens = estimateTokens({ digest, events });
  }
  return {
    state: "ok",
    detail: null,
    budget,
    tokens,
    truncated,
    digest,
    events,
  };
}
