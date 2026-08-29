import type { MemoryRetentionConfig } from "../schemas/config-schema";
import type { MemoryFact, MemoryScope } from "../schemas/memory";
import { countConsolidationCandidates } from "./consolidate";
import type { EpisodicStore } from "./episodic";
import { demoteMemoryFact, discoverMemoryFacts } from "./memory-store";

export interface RetentionSweepReport {
  eventsDeleted: number;
  articlesDemoted: Array<{ scope: MemoryScope; id: string }>;
  /** Stored-vector pairs at or above the consolidation similar threshold: count only, never applied here — the drift signal that tells the user `hive memory consolidate` is worth a run. */
  consolidationCandidates: number;
}

const DAY_MS = 24 * 3_600_000;

/** P0: Extract episode IDs referenced in memory fact provenance using structured eventIds field. Falls back to regex for legacy facts without structured provenance. */
function extractReferencedEpisodeIds(facts: MemoryFact[]): Set<number> {
  const episodeIds = new Set<number>();
  const episodePattern = /\b(?:episode|event|E)\s*#?(\d+)\b/gi;

  for (const fact of facts) {
    // Primary path: use structured eventIds field when present
    if (fact.eventIds !== undefined) {
      for (const id of fact.eventIds) {
        episodeIds.add(id);
      }
      continue;
    }

    // Fallback path for legacy facts: regex-based extraction
    if (fact.evidence) {
      for (const match of fact.evidence.matchAll(episodePattern)) {
        const id = Number(match[1]);
        if (!Number.isNaN(id)) episodeIds.add(id);
      }
    }

    for (const rawText of fact.raw) {
      for (const match of rawText.matchAll(episodePattern)) {
        const id = Number(match[1]);
        if (!Number.isNaN(id)) episodeIds.add(id);
      }
    }
  }

  return episodeIds;
}

export async function runRetentionSweep(options: {
  episodic: EpisodicStore;
  repoRoot: string;
  config: MemoryRetentionConfig;
  now: Date;
  /** Pairwise vector scan. Skip it on a kill-time sweep: the count is a diagnostic, and running it on the request thread is what made /handshave miss its 1s budget. */
  countCandidates?: boolean;
}): Promise<RetentionSweepReport> {
  const { episodic, repoRoot, config, now } = options;
  const report: RetentionSweepReport = {
    eventsDeleted: 0,
    articlesDemoted: [],
    consolidationCandidates: 0,
  };

  const cutoff = new Date(
    now.getTime() - config.events_hot_days * DAY_MS,
  ).toISOString();

  // P0: Build real keep-set from active ledger/pitfall provenance before sweep
  const allFacts = [
    ...(await discoverMemoryFacts(repoRoot, "repo")),
    ...(await discoverMemoryFacts(repoRoot, "global")),
  ];
  const keepIds = extractReferencedEpisodeIds(allFacts);

  report.eventsDeleted = episodic.sweepEvents(cutoff, keepIds);

  // (3) Verified wiki articles whose verification aged out demote to stale.
  const staleCutoff = new Date(now.getTime() - config.stale_after_days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const demotionDate = now.toISOString().slice(0, 10);
  for (const scope of ["repo", "global"] as const) {
    for (const fact of await discoverMemoryFacts(repoRoot, scope)) {
      if (fact.status !== "verified" || fact.verified === undefined) continue;
      if (fact.verified >= staleCutoff) continue;
      const demoted = await demoteMemoryFact(repoRoot, scope, fact.id, {
        date: demotionDate,
      });
      if (demoted !== null) {
        report.articlesDemoted.push({ scope, id: demoted.id });
      }
    }
  }

  // Count duplicate candidate pairs in the vector store so a growing pile is visible in the sweep report. Count only — consolidation is an offline, user-run pass, never something the sweep applies.
  if (options.countCandidates !== false) {
    report.consolidationCandidates = countConsolidationCandidates(episodic);
  }

  return report;
}
