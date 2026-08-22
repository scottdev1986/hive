/**
 * P1 #4: Mistakes recurrence≥2 auto-promote
 *
 * When the same mistake/pitfall recurs ≥2 times, auto-promote into durable LTM / pack-relevant memory
 * so new sessions know it without tool lookup.
 */

import type { EpisodicStore } from "./episodic";
import { discoverMemoryFacts, writeMemoryFact } from "./memory-store";
import type { MemoryFact } from "../schemas/memory";

const RECURRENCE_PROMOTION_KEY_PREFIX = "pitfall-promotion.recurrence.";

export interface RecurrenceStats {
  signature: string;
  count: number;
  factId: string;
  lastSeenAt: string;
  promoted: boolean;
}

export interface PromotionReport {
  scanned: number;
  promoted: RecurrenceStats[];
  alreadyPromoted: number;
  belowThreshold: number;
}

function promotionKey(signature: string): string {
  return `${RECURRENCE_PROMOTION_KEY_PREFIX}${signature}`;
}

export function incrementRecurrence(
  episodic: EpisodicStore,
  signature: string,
  factId: string,
  observedAt: string,
): number {
  const key = promotionKey(signature);
  const existing = episodic.readMeta(key);
  const current = existing ? parseInt(existing, 10) : 0;
  const newCount = current + 1;

  episodic.writeMeta(
    key,
    JSON.stringify({
      count: newCount,
      factId,
      lastSeenAt: observedAt,
    }),
  );

  return newCount;
}

export function getRecurrenceCount(
  episodic: EpisodicStore,
  signature: string,
): number {
  const key = promotionKey(signature);
  const data = episodic.readMeta(key);
  if (!data) return 0;

  try {
    const parsed = JSON.parse(data);
    return parsed.count ?? 0;
  } catch {
    return 0;
  }
}

export function markPromoted(episodic: EpisodicStore, signature: string): void {
  const key = promotionKey(signature);
  const data = episodic.readMeta(key);
  if (!data) return;

  try {
    const parsed = JSON.parse(data);
    parsed.promoted = true;
    episodic.writeMeta(key, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

export function isPromoted(
  episodic: EpisodicStore,
  signature: string,
): boolean {
  const key = promotionKey(signature);
  const data = episodic.readMeta(key);
  if (!data) return false;

  try {
    const parsed = JSON.parse(data);
    return parsed.promoted === true;
  } catch {
    return false;
  }
}

export async function autoPromoteMistakes(options: {
  repoRoot: string;
  episodic: EpisodicStore;
}): Promise<PromotionReport> {
  const { repoRoot, episodic } = options;
  const report: PromotionReport = {
    scanned: 0,
    promoted: [],
    alreadyPromoted: 0,
    belowThreshold: 0,
  };

  const pitfalls = (await discoverMemoryFacts(repoRoot, "repo")).filter(
    (fact) => fact.kind === "pitfall",
  );

  for (const pitfall of pitfalls) {
    report.scanned += 1;

    const signature = extractSignatureFromPitfall(pitfall);
    if (!signature) continue;

    const recurrence = getRecurrenceCount(episodic, signature);

    if (isPromoted(episodic, signature)) {
      report.alreadyPromoted += 1;
      continue;
    }

    if (recurrence < 2) {
      report.belowThreshold += 1;
      continue;
    }

    await promoteToAlwaysOn(repoRoot, pitfall);
    markPromoted(episodic, signature);

    report.promoted.push({
      signature,
      count: recurrence,
      factId: pitfall.id,
      lastSeenAt: pitfall.date,
      promoted: true,
    });
  }

  return report;
}

function extractSignatureFromPitfall(pitfall: MemoryFact): string | null {
  const match = pitfall.body.match(/- Failure signature: (.+)/);
  return match?.[1] ?? null;
}

async function promoteToAlwaysOn(
  repoRoot: string,
  pitfall: MemoryFact,
): Promise<void> {
  const promoted = await writeMemoryFact(repoRoot, {
    scope: "repo",
    topic: "mistakes-promoted",
    title: `[AUTO-PROMOTED] ${pitfall.title}`,
    body: `${pitfall.body}\n\n---\n\n**AUTO-PROMOTED**: This mistake recurred ≥2 times and has been promoted to always-on memory. All agents will see this in their wake pack without needing to search.`,
    tags: [...pitfall.tags, "promoted", "always-on"],
    source: "consolidator",
    evidence: `Auto-promoted from ${pitfall.id} due to recurrence ≥2`,
    status: pitfall.status,
    kind: "pitfall",
    date: new Date().toISOString().split("T")[0],
    supersedes: [pitfall.id],
  });

  return;
}
