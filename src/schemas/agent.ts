import { z } from "zod";
import { RoutingTierSchema } from "./routing";

// Reserved recipient name for the root orchestrator. It is not a spawned
// agent: it has no tmux session and no row in the agents table, so messages
// addressed to it always queue and are drained via hive_inbox.
export const ORCHESTRATOR_NAME = "orchestrator";

export const AgentRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tool: z.enum(["claude", "codex"]),
  model: z.string().min(1),
  tier: RoutingTierSchema,
  status: z.enum([
    "spawning",
    "working",
    "idle",
    "awaiting-approval",
    "stuck",
    "done",
    "dead",
    "failed",
  ]),
  failureReason: z.string().optional(),
  failedAt: z.iso.datetime().optional(),
  taskDescription: z.string(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  tmuxSession: z.string().min(1),
  contextPct: z.number().min(0).max(100),
  createdAt: z.iso.datetime(),
  lastEventAt: z.iso.datetime(),
});

export type AgentRecord = z.infer<typeof AgentRecordSchema>;
