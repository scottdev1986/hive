import type { StrandedManifestAttention } from "../schemas/hierarchy-projection";
import {
  digestWorkManifest,
  type WorkManifest,
  type WorkManifestJournalEntry,
  WorkManifestJournalEntrySchema,
  workManifestRef,
} from "../schemas/work-manifest";
import type { DatabaseHost } from "../shared/database-host";
import type { HierarchyStore } from "./hierarchy-store";

type JournalRow = { document: string };

function parseRow(row: JournalRow): WorkManifestJournalEntry {
  return WorkManifestJournalEntrySchema.parse(JSON.parse(row.document));
}

export class ManifestJournal {
  constructor(private readonly db: DatabaseHost) {
    db.database.exec(`
      CREATE TABLE IF NOT EXISTS work_manifest_journal (
        agentId TEXT NOT NULL,
        revision TEXT NOT NULL,
        recordedAt TEXT NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY (agentId, revision)
      )
    `);
  }

  /** Append one capture. The revision is the next strictly increasing value for this agentId — never supplied by the caller, so no caller can rewrite or skip history. Returns the stored entry; its (revision, digest) ref is how recovery names this exact capture. */
  append(manifest: WorkManifest, at?: string): WorkManifestJournalEntry {
    return this.db.transaction(() => {
      // SAFETY: The surrounding code already established this contract.
      const row = this.db.database
        .query(
          `SELECT revision FROM work_manifest_journal
           WHERE agentId = ?
           ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1`,
        )
        .get(manifest.agentId) as { revision: string } | null;
      const revision =
        row === null ? "1" : (BigInt(row.revision) + 1n).toString();
      const entry = WorkManifestJournalEntrySchema.parse({
        agentId: manifest.agentId,
        revision,
        digest: digestWorkManifest(manifest),
        recordedAt: at ?? new Date().toISOString(),
        manifest,
      });
      this.db.database
        .query(
          `INSERT INTO work_manifest_journal (agentId, revision, recordedAt, document)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          entry.agentId,
          entry.revision,
          entry.recordedAt,
          JSON.stringify(entry),
        );
      return entry;
    });
  }

  /** The newest capture for one agent, or null when it was never journaled. */
  latest(agentId: string): WorkManifestJournalEntry | null {
    // SAFETY: The surrounding code already established this contract.
    const row = this.db.database
      .query(
        `SELECT document FROM work_manifest_journal
         WHERE agentId = ?
         ORDER BY CAST(revision AS INTEGER) DESC LIMIT 1`,
      )
      .get(agentId) as JournalRow | null;
    return row === null ? null : parseRow(row);
  }

  /** The entries recovery and the attention projection care about: each agent's LATEST capture, keeping only the ones whose final known state was not clean. An unknown classification stays on the list on purpose — a measurement that failed is work nobody accounted for, not work that does not exist. */
  listAttention(): WorkManifestJournalEntry[] {
    // SAFETY: The surrounding code already established this contract.
    const rows = this.db.database
      .query(
        `SELECT document FROM work_manifest_journal AS candidate
         WHERE CAST(candidate.revision AS INTEGER) = (
           SELECT MAX(CAST(other.revision AS INTEGER))
           FROM work_manifest_journal AS other
           WHERE other.agentId = candidate.agentId
         )`,
      )
      .all() as JournalRow[];
    return rows
      .map(parseRow)
      .filter((entry) => entry.manifest.classification !== "clean");
  }
}

/** Map one journal entry onto the frozen stranded-manifest attention shape. Returns null when there is nothing to attend to: a clean manifest, or a branchless one — the attention shape names work by branch (min length 1), and the rest of the stranded-work model is keyed the same way, so a branchless dirty worktree stays journal-only rather than being projected under an invented branch name. Disposition comes from the classification alone because the capture is written before teardown decides anything: stranded work is work someone must preserve and merge, and an unknown classification is work whose state nobody could measure. The capture cannot know whether the preservation ref was later written, so it never claims "discard-required". */
export function projectStrandedManifestAttention(
  entry: WorkManifestJournalEntry,
): StrandedManifestAttention | null {
  const manifest = entry.manifest;
  if (manifest.classification === "clean" || manifest.branch === null) {
    return null;
  }
  return {
    nodeId: manifest.nodeId,
    agentId: manifest.agentId,
    branch: manifest.branch,
    workManifestRevision: workManifestRef(entry),
    unmergedCommits: manifest.unmergedCommits,
    dirtyFileCount: manifest.dirtyFiles.length,
    disposition: manifest.classification === "unknown" ? "unknown" : "preserve",
  };
}

/** Recovery's read after an ownership transfer: the in-flight manifest entries for every agent bound anywhere under one node. The walk composes hierarchy records with this journal and nothing else — topology from the node tree, agency from the bindings on those nodes, work from the journal. The flat agent table is never consulted, so a poisoned or empty one cannot change this answer; that is what makes the journal the source of truth for recovery instead of one reader among several. Latest capture per agent, non-clean only: clean work is accounted for, and an unknown classification stays listed for the same reason listAttention keeps it — a measurement that failed is work nobody accounted for. */
export function recoverSubtreeManifests(
  store: HierarchyStore,
  journal: ManifestJournal,
  nodeId: string,
  runId: string,
): WorkManifestJournalEntry[] {
  const agentIds = new Set<string>();
  for (const node of store.listSubtreeNodes(nodeId, runId)) {
    for (const binding of store.findBindingsByNode(node.nodeId)) {
      agentIds.add(binding.agentId);
    }
  }
  const entries: WorkManifestJournalEntry[] = [];
  for (const agentId of agentIds) {
    const entry = journal.latest(agentId);
    if (entry !== null && entry.manifest.classification !== "clean") {
      entries.push(entry);
    }
  }
  return entries;
}
