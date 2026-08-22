import { loadHiveConfig } from "../config/load";
import {
  daemonInstanceLiveness,
  expectedDaemonHandshake,
  probeDaemonReuse,
} from "../daemon/lifecycle/daemon-lifecycle";
import { projectRootOrCwd } from "../daemon/project-identity-core/project-root";
import { hiveInstanceSuffix } from "../hive-home/home";
import {
  type ConsolidationCandidate,
  type ConsolidationReport,
  runMemoryConsolidation,
} from "../memory-service/consolidate";
import { MemoryEmbeddingService } from "../memory-service/embeddings";
import { EpisodicStore } from "../memory-service/episodic";
import {
  type MemoryJobReceipt,
  MemoryJobReceiptSchema,
  MemoryMaintenanceProjectionSchema,
} from "../schemas/memory-projections";
import { definedFields } from "../shared/defined-fields";
import { bindCliHiveHome } from "./bind-hive-home";
import { UserDaemonClient } from "./user-daemon-client";

export type ConsolidationApplyTarget =
  { state: "offline" } | { state: "daemon"; port: number };

export interface ConsolidationOwnershipDependencies {
  hiveHome?: () => string;
  liveness?: typeof daemonInstanceLiveness;
  expectedHandshake?: typeof expectedDaemonHandshake;
  probeReuse?: typeof probeDaemonReuse;
}

export async function resolveConsolidationApplyTarget(
  repoRoot: string,
  dependencies: ConsolidationOwnershipDependencies = {},
): Promise<ConsolidationApplyTarget> {
  const hiveHome = (dependencies.hiveHome ?? bindCliHiveHome)();
  const liveness = await (dependencies.liveness ?? daemonInstanceLiveness)(
    hiveHome,
    hiveInstanceSuffix(hiveHome),
  );
  if (liveness === "dead") return { state: "offline" };
  if (liveness === "unknown") {
    throw new Error(
      "daemon ownership is unknown; refusing offline consolidation while " +
        "the daemon may be starting, stopping, or owned by another instance",
    );
  }

  const expected = await (
    dependencies.expectedHandshake ?? expectedDaemonHandshake
  )(repoRoot);
  const reuse = await (dependencies.probeReuse ?? probeDaemonReuse)(expected);
  if (reuse.state === "authorized") {
    return { state: "daemon", port: reuse.port };
  }
  if (reuse.state === "rejected") {
    throw new Error(
      `live daemon does not own this project/build: ${reuse.reason}`,
    );
  }
  throw new Error(
    "daemon ownership changed during consolidation startup; refusing offline " +
      "consolidation",
  );
}

async function runDaemonConsolidationApply(
  port: number,
): Promise<MemoryJobReceipt> {
  const client = new UserDaemonClient({ port });
  const started = MemoryJobReceiptSchema.parse(
    await client.json(
      "/memory/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "consolidation-apply" }),
      },
      "throw",
    ),
  );
  if (started.kind !== "consolidation-apply") {
    throw new Error(`daemon started unexpected memory job ${started.kind}`);
  }

  let receipt = started;
  while (receipt.state === "running") {
    await Bun.sleep(100);
    const maintenance = MemoryMaintenanceProjectionSchema.parse(
      await client.json("/memory/maintenance", undefined, "throw"),
    );
    const current = maintenance.jobs.recent.find(
      (candidate) => candidate.id === started.id,
    );
    if (current === undefined) {
      throw new Error(
        `daemon no longer reports consolidation job ${started.id}`,
      );
    }
    receipt = current;
  }
  return receipt;
}

async function runOfflineConsolidation(
  repoRoot: string,
  apply: boolean | undefined,
): Promise<ConsolidationReport> {
  const config = await loadHiveConfig();
  const service = new MemoryEmbeddingService({
    provider: config.memory.embedding_provider,
    model: config.memory.embedding_model,
  });
  const episodic = EpisodicStore.forProjectRoot(repoRoot);
  try {
    return await runMemoryConsolidation({
      repoRoot,
      episodic,
      service,
      ...definedFields({ apply }),
      autoPromote: apply,
      generateProposals: apply,
    });
  } finally {
    episodic.close();
  }
}

export interface MemoryConsolidateCliDependencies {
  projectRoot?: () => string;
  resolveApplyTarget?: (repoRoot: string) => Promise<ConsolidationApplyTarget>;
  runDaemonApply?: (port: number) => Promise<MemoryJobReceipt>;
  runOffline?: (
    repoRoot: string,
    apply: boolean | undefined,
  ) => Promise<ConsolidationReport>;
}

function printGroup(
  label: string,
  recommendation: string,
  pairs: ConsolidationCandidate[],
): void {
  console.log(`${label} (${pairs.length}) — ${recommendation}`);
  for (const pair of pairs) {
    const where =
      pair.kind === "article" ? `${pair.kind}:${pair.scope}` : pair.kind;
    console.log(
      `  ${pair.score.toFixed(3)}  [${where}] ${pair.olderId} ↔ ${pair.newerId}`,
    );
    console.log(
      `          older: "${pair.olderTitle}"  →  newer: "${pair.newerTitle}"`,
    );
  }
}

export async function memoryConsolidateCli(
  options: {
    apply?: boolean;
  },
  dependencies: MemoryConsolidateCliDependencies = {},
): Promise<number> {
  const repoRoot = (dependencies.projectRoot ?? projectRootOrCwd)();
  if (options.apply === true) {
    try {
      const target = await (
        dependencies.resolveApplyTarget ?? resolveConsolidationApplyTarget
      )(repoRoot);
      if (target.state === "daemon") {
        const receipt = await (
          dependencies.runDaemonApply ?? runDaemonConsolidationApply
        )(target.port);
        console.log(`memory consolidate: ${receipt.summary}`);
        if (receipt.state === "failed") {
          console.error(
            `memory consolidate: ${receipt.error ?? "daemon job failed"}`,
          );
          return 1;
        }
        return 0;
      }
    } catch (error) {
      console.error(
        `memory consolidate: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return 1;
    }
  }

  let report: ConsolidationReport;
  try {
    report = await (dependencies.runOffline ?? runOfflineConsolidation)(
      repoRoot,
      options.apply,
    );
  } catch (error) {
    console.error(
      `memory consolidate: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return 1;
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
    "recommend: user review / Possibly-related link — never auto-applied",
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
