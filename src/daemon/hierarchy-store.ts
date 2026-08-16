import type { ZodType } from "zod";
import { type AgentRecord, ORCHESTRATOR_NAME } from "../schemas/agent";
import {
  type AgentBinding,
  type AgentBindingRef,
  AgentBindingRefSchema,
  AgentBindingSchema,
  type DelegationGrant,
  DelegationGrantSchema,
  type HierarchyNode,
  HierarchyNodeSchema,
  isDelegationGrantAttenuation,
} from "../schemas/hierarchy-node";
import {
  type PlanRevision,
  PlanRevisionSchema,
  type Run,
  type RunBudget,
  RunBudgetSchema,
  RunSchema,
  type SpecRevision,
  SpecRevisionSchema,
  type TopologyDecision,
  TopologyDecisionSchema,
} from "../schemas/hierarchy-run";
import {
  type IntegrationStage,
  IntegrationStageSchema,
  IntegrationStagesSchema,
  type Review,
  ReviewSchema,
} from "../schemas/integration-stage";
import {
  type OwnershipTransfer,
  type OwnershipTransferInput,
  OwnershipTransferInputSchema,
  OwnershipTransferSchema,
} from "../schemas/ownership-transfer";
import {
  type RunControlDecision,
  RunControlDecisionSchema,
} from "../schemas/run-control";
import { type TaskDetail, TaskDetailSchema } from "../schemas/task-detail";
import type { DatabaseHost } from "../shared/database-host";
import {
  type AuthorityFences,
  bindingId,
  type GrantIssuerAuthority,
  HierarchyConflictError,
  HierarchyFenceError,
  type HierarchyRecordKind,
  type HierarchyRecordRow,
  HierarchyValidationError,
  nextRevision,
  type RoleConferral,
  revisionedId,
  sameBindingRef,
  type TaskUpdateInput,
} from "./hierarchy-service/records";
import { selectLiveReviews } from "./hierarchy-service/review-live";
import { applyTaskUpdate } from "./hierarchy-service/task-update";

interface HierarchyDatabase extends DatabaseHost {
  getAgentById(id: string): AgentRecord | null;
}

type StoredRunRow = { id: string; runId: string; document: string };

/** Bring stored Runs onto the current RunSchema. Older Runs carried a `g1` gate object and an `approvedSpec` that only that gate could ever fill; RunSchema is strict and every read parses through it, so one leftover `g1` key makes getRun throw and a fresh daemon cannot open an existing instance at all. Each Run now names its SpecRevision directly as `spec`, so carry the approved ref over where the gate had run, and otherwise take the highest stored SpecRevision — the revision the run states, and the same one tasks created under it already cite. */
function migrateRunSpecRef(db: DatabaseHost): void {
  const rows = db.database
    .query(
      `SELECT id, runId, document FROM hierarchy_records
       WHERE kind = 'run' AND document LIKE '%"g1"%'`,
    )
    .all() as StoredRunRow[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.document);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const document = parsed as Record<string, unknown>;
    document.spec ??= document.approvedSpec ?? statedSpecRef(db, row.runId);
    delete document.approvedSpec;
    delete document.g1;
    if (document.spec === null) continue;
    db.database
      .query("UPDATE hierarchy_records SET document = ? WHERE kind = 'run' AND id = ?")
      .run(JSON.stringify(document), row.id);
  }
}

/** The highest SpecRevision stored for a run, as a RevisionRef, or null when the run has none to point at. */
function statedSpecRef(
  db: DatabaseHost,
  runId: string,
): { revision: string; digest: string } | null {
  const rows = db.database
    .query(
      `SELECT document FROM hierarchy_records
       WHERE kind = 'spec-revision' AND runId = ?`,
    )
    .all(runId) as { document: string }[];
  let best: { revision: string; digest: string } | null = null;
  for (const row of rows) {
    let spec: { revision?: unknown; digest?: unknown };
    try {
      spec = JSON.parse(row.document) as typeof spec;
    } catch {
      continue;
    }
    if (typeof spec.revision !== "string" || typeof spec.digest !== "string") {
      continue;
    }
    if (best === null || BigInt(spec.revision) > BigInt(best.revision)) {
      best = { revision: spec.revision, digest: spec.digest };
    }
  }
  return best;
}

export class HierarchyStore {
  constructor(private readonly db: HierarchyDatabase) {
    db.database.exec(`
      CREATE TABLE IF NOT EXISTS hierarchy_fences (
        runId TEXT PRIMARY KEY,
        hierarchyRevision TEXT NOT NULL,
        runEpoch INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hierarchy_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        runId TEXT NOT NULL,
        revision TEXT,
        capabilityEpoch INTEGER,
        document TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS hierarchy_records_run_kind
        ON hierarchy_records(runId, kind)
    `);
    migrateRunSpecRef(db);
  }

