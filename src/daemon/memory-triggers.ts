// Trigger protocol (HiveMemory HM-3 WP7, board #120; plan
// 2026-07-22-hivememory-epic-rework.md §3 item 3, article lesson A1).
//
// Recitation is not compliance: instructions in ambient context lose to the
// vendor's own system prompt, but a trigger invoked IN THE USER TURN is
// honored. So the queen and the operator can summon memory explicitly with
// trigger words, and the DAEMON — never the agent's goodwill — executes them:
//
//   recall: <query>        — run the FTS wiki search + pitfall-check for the
//                            query and deliver the labeled results to the
//                            target agent INSTEAD of the raw trigger text.
//   note this: <fact>      — write a repo-scope wiki observation (status
//                            unverified) and deliver a short confirmation.
//   document this: <topic> — write a topic-typed curated article scaffold
//                            (status unverified) and deliver a confirmation.
//
// Only queen or operator senders carry trigger authority; an agent that sends
// trigger-shaped text has it delivered verbatim, enforced here at the daemon
// (sender classification), not in prose. Every execution is audited as an
// episodic `memory-trigger` event with sender/target/kind provenance.
import {
  discoverMemoryFacts,
  factVerificationFlag,
  listMemoryFacts,
  normalizeTitle,
  type MemoryWriteFileResult,
} from "../adapters/memory";
import {
  isOrchestratorName,
  type AgentMessage,
  type MemorySource,
  type MemoryWriteInput,
} from "../schemas";
import { OPERATOR_SUBJECT } from "./credentials";
import type { EpisodicStore } from "./episodic-store";
import type { MemoryIndex } from "./memory-index";

export type MemoryTriggerKind = "recall" | "note" | "document";

export interface MemoryTrigger {
  kind: MemoryTriggerKind;
  payload: string;
}

const TRIGGER_PHRASES: ReadonlyArray<readonly [MemoryTriggerKind, string]> = [
  ["note", "note this"],
  ["document", "document this"],
  ["recall", "recall"],
];

/**
 * Detect a trigger at the START of a message body (case-insensitive, the
 * colon is required, leading whitespace tolerated): "recall: <q>",
 * "note this: <fact>", "document this: <topic>". Trigger-shaped text anywhere
 * else in the body, a missing colon, or an empty payload is an ordinary
 * message and returns null.
 */
export function detectMemoryTrigger(text: string): MemoryTrigger | null {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  for (const [kind, phrase] of TRIGGER_PHRASES) {
    if (!lower.startsWith(`${phrase}:`)) continue;
    const payload = trimmed.slice(phrase.length + 1).trim();
    if (payload.length === 0) return null;
    return { kind, payload };
  }
  return null;
}

/**
 * Who may trigger. Queen (the orchestrator, any alias) and the operator
 * subject carry authority; every other sender — agent names, hive-control and
 * the other system senders — does not, so agent-to-agent trigger text is
 * delivered verbatim and never executed.
 */
export type MemoryTriggerAuthority = "queen" | "operator";

export function memoryTriggerAuthority(
  from: string,
): MemoryTriggerAuthority | null {
  if (isOrchestratorName(from)) return "queen";
  if (from === OPERATOR_SUBJECT) return "operator";
  return null;
}

export interface MemoryTriggerDeps {
  /** Lazy because the daemon assigns repoRoot after delivery is built. */
  repoRoot: () => string;
  /** The daemon's FTS index over the wiki; null degrades recall to an honest
   * "surface absent" block (writes still execute). */
  memory: Pick<MemoryIndex, "search"> | null;
  /** The semantic leg (HiveMemory HM-5, board #122): cosine top-k over the
   * vector store, or null when embeddings are unavailable. Undefined degrades
   * to the FTS-only bundle. */
  semantic?: (query: string, limit: number) => Promise<Array<{
    scope: string;
    id: string;
    score: number;
  }> | null>;
  /** The semantic leg's one-word state (defect D2), consulted when the leg
   * answered null so the recall envelope can name WHY it is FTS-only
   * (degraded:embedding-runtime-missing, not a silent keyword-only result). */
  semanticStatus?: () => string;
  /** The daemon's serialized writeMemoryFact (file lock + FTS upsert). The
   * optional embedding outcome (defect D2) says what happened to the write's
   * vector projection so the confirmation can say when it is keyword-only. */
  write: (
    input: MemoryWriteInput,
  ) => Promise<MemoryWriteFileResult & { embedding?: string }>;
  /** The audit sink; null skips the episodic `memory-trigger` event. */
  episodic: Pick<EpisodicStore, "appendEvent"> | null;
  /** Durable warning sink (defect D2) for trigger machinery failures;
   * undefined logs to the console only. */
  log?: (message: string) => void;
}

