import type { EpisodicEvent, EpisodicStore } from "./episodic";
import { isRecord, isString } from "../shared/is-record";
import type { JsonValue } from "../shared/json";

export interface PreferenceSignal {
  category: "style" | "tool" | "pattern" | "workflow";
  preference: string;
  rationale: string;
  confidence: "high" | "medium" | "low";
  observedAt: string;
  eventIds: number[];
}

export interface PreferenceHarvestReport {
  signals: PreferenceSignal[];
  skipped: number;
  errors: string[];
}

function eventData(event: EpisodicEvent): Partial<Record<string, JsonValue>> {
  try {
    const provenance: JsonValue = JSON.parse(event.provenance);
    if (!isRecord(provenance) || !("data" in provenance)) {
      return {};
    }
    const data = provenance.data;
    if (isRecord(data)) {
      // SAFETY: isRecord type guard confirms data is a record before narrowing to the return type
      return data as Partial<Record<string, JsonValue>>;
    }
    return {};
  } catch {
    return {};
  }
}

function extractPreferenceSignal(
  event: EpisodicEvent,
): PreferenceSignal | null {
  const data = eventData(event);

  // User approval/rejection events signal preferences
  if (event.type === "user.approved" || event.type === "user.preference") {
    const preference = isString(data.preference)
      ? data.preference.trim()
      : null;
    // SAFETY: isString guard confirms category is string; assertion narrows to union member
    const category = isString(data.category)
      ? (data.category as PreferenceSignal["category"])
      : "workflow";

    if (preference && preference.length > 0) {
      return {
        category,
        preference,
        rationale: event.summary,
        confidence: "high",
        observedAt: event.ts,
        eventIds: [event.id],
      };
    }
  }

  // Feedback events with "prefer" or "like" language
  if (event.type === "user.feedback" || event.type === "agent.feedback") {
    const feedback = event.summary.toLowerCase();
    if (
      feedback.includes("prefer") ||
      feedback.includes("like") ||
      feedback.includes("always") ||
      feedback.includes("never")
    ) {
      // Extract the preference statement
      const lines = event.summary.split("\n");
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (
          lower.includes("prefer") ||
          lower.includes("like") ||
          lower.includes("always") ||
          lower.includes("never")
        ) {
          return {
            category: "workflow",
            preference: line.trim(),
            rationale: `Extracted from user feedback: ${event.summary.slice(0, 100)}`,
            confidence: "medium",
            observedAt: event.ts,
            eventIds: [event.id],
          };
        }
      }
    }
  }

  return null;
}

function normalizePreference(pref: string): string {
  return pref
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clusterPreferences(
  signals: PreferenceSignal[],
): Map<string, { signal: PreferenceSignal; eventIds: number[] }> {
  const clusters = new Map<
    string,
    { signal: PreferenceSignal; eventIds: number[] }
  >();

  for (const signal of signals) {
    const key = `${signal.category}:${normalizePreference(signal.preference)}`;

    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, {
        signal,
        eventIds: [...signal.eventIds],
      });
    } else {
      existing.eventIds.push(...signal.eventIds);
    }
  }

  return clusters;
}

function harvestedPreferenceKey(signature: string): string {
  return `preference-harvest.persisted.${signature}`;
}

function readHarvestHighWater(store: EpisodicStore): number {
  const raw = store.readMeta("preference-harvest.high-water");
  if (raw === null) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeHarvestHighWater(store: EpisodicStore, eventId: number): void {
  store.writeMeta("preference-harvest.high-water", String(eventId));
}

export interface HarvestPreferencesDeps {
  store: EpisodicStore;
  minRecurrence?: number;
}

/**
 * Harvest preference signals from episodic events.
 * Returns signals that recur ≥minRecurrence times (default 2).
 * Does NOT write to profile - returns signals for proposal generation only.
 */
export async function harvestPreferences(
  deps: HarvestPreferencesDeps,
): Promise<PreferenceHarvestReport> {
  const { store } = deps;
  const minRecurrence = deps.minRecurrence ?? 2;

  const report: PreferenceHarvestReport = {
    signals: [],
    skipped: 0,
    errors: [],
  };

  const highWater = readHarvestHighWater(store);
  const allEvents = store.eventsFor();
  const newEvents = allEvents.filter((event) => event.id > highWater);

  if (newEvents.length === 0) {
    return report;
  }

  let maxExaminedId = highWater;
  for (const event of newEvents) {
    if (event.id > maxExaminedId) maxExaminedId = event.id;
  }

  // Extract preference signals from events
  const signals: PreferenceSignal[] = [];
  for (const event of newEvents) {
    try {
      const signal = extractPreferenceSignal(event);
      if (signal) {
        signals.push(signal);
      } else {
        report.skipped += 1;
      }
    } catch (error) {
      report.errors.push(
        `Event ${event.id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  // Cluster by normalized preference and count actual events
  const clusters = clusterPreferences(signals);

  // Emit signals for clusters with event count ≥ minRecurrence
  // Accumulate eventIds across passes for recurrence persistence
  for (const [key, cluster] of clusters) {
    const persistedKey = harvestedPreferenceKey(key);
    const priorIdsRaw = store.readMeta(persistedKey);
    const priorIds: number[] = priorIdsRaw ? JSON.parse(priorIdsRaw) : [];

    // Merge new eventIds with prior eventIds
    const allEventIds = Array.from(
      new Set([...priorIds, ...cluster.eventIds]),
    ).sort((a, b) => a - b);
    const eventCount = allEventIds.length;

    // Persist accumulated eventIds for next pass
    store.writeMeta(persistedKey, JSON.stringify(allEventIds));

    if (eventCount >= minRecurrence) {
      // Check if already proposed
      const proposedKey = `preference-harvest.proposed.${key}`;
      if (!store.readMeta(proposedKey)) {
        report.signals.push({
          category: cluster.signal.category,
          preference: cluster.signal.preference,
          rationale: `Observed ${eventCount} times`,
          confidence:
            eventCount >= 5
              ? "high"
              : eventCount >= 3
                ? "medium"
                : cluster.signal.confidence,
          observedAt: new Date().toISOString(),
          eventIds: allEventIds,
        });

        // Mark as proposed
        store.writeMeta(proposedKey, "true");
      }
    }
  }

  writeHarvestHighWater(store, maxExaminedId);

  return report;
}

/**
 * Generate proposal text for a preference signal.
 * This formats the preference for review-gated inclusion in ~/.hive/profile.md.
 */
export function formatPreferenceProposal(signal: PreferenceSignal): string {
  const categoryHeader = {
    style: "Code Style",
    tool: "Tool Preferences",
    pattern: "Patterns and Practices",
    workflow: "Workflow Preferences",
  }[signal.category];

  return [
    `## ${categoryHeader}`,
    "",
    `- ${signal.preference}`,
    "",
    `**Rationale**: ${signal.rationale}`,
    `**Confidence**: ${signal.confidence}`,
    `**Observed**: ${signal.observedAt.slice(0, 10)}`,
    `**Events**: ${signal.eventIds.map((id) => `e${id}`).join(", ")}`,
  ].join("\n");
}
