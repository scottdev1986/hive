import { z } from "zod";

export const AgentMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
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
