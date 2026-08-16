// Opens the queen's coordination run so the hierarchy board has a root to hang work on. A run root is deliberately unreachable through hive_node_create, which refuses parentNodeId null: roots exist only as the genesis half of run-create. That left the queen with no supported way to open a run at all, and a board that reads hierarchy records renders empty until one exists. This tool closes that gap without adding a second genesis path — it assembles a run-create package and hands it to the SAME RunControl operation the /run-control endpoint uses.
//
// The package is assembled here rather than asked of the caller because the queen has no honest source for a repo sha, an instance id, or a revision digest; the daemon does. What the daemon must not do is invent a package that then FENCES real work, so this one claims as little as it can: every budget dimension is zero and the plan carries no tasks. Neither is a fence — spawn admission reads neither the RunBudget nor the plan's taskDag — so they bound what this run SAYS it will spend, not what it can be made to do. What actually bounds delegation under this run is the DelegationGrant an engineer issues into it.

import { createHash } from "node:crypto";
import { z } from "zod";
import { runGit } from "../../adapters/git";
import type { Action, Capability } from "../../schemas/authority";
import { GitShaSchema, type RevisionRef } from "../../schemas/hierarchy-ids";
import type { AgentBindingRef } from "../../schemas/hierarchy-node";
import type {
  PlanRevision,
  RunBudget,
  SpecRevision,
  TopologyDecision,
} from "../../schemas/hierarchy-run";
import {
  ABSENT_RUN_EXPECTATION,
  RunControlIntentSchema,
  type RunCreateBody,
} from "../../schemas/run-control";
import { toolResult } from "../../shared/mcp-tool-result";
import { AuthorizationRefusedError } from "../authorization/authorization-service";
import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import type { HiveDatabase } from "../database/hive-database";
import { HierarchyStore } from "../hierarchy-store";
import { canonicalJson } from "../status-service/status-service";
import type { HierarchyService } from "./hierarchy-service";

/** The run's stated purpose, and the objective its SpecRevision carries. Named so a user reading the board can tell a coordination root from a delegation run at a glance. */
export const COORDINATION_RUN_PURPOSE = "root-coordination";

/** The half of a task's `delegationSpec.inputs` that only the store can answer. A caller writing a task under this root has to cite the run's spec and plan by exact revision and digest, and the sha the run was opened against; none of the three is derivable from the ids. They are returned so a tracking task can be built from this result alone. The rest of `inputs` — task revisions, interfaces, prerequisites, source artifacts — is the caller's to state. */
export type RunBootstrapTaskInputs = {
  specRevision: RevisionRef;
  planRevision: RevisionRef;
  baseSha: string;
};

/** What the tool answers with. `existing` and `created` carry the same fields so a caller never branches to find the ids: the discriminator says whether this call did the writing, and nothing else changes. */
export type RunBootstrapResult = {
  kind: "created" | "existing";
  runId: string;
  rootNodeId: string;
  rootBinding: AgentBindingRef;
  taskInputs: RunBootstrapTaskInputs;
  next: string;
};

