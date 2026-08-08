import { z } from "zod";
import type { AgentRecord, ExecutionIdentity } from "../../schemas/agent";
import { CapabilityProviderSchema } from "../../schemas/capability";
import { TaskIdSchema } from "../../schemas/hierarchy-ids";
import { opaqueString } from "../../schemas/wire-schema";
import { RoutingCategorySchema } from "../../schemas/routing-policy";
import type { AssignmentKind } from "../../schemas/hierarchy-node";
import type { AuthorizedLaunch } from "../routing-service/authorized-launch";
import {
  type HierarchyRecipientBindingState,
  HierarchySpawnFieldsSchema,
} from "./admission";

const FlatSpawnRequestSchema = z.strictObject({
  task: z.string().min(1),
  category: RoutingCategorySchema,
  tool: CapabilityProviderSchema.optional(),
  reviewOfTool: CapabilityProviderSchema.optional(),
  // An explicit user-directed model. Launched verbatim (no alias resolution), binds the spawn to its vendor for quota routing, and is never silently substituted — pass it only when the user named a model. Routine spawns resolve through the category's policy chain.
  model: z.string().min(1).optional(),
  effort: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  readOnly: z.boolean().optional(),
  handoffId: opaqueString(z.string().uuid()).optional(),
  /** Quota pools proven drained for this request: a handoff replacement must not land back on the pool that just drained its source. */
  excludedPoolIds: z.array(z.string().min(1)).optional(),
  /**
   * Optional board task linkage. Prompt/context only on a flat spawn: the agent
   * is told to read this task with hive_task_get. Does not change spawn
   * admission (a tracking task stays admission-inert). Unknown ids are refused
   * with a Fix: line naming hive_task_list.
   */
  taskId: TaskIdSchema.optional(),
});

export const HierarchySpawnRequestSchema = FlatSpawnRequestSchema.extend(
  HierarchySpawnFieldsSchema.shape,
);

export const SpawnRequestSchema = z.union([
  FlatSpawnRequestSchema,
  HierarchySpawnRequestSchema,
]);

export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;
export type HierarchySpawnRequest = z.infer<typeof HierarchySpawnRequestSchema>;

export function isHierarchySpawnRequest(
  request: SpawnRequest,
): request is HierarchySpawnRequest {
  return "runId" in request;
}

/** Registers review routing as a reviewer duty rather than a hierarchy tier. */
export function assignmentKindForSpawn(
  request: Pick<SpawnRequest, "category">,
): AssignmentKind {
  return request.category === "code_review" ? "reviewer" : "author";
}

export const SpawnBatchRequestSchema = z.strictObject({
  // SessiondHost.create enforces the admission bound that keeps a burst within the host budget; this schema cap only needs to clear the supported agent target.
  requests: z.array(SpawnRequestSchema).min(1).max(32),
});

export type SpawnBatchRequest = z.infer<typeof SpawnBatchRequestSchema>;

export interface Spawner {
  /** Resolves once the generation is durably admitted. Provider launch and readiness verification continue while the returned row is `spawning`. */
  spawn(req: SpawnRequest): Promise<AgentRecord>;
  hierarchyRecipientBindingState?(
    recipient: AgentRecord,
  ): HierarchyRecipientBindingState;
  authorizeLaunch?(identity: ExecutionIdentity): Promise<AuthorizedLaunch>;
}

// The door. Modules outside src/daemon import the spawner surface from here, never from spawner-impl directly: one module names both the interface and the sanctioned implementation pieces, so "who may build a launch" has one answer. (hive-spawner imports this module for the interface — the cycle is safe because it touches these bindings only inside function bodies.)
export {
  agentUiLaunchArgv,
  buildAgentPrompt,
  HiveSpawner,
  protocolProviderArgv,
} from "./spawner-impl";
