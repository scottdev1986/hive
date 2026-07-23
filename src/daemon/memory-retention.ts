// The tiered-retention sweep (HiveMemory HM-2 WP3, board #72;
// planning/story-m3-s37-digests-lifecycle.md DoD 5 + DoD 7). One pass does
// three things against the daemon's own memory state:
//
//   1. Ages out the raw hot tier: episodic `events` rows older than
//      `events_hot_days` are deleted — EXCEPT any row a digest's provenance
//      still references, because a referenced event is a drill-down target
//      (DoD 6's reference-check spirit, adapted: WorkManifest does not exist
//      yet, digests do as a table).
//   2. Never touches `facts` or `digests`: `facts_retention` and
//      `digests_retention` are "forever" by invariant, not by knob — facts
//      are bi-temporal history and the digest is the downsample the aged
//      events collapse into.
//   3. Demotes verified wiki articles whose `verified` date is older than
//      `stale_after_days` to `stale`, in both repo and global scope, through
//      the memory adapter's own update mechanics so article file, scope
//      index, and log stay consistent. Stale is a demotion, not a deletion:
//      the article stays visible and readable.
//
// The sweep is maintenance, not authority: the daemon logs a failure and
// keeps running.
import {
  demoteMemoryFact,
  discoverMemoryFacts,
} from "../adapters/memory";
import type { MemoryRetentionConfig, MemoryScope } from "../schemas";
import type { EpisodicStore } from "./episodic-store";
import { countConsolidationCandidates } from "./memory-consolidate";

export interface RetentionSweepReport {
  eventsDeleted: number;
  articlesDemoted: Array<{ scope: MemoryScope; id: string }>;
  /** Stored-vector pairs at or above the consolidation similar threshold
   * (HiveMemory HM-5, D1 layer 3): count only, never applied here — the
   * drift signal that tells the operator `hive memory consolidate` is worth
   * a run. */
  consolidationCandidates: number;
}

const DAY_MS = 24 * 3_600_000;

// WP4's digest compiler owns the provenance shape; the reference check knows
// only this contract: an event pointer is a positive integer under a key
// bearing "event" (`eventId`, `eventIds`, `events`, …) or an object shaped
// `{ type|kind: "event", id: <int> }` anywhere in the JSON tree.
function collectReferencedEventIds(
  value: unknown,
  into: Set<number>,
  key?: string,
): void {
  if (
    typeof value === "number" && Number.isInteger(value) && value > 0 &&
    key !== undefined && /event/i.test(key)
  ) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferencedEventIds(item, into, key);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      (record.type === "event" || record.kind === "event") &&
      typeof record.id === "number" && Number.isInteger(record.id) &&
      record.id > 0
    ) {
      into.add(record.id);
    }
    for (const [childKey, childValue] of Object.entries(record)) {
      collectReferencedEventIds(childValue, into, childKey);
    }
  }
}

/** Every event id any digest still points at. A digest provenance blob that
 * does not parse might reference anything, so it fails closed: the caller
 * keeps every event this pass rather than risk breaking a drill-down. */
function referencedEventIds(
  provenanceBlobs: string[],
): ReadonlySet<number> | "unparseable" {
  const ids = new Set<number>();
  for (const blob of provenanceBlobs) {
    try {
      collectReferencedEventIds(JSON.parse(blob), ids);
    } catch {
      return "unparseable";
    }
  }
  return ids;
}

export async function runRetentionSweep(options: {
  episodic: EpisodicStore;
  repoRoot: string;
  config: MemoryRetentionConfig;
  now: Date;
}): Promise<RetentionSweepReport> {
  const { episodic, repoRoot, config, now } = options;
  const report: RetentionSweepReport = {
    eventsDeleted: 0,
    articlesDemoted: [],
    consolidationCandidates: 0,
  };

  // (1) Hot-tier events age out; digest-referenced rows survive.
  const referenced = referencedEventIds(episodic.digestProvenanceBlobs());
  if (referenced === "unparseable") {
    console.error(
      "Hive memory retention sweep skipped event deletion: a digest " +
        "provenance blob does not parse, so no event can be proven " +
        "unreferenced this pass",
    );
  } else {
    const cutoff = new Date(now.getTime() - config.events_hot_days * DAY_MS)
      .toISOString();
    report.eventsDeleted = episodic.sweepEvents(cutoff, referenced);
  }

  // (2) Nothing to do: facts and digests are kept forever by invariant.

  // (3) Verified wiki articles whose verification aged out demote to stale.
  const staleCutoff = new Date(now.getTime() - config.stale_after_days * DAY_MS)
    .toISOString().slice(0, 10);
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

  // (4) Consolidation drift signal (HiveMemory HM-5, D1 layer 3): count
  // duplicate candidate pairs in the vector store so a growing pile is
  // visible in the sweep report. Count only — consolidation is an offline,
  // operator-run pass, never something the sweep applies.
  report.consolidationCandidates = countConsolidationCandidates(episodic);

  return report;
}
