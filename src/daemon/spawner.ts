import { z } from "zod";
import {
  RoutingTierSchema,
  type AgentRecord,
} from "../schemas";

export const SpawnRequestSchema = z.object({
  task: z.string().min(1),
  tier: RoutingTierSchema,
  name: z.string().min(1).optional(),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export interface Spawner {
  spawn(req: SpawnRequest): Promise<AgentRecord>;
}
