import { z } from "zod";

export const MessagePrioritySchema = z.enum(["normal", "urgent", "critical"]);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

export const ControlIntentSchema = z.enum([
  "instruction",
  "pause",
  "stop",
  "cancel",
  "restrict-writes",
]);
export type ControlIntent = z.infer<typeof ControlIntentSchema>;

export const MessageLifecycleStateSchema = z.enum([
  "queued",
  "injected",
  "agent-acknowledged",
  "applied",
]);
export type MessageLifecycleState = z.infer<
  typeof MessageLifecycleStateSchema
>;

export const AgentMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  priority: MessagePrioritySchema.default("normal"),
  intent: ControlIntentSchema.default("instruction"),
  state: MessageLifecycleStateSchema.default("queued"),
  injectedAt: z.iso.datetime().nullable().default(null),
  acknowledgedAt: z.iso.datetime().nullable().default(null),
  appliedAt: z.iso.datetime().nullable().default(null),
  deadlineAt: z.iso.datetime().nullable().default(null),
  alertAt: z.iso.datetime().nullable().default(null),
  sequence: z.number().int().nonnegative().default(0),
  idempotencyKey: z.string().min(1).nullable().default(null),
  capabilityEpoch: z.number().int().nonnegative().nullable().default(null),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const OrchestratorMessageEnvelopeSchema = z.object({
  kind: z.literal("hive.message"),
  id: z.string().min(1),
  from: z.string().min(1),
  createdAt: z.iso.datetime(),
  body: z.string(),
  truncated: z.boolean(),
  ref: z.string().min(1),
});

export type OrchestratorMessageEnvelope = z.infer<
  typeof OrchestratorMessageEnvelopeSchema
>;