  /** Credential rotation uses AgentRecord's one capability epoch. */
  liveCapabilityEpoch(binding: AgentBindingRef): number {
    const agent = this.db.getAgentById(binding.agentId);
    if (agent === null) {
      throw new HierarchyValidationError(
        `no flat agent ${binding.agentId} for capability epoch`,
      );
    }
    return agent.capabilityEpoch;
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work);
  }

  getFences(
    runId: string,
  ): { hierarchyRevision: string; runEpoch: number } | null {
    const row = this.db.database
      .query(
        "SELECT hierarchyRevision, runEpoch FROM hierarchy_fences WHERE runId = ?",
      )
      .get(runId) as {
      hierarchyRevision: string;
      runEpoch: number;
    } | null;
    return row;
  }

  /** The only way to advance the run-wide pause/abort fence. */
  advanceRunEpoch(runId: string, expectedRunEpoch: number): number {
    return this.db.transaction(() => {
      const fences = this.requireFences(runId);
      if (fences.runEpoch !== expectedRunEpoch) {
        throw new HierarchyFenceError(
          "runEpoch",
          expectedRunEpoch,
          fences.runEpoch,
        );
      }
      const next = fences.runEpoch + 1;
      this.db.database
        .query("UPDATE hierarchy_fences SET runEpoch = ? WHERE runId = ?")
        .run(next, runId);
      const run = this.getRun(runId);
      if (run !== null) {
        this.upsertRow(
          "run",
          run.runId,
          run.runId,
          run.revision,
          null,
          RunSchema.parse({ ...run, runEpoch: next }),
        );
      }
      return next;
    });
  }

  getRun(runId: string): Run | null {
    return this.readParsed("run", runId, RunSchema);
  }

  listRuns(): Run[] {
    return this.listDocuments("run", null).map((document) =>
      RunSchema.parse(document),
    );
  }

  /** Run epochs advance only through `advanceRunEpoch`, never a plain CAS. */
  putRun(run: Run, expectedRevision: string | null): Run {
    const parsed = RunSchema.parse(run);
    return this.db.transaction(() => {
      const fences = this.getFences(parsed.runId);
      if (fences === null) {
        if (expectedRevision !== null) {
          throw new HierarchyConflictError("0");
        }
        this.casMutable(
          "run",
          parsed.runId,
          parsed.runId,
          null,
          parsed.revision,
          null,
          parsed,
        );
        this.db.database
          .query(
            `INSERT INTO hierarchy_fences (runId, hierarchyRevision, runEpoch)
             VALUES (?, '0', ?)`,
          )
          .run(parsed.runId, parsed.runEpoch);
        return parsed;
      }

      // Update path: fence is the authority for runEpoch. The document may not disagree with it, and this method never writes the fence table.
      if (parsed.runEpoch !== fences.runEpoch) {
        throw new HierarchyFenceError(
          "runEpoch",
          parsed.runEpoch,
          fences.runEpoch,
        );
      }
      this.casMutable(
        "run",
        parsed.runId,
        parsed.runId,
        expectedRevision,
        parsed.revision,
        null,
        parsed,
      );
      return parsed;
    });
  }

  getSpecRevision(runId: string, revision: string): SpecRevision | null {
    return this.readParsed(
      "spec-revision",
      revisionedId(runId, revision),
      SpecRevisionSchema,
    );
  }

  /** Every SpecRevision proposed on a run. Spec revisions are append-only and a Run points at only one of them, so a caller asking what else has been proposed has no other way to find it. */
  listSpecRevisions(runId: string): SpecRevision[] {
    return this.listDocuments("spec-revision", runId).map((document) =>
      SpecRevisionSchema.parse(document),
    );
  }

  putSpecRevision(spec: SpecRevision): SpecRevision {
    const parsed = SpecRevisionSchema.parse(spec);
    if (parsed.lifecycle === "approved" && parsed.engineerApproval === null) {
      throw new HierarchyValidationError(
        "lifecycle approved requires a non-null engineerApproval decider",
      );
    }
    return this.db.transaction(() => {
      this.insertAppendOnly(
        "spec-revision",
        revisionedId(parsed.runId, parsed.revision),
        parsed.runId,
        parsed.revision,
        parsed,
      );
      return parsed;
    });
  }

  getPlanRevision(runId: string, revision: string): PlanRevision | null {
    return this.readParsed(
      "plan-revision",
      revisionedId(runId, revision),
      PlanRevisionSchema,
    );
  }

  /** Bind plan provenance to an existing run at its live epoch. */
  putPlanRevision(plan: PlanRevision, expectedRunEpoch: number): PlanRevision {
    const parsed = PlanRevisionSchema.parse(plan);
    return this.db.transaction(() => {
      this.assertRunEpoch(parsed.runId, expectedRunEpoch);
      this.insertAppendOnly(
        "plan-revision",
        revisionedId(parsed.runId, parsed.revision),
        parsed.runId,
        parsed.revision,
        parsed,
      );
      return parsed;
    });
  }

  getRunBudget(runId: string, revision: string): RunBudget | null {
    return this.readParsed(
      "run-budget",
      revisionedId(runId, revision),
      RunBudgetSchema,
    );
  }

  putRunBudget(budget: RunBudget, expectedRunEpoch: number): RunBudget {
    const parsed = RunBudgetSchema.parse(budget);
    return this.db.transaction(() => {
      this.assertRunEpoch(parsed.runId, expectedRunEpoch);
      this.insertAppendOnly(
        "run-budget",
        revisionedId(parsed.runId, parsed.revision),
        parsed.runId,
        parsed.revision,
        parsed,
      );
      return parsed;
    });
  }

  getTopologyDecision(
    runId: string,
    revision: string,
  ): TopologyDecision | null {
    return this.readParsed(
      "topology-decision",
      revisionedId(runId, revision),
      TopologyDecisionSchema,
    );
  }

  putTopologyDecision(decision: TopologyDecision): TopologyDecision {
    const parsed = TopologyDecisionSchema.parse(decision);
    if (
      parsed.lifecycle === "approved" &&
      parsed.decisionProvenance.engineerDecision === null
    ) {
      throw new HierarchyValidationError(
        "lifecycle approved requires a non-null engineerDecision decider",
      );
    }
    return this.db.transaction(() => {
      this.insertAppendOnly(
        "topology-decision",
        revisionedId(parsed.runId, parsed.revision),
        parsed.runId,
        parsed.revision,
        parsed,
      );
      return parsed;
    });
  }

  getNode(nodeId: string): HierarchyNode | null {
    return this.readParsed("node", nodeId, HierarchyNodeSchema);
  }

  listNodes(runId: string): HierarchyNode[] {
    return this.listDocuments("node", runId).map((document) =>
      HierarchyNodeSchema.parse(document),
    );
  }

  listTasks(runId: string): TaskDetail[] {
    return this.listDocuments("task", runId).map((document) =>
      TaskDetailSchema.parse(document),
    );
  }

  listAllTasks(): TaskDetail[] {
    return this.listDocuments("task", null).map((document) =>
      TaskDetailSchema.parse(document),
    );
  }

  putNode(
    node: HierarchyNode,
    expectedRevision: string | null,
    expectedHierarchyRevision?: string,
    conferral?: RoleConferral,
  ): HierarchyNode {
    const parsed = HierarchyNodeSchema.parse(node);
    return this.db.transaction(() => {
      const current = this.getNode(parsed.nodeId);
      if (current !== null && current.runId !== parsed.runId) {
        throw new HierarchyValidationError(
          `node ${parsed.nodeId} runId is immutable (stored ${current.runId}, got ${parsed.runId})`,
        );
      }
      if (current === null && conferral !== undefined) {
        this.requireActiveRun(parsed.runId);
        this.assertNodeOwnerLocked(parsed, conferral);
      }
      this.assertNodeTopologyLocked(parsed, current);
      this.assertRoleConferralLocked(parsed, current, conferral);
      const treeMutation =
        current !== null &&
        (current.parentNodeId !== parsed.parentNodeId ||
          current.ownerNodeId !== parsed.ownerNodeId);
      if (treeMutation) {
        if (expectedHierarchyRevision === undefined) {
          throw new HierarchyValidationError(
            "ownership/tree mutations require expectedHierarchyRevision",
          );
        }
        this.advanceHierarchyRevisionLocked(
          parsed.runId,
          expectedHierarchyRevision,
        );
      }
      this.casMutable(
        "node",
        parsed.nodeId,
        parsed.runId,
        expectedRevision,
        parsed.revision,
        null,
        parsed,
      );
      return parsed;
    });
  }

  getAgentBinding(binding: AgentBindingRef): AgentBinding | null {
    return this.readParsed("binding", bindingId(binding), AgentBindingSchema);
  }

  getRootBinding(runId: string): AgentBindingRef | null {
    return this.readParsed("root-binding", runId, AgentBindingRefSchema);
  }

  /** Records the stable queen principal on the run's one root node. */
  putRootBinding(runId: string, nodeId: string): AgentBindingRef {
    const binding = AgentBindingRefSchema.parse({
      nodeId,
      agentId: ORCHESTRATOR_NAME,
      generation: 1,
    });
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      const node = this.getNode(nodeId);
      if (run === null || node === null || node.runId !== runId) {
        throw new HierarchyValidationError(
          `root binding ${nodeId} must name a stored root node of run ${runId}`,
        );
      }
      if (node.parentNodeId !== null) {
        throw new HierarchyValidationError(
          `root binding node ${nodeId} is not the root of run ${runId}`,
        );
      }
      const roots = this.listNodes(runId).filter(
        (candidate) => candidate.parentNodeId === null,
      );
      if (roots.length !== 1 || roots[0]?.nodeId !== nodeId) {
        throw new HierarchyValidationError(
          `run ${runId} does not have ${nodeId} as its one root`,
        );
      }
      this.casMutable("root-binding", runId, runId, null, "1", 0, binding);
      return binding;
    });
  }

  rootBindingMatches(runId: string, binding: AgentBindingRef): boolean {
    const root = this.getRootBinding(runId);
    return root !== null && sameBindingRef(root, binding);
  }

  /** Bindings cannot be re-homed; capability epoch is read from AgentRecord. */
  putAgentBinding(binding: AgentBinding, runId: string): AgentBinding {
    const parsed = AgentBindingSchema.parse(binding);
    return this.db.transaction(() => {
      const node = this.getNode(parsed.nodeId);
      if (node === null) {
        throw new HierarchyValidationError(
          `node ${parsed.nodeId} must exist before binding ${parsed.agentId}`,
        );
      }
      if (node.runId !== runId) {
        throw new HierarchyValidationError(
          `binding runId ${runId} does not match node ${parsed.nodeId} run ${node.runId}`,
        );
      }
      const generationBinding = this.findBindingByAgent(
        parsed.agentId,
        parsed.generation,
      );
      if (
        generationBinding !== null &&
        !sameBindingRef(generationBinding, parsed)
      ) {
        throw new HierarchyValidationError(
          `agent ${parsed.agentId} generation ${String(parsed.generation)} is already bound to node ${generationBinding.nodeId}`,
        );
      }
      const existing = this.getAgentBinding(parsed);
      if (existing !== null) {
        const existingRunId = this.bindingRunId(existing);
        if (existingRunId !== runId) {
          throw new HierarchyValidationError(
            `binding runId is ${existingRunId}; cannot re-home to ${runId}`,
          );
        }
      }
      // Binding rows leave the capabilityEpoch column null — the fence reads the flat AgentRecord instead of a frozen copy on this document.
      this.upsertRow("binding", bindingId(parsed), runId, null, null, parsed);
      return parsed;
    });
  }

  getTask(taskId: string): TaskDetail | null {
    return this.readParsed("task", taskId, TaskDetailSchema);
  }

  putTask(task: TaskDetail): TaskDetail {
    const parsed = TaskDetailSchema.parse(task);
    return this.db.transaction(() => {
      const runId = this.requireTaskRunId(parsed);
      this.requireActiveRun(runId);
      if (parsed.assigneeNodeId !== null) {
        const assignee = this.getNode(parsed.assigneeNodeId);
        if (assignee === null) {
          throw new HierarchyValidationError(
            `assignee node ${parsed.assigneeNodeId} must exist before writing task ${parsed.taskId}`,
          );
        }
        if (assignee.runId !== runId) {
          throw new HierarchyValidationError(
            `task assignee node ${assignee.nodeId} belongs to run ${assignee.runId}, not owner run ${runId}`,
          );
        }
        if (!this.nodeIsUnderAncestor(assignee.nodeId, parsed.ownerNodeId)) {
          throw new HierarchyValidationError(
            `task assignee node ${assignee.nodeId} is outside owner ${parsed.ownerNodeId}'s node subtree`,
          );
        }
      }
      this.casMutable(
        "task",
        parsed.taskId,
        runId,
        null,
        parsed.revision,
        null,
        parsed,
      );
      return parsed;
    });
  }

  /** Terminal tasks accept evidence but refuse state changes. */
  updateTask(input: TaskUpdateInput): TaskDetail {
    return this.db.transaction(() => {
      const current = this.getTask(input.taskId);
      if (current === null) {
        throw new HierarchyConflictError("0");
      }
      if (current.revision !== input.expectedRevision) {
        throw new HierarchyConflictError(current.revision);
      }
      const runId = this.requireTaskRunId(current);
      this.requireActiveRun(runId);
      const next = applyTaskUpdate(current, input);
      this.upsertRow("task", next.taskId, runId, next.revision, null, next);
      return next;
    });
  }

  getGrant(grantId: string): DelegationGrant | null {
    return this.readParsed("grant", grantId, DelegationGrantSchema);
  }

  findGrantsBySubjectAgent(agentId: string): DelegationGrant[] {
    const matches: DelegationGrant[] = [];
    for (const document of this.listDocuments("grant", null)) {
      const grant = DelegationGrantSchema.parse(document);
      if (grant.subject.agentId === agentId) matches.push(grant);
    }
    return matches;
  }

  /** Callers decide which parent grants still hold budget. */
  findGrantsByParent(parentGrantId: string): DelegationGrant[] {
    const matches: DelegationGrant[] = [];
    for (const document of this.listDocuments("grant", null)) {
      const grant = DelegationGrantSchema.parse(document);
      if (grant.parentGrantId === parentGrantId) matches.push(grant);
    }
    return matches;
  }

  /** Live document and operation fences, issuer, attenuation, and topology are verified in one transaction; inactive grants reserve nothing. */
  putGrant(
    grant: DelegationGrant,
    fences: AuthorityFences,
    issuedBy: GrantIssuerAuthority = "acting-binding",
  ): DelegationGrant {
    return this.writeGrant(grant, fences, null, issuedBy);
  }

  private writeGrant(
    grant: DelegationGrant,
    fences: AuthorityFences,
    issuerTransferFrom: AgentBindingRef | null,
    issuedBy: GrantIssuerAuthority = "acting-binding",
  ): DelegationGrant {
    const parsed = DelegationGrantSchema.parse(grant);
    return this.db.transaction(() => {
      const rootIssued = issuedBy === "run-root";
      if (rootIssued) this.assertRunRootIssuer(parsed);
      this.assertAuthorityFences(parsed.runId, fences, rootIssued);
      this.assertDocumentFences(
        parsed.runId,
        {
          hierarchyRevision: parsed.hierarchyRevision,
          runEpoch: parsed.runEpoch,
          capabilityEpoch: parsed.capabilityEpoch,
          binding: fences.binding,
        },
        rootIssued,
      );
      if (
        rootIssued &&
        parsed.capabilityEpoch !== fences.expectedCapabilityEpoch
      ) {
        // No binding means no live epoch to check either against, so the two sources must at least still agree with each other.
        throw new HierarchyFenceError(
          "capabilityEpoch",
          parsed.capabilityEpoch,
          fences.expectedCapabilityEpoch,
        );
      }
      if (!sameBindingRef(fences.binding, parsed.issuer)) {
        throw new HierarchyValidationError(
          "acting binding must equal the grant issuer (nodeId, agentId, generation)",
        );
      }
      const existingGrant = this.getGrant(parsed.grantId);
      this.assertGrantIssuerTransition(
        existingGrant,
        parsed,
        issuerTransferFrom,
      );
      if (
        existingGrant === null &&
        this.db.getAgentById(parsed.subject.agentId) !== null &&
        this.getAgentBinding(parsed.subject) === null
      ) {
        throw new HierarchyValidationError(
          `new grant subject ${parsed.subject.agentId} belongs to an existing flat AgentRecord`,
        );
      }
      const bindingRow = rootIssued
        ? null
        : this.readRow("binding", bindingId(fences.binding));
      if (!rootIssued && bindingRow === null) {
        throw new HierarchyValidationError(
          `no agent binding for ${fences.binding.agentId}@${fences.binding.nodeId}`,
        );
      }
      if (bindingRow !== null && bindingRow.runId !== parsed.runId) {
        throw new HierarchyValidationError(
          `acting binding belongs to run ${bindingRow.runId}, not grant run ${parsed.runId}`,
        );
      }
      // Lead standing and real-tree containment share this transaction with the attenuation check so none of them can race past the write.
      const issuerNode = this.requireGrantIssuerNode(parsed);
      if (parsed.parentGrantId !== null) {
        const parent = this.getGrant(parsed.parentGrantId);
        if (parent === null) {
          throw new HierarchyValidationError(
            `parent grant ${parsed.parentGrantId} does not exist`,
          );
        }
        if (!isDelegationGrantAttenuation(parent, parsed)) {
          throw new HierarchyValidationError(
            "child grant is not a valid attenuation of its parent",
          );
        }
      }
      this.assertGrantTreeContainment(parsed, issuerNode.nodeId);
      // The epoch facts the write depends on are read again here, against live state, with nothing between them and the upsert.
      this.assertDocumentFences(
        parsed.runId,
        {
          hierarchyRevision: parsed.hierarchyRevision,
          runEpoch: parsed.runEpoch,
          capabilityEpoch: parsed.capabilityEpoch,
          binding: fences.binding,
        },
        rootIssued,
      );
      if (rootIssued) {
        // Root-ness is re-read here for the same reason the epoch facts are: the claim must be true at the write, not only at the pre-check.
        this.assertRunRootIssuer(parsed);
      }
      if (parsed.parentGrantId !== null && parsed.status === "active") {
        // Re-read rather than reuse: the parent record itself is writable, and a revoked or narrowed parent between the checks and here must refuse this child too, not only a rotated one. This is also the only place the parent's credential is checked at all. Attenuation compares no epochs — they count each binding's own rotations — so an issuer that has rotated away from the epoch its grant records has no live authority to lend, and delegation under it waits for a renewal. Checking that earlier as well would only be a check the reader can invalidate. A grant that is not active lends nothing, so revoking or expiring one stays writable under a rotated parent.
        const parentAtWrite = this.getGrant(parsed.parentGrantId);
        if (
          parentAtWrite === null ||
          !isDelegationGrantAttenuation(parentAtWrite, parsed)
        ) {
          throw new HierarchyValidationError(
            `parent grant ${parsed.parentGrantId} stopped being a valid parent while this grant was being written`,
          );
        }
        let issuerEpoch = 0;
        if (!this.rootBindingMatches(parsed.runId, parentAtWrite.issuer)) {
          const issuerAtWrite = this.requireBinding(parentAtWrite.issuer);
          if (issuerAtWrite.unboundAt !== null) {
            throw new HierarchyValidationError(
              `parent grant ${parentAtWrite.grantId} issuer ${parentAtWrite.issuer.agentId} is unbound`,
            );
          }
          issuerEpoch = this.liveCapabilityEpoch(issuerAtWrite);
        }
        if (issuerEpoch !== parentAtWrite.capabilityEpoch) {
          throw new HierarchyValidationError(
            `parent grant ${parentAtWrite.grantId} records capabilityEpoch ${String(parentAtWrite.capabilityEpoch)}, but issuer ${parentAtWrite.issuer.agentId} is at ${String(issuerEpoch)}; renew the chain before delegating under it`,
          );
        }
      }
      this.requireGrantIssuerNode(parsed);
      this.assertGrantIssuerTransition(
        this.getGrant(parsed.grantId),
        parsed,
        issuerTransferFrom,
      );
      this.upsertRow(
        "grant",
        parsed.grantId,
        parsed.runId,
        null,
        parsed.capabilityEpoch,
        parsed,
      );
      return parsed;
    });
  }

  /** Grant self-declaration never authorizes topology. */
  private assertGrantTreeContainment(
    grant: DelegationGrant,
    issuerNodeId: string,
  ): void {
    const subject = this.getNode(grant.subject.nodeId);
    if (subject !== null && subject.runId !== grant.runId) {
      throw new HierarchyValidationError(
        `grant subject ${subject.nodeId} belongs to run ${subject.runId}, not grant run ${grant.runId}`,
      );
    }
    if (!this.nodeIsUnderAncestor(grant.subject.nodeId, issuerNodeId)) {
      throw new HierarchyValidationError(
        `grant subject ${grant.subject.nodeId} is outside issuer ${issuerNodeId}'s real node subtree`,
      );
    }
    for (const descendantId of grant.descendantNodeIds) {
      const descendant = this.getNode(descendantId);
      if (descendant !== null && descendant.runId !== grant.runId) {
        throw new HierarchyValidationError(
          `descendantNodeId ${descendant.nodeId} belongs to run ${descendant.runId}, not grant run ${grant.runId}`,
        );
      }
      if (!this.nodeIsUnderAncestor(descendantId, issuerNodeId)) {
        throw new HierarchyValidationError(
          `descendantNodeId ${descendantId} is outside issuer ${issuerNodeId}'s real node subtree`,
        );
      }
    }
  }

  private assertRunRootIssuer(grant: DelegationGrant): void {
    if (!this.rootBindingMatches(grant.runId, grant.issuer)) {
      throw new HierarchyValidationError(
        `run-root issuance does not name run ${grant.runId}'s stored root principal`,
      );
    }
    if (grant.capabilityEpoch !== 0) {
      throw new HierarchyValidationError(
        `run-root issuance records capabilityEpoch ${String(grant.capabilityEpoch)}, expected 0`,
      );
    }
    const node = this.getNode(grant.issuer.nodeId);
    if (node === null) {
      throw new HierarchyValidationError(
        `run-root issuance names node ${grant.issuer.nodeId}, which does not exist`,
      );
    }
    if (node.runId !== grant.runId) {
      throw new HierarchyValidationError(
        `run-root issuance names node ${node.nodeId} of run ${node.runId}, not grant run ${grant.runId}`,
      );
    }
    if (node.parentNodeId !== null) {
      throw new HierarchyValidationError(
        `run-root issuance names node ${node.nodeId}, which is not the root of run ${grant.runId}`,
      );
    }
    const roots = this.listNodes(grant.runId).filter(
      (candidate) => candidate.parentNodeId === null,
    );
    if (roots.length !== 1 || roots[0]?.nodeId !== node.nodeId) {
      throw new HierarchyValidationError(
        `run ${grant.runId} does not have ${node.nodeId} as its one root`,
      );
    }
  }

  private requireGrantIssuerNode(grant: DelegationGrant): HierarchyNode {
    const issuerNode = this.getNode(grant.issuer.nodeId);
    if (issuerNode === null) {
      throw new HierarchyValidationError(
        `issuer node ${grant.issuer.nodeId} does not exist`,
      );
    }
    if (issuerNode.runId !== grant.runId) {
      throw new HierarchyValidationError(
        `issuer node ${grant.issuer.nodeId} belongs to run ${issuerNode.runId}, not grant run ${grant.runId}`,
      );
    }
    if (grant.parentGrantId === null && issuerNode.parentNodeId !== null) {
      throw new HierarchyValidationError(
        `only the run root may issue a parentless grant; issuer node ${issuerNode.nodeId} is not the run root`,
      );
    }
    if (
      grant.parentGrantId !== null &&
      issuerNode.parentNodeId !== null &&
      issuerNode.organizationalRole !== "lead-worker"
    ) {
      throw new HierarchyValidationError(
        `issuer node ${issuerNode.nodeId} is not lead-worker (organizationalRole=${issuerNode.organizationalRole}); only lead-workers and the run root may issue child grants`,
      );
    }
    return issuerNode;
  }

  private assertGrantIssuerTransition(
    existing: DelegationGrant | null,
    requested: DelegationGrant,
    issuerTransferFrom: AgentBindingRef | null,
  ): void {
    if (
      existing === null ||
      sameBindingRef(existing.issuer, requested.issuer)
    ) {
      return;
    }
    if (
      issuerTransferFrom !== null &&
      sameBindingRef(existing.issuer, issuerTransferFrom)
    ) {
      return;
    }
    throw new HierarchyValidationError(
      `grant ${requested.grantId} is already issued by ${existing.issuer.agentId}@${existing.issuer.nodeId}; ${requested.issuer.agentId}@${requested.issuer.nodeId} may not replace it`,
    );
  }

  /** Subtree authority fails closed on missing nodes or cycles. */
  nodeIsUnderAncestor(nodeId: string, ancestorId: string): boolean {
    if (nodeId === ancestorId) {
      return this.getNode(nodeId) !== null;
    }
    let currentId: string | null = nodeId;
    const seen = new Set<string>();
    while (currentId !== null) {
      if (seen.has(currentId)) return false;
      seen.add(currentId);
      const node = this.getNode(currentId);
      if (node === null) return false;
      if (node.parentNodeId === ancestorId) return true;
      currentId = node.parentNodeId;
    }
    return false;
  }

  getOwnershipTransfer(transferId: string): OwnershipTransfer | null {
    return this.readParsed(
      "ownership-transfer",
      transferId,
      OwnershipTransferSchema,
    );
  }

  listOwnershipTransfers(runId: string): OwnershipTransfer[] {
    return this.listDocuments("ownership-transfer", runId)
      .map((document) => OwnershipTransferSchema.parse(document))
      .sort((a, b) =>
        BigInt(a.hierarchyRevision) < BigInt(b.hierarchyRevision) ? -1 : 1,
      );
  }

  findBindingByAgent(agentId: string, generation: number): AgentBinding | null {
    let match: AgentBinding | null = null;
    for (const document of this.listDocuments("binding", null)) {
      const binding = AgentBindingSchema.parse(document);
      if (binding.agentId === agentId && binding.generation === generation) {
        if (match !== null) {
          throw new HierarchyValidationError(
            `agent ${agentId} generation ${String(generation)} has multiple hierarchy bindings`,
          );
        }
        match = binding;
      }
    }
    return match;
  }

  listAgentBindings(): Array<{ binding: AgentBinding; runId: string }> {
    return (
      this.db.database
        .query(
          "SELECT runId, document FROM hierarchy_records WHERE kind = ? ORDER BY id",
        )
        .all("binding") as Array<{ runId: string; document: string }>
    ).map(({ runId, document }) => ({
      runId,
      binding: AgentBindingSchema.parse(JSON.parse(document)),
    }));
  }

  findBindingsByAgent(agentId: string): AgentBinding[] {
    const matches: AgentBinding[] = [];
    for (const document of this.listDocuments("binding", null)) {
      const binding = AgentBindingSchema.parse(document);
      if (binding.agentId === agentId) matches.push(binding);
    }
    return matches;
  }

  findBindingsByNode(nodeId: string): AgentBinding[] {
    const matches: AgentBinding[] = [];
    for (const document of this.listDocuments("binding", null)) {
      const binding = AgentBindingSchema.parse(document);
      if (binding.nodeId === nodeId) matches.push(binding);
    }
    return matches;
  }

  findLiveBindingByAgentId(agentId: string): AgentBinding | null {
    return (
      this.findBindingsByAgent(agentId).find(
        (binding) => binding.unboundAt === null,
      ) ?? null
    );
  }

  findGrantsBySubjectNode(nodeId: string): DelegationGrant[] {
    const matches: DelegationGrant[] = [];
    for (const document of this.listDocuments("grant", null)) {
      const grant = DelegationGrantSchema.parse(document);
      if (grant.subject.nodeId === nodeId) matches.push(grant);
    }
    return matches;
  }

  findGrantsByIssuerNode(nodeId: string): DelegationGrant[] {
    const matches: DelegationGrant[] = [];
    for (const document of this.listDocuments("grant", null)) {
      const grant = DelegationGrantSchema.parse(document);
      if (grant.issuer.nodeId === nodeId) matches.push(grant);
    }
    return matches;
  }

  /** Corrupted parent chains read as no descendants, never every descendant. */
  listSubtreeNodes(nodeId: string, runId: string): HierarchyNode[] {
    return this.listNodes(runId).filter(
      (node) =>
        node.nodeId !== nodeId && this.nodeIsUnderAncestor(node.nodeId, nodeId),
    );
  }

  /** Atomic transfer verifies loss, revokes old authority, moves the subtree, and reissues grants. */
  transferOwnership(
    input: OwnershipTransferInput,
    fences: AuthorityFences,
    successorFences: AuthorityFences,
    now: Date = new Date(),
  ): OwnershipTransfer {
    const parsed = OwnershipTransferInputSchema.parse(input);
    return this.db.transaction(() => {
      this.assertAuthorityFences(parsed.runId, fences);
      const actingBinding = this.requireBinding(fences.binding);
      if (actingBinding.unboundAt !== null) {
        throw new HierarchyValidationError(
          `acting binding ${fences.binding.agentId} is unbound; a dead owner cannot transfer a subtree`,
        );
      }

      const lostNode = this.getNode(parsed.lostOwnerNodeId);
      if (lostNode === null) {
        throw new HierarchyValidationError(
          `lost owner node ${parsed.lostOwnerNodeId} does not exist`,
        );
      }
      if (lostNode.runId !== parsed.runId) {
        throw new HierarchyValidationError(
          `lost owner node ${lostNode.nodeId} belongs to run ${lostNode.runId}, not ${parsed.runId}`,
        );
      }
      if (lostNode.parentNodeId === null) {
        throw new HierarchyValidationError(
          `node ${lostNode.nodeId} is the run root; replacing the root is queen succession, not an ownership transfer`,
        );
      }
      if (
        lostNode.ownerNodeId === null ||
        fences.binding.nodeId !== lostNode.ownerNodeId
      ) {
        throw new HierarchyValidationError(
          `only the current owner of ${lostNode.nodeId} may transfer its subtree`,
        );
      }

      const lostBindings = this.findBindingsByNode(lostNode.nodeId);
      if (
        lostBindings.length === 0 ||
        lostBindings.some((binding) => binding.unboundAt === null)
      ) {
        throw new HierarchyValidationError(
          `node ${lostNode.nodeId} still has a live binding; the store records no loss to transfer from`,
        );
      }

      if (parsed.successorNodeId === lostNode.nodeId) {
        throw new HierarchyValidationError(
          `successor ${parsed.successorNodeId} is the lost node itself`,
        );
      }
      const successorNode = this.getNode(parsed.successorNodeId);
      if (successorNode === null) {
        throw new HierarchyValidationError(
          `successor node ${parsed.successorNodeId} does not exist`,
        );
      }
      if (successorNode.runId !== parsed.runId) {
        throw new HierarchyValidationError(
          `successor node ${successorNode.nodeId} belongs to run ${successorNode.runId}, not ${parsed.runId}`,
        );
      }
      if (this.nodeIsUnderAncestor(successorNode.nodeId, lostNode.nodeId)) {
        throw new HierarchyValidationError(
          `successor ${successorNode.nodeId} sits inside the lost subtree; re-parenting it under itself would cycle the tree`,
        );
      }
      if (successorFences.binding.nodeId !== successorNode.nodeId) {
        throw new HierarchyValidationError(
          `successor fences name node ${successorFences.binding.nodeId}, not the successor node ${successorNode.nodeId}`,
        );
      }
      this.assertAuthorityFences(parsed.runId, successorFences);
      const successorBinding = this.requireBinding(successorFences.binding);
      if (successorBinding.unboundAt !== null) {
        throw new HierarchyValidationError(
          `successor binding ${successorFences.binding.agentId} is unbound; ownership transfers to a live owner only`,
        );
      }
      const successorGrant = this.getGrant(parsed.successorGrantId);
      if (successorGrant === null) {
        throw new HierarchyValidationError(
          `successor grant ${parsed.successorGrantId} does not exist`,
        );
      }
      if (successorGrant.runId !== parsed.runId) {
        throw new HierarchyValidationError(
          `successor grant ${successorGrant.grantId} belongs to run ${successorGrant.runId}, not ${parsed.runId}`,
        );
      }
      if (
        successorGrant.status !== "active" ||
        Date.parse(successorGrant.expiresAt) <= now.getTime()
      ) {
        throw new HierarchyValidationError(
          `successor grant ${successorGrant.grantId} is not live; re-issues need a live parent`,
        );
      }
      if (!sameBindingRef(successorGrant.subject, successorFences.binding)) {
        throw new HierarchyValidationError(
          `successor grant ${successorGrant.grantId} is not held by the successor binding`,
        );
      }

      for (const grant of this.findGrantsBySubjectNode(lostNode.nodeId)) {
        if (grant.status !== "active") continue;
        this.putGrant(
          {
            ...grant,
            status: "revoked",
            hierarchyRevision: fences.expectedHierarchyRevision,
            runEpoch: fences.expectedRunEpoch,
            capabilityEpoch: this.liveCapabilityEpoch(actingBinding),
          },
          fences,
        );
      }

      const newHierarchyRevision = this.advanceHierarchyRevisionLocked(
        parsed.runId,
        fences.expectedHierarchyRevision,
      );

      // Attenuation binds parent and child fence fields to equal values, so no grant still carrying the old revision can parent a re-issue. The successor grant's whole chain is refreshed to the new revision, root-down, each link through putGrant under the acting fences — a link the acting binding did not issue, or one no longer live, refuses the transfer rather than letting authority ride a broken chain.
      const chain: DelegationGrant[] = [];
      let cursor = successorGrant.parentGrantId;
      while (cursor !== null) {
        const link = this.getGrant(cursor);
        if (link === null) {
          throw new HierarchyValidationError(
            `successor grant chain is broken at ${cursor}`,
          );
        }
        chain.unshift(link);
        cursor = link.parentGrantId;
      }
      const actingEpoch = this.liveCapabilityEpoch(actingBinding);
      const actingFencesAtNewRevision: AuthorityFences = {
        expectedHierarchyRevision: newHierarchyRevision,
        expectedRunEpoch: fences.expectedRunEpoch,
        expectedCapabilityEpoch: actingEpoch,
        binding: fences.binding,
      };
      for (const link of chain) {
        if (
          link.status !== "active" ||
          Date.parse(link.expiresAt) <= now.getTime()
        ) {
          throw new HierarchyValidationError(
            `successor grant chain is not live at ${link.grantId}`,
          );
        }
        this.putGrant(
          {
            ...link,
            hierarchyRevision: newHierarchyRevision,
            runEpoch: fences.expectedRunEpoch,
            capabilityEpoch: actingEpoch,
          },
          actingFencesAtNewRevision,
        );
      }
      this.putGrant(
        {
          ...successorGrant,
          hierarchyRevision: newHierarchyRevision,
          runEpoch: fences.expectedRunEpoch,
          capabilityEpoch: actingEpoch,
        },
        actingFencesAtNewRevision,
      );

      for (const node of this.listNodes(parsed.runId)) {
        const reparent = node.parentNodeId === lostNode.nodeId;
        const reown = node.ownerNodeId === lostNode.nodeId;
        if (!reparent && !reown) continue;
        const next = HierarchyNodeSchema.parse({
          ...node,
          parentNodeId: reparent ? successorNode.nodeId : node.parentNodeId,
          ownerNodeId: reown ? successorNode.nodeId : node.ownerNodeId,
          revision: nextRevision(node.revision),
        });
        if (reparent) this.assertNodeTopologyLocked(next, node);
        this.casMutable(
          "node",
          node.nodeId,
          node.runId,
          node.revision,
          next.revision,
          null,
          next,
        );
      }

      const successorEpoch = this.liveCapabilityEpoch(successorBinding);
      const reissueFences: AuthorityFences = {
        expectedHierarchyRevision: newHierarchyRevision,
        expectedRunEpoch: fences.expectedRunEpoch,
        expectedCapabilityEpoch: successorEpoch,
        binding: successorFences.binding,
      };
      for (const grant of this.findGrantsByIssuerNode(lostNode.nodeId)) {
        if (grant.status !== "active") continue;
        if (Date.parse(grant.expiresAt) <= now.getTime()) continue;
        this.writeGrant(
          {
            ...grant,
            issuer: successorFences.binding,
            parentGrantId: parsed.successorGrantId,
            hierarchyRevision: newHierarchyRevision,
            runEpoch: fences.expectedRunEpoch,
            capabilityEpoch: successorEpoch,
          },
          reissueFences,
          grant.issuer,
        );
      }

      // Bind the death fact and both authority principals again after the grant re-issues and immediately before the transfer record lands. The tree move advanced the hierarchy revision once, so the final fence names that new live value.
      const lostBindingsAtWrite = this.findBindingsByNode(lostNode.nodeId);
      if (
        lostBindingsAtWrite.length === 0 ||
        lostBindingsAtWrite.some((binding) => binding.unboundAt === null)
      ) {
        throw new HierarchyValidationError(
          `node ${lostNode.nodeId} still has a live binding; the store records no loss to transfer from`,
        );
      }
      this.assertAuthorityFences(parsed.runId, {
        ...fences,
        expectedHierarchyRevision: newHierarchyRevision,
      });
      this.assertAuthorityFences(parsed.runId, {
        ...successorFences,
        expectedHierarchyRevision: newHierarchyRevision,
      });

      const record = OwnershipTransferSchema.parse({
        ...parsed,
        reason: "owner-bindings-unbound",
        hierarchyRevision: newHierarchyRevision,
        runEpoch: fences.expectedRunEpoch,
        actingBinding: fences.binding,
        actingCapabilityEpoch: this.liveCapabilityEpoch(actingBinding),
        successorBinding: successorFences.binding,
        successorCapabilityEpoch: successorEpoch,
      });
      this.insertAppendOnly(
        "ownership-transfer",
        record.transferId,
        parsed.runId,
        newHierarchyRevision,
        record,
      );
      return record;
    });
  }

  /** Node writes preserve one root and reject cross-run or cyclic parenting. */
  private assertNodeTopologyLocked(
    next: HierarchyNode,
    current: HierarchyNode | null,
  ): void {
    if (next.parentNodeId === null) {
      if (current !== null && current.parentNodeId !== null) {
        throw new HierarchyValidationError(
          `re-parenting ${next.nodeId} to a null parent is refused: a run has exactly one root and an existing node never re-roots to null`,
        );
      }
      const other = this.listNodes(next.runId).find(
        (node) => node.parentNodeId === null && node.nodeId !== next.nodeId,
      );
      if (other !== undefined) {
        throw new HierarchyValidationError(
          `run ${next.runId} already has root ${other.nodeId}: a run has exactly one root`,
        );
      }
      return;
    }
    if (next.parentNodeId === next.nodeId) {
      throw new HierarchyValidationError(
        `node ${next.nodeId} cannot parent itself`,
      );
    }
    const parent = this.getNode(next.parentNodeId);
    if (parent === null) {
      throw new HierarchyValidationError(
        `new parent ${next.parentNodeId} does not exist`,
      );
    }
    if (parent.runId !== next.runId) {
      throw new HierarchyValidationError(
        `new parent ${parent.nodeId} belongs to run ${parent.runId}, not ${next.runId}`,
      );
    }
    if (this.nodeIsUnderAncestor(next.parentNodeId, next.nodeId)) {
      throw new HierarchyValidationError(
        `new parent ${next.parentNodeId} sits inside ${next.nodeId}'s own subtree`,
      );
    }
  }

  private assertNodeOwnerLocked(
    next: HierarchyNode,
    creator: RoleConferral,
  ): void {
    if (next.ownerNodeId === null) return;
    const creatorNode = this.requireConferralAuthority(next.runId, creator);

    if (next.ownerNodeId === next.nodeId) {
      if (
        next.parentNodeId !== null &&
        this.nodeIsUnderAncestor(next.parentNodeId, creatorNode.nodeId)
      ) {
        return;
      }
      throw new HierarchyValidationError(
        `self-owned node ${next.nodeId} is outside creator ${creatorNode.nodeId}'s held subtree`,
      );
    }

    const owner = this.getNode(next.ownerNodeId);
    if (owner === null) {
      throw new HierarchyValidationError(
        `owner node ${next.ownerNodeId} must exist before creating node ${next.nodeId}`,
      );
    }
    if (owner.runId !== next.runId) {
      throw new HierarchyValidationError(
        `owner node ${owner.nodeId} belongs to run ${owner.runId}, not ${next.runId}`,
      );
    }
    if (!this.nodeIsUnderAncestor(owner.nodeId, creatorNode.nodeId)) {
      throw new HierarchyValidationError(
        `owner node ${owner.nodeId} is outside creator ${creatorNode.nodeId}'s held subtree`,
      );
    }
  }

  /** Role authorship needs existing authority so nodes cannot mint delegation rights. */
  private assertRoleConferralLocked(
    next: HierarchyNode,
    current: HierarchyNode | null,
    conferral: RoleConferral | undefined,
  ): void {
    if (next.parentNodeId === null) return;
    const conferred =
      current === null
        ? next.organizationalRole === "lead-worker"
        : next.organizationalRole !== current.organizationalRole;
    if (!conferred) return;
    if (conferral === undefined) {
      throw new HierarchyValidationError(
        `organizationalRole ${next.organizationalRole} on node ${next.nodeId} requires an acting binding authorized to confer it`,
      );
    }
    const actor = this.requireConferralAuthority(next.runId, conferral);
    if (actor.parentNodeId === null) return;
    if (actor.organizationalRole !== "lead-worker") {
      throw new HierarchyValidationError(
        `acting node ${actor.nodeId} is not lead-worker (organizationalRole=${actor.organizationalRole}) and cannot confer organizationalRole`,
      );
    }
    const seat = current === null ? next.parentNodeId : next.nodeId;
    if (!this.nodeIsUnderAncestor(seat, actor.nodeId)) {
      throw new HierarchyValidationError(
        `node ${next.nodeId} is outside acting lead ${actor.nodeId}'s subtree`,
      );
    }
  }

  private requireConferralAuthority(
    runId: string,
    conferral: RoleConferral,
  ): HierarchyNode {
    if (this.rootBindingMatches(runId, conferral.binding)) {
      if (conferral.expectedCapabilityEpoch !== 0) {
        throw new HierarchyFenceError(
          "capabilityEpoch",
          conferral.expectedCapabilityEpoch,
          0,
        );
      }
    } else {
      const binding = this.requireBinding(conferral.binding);
      if (binding.unboundAt !== null) {
        throw new HierarchyValidationError(
          `acting binding ${conferral.binding.agentId} is unbound and cannot confer organizationalRole`,
        );
      }
      const liveEpoch = this.liveCapabilityEpoch(binding);
      if (liveEpoch !== conferral.expectedCapabilityEpoch) {
        throw new HierarchyFenceError(
          "capabilityEpoch",
          conferral.expectedCapabilityEpoch,
          liveEpoch,
        );
      }
    }
    const actor = this.getNode(conferral.binding.nodeId);
    if (actor === null || actor.runId !== runId) {
      throw new HierarchyValidationError(
        `acting node ${conferral.binding.nodeId} is not in run ${runId} and cannot confer organizationalRole`,
      );
    }
    return actor;
  }

  getRunControlDecision(idempotencyKey: string): RunControlDecision | null {
    return this.readParsed(
      "run-control-decision",
      idempotencyKey,
      RunControlDecisionSchema,
    );
  }

  listRunControlDecisions(runId: string): RunControlDecision[] {
    return this.listDocuments("run-control-decision", runId).map((document) =>
      RunControlDecisionSchema.parse(document),
    );
  }

  /** Decisions are append-only so retries cannot change their first outcome. */
  putRunControlDecision(runId: string, decision: RunControlDecision): void {
    const parsed = RunControlDecisionSchema.parse(decision);
    this.db.transaction(() => {
      this.insertAppendOnly(
        "run-control-decision",
        parsed.idempotencyKey,
        runId,
        parsed.result.observedPostState.revision,
        parsed,
      );
    });
  }

  getIntegrationStage(stageId: string): IntegrationStage | null {
    return this.readParsed(
      "integration-stage",
      stageId,
      IntegrationStageSchema,
    );
  }

  listIntegrationStages(runId: string): IntegrationStage[] {
    const rows = this.db.database
      .query(
        `SELECT document FROM hierarchy_records
         WHERE kind = 'integration-stage' AND runId = ?`,
      )
      .all(runId) as { document: string }[];
    return rows.map((row) =>
      IntegrationStageSchema.parse(JSON.parse(row.document)),
    );
  }

  /** CAS-write one stage, then re-validate the whole run collection so a second run-kind stage can never land. */
  putIntegrationStage(
    stage: IntegrationStage,
    expectedRevision: string | null,
  ): IntegrationStage {
    const parsed = IntegrationStageSchema.parse(stage);
    return this.db.transaction(() => {
      this.casMutable(
        "integration-stage",
        parsed.stageId,
        parsed.runId,
        expectedRevision,
        parsed.revision,
        null,
        parsed,
      );
      // Collection invariant: every run present in the collection has exactly one kind=run stage. Validate the post-write set for this runId.
      IntegrationStagesSchema.parse(this.listIntegrationStages(parsed.runId));
      return parsed;
    });
  }

  getReview(reviewId: string, revision: string): Review | null {
    return this.readParsed(
      "review",
      revisionedId(reviewId, revision),
      ReviewSchema,
    );
  }

  /** The live review per reviewId in one run. Re-reviewing appends a revision rather than editing the old one, so the highest revision is the current verdict. Returning every revision would put a superseded verdict on the same footing as the one in force. */
  listReviews(runId: string): Review[] {
    return selectLiveReviews(this.listDocuments("review", runId));
  }

  /** Record one immutable review revision against a live reviewer binding. A review is a durable claim about who examined what, so its reviewer must be a binding this run actually holds. Independence of that reviewer stays with the promotion path; this door only refuses reviews that no live agent could have written. Re-reviewing produces a new revision. */
  putReview(review: Review, runId: string): Review {
    const parsed = ReviewSchema.parse(review);
    return this.db.transaction(() => {
      this.requireActiveRun(runId);
      this.requireLiveParticipant(runId, parsed.reviewer);
      this.insertAppendOnly(
        "review",
        revisionedId(parsed.reviewId, parsed.revision),
        runId,
        parsed.revision,
        parsed,
      );
      return parsed;
    });
  }

  private requireActiveRun(runId: string): Run {
    const run = this.getRun(runId);
    if (run === null || run.lifecycle !== "active") {
      throw new HierarchyValidationError(
        `run ${runId} must exist and be active`,
      );
    }
    return run;
  }

  private requireLiveParticipant(
    runId: string,
    ref: AgentBindingRef,
  ): { binding: AgentBinding; node: HierarchyNode } {
    const row = this.readRow("binding", bindingId(ref));
    const binding = this.requireBinding(ref);
    if (row === null || row.runId !== runId || binding.unboundAt !== null) {
      throw new HierarchyValidationError(
        `participant ${ref.agentId}@${ref.nodeId} has no live binding on run ${runId}`,
      );
    }
    const node = this.getNode(ref.nodeId);
    if (node === null || node.runId !== runId || node.lifecycle !== "active") {
      throw new HierarchyValidationError(
        `participant node ${ref.nodeId} must be active on run ${runId}`,
      );
    }
    return { binding, node };
  }

  private advanceHierarchyRevisionLocked(
    runId: string,
    expectedHierarchyRevision: string,
  ): string {
    const fences = this.requireFences(runId);
    if (fences.hierarchyRevision !== expectedHierarchyRevision) {
      throw new HierarchyFenceError(
        "hierarchyRevision",
        expectedHierarchyRevision,
        fences.hierarchyRevision,
      );
    }
    const next = nextRevision(fences.hierarchyRevision);
    this.db.database
      .query(
        "UPDATE hierarchy_fences SET hierarchyRevision = ? WHERE runId = ?",
      )
      .run(next, runId);
    return next;
  }

  /** The run must exist and still be at the epoch the caller read. Together these are provenance and fence: a record for a run nobody created, or one written under an epoch a pause already retired, never becomes storable. */
  private assertRunEpoch(runId: string, expectedRunEpoch: number): void {
    // requireFences refuses a run nobody created: the fence row is written by putRun and by nothing else, so provenance and epoch are one check.
    const fences = this.requireFences(runId);
    if (fences.runEpoch !== expectedRunEpoch) {
      throw new HierarchyFenceError(
        "runEpoch",
        expectedRunEpoch,
        fences.runEpoch,
      );
    }
  }

  private requireFences(runId: string): {
    hierarchyRevision: string;
    runEpoch: number;
  } {
    const fences = this.getFences(runId);
    if (fences === null) {
      throw new HierarchyValidationError(
        `no hierarchy fences for run ${runId}; create the Run first`,
      );
    }
    return fences;
  }

  private requireBinding(binding: AgentBindingRef): AgentBinding {
    const current = this.getAgentBinding(binding);
    if (current === null) {
      throw new HierarchyValidationError(
        `no agent binding for ${binding.agentId}@${binding.nodeId} gen ${String(binding.generation)}`,
      );
    }
    return current;
  }

  private assertAuthorityFences(
    runId: string,
    fences: AuthorityFences,
    rootIssued = false,
  ): void {
    const current = this.requireFences(runId);
    if (current.hierarchyRevision !== fences.expectedHierarchyRevision) {
      throw new HierarchyFenceError(
        "hierarchyRevision",
        fences.expectedHierarchyRevision,
        current.hierarchyRevision,
      );
    }
    if (current.runEpoch !== fences.expectedRunEpoch) {
      throw new HierarchyFenceError(
        "runEpoch",
        fences.expectedRunEpoch,
        current.runEpoch,
      );
    }
    // The stored root principal is checked by the root-issued path before this point. It has no AgentBinding or flat-agent epoch to read here.
    if (rootIssued) return;
    const binding = this.requireBinding(fences.binding);
    if (binding.unboundAt !== null) {
      throw new HierarchyValidationError(
        `authority binding ${fences.binding.agentId}@${fences.binding.nodeId} is unbound`,
      );
    }
    const liveEpoch = this.liveCapabilityEpoch(binding);
    if (liveEpoch !== fences.expectedCapabilityEpoch) {
      throw new HierarchyFenceError(
        "capabilityEpoch",
        fences.expectedCapabilityEpoch,
        liveEpoch,
      );
    }
  }

  /** Re-check the grant (or other authority document) fields that name the three fences. Operation tokens and document fields must agree with live state independently — matching tokens cannot smuggle a stale document. */
  private assertDocumentFences(
    runId: string,
    document: {
      hierarchyRevision: string;
      runEpoch: number;
      capabilityEpoch: number;
      binding: AgentBindingRef;
    },
    rootIssued = false,
  ): void {
    const current = this.requireFences(runId);
    if (document.hierarchyRevision !== current.hierarchyRevision) {
      throw new HierarchyFenceError(
        "hierarchyRevision",
        document.hierarchyRevision,
        current.hierarchyRevision,
      );
    }
    if (document.runEpoch !== current.runEpoch) {
      throw new HierarchyFenceError(
        "runEpoch",
        document.runEpoch,
        current.runEpoch,
      );
    }
    if (rootIssued) return;
    const binding = this.requireBinding(document.binding);
    if (binding.unboundAt !== null) {
      throw new HierarchyValidationError(
        `authority binding ${document.binding.agentId}@${document.binding.nodeId} is unbound`,
      );
    }
    const liveEpoch = this.liveCapabilityEpoch(binding);
    if (document.capabilityEpoch !== liveEpoch) {
      throw new HierarchyFenceError(
        "capabilityEpoch",
        document.capabilityEpoch,
        liveEpoch,
      );
    }
  }

  private casMutable(
    kind: HierarchyRecordKind,
    id: string,
    runId: string,
    expectedRevision: string | null,
    newRevision: string,
    capabilityEpoch: number | null,
    document: unknown,
  ): void {
    const row = this.readRow(kind, id);
    if (expectedRevision === null) {
      if (row !== null) {
        throw new HierarchyConflictError(row.revision ?? "exists");
      }
    } else {
      if (row === null) {
        throw new HierarchyConflictError("0");
      }
      if (row.revision !== expectedRevision) {
        throw new HierarchyConflictError(row.revision ?? "0");
      }
    }
    this.upsertRow(kind, id, runId, newRevision, capabilityEpoch, document);
  }

  private insertAppendOnly(
    kind: HierarchyRecordKind,
    id: string,
    runId: string,
    revision: string,
    document: unknown,
  ): void {
    const row = this.readRow(kind, id);
    if (row !== null) {
      throw new HierarchyConflictError(row.revision ?? revision);
    }
    this.upsertRow(kind, id, runId, revision, null, document);
  }

  private upsertRow(
    kind: HierarchyRecordKind,
    id: string,
    runId: string,
    revision: string | null,
    capabilityEpoch: number | null,
    document: unknown,
  ): void {
    this.db.database
      .query(
        `INSERT INTO hierarchy_records
           (kind, id, runId, revision, capabilityEpoch, document)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET
           runId = excluded.runId,
           revision = excluded.revision,
           capabilityEpoch = excluded.capabilityEpoch,
           document = excluded.document`,
      )
      .run(
        kind,
        id,
        runId,
        revision,
        capabilityEpoch,
        JSON.stringify(document),
      );
  }

  private listDocuments(
    kind: HierarchyRecordKind,
    runId: string | null,
  ): unknown[] {
    const rows = (
      runId === null
        ? this.db.database
            .query(
              `SELECT document FROM hierarchy_records
               WHERE kind = ? ORDER BY id`,
            )
            .all(kind)
        : this.db.database
            .query(
              `SELECT document FROM hierarchy_records
               WHERE kind = ? AND runId = ? ORDER BY id`,
            )
            .all(kind, runId)
    ) as { document: string }[];
    return rows.map((row) => JSON.parse(row.document));
  }

  private readRow(
    kind: HierarchyRecordKind,
    id: string,
  ): HierarchyRecordRow | null {
    return (
      (this.db.database
        .query(
          `SELECT kind, id, runId, revision, capabilityEpoch, document
           FROM hierarchy_records WHERE kind = ? AND id = ?`,
        )
        .get(kind, id) as HierarchyRecordRow | null) ?? null
    );
  }

  private readParsed<T>(
    kind: HierarchyRecordKind,
    id: string,
    schema: ZodType<T>,
  ): T | null {
    const row = this.readRow(kind, id);
    if (row === null) return null;
    return schema.parse(JSON.parse(row.document));
  }

  private requireTaskRunId(task: TaskDetail): string {
    // Tasks do not embed runId; the owner node is the durable join.
    const owner = this.getNode(task.ownerNodeId);
    if (owner === null) {
      throw new HierarchyValidationError(
        `owner node ${task.ownerNodeId} must exist before writing task ${task.taskId}`,
      );
    }
    return owner.runId;
  }

  private bindingRunId(binding: AgentBinding): string {
    const existing = this.readRow("binding", bindingId(binding));
    if (existing !== null) return existing.runId;
    const node = this.getNode(binding.nodeId);
    if (node !== null) return node.runId;
    throw new HierarchyValidationError(
      `cannot resolve runId for binding ${binding.agentId} on ${binding.nodeId}`,
    );
  }
}
