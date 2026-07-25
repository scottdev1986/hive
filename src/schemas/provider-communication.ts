import { z } from "zod";
import { CapabilityProviderSchema } from "./capability";

export const ProviderEventSchema = z
  .strictObject({
    eventId: z.string().min(1),
    providerRunId: z.string().uuid(),
    provider: CapabilityProviderSchema,
    capabilityEpoch: z.number().int().nonnegative(),
    conversationId: z.string().min(1).nullable(),
    kind: z.enum([
      "run-started",
      "turn-started",
      "tool-started",
      "tool-finished",
      "approval-waiting",
      "turn-idle",
      "turn-failed",
      "interrupted",
      "compacted",
      "run-ended",
    ]),
    occurredAt: z.iso.datetime({ offset: true }),
    toolName: z.string().min(1).nullable(),
    inputDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .readonly();

export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export const ProviderCommunicationCapabilitiesSchema = z
  .strictObject({
    provider: CapabilityProviderSchema,
    eventSource: z.enum(["hooks", "native", "transcript", "none"]),
    nativeDelivery: z.boolean(),
    toolBoundaryEvents: z.boolean(),
    turnBoundaryEvents: z.boolean(),
    transcriptReader: z.boolean(),
    nativeCancel: z.boolean(),
    conversationResume: z.boolean(),
  })
  .readonly();

export type ProviderCommunicationCapabilities = z.infer<
  typeof ProviderCommunicationCapabilitiesSchema
>;

export const ActivityEvidenceRefSchema = z
  .strictObject({
    kind: z.enum([
      "terminal-output",
      "process",
      "git",
      "provider-event",
      "agent-report",
    ]),
    ref: z.string().min(1),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .readonly();

export type ActivityEvidenceRef = z.infer<typeof ActivityEvidenceRefSchema>;

export const ActivitySnapshotSchema = z
  .strictObject({
    agentId: z.string().min(1),
    providerRunId: z.string().uuid().nullable(),
    observedAt: z.iso.datetime({ offset: true }),
    terminalState: z.enum(["present", "lost", "unknown"]),
    providerState: z.enum([
      "starting",
      "running",
      "stopped",
      "exited",
      "shell-idle",
      "unmanaged",
      "unknown",
    ]),
    turnState: z.enum(["idle", "working", "waiting", "unknown"]),
    phase: z.enum(["planning", "editing", "testing", "blocked", "unknown"]),
    summary: z.string().nullable(),
    evidence: z.array(ActivityEvidenceRefSchema),
    providerEventThrough: z.string().nullable(),
    outputThrough: z.string(),
    completeness: z.enum(["complete", "gap", "unknown"]),
  })
  .readonly();

export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