export interface RunBootstrapDeps {
  db: HiveDatabase;
  hierarchy: HierarchyService;
  repoRoot: string;
  instanceId: string;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

/** A revisioned record's own content digest. A gate approves exact bytes, so every such record binds one. The digest cannot cover itself, so it is taken over the record without it and then attached — which is also what makes it verifiable later by recomputing over the stored record minus its digest. */
function withDigest<T extends object>(record: T): T & { digest: string } {
  const hash = createHash("sha256").update(canonicalJson(record), "utf8");
  return { ...record, digest: `sha256:${hash.digest("hex")}` };
}

const ref = (record: { revision: string; digest: string }) => ({
  revision: record.revision,
  digest: record.digest,
});

/** Every budget dimension at zero. This run is opened to hold the board root, not to spend: it declares no sessions, no spawns, and no landings. Zero is the honest declaration for a package no engineer sized, and it stays zero rather than carrying a generous default nobody chose. */
const NO_SPEND = { hard: 0, soft: 0, reserved: 0, used: 0 } as const;

/** The whole P0 package for a coordination run, assembled in dependency order because each record binds the digest of the one before it. `proposer` is the authenticated caller: the daemon wrote these bytes, but it wrote them because that subject asked. */
function coordinationPackage(input: {
  runId: string;
  rootNodeId: string;
  repo: string;
  instanceId: string;
  baseSha: string;
  proposer: string;
  createdAt: string;
}): RunCreateBody {
  const { runId, createdAt, proposer } = input;
  const revisioned = {
    runId,
    revision: "1",
    createdAt,
    lifecycle: "proposed",
  } as const;

  const spec: SpecRevision = withDigest({
    ...revisioned,
    objective: `${COORDINATION_RUN_PURPOSE}: hold the run root the hierarchy board hangs work on`,
    acceptanceIds: [COORDINATION_RUN_PURPOSE],
    scope: "hierarchy bookkeeping under this run's root node",
    nonGoals: ["delegation", "spawning", "landing"],
    constraints: { architecture: [], security: [], outwardEffect: [] },
    // Nothing is reviewed under this run, and the schema requires positive ceilings, so 1 is the smallest statement of "no review capacity was claimed here".
    gatePolicy: {
      reviewLocGreenMax: 1,
      reviewLocAmberMax: 1,
      reviewFilesMax: 1,
    },
    evidenceArtifactRefs: [],
    proposer,
    engineerApproval: null,
  });

  const plan: PlanRevision = withDigest({
    ...revisioned,
    parentRevision: null,
    // No planned work: tasks reach this run through hive_task_create after the root exists, not through a plan the daemon wrote.
    taskDag: [],
    topologyRationale: "the root coordinates its own board and delegates none",
    proposer,
  });

  const topology: TopologyDecision = withDigest({
    ...revisioned,
    shape: "direct",
    decomposition: { planRevision: ref(plan), taskDag: [] },
    coupling: {
      sharedFiles: [],
      sharedInvariants: [],
      interfaceMaturity: "n/a",
      dependencyDepth: 0,
      expectedIntegrationConflict: "none",
    },
    parallelValue: {
      independentWorkUnits: 0,
      predictedCriticalPath: "none",
      expectedWallClockBenefit: "none",
    },
    coordinationCost: {
      leadLoad: "none",
      reviewLoad: "none",
      communicationLoad: "none",
      ciLoad: "none",
      promotionQueueLoad: "none",
    },
    budgetEvidence: {
      reservedSessions: 0,
      tokensOrCostEstimate: "none",
      wallTimeEstimate: "none",
      reviewerCapacity: "none",
      perLeadCrewLimit: 0,
    },
    decisionProvenance: {
      proposer,
      engineerDecision: null,
      specRevision: ref(spec),
      rationale:
        "a coordination root delegates nothing, so there is no shape to decide",
    },
  });

  const budget: RunBudget = withDigest({
    ...revisioned,
    limits: {
      activeSessions: NO_SPEND,
      totalSpawns: NO_SPEND,
      perLeadCrew: NO_SPEND,
      reviewerPool: NO_SPEND,
      vendorQuota: NO_SPEND,
      tokens: NO_SPEND,
      costCents: NO_SPEND,
      wallTimeMs: NO_SPEND,
      ci: NO_SPEND,
      wakeBudget: NO_SPEND,
      messageBudget: NO_SPEND,
    },
    anomalyThresholds: {},
  });

  return {
    operation: "run-create",
    runId,
    repo: input.repo,
    instanceId: input.instanceId,
    baseSha: input.baseSha,
    rootNodeId: input.rootNodeId,
    spec,
    plan,
    topology,
    budget,
  };
}

/** The run root this instance can already act through, or null. The liveness test is the one `requireActingBinding` applies to root authority — stored run, live root binding, active root node — so "existing" means a root the caller's next MCP write will actually resolve, not merely a row that parses. */
function liveRoot(
  store: HierarchyStore,
  instanceId: string,
): { runId: string; rootBinding: AgentBindingRef } | null {
  for (const run of store.listRuns()) {
    if (run.instanceId !== instanceId || run.lifecycle !== "active") continue;
    const rootBinding = store.getRootBinding(run.runId);
    if (rootBinding === null) continue;
    const node = store.getNode(rootBinding.nodeId);
    if (
      node === null ||
      node.runId !== run.runId ||
      node.parentNodeId !== null ||
      node.lifecycle !== "active"
    ) {
      continue;
    }
    return { runId: run.runId, rootBinding };
  }
  return null;
}

/** The task inputs for whichever run this call settled on, read back from the store. The created branch goes through here too rather than reusing the package it just assembled: reading it back is what makes the returned refs a statement about stored state instead of about a local variable. */
function taskInputsOf(
  store: HierarchyStore,
  runId: string,
): RunBootstrapTaskInputs {
  const run = store.getRun(runId);
  if (run === null) throw new Error(`run ${runId} is not stored`);
  return {
    specRevision: run.spec,
    planRevision: run.currentPlan,
    baseSha: run.baseSha,
  };
}

/** The ready-to-run next step points at the stored run inputs a caller cannot
 * guess. Owner identity is deliberately absent: createTask derives it from the
 * authenticated root binding. */
function nextStep(): string {
  return "Next: hive_task_create with this result's runId, assigneeNodeId=null, and delegationSpec.inputs carrying specRevision/planRevision/baseSha verbatim from taskInputs, to put a tracking task on the board. The daemon fills both owner identities from this authenticated root session.";
}

/** The repo state this run is opened against. A coordination run lands nothing, so this sha fences no promotion; it is recorded because a run that could not say what it was opened against would be the package-nobody-chose problem in its worst form. */
async function readHeadSha(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Cannot open a coordination run: reading ${repoRoot} HEAD failed: ${result.stderr.trim() || `git exited ${String(result.exitCode)}`}`,
    );
  }
  return GitShaSchema.parse(result.stdout.trim());
}

/** Opens the coordination run, or returns the one already open. Root MCP authority rests on three facts: a stored Run, an active root provider run for this instance, and a live root binding. The third is what this operation creates, so it cannot be a precondition — but the first two are checked here exactly as `requireActingBinding` checks them, so a root opened by this tool is one the same caller can immediately write through. */
export async function bootstrapRun(
  capability: Capability,
  deps: RunBootstrapDeps,
): Promise<RunBootstrapResult> {
  const store = new HierarchyStore(deps.db);
  const existing = liveRoot(store, deps.instanceId);
  if (existing !== null) {
    // Idempotent by identity, not by key: a second root for one instance is the failure this guard exists to prevent, so an instance that already has one never reaches run-create.
    const taskInputs = taskInputsOf(store, existing.runId);
    return {
      kind: "existing",
      runId: existing.runId,
      rootNodeId: existing.rootBinding.nodeId,
      rootBinding: existing.rootBinding,
      taskInputs,
      next: nextStep(),
    };
  }

  const providerRun = deps.db.getActiveRootProviderRun(deps.instanceId);
  if (providerRun === null) {
    throw new Error(
      `no active root provider run for ${deps.instanceId}; a run root is opened by the live queen, not on her behalf`,
    );
  }
  if (capability.epoch !== providerRun.capabilityEpoch) {
    throw new AuthorizationRefusedError(
      "root capability does not hold the live provider epoch",
    );
  }

  const body = coordinationPackage({
    runId: `run_${Bun.randomUUIDv7()}`,
    rootNodeId: `node_${Bun.randomUUIDv7()}`,
    repo: deps.repoRoot,
    instanceId: deps.instanceId,
    baseSha: await readHeadSha(deps.repoRoot),
    proposer: capability.subject,
    createdAt: new Date().toISOString(),
  });

  const result = deps.hierarchy.applyRunControl(
    RunControlIntentSchema.parse({
      schemaVersion: 1,
      intentId: `rbi_${Bun.randomUUIDv7()}`,
      idempotencyKey: `run-bootstrap:${body.runId}`,
      expected: {
        kind: "revision-and-epoch",
        ...ABSENT_RUN_EXPECTATION,
      },
      body,
    }),
    capability.subject,
  );
  if (result.outcome.status === "rejected") {
    throw new Error(
      `run-create refused the coordination package: ${result.outcome.failure.message}`,
    );
  }

  const opened = store.getRootBinding(body.runId);
  if (opened === null) {
    throw new Error(`run ${body.runId} was created without a root binding`);
  }
  const taskInputs = taskInputsOf(store, body.runId);
  return {
    kind: "created",
    runId: body.runId,
    rootNodeId: opened.nodeId,
    rootBinding: opened,
    taskInputs,
    next: nextStep(),
  };
}

export function registerRunBootstrapTool(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: RunBootstrapDeps,
): void {
  server.registerTool(
    "hive_run_bootstrap",
    {
      title: "Open the coordination run that holds the board root",
      description:
        "Open this instance's coordination run and its root hierarchy node, so tasks have an owner to hang from. Takes no input: the daemon reads the repo, instance, and root identity from its own state. Returns the run, root node, root binding, and the taskInputs (specRevision, planRevision, baseSha) a task under this root must cite — everything hive_task_create needs, so no store read is required to follow up. kind=created when this call opened it, kind=existing when one was already open, and the same ids either way, so calling twice never makes a second root. The run itself grants nothing: delegating under it still needs an engineer-issued DelegationGrant. Orchestrator role only; every other role is refused.",
      inputSchema: z.object({}),
    },
    async () => {
      deps.authorizeTool(capability, "hive_run_bootstrap", "run:bootstrap");
      return toolResult(await bootstrapRun(capability, deps), "bootstrap");
    },
  );
}
