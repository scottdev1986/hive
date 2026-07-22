// Wake-delta memory injection (HiveMemory HM-3 WP6, board #120; plan
// 2026-07-22-hivememory-epic-rework.md §3 item 2, decision D6).
//
// Recall is system-triggered, never left to agent goodwill (article lesson
// A1/A2): when an agent wakes — a message is delivered to it, or its crashed
// session is resumed — the daemon injects a bounded memory delta over the
// ordinary message-delivery lane, so it needs no vendor hook support (Grok
// has none). The delta carries two things:
//
//   1. Pitfalls matching the agent's current task brief (the
//      pitfall-check/FTS path) — age-independent, because a 60-day-old
//      pitfall that matches the task is exactly the recall that matters.
//   2. Wiki changes (created/updated/stale-demoted/deleted) since the
//      agent's high-water mark, parsed from the append-only wiki ingest log.
//
// The block is hard-capped at the configured token budget
// (`memory.wake_budget_tokens`, default 300): pitfalls first, then changes,
// with loud in-band truncation. An empty delta composes to null and nothing
// is injected.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  factVerificationFlag,
  listMemoryFacts,
  normalizeTitle,
  scopeRoot,
} from "../adapters/memory";
import type { AgentRecord, MemoryScope } from "../schemas";
import type { MemoryHighWater } from "./episodic-store";
import type { MemoryIndex } from "./memory-index";

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error &&
  error.code === "ENOENT";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Chars/4 — the same estimation convention as episodic-projections' class
// budgets, deterministic in tests.
const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export interface WikiLogEntry {
  scope: MemoryScope;
  /** 1-based ordinal within its scope's log — the high-water currency. */
  ordinal: number;
  date: string;
  /** Raw operation: ingest | stale-demote | delete | migrate | … */
  op: string;
  title: string;
}

export interface WikiLogRead {
  entries: WikiLogEntry[];
  /** Per-scope entry counts — the value a high-water mark advances to. */
  totals: MemoryHighWater;
}

/**
 * Parse both scopes' append-only wiki ingest logs (`wiki/log.md`). This is a
 * best-effort reader over a human-writable file: anything that is not a
 * well-formed `## [date] op | title` entry line is skipped, and a missing
 * log simply contributes no entries.
 */
