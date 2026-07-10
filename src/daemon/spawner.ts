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
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export interface Spawner {
  spawn(req: SpawnRequest): Promise<AgentRecord>;
  restartForControl?(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<AgentRecord>;
}
