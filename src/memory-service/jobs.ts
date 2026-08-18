// Daemon-owned memory maintenance jobs. Every one of these operations already existed as a CLI command or an internal call. What was missing is the thing a user actually needs: a record that survives the operation. A job here writes a receipt before it starts, rewrites it as it progresses, and finishes by reading the stores back and recording what they now say — not what the job's own loop counter believed it did. "Reindexed 42 articles" is an act; "the index now holds 42 rows and the wiki holds 42 files" is a state, and only the second one can be checked. A failing job is isolated: it records its failure and returns. It never throws into the caller and never stops the next job.

import {
  type MemoryJobKind,
  type MemoryJobProgress,
  type MemoryJobReceipt,
  MemoryJobReceiptSchema,
} from "../schemas/memory-projections";
import type { MemoryScope, MemoryWriteInput } from "../schemas/memory";
import { runMemoryConsolidation } from "./consolidate";
import type { MemoryEmbeddingService } from "./embeddings";
import type { EpisodicStore } from "./episodic";
import type { MemoryIndex } from "./fts-index";
import type { RetentionSweepReport } from "./retention";
import { listMemoryFacts } from "./memory-store";

const RECEIPT_KEY = "memoryJobReceipt:";
const SEQUENCE_KEY = "memoryJobSequence";
/** How many receipts are kept. Bounded so a user polling a job for an hour cannot grow the store without limit; twenty covers "what happened recently", which is all a receipt log is for. */
const RECEIPT_LIMIT = 20;

export class MemoryJobStore {
  constructor(private readonly episodic: EpisodicStore) {}

  nextId(kind: MemoryJobKind): string {
    const previous = Number(this.episodic.readMeta(SEQUENCE_KEY) ?? "0");
    const next = previous + 1;
    this.episodic.writeMeta(SEQUENCE_KEY, String(next));
    return `${String(next).padStart(8, "0")}-${kind}`;
  }

  put(receipt: MemoryJobReceipt): void {
    this.episodic.writeMeta(
      `${RECEIPT_KEY}${receipt.id}`,
      JSON.stringify(MemoryJobReceiptSchema.parse(receipt)),
    );
    const keys = this.episodic.metaKeys(RECEIPT_KEY);
    for (const stale of keys.slice(
      0,
      Math.max(0, keys.length - RECEIPT_LIMIT),
    )) {
      this.episodic.deleteMeta(stale);
    }
  }

  /** Newest first. A receipt that no longer parses is dropped rather than failing the whole projection — one corrupt row must not hide the rest. */
  recent(): MemoryJobReceipt[] {
    const receipts: MemoryJobReceipt[] = [];
    for (const key of this.episodic.metaKeys(RECEIPT_KEY).reverse()) {
      const raw = this.episodic.readMeta(key);
      if (raw === null) continue;
      // safeParse does not make JSON.parse safe — a truncated row throws before the schema is ever consulted, and one such row would take the whole receipt list with it.
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = MemoryJobReceiptSchema.safeParse(decoded);
      if (parsed.success) receipts.push(parsed.data);
    }
    return receipts;
  }

  /** The newest receipt for each kind that has ever run here. A kind that has never run is absent from the list — never present with a zeroed receipt, which would read as "ran, did nothing". */
  latestPerKind(): MemoryJobReceipt[] {
    const seen = new Map<MemoryJobKind, MemoryJobReceipt>();
    for (const receipt of this.recent()) {
      if (!seen.has(receipt.kind)) seen.set(receipt.kind, receipt);
    }
    return [...seen.values()];
  }
}

export interface MemoryJobDeps {
  repoRoot: string;
  index: MemoryIndex | null;
  episodic: EpisodicStore | null;
  embeddingService: MemoryEmbeddingService | null;
  /** The daemon's own write path, so consolidation apply stays inside the same serialized memory boundary as agent writes. */
  writeMemoryFact: (
    input: MemoryWriteInput,
  ) => Promise<{ scope: MemoryScope; id: string }>;
  /** The daemon's own retention sweep, not `runRetentionSweep` directly. The sweep rewrites article files to demote them, so it has to run inside the serialized memory path and be followed by an FTS reprojection. Calling the bare function skips both: the demotion lands on disk while the index still reports the article `verified`, and the receipt says "succeeded" over the top of it. Returns null when the sweep is switched off on this daemon or a run is already in flight. */
  runRetentionSweep: () => Promise<RetentionSweepReport | null>;
  /** The daemon's own reindex, not `index.rebuild` directly. A rebuild deletes every FTS row and reinserts from the files it just listed. Run outside the serialized memory path it races an in-flight write: the write lands on disk, the rebuild's file listing predates it, and the article is missing from the index afterwards — under a "succeeded" receipt, because the job saw no error. */
  rebuildMemoryIndex: () => Promise<{ count: number }>;
  now: () => Date;
}

/** Thrown by a job that cannot run because the store it needs is not here. The distinction matters in the receipt: "could not run" is not "ran and found nothing". */
class JobUnavailable extends Error {}

type Report = (progress: MemoryJobProgress) => void;

export interface StartedMemoryJob {
  receipt: MemoryJobReceipt;
  done: Promise<MemoryJobReceipt>;
}

