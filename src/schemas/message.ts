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
