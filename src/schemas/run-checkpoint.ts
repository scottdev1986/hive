// run-checkpoint.ts The RunCheckpoint and QueenSuccession records: how a replacement queen root learns what the prior root knew, and how the exchange is proven. A RunCheckpoint is written at semantic events (a task completes, a gate moves, run control acts, a promotion boundary passes), never on a timer or a percentage. It records state by revision and digest — exact pointers into the records the hierarchy already keeps — plus one short written layer. It never carries transcripts, raw tool output, message bodies, or file copies: a checkpoint that reproduced its sources would go stale the moment it was written, while a (revision, digest) ref can always be re-read and re-checked. A QueenSuccession records one root replacement: both generations, the checkpoint (or an explicit proof that none existed), the measured snapshot and replies the exchange was built from, every discrepancy found along the way, and the fresh root's attestation. Discrepancies are recorded, never resolved silently — a contradiction that disappears from the record is a contradiction nobody fixed. Both records are daemon-internal. Nothing here crosses the client control surface: the queen-provider projection speaks only idle|pending|failed, and these records never appear in it.

import { createHash } from "node:crypto";
import { z } from "zod";
import { CapabilityProviderSchema } from "./capability";
import {
  ArtifactRefIdSchema,
  CreatedAtSchema,
  type Digest,
  DigestSchema,
  domainUuidV7Schema,
  RevisionRefSchema,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
  TaskIdSchema,
} from "./hierarchy-ids";
import { RunPhaseSchema } from "./hierarchy-run";
import { IntegrationStageIdSchema } from "./integration-stage";
import { Rfc3339UtcMillisecondsSchema } from "./session-protocol";

export const CHECKPOINT_EVENTS = [
  "task-completion",
  "gate-transition",
  "run-control",
  "promotion-boundary",
  "graceful-shutdown",
  "owner-ruling",
  "repeated-failure",
  "provider-compaction",
  "unknown-context",
] as const;
export const CheckpointEventSchema = z.enum(CHECKPOINT_EVENTS);
export type CheckpointEvent = z.infer<typeof CheckpointEventSchema>;

/** Measured absolute context usage, or an explicit unknown. Unknown is a first-class value, not a missing one: an absent measurement is never read as zero, because zero admits new work and unknown must refuse it until the usage is measured or checkpointed. */
export const ContextUsageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("measured"),
    residentTokens: SafeUintSchema,
    measuredAt: CreatedAtSchema,
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const ModelCeilingProvenanceSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: z.string().min(1),
  absoluteResidentTokenCeiling: SafeUintSchema,
  handoffReserveTokens: SafeUintSchema,
  providerSupportsCompaction: z.boolean(),
});
export const COMPACT_REPLACE = ["compact", "replace"] as const;
export const CompactReplaceDecisionSchema = z.strictObject({
  decision: z.enum(COMPACT_REPLACE),
  reason: z.string().min(1),
});
export type CompactReplaceDecision = z.infer<
  typeof CompactReplaceDecisionSchema
>;

/** One pending message, by cursor and digest only — never its body. The uuidv7 id is the delivery cursor; the digest binds the exact content so a re-read can prove the message is still the one the checkpoint saw. */
export const PendingMessageRefSchema = z.strictObject({
  messageId: z.string().min(1),
  digest: DigestSchema,
});

/** One live agent as measured at capture time. A snapshot is a measurement, not a claim: it is what the status read returned, recorded so a later succession can compare it against what it measures again. */
export const AgentSnapshotEntrySchema = z.strictObject({
  agentName: z.string().min(1),
  status: z.string().min(1),
  branch: z.string().min(1).nullable(),
  worktreePath: z.string().min(1).nullable(),
  lastEventAt: z.iso.datetime(),
});
export type AgentSnapshotEntry = z.infer<typeof AgentSnapshotEntrySchema>;

