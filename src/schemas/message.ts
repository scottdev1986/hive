import { z } from "zod";

export const MessagePrioritySchema = z.enum(["normal", "urgent"]);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

export const MessageLifecycleStateSchema = z.enum([
  "queued",
  "notified",
  "acknowledged",
]);
export type MessageLifecycleState = z.infer<typeof MessageLifecycleStateSchema>;

export const AgentMessageSchema = z.strictObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  createdAt: z.iso.datetime(),
  priority: MessagePrioritySchema.default("normal"),
  state: MessageLifecycleStateSchema.default("queued"),
  notifiedAt: z.iso.datetime().nullable().default(null),
  acknowledgedAt: z.iso.datetime().nullable().default(null),
  sequence: z.number().int().nonnegative().default(0),
  idempotencyKey: z.string().min(1).nullable().default(null),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const OrchestratorMessageEnvelopeSchema = z.strictObject({
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
