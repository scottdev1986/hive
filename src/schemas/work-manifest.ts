// work-manifest.ts The WorkManifest: the final known state of one agent's work, captured by the daemon before teardown destroys anything. Killing an agent is immediate — nobody is asked whether the work mattered — so the capture that makes the work recoverable must happen while it can still be measured, not after the worktree and branch are gone. The daemon appends each capture to its manifest journal as a revisioned, digest-bound entry. The (revision, digest) pair is how recovery names an exact manifest: a spawn brief or ownership transfer can point at the precise captured state rather than a floating "whatever the worktree looks like now". The daemon is the only writer. Clients never read the journal file or table directly; they see manifests through the stranded-attention projection.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CreatedAtSchema,
  DigestSchema,
  type RevisionRef,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
} from "./hierarchy-ids";
import { NodeIdSchema } from "./hierarchy-node";

// What the capture found. "unknown" is a first-class answer: a measurement that failed must never be written down as "clean", because clean releases attention and unknown demands it.
export const MANIFEST_CLASSIFICATIONS = [
  "clean",
  "stranded",
  "unknown",
] as const;
export const ManifestClassificationSchema = z.enum(MANIFEST_CLASSIFICATIONS);

export const WorkManifestSchema = z.strictObject({
  /** The AgentUUID: distinct per holder of a name, so a reused name never inherits a predecessor's manifest. */
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  runId: RunIdSchema.nullable(),
  nodeId: NodeIdSchema.nullable(),
  branch: z.string().min(1).nullable(),
  worktreePath: z.string().min(1).nullable(),
  dirtyFiles: z.array(z.string().min(1)),
  unmergedCommits: SafeUintSchema,
  /** The agent's last reported status at capture time. A kill mid-work is recoverable only if the record shows the work was in flight. */
  lastStatus: z.string().min(1),
  classification: ManifestClassificationSchema,
  classificationReason: z.string().min(1),
});
export type WorkManifest = z.infer<typeof WorkManifestSchema>;

/** One append to the manifest journal. Append-only: revision is strictly increasing per agentId, and the digest binds the exact manifest content so a reference can never be re-described after the fact. */
export const WorkManifestJournalEntrySchema = z.strictObject({
  agentId: z.string().min(1),
  revision: RevisionSchema,
  digest: DigestSchema,
  recordedAt: CreatedAtSchema,
  manifest: WorkManifestSchema,
});
export type WorkManifestJournalEntry = z.infer<
  typeof WorkManifestJournalEntrySchema
>;

export function workManifestRef(
  entry: Pick<WorkManifestJournalEntry, "revision" | "digest">,
): RevisionRef {
  return { revision: entry.revision, digest: entry.digest };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

export function digestWorkManifest(manifest: WorkManifest) {
  const hex = createHash("sha256").update(canonical(manifest), "utf8");
  return DigestSchema.parse(`sha256:${hex.digest("hex")}`);
}