export const MeasuredReplySchema = z.strictObject({
  agentName: z.string().min(1),
  confirmed: z.boolean(),
});
export type MeasuredReply = z.infer<typeof MeasuredReplySchema>;

export const WrittenLayerSchema = z.strictObject({
  goal: z.string().min(1),
  done: z.array(z.string().min(1)),
  failures: z.array(
    z.strictObject({
      what: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  uncertainty: z.array(z.string().min(1)),
  nextAction: z.string().min(1),
  rollback: z.string().min(1),
});
export const GATE_STATES = ["pending", "approved"] as const;

/** The kind-specific recovery refs: each names the exact record by identity, revision, and a digest over its whole stored content — never a bare revision a sibling record could share, so a drifted or missing record is identifiable, not just detectable. */
export const CheckpointTaskRefSchema = z.strictObject({
  taskId: TaskIdSchema,
  revision: RevisionSchema,
  digest: DigestSchema,
});
export const CheckpointDecisionRefSchema = z.strictObject({
  idempotencyKey: z.string().min(1),
  revision: RevisionSchema,
  digest: DigestSchema,
});
export const CheckpointStageRefSchema = z.strictObject({
  stageId: IntegrationStageIdSchema,
  revision: RevisionSchema,
  digest: DigestSchema,
});

/** The hierarchy state a checkpoint names, entirely by identity, revision, and digest refs. Null for a flat instance with no hierarchy run: a checkpoint there still binds the agent snapshot and pending messages. The dependent-record arrays bind exactly the records the store holds for the run: tasks, accepted run-control decisions, and the promotion queue. Tree-mutation records — ownership transfers — are deliberately NOT checkpoint content: they are their own record family with their own recovery flow, and the tree's current shape is re-read from the store, so a checkpoint never carries them. */
export const CheckpointHierarchySchema = z.strictObject({
  runId: RunIdSchema,
  spec: RevisionRefSchema,
  plan: RevisionRefSchema,
  topology: RevisionRefSchema,
  phase: RunPhaseSchema,
  gates: z.strictObject({
    g2: z.enum(GATE_STATES),
  }),
  budget: RevisionRefSchema,
  tasks: z.array(CheckpointTaskRefSchema),
  decisions: z.array(CheckpointDecisionRefSchema),
  promotionQueue: z.array(CheckpointStageRefSchema),
});
export type CheckpointHierarchy = z.infer<typeof CheckpointHierarchySchema>;

export const RunCheckpointSchema = z.strictObject({
  instanceId: z.string().min(1),
  revision: RevisionSchema,
  digest: DigestSchema,
  createdAt: CreatedAtSchema,
  reason: CheckpointEventSchema,
  hierarchy: CheckpointHierarchySchema.nullable(),
  pendingMessages: z.array(PendingMessageRefSchema),
  artifacts: z.array(ArtifactRefIdSchema),
  unresolvedQuestions: z.array(z.string().min(1)),
  contextUsage: ContextUsageSchema,
  /** Model/ceiling configuration provenance, or null when none is configured — an unconfigured ceiling is recorded, never invented. */
  model: ModelCeilingProvenanceSchema.nullable(),
  decision: CompactReplaceDecisionSchema,
  agentSnapshot: z.array(AgentSnapshotEntrySchema),
  replies: z.array(MeasuredReplySchema),
  /** The root's written layer, or null when this capture was written by the daemon at a boundary, where no root prose exists. Absent is unknown — the daemon never fabricates the root's layer. */
  written: WrittenLayerSchema.nullable(),
});
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;

export const RunCheckpointInputSchema = RunCheckpointSchema.omit({
  revision: true,
  digest: true,
  createdAt: true,
});
export type RunCheckpointInput = z.infer<typeof RunCheckpointInputSchema>;

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

export function digestCheckpointContent(value: unknown): Digest {
  const hex = createHash("sha256").update(canonical(value), "utf8");
  return DigestSchema.parse(`sha256:${hex.digest("hex")}`);
}

export function digestRunCheckpoint(
  record: Omit<RunCheckpoint, "digest">,
): Digest {
  return digestCheckpointContent(record);
}

export const SUCCESSION_REASONS = [
  "initial-boot",
  "provider-change",
  "root-exit-with-live-agents",
  "exit-with-live-agents",
] as const;
export const SuccessionReasonSchema = z.enum(SUCCESSION_REASONS);
export type SuccessionReason = z.infer<typeof SuccessionReasonSchema>;

/** What the successor's authority rests on. A checkpoint ref when one loaded and verified; an explicit no-checkpoint proof otherwise — including when a checkpoint existed but failed verification, with the detail saying how. "No checkpoint" is a declared, attested fact, never a silent absence. */
export const SuccessionProofSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("checkpoint"),
    ref: RevisionRefSchema,
  }),
  z.strictObject({
    kind: z.literal("no-checkpoint"),
    detail: z.string().min(1),
  }),
]);
export type SuccessionProof = z.infer<typeof SuccessionProofSchema>;

