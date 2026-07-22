// The mistake-harvest pipeline (HiveMemory HM-2 WP5, board #72;
// planning/2026-07-22-hivememory-epic-rework.md §4 HM-2): at session
// boundaries, fold the session's failure events into candidate pitfall
// articles in the REPO wiki so the next agent — a different agent — starts
// from "we burned ourselves before" instead of re-learning it.
//
// Candidates are labeled, never authoritative: every one is written with
// status `unverified` and source `orchestrator`, and promotion to `verified`
// is the queen/human's ordinary memory_write self-supersede — no new
// mechanics. Promotion to GLOBAL scope is likewise out of scope here by
// design: that is the separate human-approved memory_promote path (WP8).
// This module only ever writes scope "repo"; the seam for WP8 is that the
// scope is a constant, not a parameter a caller can smuggle in.
//
// Like every other memory projection, harvest is a derived write off the
// hot path: per-candidate failures are captured in the report, never thrown
// into the lifecycle path that triggered the harvest.
import {
  discoverMemoryFacts,
  normalizeTitle,
  writeMemoryFact as writeMemoryFactFile,
  type MemoryWriteFileResult,
} from "../adapters/memory";
import type { MemoryScope, MemoryWriteInput } from "../schemas";
import { extractExactValues, type ExactValue } from "./episodic-digest";
import type { EpisodicEvent, EpisodicStore } from "./episodic-store";

/** Same failure classification the digest's Failures section uses. */
const FAILURE_PATTERN = /error|fail|blocked|kill/i;

const ERROR_PATTERN = /\b(\w*(?:Error|Exception))\s*:?\s*([^\n;.]{0,100})/;
const EXIT_CODE_PATTERN = /\bexit(?:ed)?(?:\s+with)?(?:\s+code)?[\s:=]\s*(\d{1,5})\b/i;

const TITLE_MAX = 110;
const EXACT_VALUES_MAX = 12;
const ADVISORY_MAX = 3;

/** Strip the volatile tokens (paths, number runs, long hex) that would make
 * the same failure earn a new cluster — and a new normalized title — every
 * time it recurs at a different line or with a different id. */
