import {
  type TaskDetail,
  TaskDetailSchema,
  TaskStateSchema,
} from "../../schemas/task-detail";
import {
  HierarchyValidationError,
  nextRevision,
  type TaskUpdateInput,
} from "./records";

/**
 * Pure task-update rules: who may write, what a terminal task refuses, and the
 * next document those inputs produce.
 *
 * The store still owns the CAS, the run-active fence, and the write. Keeping
 * the authorization and next-state math here means those rules can be read
 * without the SQL that persists them.
 */

export function applyTaskUpdate(
  current: TaskDetail,
  input: TaskUpdateInput,
): TaskDetail {
  if (input.state !== undefined) TaskStateSchema.parse(input.state);

  const isOwner = input.actorNodeId === current.ownerNodeId;
  const isAssignee =
    current.assigneeNodeId !== null &&
    input.actorNodeId === current.assigneeNodeId;
  if (!isOwner && !isAssignee) {
    throw new HierarchyValidationError(
      "task update requires the assignee or owner binding",
    );
  }
  if (input.assigneeNodeId !== undefined && !isOwner) {
    throw new HierarchyValidationError("only the task owner may assign it");
  }
  if (input.correction !== undefined && !isOwner) {
    throw new HierarchyValidationError(
      "only the task owner may correct its story",
    );
  }
  if (input.moveGate === true) {
    throw new HierarchyValidationError(
      "task update cannot move gates; gate transitions are a separate operation",
    );
  }
  if (input.acceptResult === true) {
    if (isAssignee) {
      throw new HierarchyValidationError(
        "assignee cannot accept its own result; only a distinct owner may accept",
      );
    }
    if (!isOwner) {
      throw new HierarchyValidationError(
        "only the owner may accept a task result",
      );
    }
  }

  // A terminal task refuses only the lie: a requested state change, which used
  // to be dropped silently while the rest of the write landed. Blockers and
  // evidence appends stay legal, and re-sending the current state is not a change.
  const terminal =
    current.state === "completed" || current.state === "terminated";
  if (terminal && input.state !== undefined && input.state !== current.state) {
    throw new HierarchyValidationError(
      `task update cannot change state on a ${current.state} task`,
    );
  }

  return TaskDetailSchema.parse({
    ...current,
    revision: nextRevision(current.revision),
    state: input.state ?? current.state,
    blockers: input.blockers ?? current.blockers,
    evidence: input.evidence ?? current.evidence,
    assigneeNodeId: input.assigneeNodeId ?? current.assigneeNodeId,
    ...(input.correction === undefined ? {} : { correction: input.correction }),
  });
}
