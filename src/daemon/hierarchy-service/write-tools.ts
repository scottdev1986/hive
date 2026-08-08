// Authenticated MCP doors for the hierarchy records agents are allowed to write. Caller identity never comes from a record field. HierarchyService resolves the authenticated session's live hierarchy identity inside the transaction that writes the record; these handlers only name the tool, shape its input, and render what the service returns.

import { z } from "zod";
import { RevisionSchema, TaskIdSchema } from "../../schemas/hierarchy-ids";
import { DelegationGrantSchema } from "../../schemas/hierarchy-node";
import { ReviewSchema } from "../../schemas/integration-stage";
import { OwnershipTransferInputSchema } from "../../schemas/ownership-transfer";
import {
  type TaskDetail,
  TaskCreateInputSchema,
  TaskStateSchema,
} from "../../schemas/task-detail";
import { toolResult } from "../../shared/mcp-tool-result";
import type { Capability } from "../authorization/authorization-service";
import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import type { HierarchyService } from "./hierarchy-service";

const GrantIssueInputSchema = DelegationGrantSchema.omit({
  issuer: true,
  capabilityEpoch: true,
});

const TaskUpdateToolInputSchema = z.strictObject({
  taskId: TaskIdSchema,
  expectedRevision: RevisionSchema,
  state: TaskStateSchema.optional(),
  blockers: z.array(z.string().min(1)).optional(),
  evidence: z.array(z.string().min(1)).optional(),
  correction: z.string().min(1).optional(),
  acceptResult: z.boolean().optional(),
  moveGate: z.boolean().optional(),
});

const ReviewWriteInputSchema = ReviewSchema.omit({ reviewer: true });

const OwnershipTransferToolInputSchema = z.strictObject({
  transfer: OwnershipTransferInputSchema,
  expectedHierarchyRevision: RevisionSchema,
  expectedRunEpoch: z.number().int().nonnegative(),
});

/** A write receipt carries what the next CAS needs, not the full story the
 * caller just supplied. Full task records remain available through task_get. */
function taskWriteReceipt(task: TaskDetail) {
  return {
    taskId: task.taskId,
    revision: task.revision,
    state: task.state,
    assigneeNodeId: task.assigneeNodeId,
    blockerCount: task.blockers.length,
    evidenceCount: task.evidence.length,
  };
}

export function registerHierarchyWriteTools(
  server: HiveToolRegistrar,
  capability: Capability,
  hierarchy: HierarchyService,
): void {
  server.registerTool(
    "hive_grant_issue",
    {
      title: "Issue hierarchy grant",
      description:
        "Issue or update one delegation grant as the authenticated hierarchy binding.",
      inputSchema: GrantIssueInputSchema,
    },
    async (rawInput) =>
      toolResult(
        hierarchy.issueGrant(capability, GrantIssueInputSchema.parse(rawInput)),
        "grant",
      ),
  );

  server.registerTool(
    "hive_task_create",
    {
      title: "Create hierarchy task",
      description:
        "Create one task. The daemon derives both owner identities from the authenticated hierarchy binding and returns a compact CAS receipt; use hive_task_get for the full story. Read hive_knowledge topic=board-conventions before use.",
      inputSchema: TaskCreateInputSchema,
    },
    async (rawTask) =>
      toolResult(
        taskWriteReceipt(
          hierarchy.createTask(
            capability,
            TaskCreateInputSchema.parse(rawTask),
          ),
        ),
        "task",
      ),
  );

  server.registerTool(
    "hive_task_update",
    {
      title: "Update hierarchy task",
      description:
        "CAS-update task progress as the authenticated assignee or owner binding. Returns a compact receipt with the next revision; use hive_task_get for the full story. Read hive_knowledge topic=board-conventions before use.",
      inputSchema: TaskUpdateToolInputSchema,
    },
    async (rawInput) =>
      toolResult(
        taskWriteReceipt(
          hierarchy.updateTask(
            capability,
            TaskUpdateToolInputSchema.parse(rawInput),
          ),
        ),
        "task",
      ),
  );

  server.registerTool(
    "hive_review_put",
    {
      title: "Record hierarchy review",
      description:
        "Record one immutable review revision under the authenticated reviewer binding.",
      inputSchema: ReviewWriteInputSchema,
    },
    async (rawReview) =>
      toolResult(
        hierarchy.putReview(
          capability,
          ReviewWriteInputSchema.parse(rawReview),
        ),
        "review",
      ),
  );

  server.registerTool(
    "hive_ownership_transfer",
    {
      title: "Transfer hierarchy ownership",
      description:
        "Transfer a recorded lost subtree from its authenticated current owner to the successor grant holder.",
      inputSchema: OwnershipTransferToolInputSchema,
    },
    async (rawInput) =>
      toolResult(
        hierarchy.transferOwnership(
          capability,
          OwnershipTransferToolInputSchema.parse(rawInput),
        ),
        "ownershipTransfer",
      ),
  );
}