function sanitizeLabel(text: string): string {
  return text
    .replace(/\b(?:[\w@.~-]+\/)+[\w.@~-]+\b/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

interface FailureSignature {
  /** Cluster key: two events with the same key are the same failure. */
  key: string;
  /** Human-readable label for the title and body. */
  label: string;
}

/** The normalized error signature a failure cluster is keyed on: the error
 * string when there is one, the exit code plus the failing command's leading
 * words otherwise, and a sanitized summary fallback so no failure event is
 * silently dropped. */
function failureSignature(event: EpisodicEvent): FailureSignature {
  const text = event.summary;
  const error = ERROR_PATTERN.exec(text);
  if (error !== null) {
    const label = sanitizeLabel(`${error[1]}: ${error[2]}`.replace(/:\s*$/, ""));
    return { key: `error:${label.toLowerCase()}`, label };
  }
  const exit = EXIT_CODE_PATTERN.exec(text);
  if (exit !== null) {
    const command = sanitizeLabel(text.split(/\s+/).slice(0, 4).join(" "));
    const label = `${command} (exit code ${exit[1]})`;
    return { key: `exit:${exit[1]}:${command.toLowerCase()}`, label };
  }
  const label = sanitizeLabel(text).slice(0, 80);
  return { key: `fail:${event.type}:${label.toLowerCase()}`, label };
}

export interface PitfallCandidate {
  id: string;
  title: string;
  /** created = new article; updated = normalized-title dedup re-issued the
   * candidate as a self-superseding update of the existing article. */
  action: "created" | "updated";
  signature: string;
  eventIds: number[];
  /** Advisory links (dedup layer 2, plan D1): similar-but-distinct articles
   * the candidate body points at with "Possibly related:" — appended and
   * linked, never merged. */
  related: Array<{ scope: MemoryScope; id: string; title: string }>;
}

export interface PitfallHarvestReport {
  candidates: PitfallCandidate[];
  /** Per-candidate failures, captured so one bad write cannot strand the
   * rest of the harvest or the lifecycle path that fired it. */
  errors: string[];
}

export interface HarvestPitfallsDeps {
  store: EpisodicStore;
  repoRoot: string;
  /** The daemon's agent id — the same key episodic events are stored under. */
  agent: string;
  sessionId: string | null;
  /** The write path; the daemon passes its serialized, FTS-maintaining
   * writeMemoryFact. Defaults to the raw file adapter for tests. */
  write?: (input: MemoryWriteInput) => Promise<MemoryWriteFileResult>;
  /** Advisory search for "Possibly related:" links (dedup layer 2). The
   * daemon passes its FTS MemoryIndex; omitting it skips the advisory. */
  search?: (query: string) => Array<{ scope: MemoryScope; id: string; title: string }>;
}

function candidateBody(input: {
  cluster: EpisodicEvent[];
  label: string;
  agent: string;
  sessionId: string | null;
  digestId: number | null;
  related: Array<{ scope: MemoryScope; id: string; title: string }>;
}): string {
  const { cluster, label, agent, sessionId, digestId, related } = input;
  const eventIds = cluster.map((event) => event.id);
  const exactValues: ExactValue[] = [];
  for (const event of cluster) extractExactValues(event, exactValues);
  const seen = new Set<string>();
  const exactRows = exactValues.filter((row) => {
    const key = `${row.kind}${row.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, EXACT_VALUES_MAX);

  const lines: string[] = [
    "## What failed",
    "",
    ...cluster.map((event) =>
      `- [e${event.id}] ${event.ts} \`${event.type}\` — ${
        event.summary.replace(/\s+/g, " ").trim()
      }`
    ),
    "",
    "## Context",
    "",
    `- Failure signature: ${label}`,
    `- Agent: ${agent}`,
    `- Session: ${sessionId ?? "unknown"}`,
    `- Occurrences in session: ${cluster.length}`,
    "",
  ];
  if (exactRows.length > 0) {
    lines.push("## Exact values", "", "| kind | value | source |", "| --- | --- | --- |");
    for (const row of exactRows) {
      lines.push(`| ${row.kind} | \`${row.value}\` | e${row.eventId} |`);
    }
    lines.push("");
  }
  if (related.length > 0) {
    lines.push("## Possibly related", "");
    for (const candidate of related) {
      lines.push(
        `- Possibly related: [${candidate.scope}] ${candidate.id} — ${candidate.title}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Provenance",
    "",
    `- Events: ${eventIds.map((id) => `e${id}`).join(", ")} ` +
      "(drill down with memory_digest { eventId })",
    `- Digest: ${digestId === null ? "none compiled" : `#${digestId}`}`,
    `- Session: ${sessionId ?? "unknown"}`,
    "",
    "UNVERIFIED harvest candidate from the session-boundary mistake " +
      "harvester — a hint, not authority. Verify the failure against the " +
      "cited source events, then promote with an ordinary memory_write " +
      "self-supersede (status verified) before treating it as a lesson.",
    "",
  );
  return lines.join("\n");
}

/** Harvest one session's failure events into unverified pitfall candidates
 * in the repo wiki: one candidate per distinct normalized failure signature
 * (a repeated failure inside the session clusters into a single candidate).
 * Honors the wiki dedup contract both ways: a normalized-title duplicate is
 * re-issued as a self-superseding UPDATE of the existing article (refreshing
 * its provenance), and a similar-but-distinct article earns a "Possibly
 * related:" link in the body — appended and linked, never merged (plan D1). */
export async function harvestPitfalls(
  deps: HarvestPitfallsDeps,
): Promise<PitfallHarvestReport> {
  const write = deps.write ??
    ((input: MemoryWriteInput) => writeMemoryFactFile(deps.repoRoot, input));
  const report: PitfallHarvestReport = { candidates: [], errors: [] };

  const events = deps.store.eventsFor({ agent: deps.agent });
  const failures = events.filter((event) =>
    FAILURE_PATTERN.test(`${event.type} ${event.summary}`)
  );
  if (failures.length === 0) return report;

  // Cluster by normalized error signature, first occurrence's label wins.
  const clusters = new Map<string, { label: string; events: EpisodicEvent[] }>();
  for (const event of failures) {
    const signature = failureSignature(event);
    const cluster = clusters.get(signature.key);
    if (cluster === undefined) {
      clusters.set(signature.key, { label: signature.label, events: [event] });
    } else {
      cluster.events.push(event);
    }
  }

  // The digest was compiled just before this harvest runs, so its id is the
  // drill-down anchor the provenance pointers cite.
  const digest = deps.store.digestFor(
    deps.sessionId === null
      ? { agent: deps.agent }
      : { agent: deps.agent, sessionId: deps.sessionId },
  );
  const articles = (await discoverMemoryFacts(deps.repoRoot, "repo")).map(
    (fact) => ({ id: fact.id, title: fact.title }),
  );

  for (const [signature, cluster] of clusters) {
    try {
      const title = `Pitfall: ${cluster.label}`.slice(0, TITLE_MAX);
      const duplicate = articles.find((article) =>
        normalizeTitle(article.title) === normalizeTitle(title)
      );
      const related: PitfallCandidate["related"] = [];
      if (duplicate === undefined && deps.search !== undefined) {
        // Advisory (dedup layer 2): the cluster's most distinctive token is
        // the FTS probe — an exact-title hit is the duplicate path above, so
        // anything left here is similar-but-distinct and earns a link.
        const probe = cluster.label.split(/\s+/)
          .filter((token) => /^[a-z0-9]{4,}$/i.test(token))
          .sort((a, b) => b.length - a.length)[0];
        if (probe !== undefined) {
          const normalized = normalizeTitle(title);
          for (const hit of deps.search(probe)) {
            if (normalizeTitle(hit.title) === normalized) continue;
            if (
              related.some((candidate) =>
                candidate.scope === hit.scope && candidate.id === hit.id
              )
            ) continue;
            related.push({ scope: hit.scope, id: hit.id, title: hit.title });
            if (related.length >= ADVISORY_MAX) break;
          }
        }
      }
      const body = candidateBody({
        cluster: cluster.events,
        label: cluster.label,
        agent: deps.agent,
        sessionId: deps.sessionId,
        digestId: digest?.id ?? null,
        related,
      });
      const written = await write({
        scope: "repo",
        ...(duplicate === undefined ? {} : { id: duplicate.id }),
        topic: "pitfalls",
        title,
        body,
        tags: ["pitfall", "harvest"],
        source: "orchestrator",
        evidence: `Harvested from ${cluster.events.length} failure event(s) ` +
          `(${
            cluster.events.map((event) => `e${event.id}`).join(", ")
          }) of agent ${deps.agent}, session ${deps.sessionId ?? "unknown"}` +
          (digest === null ? "" : `, digest #${digest.id}`),
        status: "unverified",
        kind: "pitfall",
        supersedes: duplicate === undefined ? [] : [duplicate.id],
      });
      if (duplicate === undefined) {
        // Keep the local view of the wiki current for the next cluster.
        articles.push({ id: written.id, title });
      }
      report.candidates.push({
        id: written.id,
        title,
        action: duplicate === undefined ? "created" : "updated",
        signature,
        eventIds: cluster.events.map((event) => event.id),
        related,
      });
    } catch (error) {
      report.errors.push(
        `${signature}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}
