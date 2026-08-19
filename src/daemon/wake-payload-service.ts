import type { MailStore } from "../mail-service/store";
import {
  factVerificationFlag,
  listMemoryFacts,
} from "../memory-service/memory-store";
import {
  partitionMemoryRecall,
  type MemoryRecallRow,
} from "../memory-service/recall";
import type { WakePayload, WakePayloadRequest } from "../schemas/wake-payload";

export interface WakePayloadServiceDeps {
  readonly mailStore: MailStore;
  readonly repoRoot: () => string;
  readonly wakeBudgetTokens: number;
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Date-ranked recent wiki slice, not a since-last-wake delta. Cap is same order of magnitude as recall limit (8). */
const RECENT_WIKI_LIMIT = 10;

/** Builds the wake payload: mail counts by lane + recent wiki slice clamped to wake_budget_tokens. This is the last-mile wiring that turns a wake schedule into the structured prompt that reaches the model. */
export class WakePayloadService {
  constructor(private readonly deps: WakePayloadServiceDeps) {}

  /** Build the complete wake payload for submission. Queries current mail counts by lane and builds a date-ranked recent wiki slice clamped to wake_budget_tokens. This is NOT a since-last-wake delta - there is no per-agent cursor. It's an honest date-ranked slice of the wiki. */
  async build(request: WakePayloadRequest): Promise<WakePayload> {
    const { recipient, wakeId, oldestItemId, lane } = request;

    // Query current available counts by lane
    const controlAvailable = this.deps.mailStore.countByState(
      recipient,
      "control",
      "available",
    );
    const workAvailable = this.deps.mailStore.countByState(
      recipient,
      "work",
      "available",
    );

    // Build recent wiki slice (date-ranked, not a delta)
    const facts = await listMemoryFacts(this.deps.repoRoot());
    // Sort by date descending, then id for stability (copy to avoid mutating store array)
    const sorted = [...facts].sort((a, b) => {
      const dateComp = b.date.localeCompare(a.date);
      return dateComp !== 0 ? dateComp : a.id.localeCompare(b.id);
    });
    const recent = sorted.slice(0, RECENT_WIKI_LIMIT);

    let state: "ok" | "empty" | "absent";
    let rows: MemoryRecallRow[];

    if (facts.length === 0) {
      state = "empty";
      rows = [];
    } else if (recent.length === 0) {
      state = "empty";
      rows = [];
    } else {
      state = "ok";
      rows = recent.map(
        (fact): MemoryRecallRow => ({
          scope: fact.scope,
          topic: fact.topic,
          id: fact.id,
          date: fact.date,
          title: fact.title,
          snippet: oneLine(fact.body).slice(0, 160),
          status: fact.status,
          flag: factVerificationFlag(fact),
          pitfall: fact.kind === "pitfall",
        }),
      );
    }

    // Partition into pitfalls and articles, clamped to budget
    const partition = partitionMemoryRecall(
      {
        pitfalls: rows.filter((r) => r.pitfall),
        articles: rows.filter((r) => !r.pitfall),
      },
      this.deps.wakeBudgetTokens,
    );

    return {
      wakeId,
      oldestItemId,
      lane,
      mailCounts: {
        controlAvailable,
        workAvailable,
      },
      memoryDelta: {
        state,
        semantic: "disabled" as const,
        pitfalls: partition.pitfalls,
        articles: partition.articles,
        tokens: partition.tokens,
        budget: this.deps.wakeBudgetTokens,
        truncated: partition.truncated,
        omitted: partition.omitted,
        omittedPitfalls: partition.omittedPitfalls,
        omittedArticles: partition.omittedArticles,
      },
    };
  }
}