export async function readWikiLog(root: string): Promise<WikiLogRead> {
  const entries: WikiLogEntry[] = [];
  const totals: MemoryHighWater = { repo: 0, global: 0 };
  for (const scope of ["repo", "global"] as const) {
    let contents: string;
    try {
      contents = await readFile(
        join(scopeRoot(root, scope), "wiki", "log.md"),
        "utf8",
      );
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    let ordinal = 0;
    for (const line of contents.split(/\r?\n/)) {
      if (!line.startsWith("## [")) continue;
      const close = line.indexOf("] ");
      if (close < 0) continue;
      const date = line.slice(4, close);
      if (!ISO_DATE.test(date)) continue;
      const rest = line.slice(close + 2);
      // Split on the FIRST " | ": the operation never contains one, titles may.
      const pipe = rest.indexOf(" | ");
      if (pipe < 0) continue;
      const op = rest.slice(0, pipe).trim();
      const title = rest.slice(pipe + 3).trim();
      if (op.length === 0 || title.length === 0) continue;
      ordinal += 1;
      entries.push({ scope, ordinal, date, op, title });
    }
    totals[scope] = ordinal;
  }
  return { entries, totals };
}

const OP_LABELS: Record<string, string> = {
  ingest: "new/updated",
  "stale-demote": "demoted to stale",
  delete: "deleted",
};

export interface ComposeMemoryDeltaOptions {
  repoRoot: string;
  /** The recipient's current task brief; pitfall matching reads it. Absent
   * or blank degrades to no pitfall section. */
  brief?: string | null;
  /** What the agent has already been shown. */
  highWater: MemoryHighWater;
  /** Hard ceiling for the whole block, in estimated tokens. */
  budgetTokens: number;
  /** The daemon's FTS index over the wiki; null degrades to no pitfall
   * section (changes still compose). */
  memory: Pick<MemoryIndex, "search"> | null;
}

export interface ComposedMemoryDelta {
  /** The labeled Markdown block, ready to append to a delivered message. */
  block: string;
  /** The log totals at compose time — the mark to store only after the
   * block was actually delivered. */
  advanceTo: MemoryHighWater;
}

/**
 * Compose the bounded memory delta for one agent's wake, or null when there
 * is nothing new to say (no matching pitfalls, no log changes past the
 * high-water mark) — null means inject nothing.
 */
export async function composeMemoryDelta(
  options: ComposeMemoryDeltaOptions,
): Promise<ComposedMemoryDelta | null> {
  const { entries, totals } = await readWikiLog(options.repoRoot);
  const changes = entries.filter((entry) =>
    entry.ordinal > options.highWater[entry.scope]
  );

  // Facts are read once and serve both sections: the pitfall kind lookup and
  // the hint-not-authority status labels on change lines. Title is unique
  // per scope (write-path dedup layer 1 rejects normalized-title collisions),
  // so a log entry's title resolves to at most one article.
  const facts = await listMemoryFacts(options.repoRoot);
  const statusByTitle = new Map(
    facts.map((fact) =>
      [
        `${fact.scope}:${normalizeTitle(fact.title)}`,
        factVerificationFlag(fact),
      ] as const
    ),
  );

  // (a) Pitfalls matching the current brief — the pitfall-check/FTS path,
  // deliberately NOT filtered by the high-water mark: a task-matching
  // pitfall matters however old it is.
  const pitfallLines: string[] = [];
  const brief = options.brief?.trim() ?? "";
  if (brief.length > 0 && options.memory !== null) {
    const pitfalls = new Set(
      facts.filter((fact) => fact.kind === "pitfall").map((fact) =>
        `${fact.scope}:${fact.id}`
      ),
    );
    if (pitfalls.size > 0) {
      for (const hit of options.memory.search(brief, { limit: 8 })) {
        if (!pitfalls.has(`${hit.scope}:${hit.id}`)) continue;
        pitfallLines.push(
          `- [${hit.scope}/${hit.topic}] ${hit.id} (${hit.date}) ` +
            `[${hit.status}]: ${hit.title} — ${oneLine(hit.snippet)}`,
        );
      }
    }
  }

  // (b) Wiki changes since the high-water mark.
  const changeLines = changes.map((entry) => {
    const flag = statusByTitle.get(
      `${entry.scope}:${normalizeTitle(entry.title)}`,
    );
    return `- [${entry.scope}] ${entry.date} ${OP_LABELS[entry.op] ?? entry.op}: ` +
      entry.title + (flag === null || flag === undefined ? "" : ` [${flag}]`);
  });

  if (pitfallLines.length === 0 && changeLines.length === 0) return null;

  const header =
    `🧠 Hive memory update since your last turn — ${changeLines.length} ` +
    `change${changeLines.length === 1 ? "" : "s"} (system-injected by the ` +
    "Hive daemon: durable memory, not part of the sender's message. " +
    "[unverified] and [stale] entries are hints to reconcile before acting, " +
    "not authority.)";
  const sections: Array<{ kind: "pitfall" | "change"; header: string; lines: string[] }> = [];
  if (pitfallLines.length > 0) {
    sections.push({
      kind: "pitfall",
      header: "Pitfalls matching your current task:",
      lines: pitfallLines,
    });
  }
  if (changeLines.length > 0) {
    sections.push({ kind: "change", header: "Wiki changes:", lines: changeLines });
  }

  // Strict priority fill: pitfalls first, then changes; the first line that
  // would cross the ceiling stops the fill and everything remaining counts
  // toward the loud truncation marker.
  const budget = options.budgetTokens;
  const kept: Array<{ kind: "section" | "pitfall" | "change"; text: string }> = [];
  let used = estimateTokens(header);
  let stopped = false;
  let omittedPitfalls = 0;
  let omittedChanges = 0;
  for (const section of sections) {
    if (stopped) {
      if (section.kind === "pitfall") omittedPitfalls += section.lines.length;
      else omittedChanges += section.lines.length;
      continue;
    }
    const headerCost = estimateTokens(section.header);
    if (used + headerCost > budget) {
      stopped = true;
      if (section.kind === "pitfall") omittedPitfalls += section.lines.length;
      else omittedChanges += section.lines.length;
      continue;
    }
    used += headerCost;
    kept.push({ kind: "section", text: section.header });
    for (const line of section.lines) {
      const cost = estimateTokens(line);
      if (stopped || used + cost > budget) {
        stopped = true;
        if (section.kind === "pitfall") omittedPitfalls += 1;
        else omittedChanges += 1;
        continue;
      }
      used += cost;
      kept.push({ kind: section.kind, text: line });
    }
  }

  const marker = (): string | null => {
    if (omittedPitfalls === 0 && omittedChanges === 0) return null;
    const what = omittedPitfalls > 0
      ? omittedChanges > 0
        ? `${omittedPitfalls} more pitfalls and ${omittedChanges} more changes`
        : `${omittedPitfalls} more pitfalls`
      : `${omittedChanges} more changes`;
    return `… ${what} — use memory_search or memory_query to see them`;
  };

  // The marker is part of the budget contract: if it does not fit, trailing
  // content lines give way to it — changes first (they sit last), so
  // pitfalls survive truncation.
  let text = marker();
  while (text !== null && used + estimateTokens(text) > budget && kept.length > 0) {
    const dropped = kept.pop()!;
    used -= estimateTokens(dropped.text);
    if (dropped.kind === "pitfall") omittedPitfalls += 1;
    if (dropped.kind === "change") omittedChanges += 1;
    text = marker();
  }

  const block = [header, ...kept.map((line) => line.text)]
    .concat(text === null ? [] : [text])
    .join("\n");
  return { block, advanceTo: totals };
}

/**
 * The delivery seam's view of wake deltas: compose the block for a
 * recipient, and — only after the delivery carrying it actually landed —
 * advance the recipient's high-water mark past what it showed.
 */
export interface WakeDeltaProvider {
  compose(recipient: AgentRecord): Promise<ComposedMemoryDelta | null>;
  advance(recipient: AgentRecord, mark: MemoryHighWater): void;
}

export interface WakeDeltaDeps {
  repoRoot: () => string;
  store: {
    memoryHighWater(agent: string): MemoryHighWater | null;
    advanceMemoryHighWater(agent: string, mark: MemoryHighWater): void;
  };
  memory: Pick<MemoryIndex, "search"> | null;
  budgetTokens: number;
}

export function createWakeDeltaProvider(deps: WakeDeltaDeps): WakeDeltaProvider {
  return {
    async compose(recipient) {
      const mark = deps.store.memoryHighWater(recipient.name);
      // No mark means this agent's baseline was never recorded (an embedder
      // without spawn-time seeding). Re-baseline silently to the current log
      // end rather than flooding its first wake with the whole history; the
      // next wake composes a real delta.
      if (mark === null) {
        const { totals } = await readWikiLog(deps.repoRoot());
        deps.store.advanceMemoryHighWater(recipient.name, totals);
        return null;
      }
      return await composeMemoryDelta({
        repoRoot: deps.repoRoot(),
        brief: recipient.taskDescription,
        highWater: mark,
        budgetTokens: deps.budgetTokens,
        memory: deps.memory,
      });
    },
    advance(recipient, mark) {
      deps.store.advanceMemoryHighWater(recipient.name, mark);
    },
  };
}
