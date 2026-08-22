import type { MailStore } from "../mail-service/store";
import { factVerificationFlag } from "../memory-service/memory-store";
import {
  buildMemoryRecallBundle,
  partitionMemoryRecall,
  type MemoryRecallDeps,
  type MemoryRecallRow,
} from "../memory-service/recall";
import type { WakePayload, WakePayloadRequest } from "../schemas/wake-payload";

export interface WakePayloadServiceDeps {
  readonly mailStore: MailStore;
  readonly repoRoot: () => string;
  readonly wakeBudgetTokens: number;
  readonly memoryRecallDeps: () => MemoryRecallDeps;
}

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** P0: Build named wake query from context. */
function buildWakeQuery(request: WakePayloadRequest): string {
  const parts: string[] = [];
  
  if (request.lane) parts.push(request.lane);
  if (request.topic) parts.push(request.topic);
  if (request.objective) parts.push(request.objective);
  if (request.lastMailSnippet) {
    parts.push(request.lastMailSnippet.slice(0, 200));
  }
  
  return parts.filter((p) => p.trim().length > 0).join(" ");
}

/** Builds the wake payload: mail counts by lane + memory recall from named query. P0: Uses real buildMemoryRecallBundle with hybrid recall, not newest-10 date slice. */
export class WakePayloadService {
  constructor(private readonly deps: WakePayloadServiceDeps) {}

  /** P0: Build wake payload with real recall (named query + hybrid). Not newest-10 date slice; not hardcoded semantic disabled. */
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

    // P0: Named query construction from wake context
    const query = buildWakeQuery(request);
    
    // P0: Real buildMemoryRecallBundle with hybrid (not newest-10)
    const bundle = await buildMemoryRecallBundle(
      query,
      this.deps.memoryRecallDeps(),
      8, // same limit as before
    );

    // Partition into pitfalls and articles, clamped to budget
    const partition = partitionMemoryRecall(
      {
        pitfalls: bundle.pitfalls,
        articles: bundle.articles,
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
        state: bundle.state,
        semantic: bundle.semantic, // P0: Real semantic status, not hardcoded "disabled"
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
