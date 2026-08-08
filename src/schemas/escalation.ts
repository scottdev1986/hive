import { z } from "zod";

export const EscalationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  model: z.string().min(1),
  category: z.string().min(1),
  reason: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
});

export type Escalation = z.infer<typeof EscalationSchema>;