/** The fresh root's attestation, recorded before its authority resumes: the exact checkpoint digest it verified, or null when it attests that no checkpoint existed. */
export const SuccessionAttestationSchema = z.strictObject({
  checkpointDigest: DigestSchema.nullable(),
  attestedAt: CreatedAtSchema,
});

export const QueenSuccessionSchema = z.strictObject({
  successionId: domainUuidV7Schema("qsc"),
  instanceId: z.string().min(1),
  revision: RevisionSchema,
  createdAt: CreatedAtSchema,
  reason: SuccessionReasonSchema,
  reasonDetail: z.string().min(1),
  priorRootGeneration: SafeUintSchema,
  newRootGeneration: SafeUintSchema.nullable(),
  proof: SuccessionProofSchema,
  /** The bounded live-agent snapshot the backup received. */
  snapshot: z.array(AgentSnapshotEntrySchema),
  replies: z.array(MeasuredReplySchema),
  /** Every contradiction found at load and at comparison time. Visible until resolved; never dropped because convergence succeeded anyway. */
  discrepancies: z.array(z.string().min(1)),
  launchRequestId: domainUuidV7Schema("req").optional(),
  bootCapsuleDigest: DigestSchema.optional(),
  attestation: SuccessionAttestationSchema.nullable(),
});
export type QueenSuccession = z.infer<typeof QueenSuccessionSchema>;

/** What the supervisor may supply when it declares a backup. The declaration precedes the recovery requests, so no replies exist yet — they are recorded separately as they are measured. The record's identity, revision, reason, proof, discrepancies, and attestation are the daemon's to assign, not the caller's: the reason in particular is derived from what the daemon itself knows (a pending provider change), never from the caller's claim. */
export const PrepareQueenLaunchRequestSchema = z.strictObject({
  requestId: domainUuidV7Schema("req"),
  provider: CapabilityProviderSchema,
  cwd: z.string().min(1),
  reason: SuccessionReasonSchema,
  reasonDetail: z.string().min(1),
});
export type PrepareQueenLaunchRequest = z.infer<
  typeof PrepareQueenLaunchRequestSchema
>;
export const BeginSuccessionRequestSchema = z.strictObject({
  reasonDetail: z.string().min(1),
  priorRootGeneration: SafeUintSchema,
  snapshot: z.array(AgentSnapshotEntrySchema),
});
export type BeginSuccessionRequest = z.infer<
  typeof BeginSuccessionRequestSchema
>;

/** The measured replies to the recovery requests, recorded against the open succession they belong to. An unconfirmed request is a measurement, not an absence — it goes on the record as unconfirmed. */
export const RecoveryRepliesRequestSchema = z.strictObject({
  successionId: domainUuidV7Schema("qsc"),
  replies: z.array(MeasuredReplySchema),
});
export type RecoveryRepliesRequest = z.infer<
  typeof RecoveryRepliesRequestSchema