/** Record the running receipt, then run. The receipt is written BEFORE the work starts: a job that dies mid-run leaves a receipt stuck in `running`, which is a true statement about what is known, whereas writing the receipt at the end would leave no trace at all that it was attempted. */
export function startMemoryJob(
  store: MemoryJobStore,
  deps: MemoryJobDeps,
  kind: MemoryJobKind,
  requestedBy: string,
): StartedMemoryJob {
  const startedAt = deps.now().toISOString();
  const receipt: MemoryJobReceipt = {
    id: store.nextId(kind),
    kind,
    state: "running",
    requestedBy,
    startedAt,
    finishedAt: null,
    progress: { step: "starting", done: 0, total: null },
    summary: "",
    error: null,
    readback: null,
  };
  store.put(receipt);

  const done = (async (): Promise<MemoryJobReceipt> => {
    let latest: MemoryJobReceipt = receipt;
    const report: Report = (progress) => {
      latest = { ...latest, progress };
      store.put(latest);
    };
    try {
      const outcome = await runJobBody(deps, kind, report);
      latest = {
        ...latest,
        state: "succeeded",
        finishedAt: deps.now().toISOString(),
        summary: outcome.summary,
        readback: outcome.readback,
      };
    } catch (error) {
      latest = {
        ...latest,
        state: "failed",
        finishedAt: deps.now().toISOString(),
        summary:
          error instanceof JobUnavailable
            ? "could not run"
            : "failed part-way through",
        error: error instanceof Error ? error.message : "unknown error",
        // A failed job still reads the stores back where it can. What the stores hold after a failure is exactly what the user needs to know, and it is never what the job intended.
        readback: await safeReadback(deps),
      };
    }
    store.put(latest);
    return latest;
  })();

  return { receipt, done };
}

interface JobOutcome {
  summary: string;
  readback: Record<string, number | string>;
}

async function runJobBody(
  deps: MemoryJobDeps,
  kind: MemoryJobKind,
  report: Report,
): Promise<JobOutcome> {
  switch (kind) {
    case "reindex":
      return await runReindex(deps, report);
    case "retention-sweep":
      return await runSweep(deps, report);
    case "consolidation-dry-run":
      return await runConsolidation(deps, report, false);
    case "consolidation-apply":
      return await runConsolidation(deps, report, true);
  }
}

async function currentCounts(
  deps: MemoryJobDeps,
): Promise<Record<string, number | string>> {
  const facts = await listMemoryFacts(deps.repoRoot);
  const counts: Record<string, number | string> = {
    wikiArticles: facts.length,
    ftsRows: deps.index === null ? "absent" : deps.index.count(),
  };
  if (deps.episodic !== null) {
    counts.events = deps.episodic.rowCounts().events;
  }
  return counts;
}

async function safeReadback(
  deps: MemoryJobDeps,
): Promise<Record<string, number | string> | null> {
  return await currentCounts(deps).catch(() => null);
}

async function runReindex(
  deps: MemoryJobDeps,
  report: Report,
): Promise<JobOutcome> {
  if (deps.index === null) {
    throw new JobUnavailable("this daemon has no memory search index wired");
  }
  report({ step: "rebuilding index files and FTS", done: 0, total: 1 });
  const result = await deps.rebuildMemoryIndex();
  report({ step: "reading back", done: 1, total: 1 });
  const readback = await currentCounts(deps);
  return {
    summary: `reindexed ${result.count} compiled articles`,
    readback,
  };
}

async function runSweep(
  deps: MemoryJobDeps,
  report: Report,
): Promise<JobOutcome> {
  if (deps.episodic === null) {
    throw new JobUnavailable("this daemon has no episodic store open");
  }
  report({ step: "sweeping", done: 0, total: 1 });
  const swept = await deps.runRetentionSweep();
  if (swept === null) {
    throw new JobUnavailable(
      "the retention sweep is not configured on this daemon, or a sweep was " +
        "already running — nothing was swept by this job",
    );
  }
  report({ step: "reading back", done: 1, total: 1 });
  return {
    summary:
      `deleted ${swept.eventsDeleted} aged events, demoted ` +
      `${swept.articlesDemoted.length} articles to stale, ` +
      `${swept.consolidationCandidates} consolidation candidates`,
    readback: {
      ...(await currentCounts(deps)),
      articlesDemoted: swept.articlesDemoted.length,
      consolidationCandidates: swept.consolidationCandidates,
    },
  };
}

async function runConsolidation(
  deps: MemoryJobDeps,
  report: Report,
  apply: boolean,
): Promise<JobOutcome> {
  const { episodic, embeddingService } = deps;
  if (episodic === null || embeddingService === null) {
    throw new JobUnavailable(
      "consolidation needs the episodic store and the semantic surface, and " +
        "at least one is not available on this daemon",
    );
  }
  report({ step: apply ? "applying" : "scanning", done: 0, total: 1 });
  const result = await runMemoryConsolidation({
    repoRoot: deps.repoRoot,
    episodic,
    service: embeddingService,
    apply,
    writeMemoryFact: deps.writeMemoryFact,
  });
  report({ step: "reading back", done: 1, total: 1 });
  return {
    summary:
      `${result.scanned} vectors scanned, ${result.identical.length} ` +
      `identical and ${result.similar.length} similar pairs, ` +
      `${result.applied.length} applied`,
    readback: {
      ...(await currentCounts(deps)),
      scanned: result.scanned,
      identical: result.identical.length,
      similar: result.similar.length,
      applied: result.applied.length,
      failures: result.failures.length,
    },
  };
}
