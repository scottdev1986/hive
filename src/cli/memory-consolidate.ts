// `hive memory consolidate` (HiveMemory HM-5, board #122; plan D1 layer 3):
// the offline consolidation dedup pass over THIS project's memory stores
// (repo + global wiki articles and the project's episodic facts). Report
// first: default mode finds and groups duplicate pairs, changes nothing, and
// exits 0 even with findings — it is a report, not a gate. `--apply`
// supersedes only the ≥0.95 identical bucket (older into newer) through the
// memory system's own write paths; the similar bucket is never auto-applied
// (D1: false merges destroy information irreversibly). Real errors — the
// semantic surface being unavailable, an apply the write path refused —
// exit nonzero.
import { loadHiveConfig } from "../config/load";
import {
  type ConsolidationCandidate,
  type ConsolidationReport,
  runMemoryConsolidation,
} from "../daemon/memory-consolidate";
import { MemoryEmbeddingService } from "../daemon/memory-embeddings";
import { EpisodicStore } from "../daemon/episodic-store";
import { projectRootOrCwd } from "./project-root";

function printGroup(
  label: string,
  recommendation: string,
  pairs: ConsolidationCandidate[],
): void {
  console.log(`${label} (${pairs.length}) — ${recommendation}`);
  for (const pair of pairs) {
    const where = pair.kind === "article" ? `${pair.kind}:${pair.scope}` : pair.kind;
    console.log(
      `  ${pair.score.toFixed(3)}  [${where}] ${pair.olderId} ↔ ${pair.newerId}`,
    );
    console.log(
      `          older: "${pair.olderTitle}"  →  newer: "${pair.newerTitle}"`,
    );
  }
}

export async function memoryConsolidateCli(options: {
  apply?: boolean;
}): Promise<number> {
  const repoRoot = projectRootOrCwd();
  const config = await loadHiveConfig();
  const service = new MemoryEmbeddingService({
    provider: config.memory.embedding_provider,
    model: config.memory.embedding_model,
  });
  const episodic = EpisodicStore.forProjectRoot(repoRoot);
  let report: ConsolidationReport;
  try {
    report = await runMemoryConsolidation({
      repoRoot,
      episodic,
      service,
      ...(options.apply === undefined ? {} : { apply: options.apply }),
    });
  } catch (error) {
    console.error(
      `memory consolidate: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 1;
  } finally {
    episodic.close();
  }

  console.log(
    `memory consolidate: scanned ${report.scanned} embedded memor` +
      `${report.scanned === 1 ? "y" : "ies"}` +
      (report.embedded > 0 ? ` (${report.embedded} embedded on demand)` : ""),
  );
  printGroup(
    `identical (cosine ≥ 0.95)`,
    options.apply === true
      ? "superseded older into newer"
      : "recommend: keep newer, supersede older (re-run with --apply)",
    report.identical,
  );
  printGroup(
    "similar (0.85–0.95)",
    "recommend: human review / Possibly-related link — never auto-applied",
    report.similar,
  );
  for (const failure of report.failures) {
    console.error(`memory consolidate: apply FAILED for ${failure}`);
  }
  console.log(
    `memory consolidate: ${report.applied.length} applied, ` +
      `${report.skipped.length} identical skipped` +
      (options.apply === true ? "" : " (report mode — nothing modified)"),
  );
  return report.failures.length > 0 ? 1 : 0;
}
