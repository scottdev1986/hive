// Owns memory-retention scheduling and sweep coordination. HiveDaemon supplies
// its memory stores and the serialized mutation/reindex seams; the service
// never reaches back into the daemon.

import type { EpisodicStore } from "../../memory-service/episodic";
import {
  type RetentionSweepReport,
  runRetentionSweep,
} from "../../memory-service/retention";
import type { MemoryRetentionConfig } from "../../schemas/config-schema";

export interface MemoryRetentionServiceDependencies {
  repoRoot: string;
  config: MemoryRetentionConfig | null;
  episodic: EpisodicStore | null;
  serializeMemory: <T>(operation: () => Promise<T>) => Promise<T>;
  rebuildMemoryIndex: () => Promise<unknown>;
  runSweep: (reason: string) => Promise<RetentionSweepReport | null>;
  /** Ages stored work products out on the same pass, and returns how many files it deleted. The artifact store owns where they live and how old is too old; retention only decides when the pass happens. */
  sweepArtifacts: () => number;
  artifactRetentionDays: number;
  log: (line: string) => void;
}

export class MemoryRetentionService {
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private retentionRunning = false;

  constructor(private readonly deps: MemoryRetentionServiceDependencies) {}

  start(): void {
    const retention = this.deps.config;
    if (retention === null) return;
    // Episodic memory is the leg that can be absent — a store that failed to open still leaves artifacts to age out, so the pass runs either way.
    if (this.deps.episodic !== null) {
      const line =
        `Hive memory retention: events hot for ${retention.events_hot_days}d, ` +
        `verified articles demote to stale after ${retention.stale_after_days}d, ` +
        `sweep every ${retention.sweep_interval_hours}h`;
      this.deps.log(line);
    }
    this.deps.log(
      `Hive artifact retention: work products kept for ${this.deps.artifactRetentionDays}d, swept on the same pass`,
    );
    this.retentionTimer = setInterval(() => {
      this.triggerMemoryRetentionSweep("periodic");
    }, retention.sweep_interval_hours * 3_600_000);
    this.retentionTimer.unref?.();
    this.triggerMemoryRetentionSweep("startup");
  }

  /** Artifacts age out on every pass; the memory tiers additionally need config and an episodic store. */
  async runMemoryRetentionSweep(
    reason = "manual",
  ): Promise<RetentionSweepReport | null> {
    if (this.retentionRunning) return null;
    this.retentionRunning = true;
    try {
      const artifactsDeleted = this.deps.sweepArtifacts();
      if (artifactsDeleted > 0) {
        this.deps.log(
          `Hive artifact retention sweep: deleted ${artifactsDeleted} aged work product(s)`,
        );
      }
      const config = this.deps.config;
      const episodic = this.deps.episodic;
      if (config === null || episodic === null) return null;
      // The demotion half writes article files, so the sweep takes the same serialized memory write path as memory_write; a retention pass must never interleave with an agent's write. The FTS rebuild below re-enters the lock after this one releases, so it cannot live inside.
      const report = await this.deps.serializeMemory(() =>
        runRetentionSweep({
          episodic,
          repoRoot: this.deps.repoRoot,
          config,
          now: new Date(),
          // A session end is a harvest boundary, not a consolidation review. The pairwise scan is sync CPU on the daemon thread; running it at every kill is what made /handshake miss its 1s budget.
          countCandidates: reason !== "agent session end",
        }),
      );
      if (
        report.eventsDeleted > 0 ||
        report.articlesDemoted.length > 0 ||
        report.consolidationCandidates > 0
      ) {
        const line =
          `Hive memory retention sweep: deleted ${report.eventsDeleted} ` +
          `aged event(s), demoted ${report.articlesDemoted.length} ` +
          "verified article(s) to stale, " +
          `${report.consolidationCandidates} consolidation candidate ` +
          "pair(s) in the vector store (hive memory consolidate to review)";
        this.deps.log(line);
      }
      if (report.articlesDemoted.length > 0) {
        // The FTS index is a disposable projection of the article files and the demotions just rewrote files; reproject so a stale status is visible to memory_search right away. A failure here is logged by the caller's catch like any other sweep failure.
        await this.deps.rebuildMemoryIndex();
      }
      return report;
    } finally {
      this.retentionRunning = false;
    }
  }

  /** Retention failure is logged maintenance noise, never a daemon failure. */
  triggerMemoryRetentionSweep(reason: string): void {
    void this.deps.runSweep(reason).catch((error) => {
      const line = `Hive memory retention sweep (${reason}) failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`;
      this.deps.log(line);
    });
  }

  close(): void {
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }
}
