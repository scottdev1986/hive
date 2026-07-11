import { z } from "zod";
import {
  RoutingTierSchema,
  type AgentRecord,
  type AgentMessage,
} from "../schemas";

export const SpawnRequestSchema = z.object({
  task: z.string().min(1),
  tier: RoutingTierSchema,
  name: z.string().optional(),
  tool: z.enum(["claude", "codex"]).optional(),
  reviewOfTool: z.enum(["claude", "codex"]).optional(),
  // An explicit user-directed model. Launched verbatim (no alias resolution),
  // binds the spawn to its vendor for quota routing, and is never silently
  // substituted — pass it only when the user named a model. Routine spawns
  // keep resolving models through the routing table.
  model: z.string().min(1).optional(),
  // A user directive, passed verbatim after validation against the resolved
  // model's discovered capability record. No tier default is implied.
  effort: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export interface Spawner {
  spawn(req: SpawnRequest): Promise<AgentRecord>;
  restartForControl?(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<AgentRecord>;
}
