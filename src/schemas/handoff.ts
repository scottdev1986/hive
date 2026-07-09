import { z } from "zod";

export const HandoffSchema = z.object({
  agentName: z.string().min(1),
  goal: z.string(),
  done: z.array(z.string()),
  remaining: z.array(z.string()),
  decisions: z.array(z.string()),
  failedApproaches: z.array(z.string()),
  branch: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export type Handoff = z.infer<typeof HandoffSchema>;
