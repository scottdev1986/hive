import { z } from "zod";
import {
  type AgentMessage,
  type AgentRecord,
  CapabilityProviderSchema,
  type ExecutionIdentity,
  RoutingCategorySchema,
} from "../schemas";
import type { AuthorizedLaunch } from "./authorized-launch";

export const SpawnRequestSchema = z.strictObject({
  task: z.string().min(1),
  /** The task category. The router resolves it to the user's configured
   * candidate set and selects one exact model fairly. */
  category: RoutingCategorySchema,
  name: z.string().optional(),
  tool: CapabilityProviderSchema.optional(),
  reviewOfTool: CapabilityProviderSchema.optional(),
  // An explicit user-directed model. Launched verbatim (no alias resolution),
  // binds the spawn to its vendor for quota routing, and is never silently
  // substituted — pass it only when the user named a model. Routine spawns
  // resolve through the category's policy chain.
  model: z.string().min(1).optional(),
  // An explicit user choice, passed verbatim after validation against the resolved
  // model's discovered capability record. No default is implied.
  effort: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  /**
   * The long-context requirement MODIFIER (not a category): links whose
   * measured context window is unknown or below this fail the gate. Unknown
   * fails closed — Hive never guesses a window.
   */
  minContextTokens: z.number().int().positive().optional(),
  /** Launch with reader authority and the vendor's enforced read-only mode. */
  readOnly: z.boolean().optional(),
  /** Durable C5 bundle this replacement must pick up before writing. */
  handoffId: z.string().uuid().optional(),
  /** Quota pools proven drained for this request: a handoff replacement must
   * not land back on the pool that just drained its source. */
  excludedPoolIds: z.array(z.string().min(1)).optional(),
});

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

export const SpawnBatchRequestSchema = z.strictObject({
  // SessiondHost.create enforces the admission bound that keeps a burst within
  // the host budget; this schema cap only needs to clear the supported agent target.
  requests: z.array(SpawnRequestSchema).min(1).max(32),
});

export type SpawnBatchRequest = z.infer<typeof SpawnBatchRequestSchema>;

export interface Spawner {
  /** Resolves once the generation is durably admitted. Provider launch and
   * readiness verification continue while the returned row is `spawning`. */
  spawn(req: SpawnRequest): Promise<AgentRecord>;
  authorizeLaunch?(identity: ExecutionIdentity): Promise<AuthorizedLaunch>;
  createRecoverySession?(
    agent: AgentRecord,
    command: string,
    expectedExecutable: string,
    launchGrantId: string,
    /** Required: the run the provider's hooks will report under. An id minted
     * downstream matches no hook and loses every event silently. */
    providerRunId: string,
  ): Promise<void>;
}