>;

/** The successor's own attestation, bound to the exact succession, the exact generation, and the exact digest it verified — or null when it attests that no checkpoint existed. A provider observation is not an attestation: only this declaration, after the successor's measured re-read of status and inbox, completes a succession. */
export const SuccessionAttestRequestSchema = z.strictObject({
  successionId: domainUuidV7Schema("qsc"),
  generation: SafeUintSchema,
  checkpointDigest: DigestSchema.nullable(),
});
export type SuccessionAttestRequest = z.infer<
  typeof SuccessionAttestRequestSchema
>;

/** What the root supplies when she writes a checkpoint: the semantic event it answers, her context usage as she measured it (or her explicit unknown), her compact-versus-replace decision, and her written layer. Everything measurable by the daemon — the snapshot, pending messages, hierarchy refs — is filled by the daemon, never taken from her. */
export const HiveRunCheckpointRequestSchema = z.strictObject({
  reason: CheckpointEventSchema,
  contextUsage: ContextUsageSchema,
  decision: CompactReplaceDecisionSchema,
  written: WrittenLayerSchema,
  unresolvedQuestions: z.array(z.string().min(1)),
  model: ModelCeilingProvenanceSchema.nullable(),
});
export type HiveRunCheckpointRequest = z.infer<
  typeof HiveRunCheckpointRequestSchema
>;

export const HiveRunCheckpointGetRequestSchema = z.strictObject({
  revision: RevisionSchema.optional(),
});

/** One journaled manifest the fresh root must account for, named by its exact (revision, digest) ref. Bootstrap reads the journal and the measured replies — never the agent table alone. */
export const BootstrapManifestRefSchema = z.strictObject({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  branch: z.string().min(1).nullable(),
  classification: z.string().min(1),
  workManifest: RevisionRefSchema,
});
export type BootstrapManifestRef = z.infer<typeof BootstrapManifestRefSchema>;

export const PrepareQueenLaunchResponseSchema = z.strictObject({
  succession: QueenSuccessionSchema,
  targetGeneration: SafeUintSchema,
  bootCapsule: z.string().min(1),
  bootCapsuleDigest: DigestSchema,
  bootstrap: z.array(BootstrapManifestRefSchema),
  snapshot: z.array(AgentSnapshotEntrySchema),
});
export type PrepareQueenLaunchResponse = z.infer<
  typeof PrepareQueenLaunchResponseSchema
>;
export const BeginSuccessionResponseSchema = z.strictObject({
  succession: QueenSuccessionSchema,
  bootstrap: z.array(BootstrapManifestRefSchema),
});
export type BeginSuccessionResponse = z.infer<
  typeof BeginSuccessionResponseSchema
>;

export const SUCCESSION_STATES = ["recovering", "attested"] as const;
export const SuccessionStateSchema = z.enum(SUCCESSION_STATES);

/** The daemon-internal read model over the succession records. Its contradictions field is where discrepancies stay visible: a corrupt or stale checkpoint, a snapshot that no longer matches — they appear here and remain until resolved, whether or not convergence succeeded. */
export const QueenSuccessionProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: z.string().min(1),
  latestCheckpoint: RevisionRefSchema.nullable(),
  succession: z
    .strictObject({
      successionId: domainUuidV7Schema("qsc"),
      revision: RevisionSchema,
      state: SuccessionStateSchema,
      reason: SuccessionReasonSchema,
      priorRootGeneration: SafeUintSchema,
      newRootGeneration: SafeUintSchema.nullable(),
    })
    .nullable(),
  contradictions: z.array(z.string().min(1)),
  observedAt: Rfc3339UtcMillisecondsSchema,
});
export type QueenSuccessionProjection = z.infer<
  typeof QueenSuccessionProjectionSchema
>;
