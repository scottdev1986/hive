import { z } from "zod";
import {
  CapabilityProviderSchema,
  RoutingCategorySchema,
  type AgentRecord,
  type AgentMessage,
  type ExecutionIdentity,
} from "../schemas";
import type { AuthorizedLaunch } from "./authorized-launch";

export const SpawnRequestSchema = z.object({
  task: z.string().min(1),
  /** The task category. The user's policy maps it to an ordered fallback
   * chain of exact models; the first link that clears the launch gate runs. */
  category: RoutingCategorySchema,
  name: z.string().optional(),
  tool: CapabilityProviderSchema.optional(),
  reviewOfTool: CapabilityProviderSchema.optional(),
  // An explicit user-directed model. Launched verbatim (no alias resolution),
  // binds the spawn to its vendor for quota routing, and is never silently
  // substituted — pass it only when the user named a model. Routine spawns
  // resolve through the category's policy chain.
  model: z.string().min(1).optional(),
  // A user directive, passed verbatim after validation against the resolved
  // model's discovered capability record. No default is implied.
  effort: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  /**
   * The long-context requirement MODIFIER (not a category): links whose
   * measured context window is unknown or below this fail the gate. Unknown
   * fails closed — Hive never guesses a window.
   */
  minContextTokens: z.number().int().positive().optional(),
  /** Launch with reader authority and the vendor's enforced read-only mode. */
  readOnly: z.boolean().optional(),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export interface Spawner {
  spawn(req: SpawnRequest): Promise<AgentRecord>;
  authorizeLaunch?(identity: ExecutionIdentity): Promise<AuthorizedLaunch>;
  restartForControl?(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<AgentRecord>;
}
