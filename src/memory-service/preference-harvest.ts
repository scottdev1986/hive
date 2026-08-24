/**
 * P1 Item #8: Preference learning and harvesting
 *
 * Extracts user preferences from episodic events and generates review-gated
 * proposals for ~/.hive/profile.md. Never writes profile silently.
 *
 * Preferences are harvested from:
 * - Approval/rejection patterns (user.approved / user.rejected events)
 * - Repeated corrections or feedback
 * - Explicit preference statements in user feedback
 *
 * All harvested preferences go through the proposals inbox before applying.
 */

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

interface PreferenceCluster {
  category: PreferenceSignal["category"];
  preference: string;
  events: EpisodicEvent[];
  confidence: PreferenceSignal["confidence"];
}

function eventData(event: EpisodicEvent): Partial<Record<string, JsonValue>> {
  try {
    const provenance: JsonValue = JSON.parse(event.provenance);
    if (!isRecord(provenance) || !("data" in provenance)) {
      return {};
    }
    const data = provenance.data;
    if (isRecord(data)) return data as Partial<Record<string, JsonValue>>;
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

  // Repeated tool/command patterns (recurrence signals preference)
  if (
    event.type === "agent.tool-used" ||
    event.type === "command.executed" ||
    event.type === "tool.success"
  ) {
    const tool = isString(data.tool) ? data.tool.trim() : null;
    const command = isString(data.command) ? data.command.trim() : null;
    const target = tool ?? command;

    if (target && target.length > 0) {
      return {
        category: "tool",
        preference: `Use ${target}`,
        rationale: `Observed successful use of ${target}`,
        confidence: "low",
        observedAt: event.ts,
        eventIds: [event.id],
      };
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
): Map<string, PreferenceCluster> {
  const clusters = new Map<string, PreferenceCluster>();

  for (const signal of signals) {
    const key = `${signal.category}:${normalizePreference(signal.preference)}`;

    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, {
        category: signal.category,
        preference: signal.preference,
        events: [],
        confidence: signal.confidence,
      });
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

  // Cluster by normalized preference
  const clusters = clusterPreferences(signals);

  // Count recurrences for each cluster
  const recurrenceCounts = new Map<string, number>();
  for (const [key] of clusters) {
    const persistedKey = harvestedPreferenceKey(key);
    const persisted = store.readMeta(persistedKey);
    const count = persisted ? Number(persisted) + 1 : 1;
    recurrenceCounts.set(key, count);
  }

  // Emit signals for clusters with recurrence ≥ minRecurrence
  for (const [key, cluster] of clusters) {
    const count = recurrenceCounts.get(key) ?? 0;
    if (count >= minRecurrence) {
      // Check if already proposed
      const proposedKey = `preference-harvest.proposed.${key}`;
      if (!store.readMeta(proposedKey)) {
        report.signals.push({
          category: cluster.category,
          preference: cluster.preference,
          rationale: `Observed ${count} times`,
          confidence:
            count >= 5 ? "high" : count >= 3 ? "medium" : cluster.confidence,
          observedAt: new Date().toISOString(),
          eventIds: signals
            .filter(
              (s) =>
                `${s.category}:${normalizePreference(s.preference)}` === key,
            )
            .flatMap((s) => s.eventIds),
        });

        // Mark as proposed
        store.writeMeta(proposedKey, "true");
      }
    }

    // Update recurrence count
    const persistedKey = harvestedPreferenceKey(key);
    store.writeMeta(persistedKey, String(count));
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
