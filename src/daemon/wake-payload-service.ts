import type { MailStore } from "../mail-service/store";
import type { MemoryIndex } from "../memory-service/fts-index";
import {
  buildMemoryRecallBundle,
  partitionMemoryRecall,
} from "../memory-service/recall";
import type {
  WakePayload,
  WakePayloadRequest,
} from "../schemas/wake-payload";

export interface WakePayloadServiceDeps {
  readonly mailStore: MailStore;
  readonly repoRoot: () => string;
  readonly memory: Pick<MemoryIndex, "search"> | null;
  readonly semantic?: (
    query: string,
    limit: number,
  ) => Promise<Array<{ scope: string; id: string; score: number }> | null>;
  readonly semanticStatus?: () => string;
  readonly wakeBudgetTokens: number;
}

/** Builds the wake payload: mail counts by lane + memory delta clamped to wake_budget_tokens. This is the last-mile wiring that turns a wake schedule into the structured prompt that reaches the model. */
export class WakePayloadService {
  constructor(private readonly deps: WakePayloadServiceDeps) {}

  /** Build the complete wake payload for submission. Queries current mail counts by lane and builds a memory recall delta clamped to wake_budget_tokens. The memory query is intentionally simple: it searches for the recipient name as a proxy for "what changed for this agent". A more sophisticated query (e.g., task-matching pitfalls) would require per-agent state tracking, which is out of scope for this last-mile wiring. */
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

    // Build memory recall delta
    // Simple query: recipient name. A production system might track last-wake timestamp per agent and query "changed since X", but that requires per-agent state. This is the minimal honest query: search for the agent's name.
    const memoryQuery = recipient;
    const bundle = await buildMemoryRecallBundle(memoryQuery, this.deps, 8);
    const partition = partitionMemoryRecall(bundle, this.deps.wakeBudgetTokens);

    return {
      wakeId,
      oldestItemId,
      lane,
      mailCounts: {
        controlAvailable,
        workAvailable,
      },
      memoryDelta: {
        state: bundle.state,
        semantic: bundle.semantic,
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
