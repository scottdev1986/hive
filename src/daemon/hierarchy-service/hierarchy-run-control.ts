import { createHash, randomUUID } from "node:crypto";
import {
  type Run,
  type RunLifecycle,
  RunSchema,
} from "../../schemas/hierarchy-run";
import {
  type MutationFailure,
  RUN_CONTROL_FAILURE_CODES,
  type RunControlIntent,
  type RunControlResult,
  RunControlResultSchema,
  type RunCreateBody,
  type RunDelegateBody,
  runDelegateWireRefusal,
} from "../../schemas/run-control";
import type { HierarchyStore } from "../hierarchy-store";
import { canonicalJson } from "../status-service/status-service";
import { HierarchyConflictError, HierarchyFenceError } from "./records";

/** Named seam for the promotion engine: what abort leaves behind is a run whose lifecycle is "aborted" and whose runEpoch has moved past every grant issued before it. Admission refuses on both counts. Run control only leaves that state — it does not police promotion. */
export const ABORTED_RUN_ADMISSION_SEAM =
  "aborted lifecycle + advanced runEpoch → promotion admission refuses" as const;

export class RunNotFoundError extends Error {
  readonly code = "RUN_NOT_FOUND";

  constructor(runId: string) {
    super(`no run ${runId}`);
    this.name = "RunNotFoundError";
  }
}

const nextRevision = (current: string): string =>
  (BigInt(current) + 1n).toString();

const fail = (code: string, message: string): MutationFailure => ({
  code,
  message,
});