export interface MemoryTriggerContext {
  authority: MemoryTriggerAuthority;
  /** The canonical sender name (for evidence/provenance text). */
  from: string;
  /** The agent the trigger message was addressed to. */
  target: string;
}

export interface MemoryTriggerExecution {
  /** The labeled block that REPLACES the raw trigger text on the wire. The
   * trigger is a command, not message content. */
  body: string;
  /** One-line summary for the episodic audit event. */
  summary: string;
  /** Kind-specific audit provenance (query, or article id + action). */
  provenance: Record<string, unknown>;
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// The shared recall bundle (HiveMemory plan §5): the trigger protocol's
// "recall:" path and the memory_recall MCP tool render the SAME ranked bundle
// — wiki FTS hits partitioned into pitfalls and articles with verification
// labels — so the formatting lives here exactly once.
// ---------------------------------------------------------------------------

export interface MemoryRecallRow {
  scope: string;
  topic: string;
  id: string;
  date: string;
  title: string;
  snippet: string;
  status: string;
  /** The verification label rendered next to the row; null for verified. */
  flag: string | null;
  pitfall: boolean;
}

/** The hint-not-authority label every recall surface carries. */
export const MEMORY_RECALL_HINT_NOTE =
  "[unverified], [stale] and [conflicted] entries are hints to reconcile " +
  "before acting, not authority; pull the full article with " +
  "memory_read(scope, id).";

export interface MemoryRecallBundle {
  /** absent = no wiki search index wired; empty = searched, no matches. */
  state: "ok" | "empty" | "absent";
  /** What the semantic leg contributed to THIS bundle (defect D2): "hybrid"
   * — semantic search actually ran and was blended; "disabled" — the leg is
   * not wired (or provider config keeps it off); "degraded:<state>" — the
   * leg is down and these results are keyword-only, named with the distinct
   * state label (e.g. degraded:embedding-runtime-missing). */
  semantic: MemoryRecallSemantic;
  pitfalls: MemoryRecallRow[];
  articles: MemoryRecallRow[];
}

export type MemoryRecallSemantic = "hybrid" | "disabled" | `degraded:${string}`;

/** The loud line every degraded recall surface carries (defect D2). Kept as
 * a function of the state label so the trigger lane and the memory_recall
 * tool render byte-identical wording. */
export function memoryRecallDegradedWarning(state: string): string {
  return `⚠ semantic search unavailable (${state}) — results are keyword-only`;
}

export function formatMemoryRecallRow(row: MemoryRecallRow): string {
  return `- [${row.scope}/${row.topic}] ${row.id} (${row.date})` +
    (row.flag === null ? "" : ` [${row.flag}]`) +
    (row.pitfall ? " [pitfall]" : "") +
    `: ${row.title} — ${oneLine(row.snippet)}`;
}

/**
 * Reciprocal-rank fusion (HiveMemory HM-5, board #122): the blend between
 * the FTS leg and the semantic leg. Fixed weights by design — no tuning
 * knobs (plan D4: embeddings buy paraphrase recall, not correctness). Both
 * legs weigh equally; k=60 is the standard RRF constant from Cormack et al.
 * 2009, dampening head-of-list dominance so a leg's #1 does not swamp the
 * other leg entirely.
 */
const RECALL_RRF_K = 60;

/**
 * Search the wiki for `query` and partition the hits into the pitfall class
 * and ordinary articles, each row carrying its verification label. The FTS
 * row carries no kind, so kinds resolve from the on-disk articles (the same
 * pattern as memory_query pitfall-check).
 *
 * Hybrid retrieval (HM-5): when deps.semantic is wired AND answers (non-null),
 * its cosine top-k is RRF-blended with the FTS ranking — a paraphrase the
 * porter tokenizer cannot match still ranks. When the semantic leg is absent
 * or unavailable (null), the bundle's ROWS are byte-identical to the FTS-only
 * output — a test pins this — while the envelope's `semantic` field
 * (defect D2) says out loud that the leg did not run, and why.
 */
export async function buildMemoryRecallBundle(
  query: string,
  deps: Pick<MemoryTriggerDeps, "memory" | "repoRoot" | "semantic" | "semanticStatus">,
  limit = 8,
): Promise<MemoryRecallBundle> {
  // The envelope discriminator (defect D2): names what the semantic leg
  // contributed, so "FTS-only because embeddings are down" is never
  // indistinguishable from a genuine keyword-only result. In the absent
  // state nothing was searched at all; the field then reports the leg's
  // wiring/health, not a search outcome.
  const degradedSemantic = (): MemoryRecallSemantic => {
    if (deps.semantic === undefined) return "disabled";
    const label = deps.semanticStatus?.() ?? "unavailable";
    return label === "disabled" ? "disabled" : `degraded:${label}`;
  };
  if (deps.memory === null) {
    return {
      state: "absent",
      semantic: degradedSemantic(),
      pitfalls: [],
      articles: [],
    };
  }
  const hits = deps.memory.search(query, { limit });
  const semantic = deps.semantic === undefined
    ? null
    : await deps.semantic(query, limit);
  if (semantic === null && hits.length === 0) {
    return {
      state: "empty",
      semantic: degradedSemantic(),
      pitfalls: [],
      articles: [],
    };
  }
  const facts = await listMemoryFacts(deps.repoRoot());
  const factByKey = new Map<string, (typeof facts)[number]>(
    facts.map((fact) => [`${fact.scope}:${fact.id}`, fact]),
  );
  const statusByKey = new Map<string, string | null>(
    facts.map((fact) =>
      [`${fact.scope}:${fact.id}`, factVerificationFlag(fact)] as const
    ),
  );
  const pitfallKeys = new Set<string>(
    facts.filter((fact) => fact.kind === "pitfall").map((fact) =>
      `${fact.scope}:${fact.id}`
    ),
  );
  const toRow = (hit: {
    scope: string;
    topic: string;
    id: string;
    date: string;
    title: string;
    snippet: string;
    status: string;
  }): MemoryRecallRow => ({
    scope: hit.scope,
    topic: hit.topic,
    id: hit.id,
    date: hit.date,
    title: hit.title,
    snippet: hit.snippet,
    status: hit.status,
    flag: statusByKey.get(`${hit.scope}:${hit.id}`) ??
      (hit.status === "verified" ? null : hit.status),
    pitfall: pitfallKeys.has(`${hit.scope}:${hit.id}`),
  });
  // FTS-only: the unavailable-degradation contract. This path is the exact
  // pre-HM-5 behavior — same hits, same order, same rows.
  if (semantic === null) {
    const rows = hits.map(toRow);
    return {
      state: "ok",
      semantic: degradedSemantic(),
      pitfalls: rows.filter((row) => row.pitfall),
      articles: rows.filter((row) => !row.pitfall),
    };
  }
  // Hybrid: RRF over both ranked lists, capped back at `limit`.
  const fused = new Map<string, { score: number; fts: number }>();
  hits.forEach((hit, rank) => {
    fused.set(`${hit.scope}:${hit.id}`, {
      score: 1 / (RECALL_RRF_K + rank + 1),
      fts: rank,
    });
  });
  semantic.forEach((hit, rank) => {
    const key = `${hit.scope}:${hit.id}`;
    const entry = fused.get(key);
    if (entry === undefined) {
      fused.set(key, { score: 1 / (RECALL_RRF_K + rank + 1), fts: -1 });
    } else {
      entry.score += 1 / (RECALL_RRF_K + rank + 1);
    }
  });
  const ordered = [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, limit);
  if (ordered.length === 0) {
    // Both legs answered and neither matched — the honest empty result, same
    // as the FTS-only path reports.
    return { state: "empty", semantic: "hybrid", pitfalls: [], articles: [] };
  }
  const rows = ordered.flatMap(([key, entry]): MemoryRecallRow[] => {
    const ftsHit = entry.fts >= 0 ? hits[entry.fts] : undefined;
    if (ftsHit !== undefined) {
      return [toRow(ftsHit)];
    }
    // A semantic-only hit: hydrate the row from the on-disk article. Gone
    // from disk (a stale vector row not yet pruned) means no row at all.
    const fact = factByKey.get(key);
    if (fact === undefined) return [];
    return [toRow({
      scope: fact.scope,
      topic: fact.topic,
      id: fact.id,
      date: fact.date,
      title: fact.title,
      snippet: oneLine(fact.body).slice(0, 160),
      status: fact.status,
    })];
  });
  return {
    state: "ok",
    semantic: "hybrid",
    pitfalls: rows.filter((row) => row.pitfall),
    articles: rows.filter((row) => !row.pitfall),
  };
}

/** The MemoryTopicSchema kebab-case shape, derived from free text. */
function deriveTopic(payload: string): string {
  const topic = payload
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return topic.length > 0 ? topic : "notes";
}

const SYSTEM_NOTE = (from: string, trigger: string) =>
  `system-injected by the Hive daemon: ${from} invoked the "${trigger}" ` +
  "trigger; this is durable-memory machinery, not part of any sender's message.";

async function executeRecall(
  query: string,
  context: MemoryTriggerContext,
  deps: MemoryTriggerDeps,
): Promise<MemoryTriggerExecution> {
  const header = (outcome: string) =>
    `🧠 Hive memory recall for '${query}' — ${outcome} (${SYSTEM_NOTE(context.from, "recall:")})`;

  const bundle = await buildMemoryRecallBundle(query, deps);
  // The degradation warning rides directly under the header (defect D2): it
  // is part of the envelope, not a result row, so budget clamping can never
  // cut it, and an FTS-only empty result is never mistaken for a genuine
  // no-match.
  const degradedWarning = bundle.semantic.startsWith("degraded:")
    ? `\n${memoryRecallDegradedWarning(bundle.semantic.slice("degraded:".length))}`
    : "";
  if (bundle.state === "absent") {
    return {
      body: header("memory surface unavailable") +
        "\nThis daemon has no wiki search index wired, so the recall could " +
        "not run — the surface is ABSENT, which is not the same as an empty " +
        "result. Nothing was searched.",
      summary: `recall trigger from ${context.from} to ${context.target}: memory surface absent`,
      provenance: { query, outcome: "absent" },
    };
  }
  if (bundle.state === "empty") {
    return {
      body: header("no matching memory") + degradedWarning +
        "\nThe wiki was searched and nothing matched — an honest empty " +
        "result, not a missing index. Broaden the query with memory_search, " +
        'or record what you learn with "note this:".',
      summary:
        `recall trigger from ${context.from} to ${context.target}: no matches for "${query}"`,
      provenance: { query, outcome: "empty" },
    };
  }

  const count = bundle.pitfalls.length + bundle.articles.length;
  const sections: string[] = [];
  if (bundle.pitfalls.length > 0) {
    sections.push(
      "Pitfalls matching this query:",
      ...bundle.pitfalls.map(formatMemoryRecallRow),
    );
  }
  if (bundle.articles.length > 0) {
    sections.push("Articles:", ...bundle.articles.map(formatMemoryRecallRow));
  }
  return {
    body: header(`${count} result${count === 1 ? "" : "s"}`) + degradedWarning +
      `\n${MEMORY_RECALL_HINT_NOTE}\n` +
      sections.join("\n"),
    summary:
      `recall trigger from ${context.from} to ${context.target}: ${count} result(s) for "${query}"`,
    provenance: { query, outcome: "ok", results: count },
  };
}

/**
 * Write a trigger-sourced wiki article, honoring the write path's dedup
 * contract (HiveMemory plan D1 layer 1): a normalized-title match is a
 * duplicate, re-issued as an update to the existing id (same pattern as the
 * pitfall harvester) rather than rejected back at the user. Returns the
 * written article and whether it created or updated.
 */
async function writeTriggerArticle(
  input: Omit<MemoryWriteInput, "id" | "supersedes">,
  deps: MemoryTriggerDeps,
): Promise<{
  written: MemoryWriteFileResult & { embedding?: string };
  action: "created" | "updated";
}> {
  const duplicate = (await discoverMemoryFacts(deps.repoRoot(), "repo")).find(
    (fact) => normalizeTitle(fact.title) === normalizeTitle(input.title),
  );
  if (duplicate === undefined) {
    return { written: await deps.write({ ...input, supersedes: [] }), action: "created" };
  }
  // The update keeps the existing article's topic — writeMemoryFact rejects
  // an id that moves topics, and an update is not a move.
  const written = await deps.write({
    ...input,
    id: duplicate.id,
    topic: duplicate.topic,
    supersedes: [duplicate.id],
  });
  return { written, action: "updated" };
}

async function executeWrite(
  kind: "note" | "document",
  payload: string,
  context: MemoryTriggerContext,
  deps: MemoryTriggerDeps,
): Promise<MemoryTriggerExecution> {
  const source: MemorySource = context.authority === "queen"
    ? "orchestrator"
    : "human";
  const trigger = kind === "note" ? "note this:" : "document this:";
  const evidence = `${context.from} via the "${trigger}" trigger in a message to ` +
    `${context.target}, ${todayIsoDate()}`;
  const base = {
    scope: "repo" as const,
    title: payload,
    source,
    evidence,
    status: "unverified" as const,
    kind: "article" as const,
    tags: ["trigger", kind],
  };
  const input: Omit<MemoryWriteInput, "id" | "supersedes"> = kind === "note"
    ? { ...base, topic: "notes", body: payload }
    : {
      ...base,
      topic: deriveTopic(payload),
      body: [
        "## Claim",
        "",
        payload,
        "",
        "## Verification",
        "",
        "TODO: this article is a scaffold the Hive daemon wrote from a " +
        `"${trigger}" trigger; the claim is UNVERIFIED. Check it against ` +
        "the repo, correct the body as needed, then promote it with " +
        "memory_write (status: verified and a verified date) before " +
        "treating it as authority.",
      ].join("\n"),
    };
  const { written, action } = await writeTriggerArticle(input, deps);
  const verb = kind === "note" ? "Hive noted" : "Hive documented";
  const did = action === "created"
    ? `wrote article [${written.scope}/${written.topic}] ${written.id}`
    : `updated existing article [${written.scope}/${written.topic}] ${written.id}`;
  const embedding = written.embedding;
  const embeddingWarning = embedding !== undefined &&
      embedding.startsWith("unavailable:")
    ? `\n⚠ semantic index unavailable (${embedding.slice("unavailable:".length)})` +
      " — this write is keyword-searchable only."
    : "";
  return {
    body: `🧠 ${verb}: "${written.title}" [unverified] (${SYSTEM_NOTE(context.from, trigger)} ` +
      `The daemon ${did}. Unverified is a claim to reconcile, not ` +
      "authority — verify with memory_read and promote before relying on it.)" +
      embeddingWarning,
    summary:
      `${kind} trigger from ${context.from} to ${context.target}: ${action} [repo/${written.topic}] ${written.id}`,
    provenance: {
      scope: written.scope,
      topic: written.topic,
      id: written.id,
      action,
    },
  };
}

/**
 * Execute one detected trigger. Throws on failure — the delivery seam
 * isolates that (original text plus a failure note, never a dropped
 * message). The audit event is appended here, after the action it records
 * actually happened; an audit failure is logged, never thrown into delivery.
 */
export async function executeMemoryTrigger(
  trigger: MemoryTrigger,
  context: MemoryTriggerContext,
  deps: MemoryTriggerDeps,
): Promise<MemoryTriggerExecution> {
  const execution = trigger.kind === "recall"
    ? await executeRecall(trigger.payload, context, deps)
    : await executeWrite(trigger.kind, trigger.payload, context, deps);
  if (deps.episodic !== null) {
    try {
      deps.episodic.appendEvent({
        agent: context.target,
        type: "memory-trigger",
        summary: execution.summary,
        provenance: {
          sender: context.from,
          target: context.target,
          kind: trigger.kind,
          ...execution.provenance,
        },
      });
    } catch (error) {
      const message =
        `Hive could not audit the memory trigger from ${context.from} to ${context.target}: ${
          error instanceof Error ? error.message : "unknown error"
        }`;
      console.error(message);
      deps.log?.(message);
    }
  }
  return execution;
}

/**
 * The delivery seam's view of the trigger protocol: given the stored
 * message, decide whether it is an authorized trigger and, if so, return the
 * labeled block that replaces its body. Null means deliver the body as
 * formatted — no trigger, or no authority to trigger.
 */
export interface MemoryTriggerExecutor {
  execute(
    message: Pick<AgentMessage, "from" | "to" | "body">,
  ): Promise<string | null>;
}

export function createMemoryTriggerExecutor(
  deps: MemoryTriggerDeps,
): MemoryTriggerExecutor {
  return {
    async execute(message) {
      // Authority first: an agent's trigger-shaped text is verbatim message
      // content, never a command — enforced here, at the daemon.
      const authority = memoryTriggerAuthority(message.from);
      if (authority === null) return null;
      const trigger = detectMemoryTrigger(message.body);
      if (trigger === null) return null;
      const execution = await executeMemoryTrigger(
        trigger,
        { authority, from: message.from, target: message.to },
        deps,
      );
      return execution.body;
    },
  };
}
