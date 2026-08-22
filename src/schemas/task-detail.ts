import { z } from "zod";
import {
  ArtifactRefIdSchema,
  CreatedAtSchema,
  DigestSchema,
  GitShaSchema,
  RevisionSchema,
  RunIdSchema,
  SafeUintSchema,
  TaskIdSchema,
} from "./hierarchy-ids";
import {
  DelegationSpecSchema,
  NodeIdSchema,
  RepoPathSchema,
} from "./hierarchy-node";

export const TASK_STATES = [
  "planned",
  "assigned",
  "in-progress",
  "blocked",
  "completed",
  "terminated",
] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

const TaskFields = {
  taskId: TaskIdSchema,
  revision: RevisionSchema,
  parentTaskId: TaskIdSchema.nullable(),
  dependsOn: z.array(TaskIdSchema),
  delegationSpec: DelegationSpecSchema,
  acceptanceIds: z.array(z.string().min(1)).min(1),
  ownerNodeId: NodeIdSchema,
  assigneeNodeId: NodeIdSchema.nullable(),
  pathLeases: z.array(
    z.strictObject({
      path: RepoPathSchema,
      mode: z.enum(["read", "write"]),
    }),
  ),
  branch: z.string().min(1),
  baseSha: GitShaSchema,
  state: TaskStateSchema,
  blockers: z.array(z.string().min(1)),
  evidence: z.array(ArtifactRefIdSchema),
  artifactRefs: z.array(ArtifactRefIdSchema),
  correction: z.string().min(1).optional(),
} as const;

export const TaskSchema = z.strictObject(TaskFields);
export type Task = z.infer<typeof TaskSchema>;

// TaskDetail intentionally has one record revision. A state-changing operation carries its own expected revision, so the record cannot contain two untied values that disagree about which version is current.
export const TaskDetailSchema = TaskSchema;
export type TaskDetail = Task;

/** Agent input for creating a task. The authenticated hierarchy binding owns
 * the task, so callers cannot choose or copy either form of owner identity. */
export const TaskCreateInputSchema = TaskDetailSchema.omit({
  ownerNodeId: true,
  delegationSpec: true,
}).extend({
  runId: RunIdSchema.describe(
    "The coordination run this task belongs to. This selects a run; it does not identify or fence the caller.",
  ),
  delegationSpec: DelegationSpecSchema.omit({ allowance: true }).extend({
    allowance: DelegationSpecSchema["shape"].allowance.omit({ owner: true }),
  }),
});
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const ARTIFACT_RETENTION = ["run", "durable"] as const;
export const ArtifactRetentionSchema = z.enum(ARTIFACT_RETENTION);

export const ArtifactRefSchema = z.strictObject({
  artifactId: ArtifactRefIdSchema,
  kind: z.string().min(1),
  ownerNodeId: NodeIdSchema,
  taskId: TaskIdSchema.nullable(),
  digest: DigestSchema,
  contentRevision: RevisionSchema,
  storageLocator: z.string().min(1),
  accessCapability: z.string().min(1),
  sizeBytes: SafeUintSchema,
  createdAt: CreatedAtSchema,
  retention: ArtifactRetentionSchema,
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