function intentDigest(intent: RunControlIntent): string {
  const hash = createHash("sha256").update(canonicalJson(intent), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

/** The refusal a store race maps to, or null when the error is not a race and belongs to the caller as a fault. Both fences are compare-and-swap failures from the client's point of view: something moved under the intent. */
function racedWrite<T>(error: T): MutationFailure | null {
  if (error instanceof HierarchyConflictError) {
    return fail(
      RUN_CONTROL_FAILURE_CODES.revisionConflict,
      `run moved to revision ${error.currentRevision} while the decision was being written`,
    );
  }
  if (error instanceof HierarchyFenceError && error.fence === "runEpoch") {
    return fail(
      RUN_CONTROL_FAILURE_CODES.epochConflict,
      `run epoch moved to ${String(error.current)} while the decision was being written`,
    );
  }
  return null;
}

const ref = (record: { revision: string; digest: string }) => ({
  revision: record.revision,
  digest: record.digest,
});

export class RunControl {
  /** @param onAccepted Called once per fresh accepted decision, after the commit is durable — never on a refusal and never on an idempotent replay, so a retry cannot double-fire whatever the listener records. */
  constructor(
    private readonly store: HierarchyStore,
    private readonly onAccepted?: (
      intent: RunControlIntent,
      after: Run,
    ) => void,
  ) {}

  /** Decide one intent. Reading the facts and committing the decision happen inside one store transaction. Throws only when the run does not exist; every other refusal comes back as a rejected result with the observed post-state. */
  apply(intent: RunControlIntent, _decider: string): RunControlResult {
    const runId = intent.body.runId;
    if (intent.body.operation === "run-create") {
      return this.createRun(intent, intent.body);
    }
    const replay = this.replayOf(intent);
    if (replay !== null) return replay;

    let failure: MutationFailure | null;
    try {
      failure = this.store.transaction((): MutationFailure | null => {
        const before = this.store.getRun(runId);
        if (before === null) throw new RunNotFoundError(runId);
        const epoch = this.store.getFences(runId)?.runEpoch ?? before.runEpoch;
        const refused = this.check(intent, before, epoch);
        if (refused !== null) return refused;
        return this.commit(intent, before, epoch);
      });
    } catch (error) {
      // A write that lost a race is a refusal the caller can act on, not a server fault: it comes back as a rejection carrying live state.
      const raced = racedWrite(error);
      if (raced === null) throw error;
      failure = raced;
    }

    const after = this.store.getRun(runId);
    if (after === null) throw new RunNotFoundError(runId);
    const result = RunControlResultSchema.parse({
      schemaVersion: 1,
      intentId: intent.intentId,
      operationId: `op_${randomUUID()}`,
      postStateToken: {
        kind: "revision-and-epoch",
        revision: after.revision,
        epoch: String(after.runEpoch),
      },
      outcome:
        failure === null
          ? { status: "accepted" }
          : { status: "rejected", failure },
      observedPostState: after,
    });
    // Only decisions that changed something are worth replaying. A refusal has no effect to repeat, and re-deciding it answers from live state.
    if (failure === null) {
      this.store.putRunControlDecision(runId, {
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        result,
      });
      this.onAccepted?.(intent, after);
    }
    return result;
  }

  /** Genesis: the one intent whose run does not exist yet. Everything the run needs is written in ONE transaction, in the order the store's own fences require: the spec and topology first because they are append-only and fence on nothing, then the Run — which is what seeds hierarchy_fences — then the plan and budget, which assert the run epoch the Run just established, then the root node and its stable principal. The Run points at every record in the caller's package, spec included, so spawn admission fences on exactly the revisions named here. The root principal is not an AgentBinding and creates no agents-table row; it only makes the queen's pre-existing root capability resolvable to this run's root node. */
  private createRun(
    intent: RunControlIntent,
    body: RunCreateBody,
  ): RunControlResult {
    const recorded = this.store.getRunControlDecision(intent.idempotencyKey);
    if (recorded !== null && recorded.intentDigest === intentDigest(intent)) {
      return recorded.result;
    }

    let failure: MutationFailure | null;
    try {
      failure = this.store.transaction((): MutationFailure | null => {
        if (this.store.getRun(body.runId) !== null) {
          return fail(
            RUN_CONTROL_FAILURE_CODES.runAlreadyExists,
            `run ${body.runId} already exists`,
          );
        }
        this.store.putSpecRevision(body.spec);
        this.store.putTopologyDecision(body.topology);
        const run = RunSchema.parse({
          runId: body.runId,
          revision: "1",
          repo: body.repo,
          instanceId: body.instanceId,
          spec: ref(body.spec),
          currentPlan: ref(body.plan),
          topology: ref(body.topology),
          phase: "P0",
          baseSha: body.baseSha,
          budget: ref(body.budget),
          runEpoch: 0,
          lifecycle: "active",
        });
        this.store.putRun(run, null);
        this.store.putPlanRevision(body.plan, run.runEpoch);
        this.store.putRunBudget(body.budget, run.runEpoch);
        this.store.putNode(
          {
            nodeId: body.rootNodeId,
            runId: body.runId,
            parentNodeId: null,
            ownerNodeId: null,
            organizationalRole: "lead-worker",
            assignmentKind: "lead-coordination",
            taskScope: [],
            capacityCharge: 0,
            lifecycle: "active",
            revision: "1",
          },
          null,
        );
        this.store.putRootBinding(body.runId, body.rootNodeId);
        return null;
      });
    } catch (error) {
      const raced = racedWrite(error);
      if (raced === null) throw error;
      failure = raced;
    }

    const after = this.store.getRun(body.runId);
    if (after === null) throw new RunNotFoundError(body.runId);
    const result = RunControlResultSchema.parse({
      schemaVersion: 1,
      intentId: intent.intentId,
      operationId: `op_${randomUUID()}`,
      postStateToken: {
        kind: "revision-and-epoch",
        revision: after.revision,
        epoch: String(after.runEpoch),
      },
      outcome:
        failure === null
          ? { status: "accepted" }
          : { status: "rejected", failure },
      observedPostState: after,
    });
    if (failure === null) {
      this.store.putRunControlDecision(body.runId, {
        idempotencyKey: intent.idempotencyKey,
        intentDigest: intentDigest(intent),
        result,
      });
      this.onAccepted?.(intent, after);
    }
    return result;
  }

  /** The answer a spent idempotency key already bought, or null when the key is fresh. The same bytes get back the same decision — the same operation id included, because a retry refers to one server decision rather than asking for a second one. Different bytes under a spent key are refused: the caller meant a new mutation and must spend a new key on it. */
  private replayOf(intent: RunControlIntent): RunControlResult | null {
    const recorded = this.store.getRunControlDecision(intent.idempotencyKey);
    if (recorded === null) return null;
    if (recorded.intentDigest === intentDigest(intent)) return recorded.result;
    const after = this.store.getRun(intent.body.runId);
    if (after === null) throw new RunNotFoundError(intent.body.runId);
    return RunControlResultSchema.parse({
      schemaVersion: 1,
      intentId: intent.intentId,
      operationId: `op_${randomUUID()}`,
      postStateToken: {
        kind: "revision-and-epoch",
        revision: after.revision,
        epoch: String(after.runEpoch),
      },
      outcome: {
        status: "rejected",
        failure: fail(
          RUN_CONTROL_FAILURE_CODES.idempotencyKeyReused,
          `idempotency key ${intent.idempotencyKey} already decided a different intent`,
        ),
      },
      observedPostState: after,
    });
  }

  private check(
    intent: RunControlIntent,
    run: Run,
    epoch: number,
  ): MutationFailure | null {
    const expected = intent.expected;
    if (expected.revision !== run.revision) {
      return fail(
        RUN_CONTROL_FAILURE_CODES.revisionConflict,
        `expected revision ${expected.revision}; run is at ${run.revision}`,
      );
    }
    if (expected.epoch !== String(epoch)) {
      return fail(
        RUN_CONTROL_FAILURE_CODES.epochConflict,
        `expected epoch ${expected.epoch}; run is at ${String(epoch)}`,
      );
    }

    switch (intent.body.operation) {
      case "run-pause":
        return admits(run, ["active"], "pause");
      case "run-resume":
        return admits(run, ["paused"], "resume");
      case "run-abort":
        return admits(run, ["active", "paused"], "abort");
      case "run-delegate":
        return this.checkDelegate(intent.body, run);
      case "run-create":
        // Creation never reaches here: apply routes it before loading a run, because this path exists to decide against one that already exists.
        return fail(
          RUN_CONTROL_FAILURE_CODES.runAlreadyExists,
          `run ${run.runId} already exists`,
        );
    }
  }

  private checkDelegate(
    body: RunDelegateBody,
    run: Run,
  ): MutationFailure | null {
    const gate = admits(run, ["active"], "delegate");
    if (gate !== null) return gate;
    const wire = runDelegateWireRefusal(body);
    if (wire !== null) {
      return fail(RUN_CONTROL_FAILURE_CODES.delegationInvalid, wire);
    }
    const root = this.store
      .listNodes(run.runId)
      .filter((node) => node.parentNodeId === null);
    const rootNodeId = root.length === 1 ? root[0]?.nodeId : undefined;
    if (rootNodeId === undefined) {
      return fail(
        RUN_CONTROL_FAILURE_CODES.delegationInvalid,
        `run ${run.runId} does not have exactly one root node`,
      );
    }
    if (
      body.grant.issuer.nodeId !== rootNodeId ||
      body.node.parentNodeId !== rootNodeId ||
      body.node.ownerNodeId !== rootNodeId ||
      body.task.ownerNodeId !== rootNodeId
    ) {
      return fail(
        RUN_CONTROL_FAILURE_CODES.delegationInvalid,
        `run-delegate issues only from run ${run.runId}'s root node ${rootNodeId}`,
      );
    }
    if (body.task.baseSha !== run.baseSha) {
      return fail(
        RUN_CONTROL_FAILURE_CODES.delegationInvalid,
        `task baseSha ${body.task.baseSha} is not the run's baseSha ${run.baseSha}`,
      );
    }
    return null;
  }

  /** Write the decision, or refuse it on a fact that moved since the check. Callers run this inside the same transaction as the check, so the recheck here is the last read of the stage before the write is durable. */
  private commit(
    intent: RunControlIntent,
    run: Run,
    epoch: number,
  ): MutationFailure | null {
    const body = intent.body;
    switch (body.operation) {
      case "run-pause":
        this.transition(run, epoch, "paused");
        return null;
      case "run-resume":
        this.transition(run, epoch, "active");
        return null;
      case "run-abort":
        this.transition(run, epoch, "aborted");
        return null;
      case "run-delegate": {
        // Node before task before grant: a task needs its node, and a grant needs both. The grant is written under the root's own authority, which the store re-verifies rather than takes on trust.
        this.store.putNode(body.node, null);
        this.store.putTask(body.task);
        const fences = this.store.getFences(run.runId);
        this.store.putGrant(
          body.grant,
          {
            expectedHierarchyRevision: fences?.hierarchyRevision ?? "0",
            expectedRunEpoch: epoch,
            expectedCapabilityEpoch: body.grant.capabilityEpoch,
            binding: body.grant.issuer,
          },
          "run-root",
        );
        return null;
      }
      case "run-create":
        return fail(
          RUN_CONTROL_FAILURE_CODES.runAlreadyExists,
          `run ${run.runId} already exists`,
        );
    }
  }

  /** Move lifecycle and retire the current epoch together. The epoch advances first: if the process dies between the two writes the run is over-fenced — prior-epoch work already refused — instead of still admitting work under an epoch the pause was meant to close. */
  private transition(run: Run, epoch: number, lifecycle: RunLifecycle): void {
    const next = this.store.advanceRunEpoch(run.runId, epoch);
    this.store.putRun(
      {
        ...run,
        revision: nextRevision(run.revision),
        runEpoch: next,
        lifecycle,
      },
      run.revision,
    );
  }
}

function admits(
  run: Run,
  lifecycles: readonly RunLifecycle[],
  operation: string,
): MutationFailure | null {
  if (lifecycles.includes(run.lifecycle)) return null;
  return fail(
    RUN_CONTROL_FAILURE_CODES.lifecycleInvalid,
    `cannot ${operation} a ${run.lifecycle} run`,
  );
}
