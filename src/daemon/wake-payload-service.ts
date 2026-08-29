import type { MailStore } from "../mail-service/store";
import {
  buildMemoryRecallBundle,
  partitionMemoryRecall,
  type MemoryRecallDeps,
} from "../memory-service/recall";
import type { WakePayload, WakePayloadRequest } from "../schemas/wake-payload";

export interface WakePayloadServiceDeps {
  readonly mailStore: MailStore;
  readonly repoRoot: () => string;
  readonly wakeBudgetTokens: number;
  readonly memoryRecallDeps: () => MemoryRecallDeps;
}

/** Build named wake query from available context. Returns lane-only query when topic/objective/lastMailSnippet are all absent or empty. */
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

/** Builds the wake payload: mail counts by lane + memory recall from named query. Calls buildMemoryRecallBundle which conditionally uses hybrid recall when semantic is available or falls back to FTS-only. */
export class WakePayloadService {
  constructor(private readonly deps: WakePayloadServiceDeps) {}

  /** Build wake payload with memory recall via buildMemoryRecallBundle (hybrid when semantic available, FTS-only otherwise). Query built from lane + mail topic + snippet. */
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

    // Populate wake context from mail if not provided by caller
    const enrichedRequest = { ...request };
    if (!request.topic && !request.objective && !request.lastMailSnippet) {
      const mailItem = this.deps.mailStore.getItem(oldestItemId);
      if (mailItem !== null) {
        enrichedRequest.topic = mailItem.topic;
        enrichedRequest.lastMailSnippet = mailItem.body.slice(0, 300);
      }
    }

    // P0: Named query construction from wake context
    const query = buildWakeQuery(enrichedRequest);

    // P0: Real buildMemoryRecallBundle (hybrid when semantic available, FTS-only otherwise)
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
