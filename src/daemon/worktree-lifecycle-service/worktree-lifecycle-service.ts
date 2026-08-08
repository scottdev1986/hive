// Owns every product decision that can remove or retain a worktree, branch, or
// stewardship ref. The adapter supplies proof-bound mechanics only; callers
// cannot authorize deletion with a teardown option.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  reconcileOrphanedWorktrees as reconcileWorktrees,
  StrandedWork,
  SettlementBranch,
  WorktreeReconciliationOutcome,
  WorktreeReconciliationReport,
} from "../../adapters/worktrees";
import {
  captureWipSalvage,
  countCommitsNotOnMain,
  createWorktreeSettlementBoundary,
  isWorktreeBranchFor,
  keepStewardshipRef,
  listStaleOwnerRefs,
  listStewardshipRefs,
  markBranchPreserved,
  readRefOid,
  type StewardshipRef,
  type SettlementMutationIssuer,
  stewardshipBundleRefs,
  type WorktreeSettlementMutator,
  unavailableAgentNames,
} from "../../adapters/worktrees";
import { hiveInstanceSuffix } from "../../hive-home/instance-identity";
import type { SystemMailPublish } from "../../mail-service/service";
import {
  type AgentRecord,
  isLiveAgent,
  ORCHESTRATOR_NAME,
} from "../../schemas/agent";
import type { WorkManifest } from "../../schemas/work-manifest";
import type { Clock } from "../../shared/clock";
import { errorMessage } from "../../shared/error-message";
import { logAlertDeliveryFailure } from "../observability/daemon-log";
import type { HiveDatabase } from "../database/hive-database";
import {
  DetachedCheckoutError,
  type NothingToLandEvidence,
  resolveLandingTargetBranch,
} from "../landing/landing-service";
import { NAME_POOL } from "../spawn/agent-name-selection";
import {
  measureAutomaticRelease,
  type SettlementProcessLiveness,
  type SettlementProofResult,
  type SettlementSnapshot,
} from "./settlement-proof";
import {
  SettlementCaseStore,
  type SettlementCase,
  type StoredSettlementCase,
} from "./settlement-case-store";
import {
  SettlementDecisionStore,
  type SettlementDecision,
} from "./settlement-decision-store";
import {
  escalationTier,
  projectSettlementDebt,
  renderSettlementDebt,
  settlementDebtNeedsNotice,
  type SettlementDebtAggregate,
} from "./settlement-debt";

/**
 * How long a preserved/salvage ref may sit before the sweep mails a decision
 * inventory to queen. Fixed: escalation is a reporting delay, not a deletion.
 */
const STEWARDSHIP_ESCALATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * States a resolver or a person owns. The sweep may refresh their evidence, but it does not
 * replace the hold or automatically release a subject that still exists. A case whose complete
 * subject is gone is different: the absence proof closes it because there is nothing left to own.
 */
const OWNED_ELSEWHERE: readonly SettlementCase["state"][] = [
  "blocked",
  "parked",
  "owner-decision",
  "resolution-in-progress",
];

/**
 * States nothing outside this service's own measurement ever advances: the
 * resolver-owned states wait on a lease nothing hands out, and the
 * measurement states only ever recur. Fruitless rewrites of these are the
 * stuck signal — UNATTENDED_REMEASUREMENTS_PER_TIER of them without leaving
 * the set means the case is stuck now, not after a day.
 */
const UNATTENDED_STATES: readonly SettlementCase["state"][] = [
  "needs-integration",
  "resolution-in-progress",
  "measurement-blocked",
  "assessing",
];

/**
 * Unattended states whose wait is also measured by age: they wait on a
 * resolver, and crossing a tier is what proves the wait was unattended. The
 * measurement states are excluded — a measurement that cannot complete yet
 * (unverifiable liveness, a git operation in flight) must be retried, not
 * parked on age; only repeated failure makes it an owner decision.
 */
const RESOLVER_OWNED_STATES: readonly SettlementCase["state"][] = [
  "needs-integration",
  "resolution-in-progress",
];

/** Fruitless rewrites of an unattended case that advance one escalation tier. */
const UNATTENDED_REMEASUREMENTS_PER_TIER = 5;

/**
 * Whether a branch belongs to this agent's worktree. The name is the only
 * surviving tie once the agent row and the live checkout have both moved past
 * a branch: git reports a worktree's current checkout and nothing about the
 * branches previously cut there. An agent with no worktree has no worktree for
 * a branch to belong to.
 */
function ownsWorktreeBranch(agent: AgentRecord, branch: string): boolean {
  return agent.worktreePath !== null && isWorktreeBranchFor(agent.name, branch);
}

/** The stranded-work account a kill reports: never a deletion, always what was kept and why. */
export interface TeardownStrandedWork {
  branch: string | null;
  worktreePath: string | null;
  dirtyFiles: string[];
  unmergedCommits: number;
  note: string;
}

/** Everything the teardown ladder measured before the kill, read once and reused by every decision after it. */
export interface FinalWorkCapture {
  manifest: WorkManifest;
  work: StrandedWork | null;
  targetBranch: string;
  checkError: string | null;
}

export interface TeardownWorktreeRequest {
  agent: AgentRecord;
  /** The row as it stands after the kill; returned updated when the worktree is released. */
  updated: AgentRecord;
  capture: FinalWorkCapture;
  at: string;
  removeWorktree: boolean;
}

export interface TeardownWorktreeSettlement {
  agent: AgentRecord;
  cleaned: { worktreePath: string | null; branch: string | null };
  preserved: {
    branch: string;
    ref: string;
    salvageRef?: string;
  } | null;
  stranded: TeardownStrandedWork | null;
}

/** Pin the outcome strings: hive_kill's structured worktree field uses only these. */
export type WorktreeKillOutcome =
  | "removed"
  | "preserved-stranded"
  | "kept-clean"
  | "absent";

/**
 * Honest account of what happened to the agent's worktree on kill.
 * Replaces the ambiguous cleaned:{worktreePath:null} reading that could mean
 * "never had one", "had one and kept it", or "had one and failed to remove it".
 */
export interface WorktreeKillResult {
  outcome: WorktreeKillOutcome;
  path: string | null;
  branch: string | null;
  unmergedCommits: number;
  dirtyFiles: string[];
  preservedRef?: string;
  salvageRef?: string;
  /** Ready-to-run remedy when the worktree was not released. */
  resolve?: string;
}

/** Derive the structured kill worktree field from the pre-kill agent row and the ladder's settlement. */
export function describeWorktreeKill(
  agent: AgentRecord,
  settled: TeardownWorktreeSettlement,
): WorktreeKillResult {
  const path = agent.worktreePath;
  const branch = agent.branch;
  const unmergedCommits = settled.stranded?.unmergedCommits ?? 0;
  const dirtyFiles = settled.stranded?.dirtyFiles ?? [];
  if (path === null && branch === null) {
    return {
      outcome: "absent",
      path: null,
      branch: null,
      unmergedCommits: 0,
      dirtyFiles: [],
    };
  }
  if (
    settled.cleaned.worktreePath !== null ||
    settled.cleaned.branch !== null
  ) {
    return {
      outcome: "removed",
      path: settled.cleaned.worktreePath ?? path,
      branch: settled.cleaned.branch ?? branch,
      unmergedCommits,
      dirtyFiles,
    };
  }
  if (settled.stranded !== null) {
    const preservedRef = settled.preserved?.ref;
    const salvageRef = settled.preserved?.salvageRef;
    const salvageClause =
      salvageRef === undefined ? "" : ` (WIP salvage at ${salvageRef})`;
    return {
      outcome: "preserved-stranded",
      path,
      branch,
      unmergedCommits,
      dirtyFiles,
      ...(preservedRef === undefined ? {} : { preservedRef }),
      ...(salvageRef === undefined ? {} : { salvageRef }),
      resolve:
        branch === null
          ? `spawn integrator to inspect ${path ?? "the worktree"}${salvageClause}; only a user-bound settlement decision can discard it`
          : `spawn integrator to land ${branch}${salvageClause}; only a user-bound settlement decision can discard it`,
    };
  }
  return {
    outcome: "kept-clean",
    path,
    branch,
    unmergedCommits: 0,
    dirtyFiles: [],
    resolve:
      "hive_settlement_sweep to retry the exact proof after its watched condition changes",
  };
}

export interface WorktreeLifecycleServiceDependencies {
  db: HiveDatabase;
  repoRoot: string;
  clock: Clock;
  publish: SystemMailPublish;
  assessStrandedWork: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
    mainBranch?: string,
  ) => Promise<StrandedWork>;
  listSettlementBranches: (
    repoRoot: string,
    mainBranch?: string,
  ) => Promise<SettlementBranch[]>;
  reconcileOrphanedWorktrees: typeof reconcileWorktrees;
  processLiveness?: (agent: AgentRecord) => Promise<SettlementProcessLiveness>;
  settlementBoundary?: {
    readonly issuer: SettlementMutationIssuer;
    readonly mutator: WorktreeSettlementMutator;
  };
  onAlertDeliveryFailure?: (error: unknown) => void;
}

export interface SettledCaseEvidence {
  caseId: string;
  branch: string | null;
  worktreePath: string | null;
  evidenceDigest: string;
  accountedBy: NonNullable<SettlementSnapshot["accountedBy"]>;
  missing: Array<SettlementSnapshot["missing"][number]>;
}

export interface SettlementReconciliationReport
  extends WorktreeReconciliationReport {
  settledCases: SettledCaseEvidence[];
}

function residueProjection(
  snapshot: SettlementSnapshot,
  automaticRelease: boolean,
): NonNullable<SettlementCase["residue"]> {
  const mainContainsBranchWork =
    snapshot.branchOid === null ? null : snapshot.accountedBy !== null;
  const releaseDisposition = automaticRelease
    ? "automatic-release"
    : snapshot.residue.length > 0 ||
        snapshot.unaccountedCommitOids.length > 0 ||
        mainContainsBranchWork !== true
      ? "integrate-or-user-discard"
      : "user-discard";
  return {
    targetRef: snapshot.targetRef,
    targetOid: snapshot.targetOid,
    mergeBaseOid: snapshot.mergeBaseOid,
    branchOid: snapshot.branchOid,
    worktreePresent: snapshot.worktreePath !== null,
    dirtyFiles: [...snapshot.residue],
    unaccountedCommitOids: [...snapshot.unaccountedCommitOids],
    stewardshipRefs: snapshot.stewardshipRefs.map(({ ref, oid }) => ({
      ref,
      oid,
    })),
    mainContainsBranchWork,
    missing: [...snapshot.missing],
    releaseDisposition,
  };
}

function settledCaseEvidence(
  stored: StoredSettlementCase,
  snapshot: SettlementSnapshot,
): SettledCaseEvidence {
  if (snapshot.accountedBy === null) {
    throw new Error("settled case has no accounting proof");
  }
  return {
    caseId: stored.record.caseId,
    branch: stored.record.branch,
    worktreePath: stored.record.worktreePath,
    evidenceDigest: snapshot.digest,
    accountedBy: snapshot.accountedBy,
    missing: [...snapshot.missing],
  };
}

export class WorktreeLifecycleService {
  private readonly cases: SettlementCaseStore;
  private readonly decisions: SettlementDecisionStore;
  private readonly settlementIssuer: SettlementMutationIssuer;
  private readonly settlementMutator: WorktreeSettlementMutator;
  private readonly activeWrites = new Set<Promise<unknown>>();
  private stopped = false;
  private settlementMeasurementFailure: string | null = null;

  constructor(private readonly deps: WorktreeLifecycleServiceDependencies) {
    this.cases = new SettlementCaseStore(deps.repoRoot);
    this.decisions = new SettlementDecisionStore(deps.repoRoot);
    const boundary =
      deps.settlementBoundary ?? createWorktreeSettlementBoundary();
    this.settlementIssuer = boundary.issuer;
    this.settlementMutator = boundary.mutator;
  }

  /** Refuse new writes and wait until every write already admitted has settled. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.activeWrites]);
  }

  private assertWritesAccepted(): void {
    if (this.stopped) {
      throw new Error("worktree lifecycle service is stopped");
    }
  }

  private runWrite<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertWritesAccepted();
    } catch (error) {
      return Promise.reject(error);
    }
    const work = Promise.resolve().then(operation);
    this.activeWrites.add(work);
    void work.then(
      () => this.activeWrites.delete(work),
      () => this.activeWrites.delete(work),
    );
    return work;
  }

  private reportAlertDeliveryFailure(error: unknown): undefined {
    if (this.deps.onAlertDeliveryFailure === undefined) {
      return logAlertDeliveryFailure(error);
    }
    this.deps.onAlertDeliveryFailure(error);
    return undefined;
  }

  private generation(agent: AgentRecord): number | null {
    return agent.sessionLocator?.generation ?? null;
  }

  private async targetBranch(): Promise<string> {
    return resolveLandingTargetBranch(this.deps.repoRoot);
  }

  private async findCaseForAgent(
    agent: AgentRecord,
  ): Promise<StoredSettlementCase | null> {
    const generation = this.generation(agent);
    let target: string;
    try {
      target = await this.targetBranch();
    } catch (error) {
      // Settlement cases are keyed by the target branch; a detached primary has none, so no case can be attributed — the caller's unknown-evidence path, never a case listed under a fabricated name.
      if (error instanceof DetachedCheckoutError) return null;
      throw error;
    }
    const matches = (await this.cases.list(target)).filter(
      ({ record }) =>
        record.agentId === agent.id && record.generation === generation,
    );
    if (matches.length <= 1) return matches[0] ?? null;
    // A retasked agent holds one case per branch it has owned; the case for its
    // current branch is the agent's own, and the rest are leftover bundles
    // awaiting their own settlement. Ambiguity beyond that is genuine.
    const current = matches.filter(
      ({ record }) => record.branch === agent.branch,
    );
    if (current.length !== 1) {
      throw new Error(
        `multiple open settlement cases name agent generation ${agent.id}/${String(generation)}`,
      );
    }
    return current[0] ?? null;
  }

  /** Returns the recorded spawn base and current source commit. The landing service owns what that evidence means. */
  async landingEvidence(
    agent: AgentRecord,
    sourceOid: string | null,
  ): Promise<NothingToLandEvidence> {
    const stored = await this.findCaseForAgent(agent);
    const branchOid =
      sourceOid ??
      (agent.branch === null
        ? null
        : await readRefOid(this.deps.repoRoot, `refs/heads/${agent.branch}`));
    const baseOid = stored?.record.baseOid ?? null;
    return { sourceOid: branchOid, baseOid };
  }

  private async updateCase(
    stored: StoredSettlementCase,
    next: SettlementCase,
  ): Promise<StoredSettlementCase> {
    const { revision: _revision, ...withoutRevision } = next;
    // The unattended baseline tracks entry into a run of unattended states so
    // the escalation sweep can count fruitless rewrites against it. "assessing"
    // is inside the set, so a measurement round trip neither resets nor clears
    // it; only genuinely leaving the set does.
    const wasUnattended = UNATTENDED_STATES.includes(stored.record.state);
    const isUnattended = UNATTENDED_STATES.includes(next.state);
    const adjusted =
      isUnattended && !wasUnattended
        ? {
            ...withoutRevision,
            unattendedBaseRevision: stored.record.revision + 1,
          }
        : !isUnattended && wasUnattended
          ? { ...withoutRevision, unattendedBaseRevision: null }
          : withoutRevision;
    return this.cases.update(stored, adjusted);
  }

  /** Create the durable work-bundle record before `git worktree add` runs. */
  async openSettlementCase(
    agent: AgentRecord,
    worktree: { path: string; branch: string },
    baseOid: string | null,
  ): Promise<void> {
    return this.runWrite(() =>
      this.openSettlementCaseWrite(agent, worktree, baseOid),
    );
  }

  private async openSettlementCaseWrite(
    agent: AgentRecord,
    worktree: { path: string; branch: string },
    baseOid: string | null,
  ): Promise<void> {
    await this.cases.open({
      agentId: agent.id,
      agentName: agent.name,
      generation: this.generation(agent),
      worktreePath: worktree.path,
      branch: worktree.branch,
      baseOid,
      now: agent.createdAt,
      reason: "agent generation owns an active worktree bundle",
    });
  }

  private async adoptCase(agent: AgentRecord): Promise<StoredSettlementCase> {
    const existing = await this.findCaseForAgent(agent);
    if (existing !== null) return existing;
    return this.cases.open({
      agentId: agent.id,
      agentName: agent.name,
      generation: this.generation(agent),
      worktreePath: agent.worktreePath,
      branch: agent.branch,
      baseOid: null,
      now: agent.createdAt,
      reason: "discovered legacy work bundle is awaiting assessment",
    });
  }

  private processLiveness(
    agent: AgentRecord,
  ): Promise<SettlementProcessLiveness> {
    return this.deps.processLiveness?.(agent) ?? Promise.resolve("unknown");
  }

  private async keepMeasuredCase(
    stored: StoredSettlementCase,
    result: Exclude<SettlementProofResult, { kind: "safe" }>,
    at: string,
  ): Promise<StoredSettlementCase> {
    const due =
      result.state === "active"
        ? { nextActionAt: null, watchedTrigger: "agent-generation-ended" }
        : result.state === "owner-decision"
          ? { nextActionAt: null, watchedTrigger: "owner-decision" }
          : result.state === "settling"
            ? {
                nextActionAt: new Date(Date.parse(at) + 30_000).toISOString(),
                watchedTrigger: null,
              }
            : result.state === "needs-integration"
              ? { nextActionAt: at, watchedTrigger: null }
              : {
                  nextActionAt: new Date(
                    Date.parse(at) + 5 * 60_000,
                  ).toISOString(),
                  watchedTrigger: null,
                };
    const owner =
      result.state === "active"
        ? "agent"
        : result.state === "owner-decision"
          ? "user"
          : result.state === "needs-integration"
            ? "resolver"
            : "settlement-service";
    return this.updateCase(stored, {
      ...stored.record,
      state: result.state,
      owner,
      reason: result.reason,
      due,
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
      lastMeasuredAt: at,
      headOid: result.snapshot?.headOid ?? stored.record.headOid,
      evidenceDigest: result.snapshot?.digest ?? null,
      evidenceFormat: result.snapshot === null ? null : "disposition-v1",
      residue:
        result.snapshot === null
          ? null
          : residueProjection(result.snapshot, false),
      regenerable: [...(result.snapshot?.regenerable ?? [])],
    } as SettlementCase);
  }

  private async measureResolverCase(
    stored: StoredSettlementCase,
    agent: AgentRecord | null,
    targetBranch: string,
    at: string,
  ): Promise<StoredSettlementCase> {
    const measured = await measureAutomaticRelease(
      {
        repoRoot: this.deps.repoRoot,
        processLiveness: (candidate) => this.processLiveness(candidate),
      },
      stored.record,
      agent,
      targetBranch,
    );
    if (measured.snapshot === null) {
      if (OWNED_ELSEWHERE.includes(stored.record.state)) return stored;
      return (await this.assessStoredCase(stored, agent, at)).case;
    }
    if (
      measured.kind === "kept" &&
      !OWNED_ELSEWHERE.includes(stored.record.state)
    ) {
      return this.keepMeasuredCase(stored, measured, at);
    }
    return this.updateCase(stored, {
      ...stored.record,
      lastMeasuredAt: at,
      headOid: measured.snapshot.headOid,
      evidenceDigest: measured.snapshot.digest,
      evidenceFormat: "disposition-v1",
      residue: residueProjection(measured.snapshot, measured.kind === "safe"),
      regenerable: [...measured.snapshot.regenerable],
    } as SettlementCase);
  }

  /**
   * Bind a case that was opened unowned to the agent this sweep's branch match
   * proves owns it. The branch is the bundle's identity and agentId, generation
   * and worktreePath are attributes of that bundle — the case store's own
   * contract — so the record follows the proven owner. A live owner also
   * reclassifies the bundle as active agent-owned work: a resolver-owned case
   * over a live agent's current branch hands that agent's in-progress work to
   * integration.
   */
  private async reattributeCase(
    stored: StoredSettlementCase,
    agent: AgentRecord,
  ): Promise<StoredSettlementCase> {
    const reactivate =
      isLiveAgent(agent) &&
      (stored.record.state === "needs-integration" ||
        stored.record.state === "measurement-blocked");
    return this.updateCase(stored, {
      ...stored.record,
      agentId: agent.id,
      agentName: agent.name,
      generation: this.generation(agent),
      worktreePath: agent.worktreePath,
      ...(reactivate
        ? {
            state: "active",
            owner: "agent",
            reason: "agent generation owns an active worktree bundle",
            due: {
              nextActionAt: null,
              watchedTrigger: "agent-generation-ended",
            },
            blockedOn: null,
            reviewAt: null,
            proofDigest: null,
          }
        : {}),
    } as SettlementCase);
  }

  async updateSettlementDebt(settledThisSweep = 0): Promise<{
    aggregate: SettlementDebtAggregate;
    published: boolean;
    tierAdvances: number;
  }> {
    return this.runWrite(() =>
      this.updateSettlementDebtWrite(settledThisSweep),
    );
  }

  private async updateSettlementDebtWrite(settledThisSweep = 0): Promise<{
    aggregate: SettlementDebtAggregate;
    published: boolean;
    tierAdvances: number;
  }> {
    const targetBranch = await this.targetBranch();
    const now = this.deps.clock().getTime();
    let cases = await this.cases.list(targetBranch);
    let tierAdvances = 0;
    let rebaselined = false;
    for (let stored of cases) {
      // The unattended states wait on something that never comes on its own: a
      // resolver lease nothing hands out or returns, a measurement that cannot
      // complete. For a resolver-owned case, crossing an age tier proves the
      // wait was unattended. For any of them, fruitless re-measurement is the
      // other proof: a case re-written that often without leaving the set is
      // stuck now, not after a day, and every rewrite republishes the debt
      // notice.
      const unattended = UNATTENDED_STATES.includes(stored.record.state);
      if (
        !unattended &&
        stored.record.state !== "owner-decision" &&
        stored.record.state !== "blocked" &&
        stored.record.state !== "parked"
      ) {
        continue;
      }
      if (unattended && stored.record.unattendedBaseRevision === null) {
        // A case from before the baseline existed takes its first sighting as
        // the baseline; spin is measured from there.
        stored = await this.updateCase(stored, {
          ...stored.record,
          unattendedBaseRevision: stored.record.revision,
        } as SettlementCase);
        rebaselined = true;
        continue;
      }
      // Age measures the wait for every eligible state except the measurement
      // ones, where retry-until-repeatedly-stuck is the spin tier's job alone.
      const ageTier =
        unattended && !RESOLVER_OWNED_STATES.includes(stored.record.state)
          ? 0
          : escalationTier(stored.record.firstSeenAt, now);
      const tier = Math.max(
        ageTier,
        unattended
          ? Math.floor(
              (stored.record.revision -
                (stored.record.unattendedBaseRevision ??
                  stored.record.revision)) /
                UNATTENDED_REMEASUREMENTS_PER_TIER,
            )
          : 0,
      );
      if (tier <= stored.record.escalationTier) continue;
      stored = unattended
        ? // Nothing advanced it for a whole tier, so "resolving" has become a false report:
          // landing the work and discarding it are both product judgments, and only a person can
          // make one. Reclassifying is the whole escalation — it reaches the owner, deletes
          // nothing, and blocks nothing.
          await this.updateCase(stored, {
            ...stored.record,
            escalationTier: tier,
            state: "owner-decision",
            owner: "user",
            reason: `${stored.record.reason}; ${
              stored.record.state === "needs-integration" ||
              stored.record.state === "resolution-in-progress"
                ? "no resolver advanced it"
                : "measurement never completed"
            }, so only an owner decision can settle it`,
            due: {
              nextActionAt: new Date(now).toISOString(),
              watchedTrigger: null,
            },
            blockedOn: null,
            reviewAt: null,
            proofDigest: null,
          } as SettlementCase)
        : await this.updateCase(stored, {
            ...stored.record,
            escalationTier: tier,
          });
      tierAdvances += 1;
    }
    if (tierAdvances > 0 || rebaselined)
      cases = await this.cases.list(targetBranch);
    const [prior, unavailable] = await Promise.all([
      this.cases.readAggregate(),
      unavailableAgentNames(this.deps.repoRoot, NAME_POOL),
    ]);
    const aggregate = projectSettlementDebt(
      cases.map(({ record }) => record),
      {
        now,
        autoSettled: (prior?.record.autoSettled ?? 0) + settledThisSweep,
        unavailableNames: unavailable.size,
        namePoolTotal: NAME_POOL.length,
        liveAgentIds: new Set(
          this.deps.db
            .listAgents()
            .filter(isLiveAgent)
            .map((agent) => agent.id),
        ),
      },
    );
    const rendered = renderSettlementDebt(aggregate);
    const changed = prior?.record.digest !== aggregate.digest;
    const noticeChanged = prior?.record.noticeDigest !== aggregate.noticeDigest;
    const shouldPublish =
      noticeChanged &&
      settlementDebtNeedsNotice(aggregate) &&
      (cases.length > 0 || (prior?.record.openCases ?? 0) > 0);
    if (shouldPublish) {
      await this.deps.publish(
        "hive-lifecycle",
        ORCHESTRATOR_NAME,
        `Hive settlement debt [case-revision digest ${aggregate.digest.slice(0, 12)}]: ${rendered}. Read hive_status and compare the digest before acting; a mismatch means this notice is stale.`,
        { idempotencyKey: `settlement-debt:${aggregate.digest}` },
      );
    }
    if (changed || prior === null) {
      await this.cases.writeAggregate(
        {
          version: 1,
          digest: aggregate.digest,
          noticeDigest: aggregate.noticeDigest,
          rendered,
          updatedAt: new Date(now).toISOString(),
          autoSettled: aggregate.autoSettled,
          openCases: cases.length,
        },
        prior?.objectOid ?? null,
      );
    }
    return {
      aggregate,
      published: shouldPublish,
      tierAdvances,
    };
  }

  async settlementDebt() {
    if (this.settlementMeasurementFailure !== null) {
      return {
        state: "measurement-blocked",
        reason: this.settlementMeasurementFailure,
      };
    }
    try {
      return (await this.cases.readAggregate())?.record ?? null;
    } catch (error) {
      return {
        state: "measurement-blocked",
        reason: errorMessage(error),
      };
    }
  }

  async listSettlementCases(): Promise<SettlementCase[]> {
    const priority: Readonly<Record<SettlementCase["state"], number>> = {
      "owner-decision": 0,
      blocked: 1,
      "measurement-blocked": 2,
      "needs-integration": 3,
      "resolution-in-progress": 4,
      parked: 5,
      settling: 6,
      assessing: 7,
      "safe-release": 8,
      active: 9,
    };
    return (await this.cases.list(await this.targetBranch()))
      .map(({ record }) => record)
      .sort(
        (left, right) =>
          priority[left.state] - priority[right.state] ||
          left.firstSeenAt.localeCompare(right.firstSeenAt) ||
          left.caseId.localeCompare(right.caseId),
      );
  }

  recordSettlementMeasurementFailure(error: unknown): void {
    this.assertWritesAccepted();
    this.settlementMeasurementFailure = errorMessage(error);
  }

  private async assessAndMaybeRelease(
    agent: AgentRecord,
    at: string,
  ): Promise<{
    released: boolean;
    proof: SettlementProofResult;
    case: StoredSettlementCase;
  }> {
    return this.assessStoredCase(await this.adoptCase(agent), agent, at);
  }

  private async assessStoredCase(
    initial: StoredSettlementCase,
    agent: AgentRecord | null,
    at: string,
  ): Promise<{
    released: boolean;
    proof: SettlementProofResult;
    case: StoredSettlementCase;
  }> {
    let stored = initial;
    stored = await this.updateCase(stored, {
      ...stored.record,
      state: "assessing",
      owner: "settlement-service",
      reason: "settlement service is acquiring one consistent measurement",
      due: { nextActionAt: at, watchedTrigger: null },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
    } as SettlementCase);
    const targetBranch = await this.targetBranch();
    const proof = await measureAutomaticRelease(
      {
        repoRoot: this.deps.repoRoot,
        processLiveness: (candidate) => this.processLiveness(candidate),
      },
      stored.record,
      agent,
      targetBranch,
    );
    if (proof.kind === "kept") {
      const kept = await this.keepMeasuredCase(stored, proof, at);
      return { released: false, proof, case: kept };
    }
    const nextRevision = stored.record.revision + 1;
    const proofDigest = createHash("sha256")
      .update(
        `${stored.record.caseId}:${String(nextRevision)}:${proof.snapshot.digest}`,
      )
      .digest("hex");
    stored = await this.updateCase(stored, {
      ...stored.record,
      state: "safe-release",
      owner: "settlement-service",
      reason: `exact content accounted for by ${proof.snapshot.accountedBy}`,
      due: { nextActionAt: at, watchedTrigger: null },
      blockedOn: null,
      reviewAt: null,
      proofDigest,
      lastMeasuredAt: at,
      headOid: proof.snapshot.headOid,
      evidenceDigest: proof.snapshot.digest,
      evidenceFormat: "disposition-v1",
      residue: residueProjection(proof.snapshot, true),
      // The record names what release destroys before the authority to destroy it is issued.
      regenerable: [...proof.snapshot.regenerable],
    });
    const authority = this.settlementIssuer.issue({
      kind: "release-worktree",
      repoRoot: this.deps.repoRoot,
      worktreePath: proof.snapshot.worktreePath,
      // A branch the proof could not find is a branch there is nothing to delete: the record still
      // names it, and only the measurement knows whether it is still there.
      branch: proof.snapshot.branchOid === null ? null : stored.record.branch,
      branchOid: proof.snapshot.branchOid,
      expectedDigest: proof.snapshot.digest,
      revalidate: async () => {
        const current = await this.cases.read(stored.record.caseId);
        if (current?.objectOid !== stored.objectOid) {
          throw new Error("settlement case changed before mutation");
        }
        const reread = await measureAutomaticRelease(
          {
            repoRoot: this.deps.repoRoot,
            processLiveness: (candidate) => this.processLiveness(candidate),
          },
          stored.record,
          agent,
          targetBranch,
        );
        if (reread.kind !== "safe") {
          throw new Error(`settlement proof no longer holds: ${reread.reason}`);
        }
        if (
          (await this.cases.read(stored.record.caseId))?.objectOid !==
          stored.objectOid
        ) {
          throw new Error("settlement case changed during proof revalidation");
        }
        return reread.snapshot.digest;
      },
    });
    await this.settlementMutator.apply(authority);
    await this.cases.close(stored);
    return { released: true, proof, case: stored };
  }

  /** Failed work measurement is unknown, never clean, and shares teardown's snapshot. */
  async captureFinalWorkManifest(
    agent: AgentRecord,
  ): Promise<FinalWorkCapture> {
    const base = {
      agentId: agent.id,
      agentName: agent.name,
      runId: null,
      nodeId: null,
      branch: agent.branch,
      worktreePath: agent.worktreePath,
      lastStatus: agent.status,
    };
    if (agent.worktreePath === null && agent.branch === null) {
      return {
        manifest: {
          ...base,
          dirtyFiles: [],
          unmergedCommits: 0,
          classification: "clean",
          classificationReason: "agent held no worktree or branch at teardown",
        },
        work: null,
        targetBranch: "main",
        checkError: null,
      };
    }
    let targetBranch = "main";
    try {
      targetBranch = await resolveLandingTargetBranch(this.deps.repoRoot);
      const work = await this.deps.assessStrandedWork(
        this.deps.repoRoot,
        agent.worktreePath,
        agent.branch,
        targetBranch,
      );
      const stranded = work.dirtyFiles.length > 0 || work.unmergedCommits > 0;
      return {
        manifest: {
          ...base,
          dirtyFiles: work.dirtyFiles,
          unmergedCommits: work.unmergedCommits,
          classification: stranded ? "stranded" : "clean",
          classificationReason: stranded
            ? `${work.unmergedCommits} unmerged commit(s) and ${work.dirtyFiles.length} dirty file(s) not on ${targetBranch}`
            : `no unmerged commits or dirty files against ${targetBranch}`,
        },
        work,
        targetBranch,
        checkError: null,
      };
    } catch (error) {
      const checkError =
        error instanceof Error ? error.message : "unknown error";
      return {
        manifest: {
          ...base,
          dirtyFiles: [],
          unmergedCommits: 0,
          classification: "unknown",
          classificationReason: `stranded-work check failed (${checkError})`,
        },
        work: null,
        targetBranch,
        checkError,
      };
    }
  }

  /** Record the final capture, then let the exact proof either release the whole bundle or preserve what remains. */
  async settleTeardownWorktree(
    request: TeardownWorktreeRequest,
  ): Promise<TeardownWorktreeSettlement> {
    return this.runWrite(() => this.settleTeardownWorktreeWrite(request));
  }

  private async settleTeardownWorktreeWrite(
    request: TeardownWorktreeRequest,
  ): Promise<TeardownWorktreeSettlement> {
    const { agent, capture, at: timestamp } = request;
    let updated = request.updated;
    const cleaned: { worktreePath: string | null; branch: string | null } = {
      worktreePath: null,
      branch: null,
    };
    let stranded: TeardownStrandedWork | null = null;
    type PreservedBundle = {
      branch: string;
      ref: string;
      salvageRef?: string;
    };
    let preserved: PreservedBundle | null = null;
    let settledThisAction = 0;
    // The work state was measured at capture time, before the kill — the journal entry and the decisions below read the same snapshot, so the record can never disagree with what teardown acted on.
    const targetBranch = capture.targetBranch;
    if (agent.worktreePath !== null || agent.branch !== null) {
      const work = capture.work;
      if (work === null) {
        stranded = {
          branch: agent.branch,
          worktreePath: agent.worktreePath,
          dirtyFiles: [],
          unmergedCommits: 0,
          note: `stranded-work check failed (${
            capture.checkError ?? "unknown error"
          }); worktree kept.`,
        };
      } else if (work.dirtyFiles.length > 0 || work.unmergedCommits > 0) {
        stranded = {
          branch: agent.branch,
          worktreePath: agent.worktreePath,
          dirtyFiles: work.dirtyFiles,
          unmergedCommits: work.unmergedCommits,
          note: `${agent.name} left work that is not on ${targetBranch}; merge it via an integrator agent or request a user-bound settlement decision.`,
        };
      }
    }

    const preserveCapturedWork = async (): Promise<PreservedBundle | null> => {
      const work = capture.work;
      if (
        preserved !== null ||
        stranded === null ||
        agent.branch === null ||
        (work !== null &&
          work.dirtyFiles.length === 0 &&
          work.unmergedCommits === 0)
      ) {
        return preserved;
      }
      try {
        await markBranchPreserved(this.deps.repoRoot, agent.branch, {
          agentName: agent.name,
          preservedAt: timestamp,
        });
        let kept: PreservedBundle = {
          branch: agent.branch,
          ref: `refs/hive-preserved/${agent.branch}`,
        };
        // Uncommitted WIP is not on the branch tip. Capture it under a salvage
        // ref without changing the live worktree or index.
        if (
          agent.worktreePath !== null &&
          work !== null &&
          work.dirtyFiles.length > 0 &&
          existsSync(agent.worktreePath)
        ) {
          try {
            const salvage = await captureWipSalvage(
              this.deps.repoRoot,
              agent.worktreePath,
              agent.branch,
              { agentName: agent.name, preservedAt: timestamp },
            );
            if (salvage !== null) {
              kept = { ...kept, salvageRef: salvage.ref };
            }
          } catch (error) {
            stranded.note += ` Capturing WIP salvage FAILED (${
              error instanceof Error ? error.message : "unknown error"
            }); the preserved branch ref still stands.`;
          }
        }
        return kept;
      } catch (error) {
        stranded.note += ` Preserving the branch FAILED (${
          error instanceof Error ? error.message : "unknown error"
        }); the branch itself was not deleted.`;
        return null;
      }
    };

    if (agent.worktreePath !== null) {
      let settlement: Awaited<ReturnType<typeof this.assessAndMaybeRelease>>;
      try {
        settlement = await this.assessAndMaybeRelease(agent, timestamp);
      } catch (error) {
        stranded ??= {
          branch: agent.branch,
          worktreePath: agent.worktreePath,
          dirtyFiles: capture.work?.dirtyFiles ?? [],
          unmergedCommits: capture.work?.unmergedCommits ?? 0,
          note: `settlement case could not be recorded or measured (${errorMessage(
            error,
          )}); worktree kept.`,
        };
        preserved = await preserveCapturedWork();
        await this.updateSettlementDebtWrite().catch((debtError) =>
          this.reportAlertDeliveryFailure(debtError),
        );
        return { agent: updated, cleaned, preserved, stranded };
      }
      if (settlement.released) {
        settledThisAction = 1;
        stranded = null;
        cleaned.worktreePath = agent.worktreePath;
        cleaned.branch = agent.branch;
        updated = this.deps.db.upsertAgent({
          ...updated,
          worktreePath: null,
          branch: null,
        });
      } else {
        if (stranded === null) {
          stranded = {
            branch: agent.branch,
            worktreePath: agent.worktreePath,
            dirtyFiles:
              settlement.proof.snapshot?.residue.map((path) => path) ?? [],
            unmergedCommits: capture.work?.unmergedCommits ?? 0,
            note: `${
              settlement.proof.kind === "kept"
                ? settlement.proof.reason
                : "settlement mutation did not complete"
            }; worktree kept under settlement case ${settlement.case.record.caseId}.`,
          };
        }
        preserved = await preserveCapturedWork();
        if (preserved !== null) {
          const withRefs = await this.updateCase(settlement.case, {
            ...settlement.case.record,
            preservedRef: preserved.ref,
            salvageRef: preserved.salvageRef ?? null,
          } as SettlementCase);
          await this.measureResolverCase(
            withRefs,
            agent,
            targetBranch,
            timestamp,
          );
        }
      }
    }
    if (agent.worktreePath === null) {
      preserved = await preserveCapturedWork();
    }

    await this.updateSettlementDebtWrite(settledThisAction).catch((error) =>
      this.reportAlertDeliveryFailure(error),
    );
    return { agent: updated, cleaned, preserved, stranded };
  }

  async reconcileOrphanedWorktrees(): Promise<SettlementReconciliationReport> {
    return this.runWrite(() => this.reconcileOrphanedWorktreesWrite());
  }

  private async reconcileOrphanedWorktreesWrite(): Promise<SettlementReconciliationReport> {
    let agents = this.deps.db.listAgents();
    const targetBranch = await resolveLandingTargetBranch(this.deps.repoRoot);
    const branchInventory = await this.deps.listSettlementBranches(
      this.deps.repoRoot,
      targetBranch,
    );
    const detected = await this.deps.reconcileOrphanedWorktrees(
      this.deps.repoRoot,
      agents,
      targetBranch,
      {
        assess: this.deps.assessStrandedWork,
        now: () => this.deps.clock().getTime(),
      },
    );
    // A row names the branch its agent spawned on. A retasked agent cuts a new
    // branch in the same worktree, and until the row follows the worktree's
    // live checkout, every reader of agent.branch — this sweep, teardown,
    // hive_land — acts on the branch the agent came from. The checkout is
    // measured each sweep; the row follows it. Only a hive/* branch rebinds:
    // anything else (a detached HEAD mid-rebase reads as no branch at all) is
    // a transient the agent will leave again.
    let rebound = false;
    for (const outcome of detected.worktrees) {
      if (outcome.branch === null || !outcome.branch.startsWith("hive/")) {
        continue;
      }
      const candidates = agents.filter(
        (candidate) =>
          candidate.worktreePath !== null &&
          resolve(candidate.worktreePath) === outcome.path,
      );
      const owner = candidates.find(isLiveAgent) ?? candidates.at(-1);
      if (owner === undefined || owner.branch === outcome.branch) continue;
      const fresh = this.deps.db.getAgentById(owner.id);
      if (fresh === null || fresh.branch === outcome.branch) continue;
      this.deps.db.upsertAgent({ ...fresh, branch: outcome.branch });
      rebound = true;
      // The bundle the row used to name decouples here: the worktree now hosts
      // the new branch, so the old branch's case no longer holds a worktree.
      for (const stored of await this.cases.list(targetBranch)) {
        if (
          stored.record.agentId === fresh.id &&
          stored.record.branch !== outcome.branch &&
          stored.record.worktreePath !== null &&
          resolve(stored.record.worktreePath) === outcome.path &&
          (stored.record.state === "active" ||
            stored.record.state === "needs-integration" ||
            stored.record.state === "measurement-blocked")
        ) {
          await this.updateCase(stored, {
            ...stored.record,
            worktreePath: null,
          } as SettlementCase);
        }
      }
    }
    if (rebound) agents = this.deps.db.listAgents();
    const at = new Date(this.deps.clock().getTime()).toISOString();
    let settled = 0;
    const settledCases: SettledCaseEvidence[] = [];
    const openCases = await this.cases.list(targetBranch);
    const casesByBranch = new Map(
      openCases.flatMap((stored) =>
        stored.record.branch === null
          ? []
          : [[stored.record.branch, stored] as const],
      ),
    );
    const casesByPath = new Map(
      openCases.flatMap((stored) =>
        stored.record.worktreePath === null
          ? []
          : [[stored.record.worktreePath, stored] as const],
      ),
    );
    for (const branch of branchInventory) {
      let existing = casesByBranch.get(branch.branch);
      if (
        branch.ownerInstanceId !== undefined &&
        branch.ownerInstanceId !== hiveInstanceSuffix() &&
        existing === undefined
      ) {
        continue;
      }
      // A branch is owned by the agent whose row names it; a case is answered
      // by the agent the case names. The second leg keeps a bundle attributed
      // after its agent's row moved on to a new branch.
      const recordedAgentId = existing?.record.agentId ?? null;
      // The third leg reaches a branch the first two cannot: an agent retasked
      // more than once leaves branches its row no longer names and no case yet
      // records, and neither the row nor git can tie a branch that is not the
      // live checkout back to the worktree it was cut in. A name-pool name is
      // reissued after its agent retires, so a live holder outranks a retired
      // one. This decides attribution only; liveness still decides ownership.
      const named = agents.filter((candidate) =>
        ownsWorktreeBranch(candidate, branch.branch),
      );
      const agent =
        agents.find((candidate) => candidate.branch === branch.branch) ??
        (recordedAgentId === null
          ? undefined
          : agents.find((candidate) => candidate.id === recordedAgentId)) ??
        named.find(isLiveAgent) ??
        named.at(-1);
      if (
        agent !== undefined &&
        existing !== undefined &&
        existing.record.agentId === null
      ) {
        // The case was opened while no row named this branch; the match this
        // sweep just made proves the owner the record is missing.
        existing = await this.reattributeCase(existing, agent);
        casesByBranch.set(branch.branch, existing);
        if (existing.record.worktreePath !== null) {
          casesByPath.set(existing.record.worktreePath, existing);
        }
      }
      if (agent !== undefined && isLiveAgent(agent)) continue;
      let stored =
        existing ??
        (await this.cases.open({
          agentId: agent?.id ?? null,
          agentName: agent?.name ?? null,
          generation: agent === undefined ? null : this.generation(agent),
          worktreePath: agent?.worktreePath ?? null,
          branch: branch.branch,
          baseOid: branch.tip,
          now:
            agent?.createdAt ??
            new Date(this.deps.clock().getTime()).toISOString(),
          reason: "discovered unlanded branch is awaiting settlement",
        }));
      casesByBranch.set(branch.branch, stored);
      if (stored.record.evidenceFormat !== "disposition-v1") {
        stored = await this.measureResolverCase(
          stored,
          agent ?? null,
          targetBranch,
          at,
        );
        casesByBranch.set(branch.branch, stored);
        if (stored.record.worktreePath !== null) {
          casesByPath.set(stored.record.worktreePath, stored);
        }
      }
      if (
        existing !== undefined &&
        OWNED_ELSEWHERE.includes(existing.record.state)
      ) {
        continue;
      }
      // Nothing on this branch is missing from the landing target, so there is no integration to
      // ask a resolver for. A case that still holds a worktree is measured and reported by the
      // worktree pass below; one that holds only a branch has no other pass to reach it, and
      // before this it had no exit at all. Either way the proof decides, never this inventory.
      //
      // Proven ownership permits automatic release. A missing or foreign owner keeps that path
      // blocked, but the exact ownership verdict is still measured for a user-bound decision.
      if (branch.unmergedCommits === 0) {
        if (branch.ownerInstanceId !== hiveInstanceSuffix()) {
          const unowned =
            branch.ownerInstanceId === undefined
              ? `${targetBranch} already holds every commit on this branch, which no Hive instance proves it owns`
              : `${targetBranch} already holds every commit on this branch, which Hive instance ${branch.ownerInstanceId} owns`;
          if (
            stored.record.state !== "needs-integration" ||
            stored.record.reason !== unowned
          ) {
            stored = await this.updateCase(stored, {
              ...stored.record,
              state: "needs-integration",
              owner: "resolver",
              reason: unowned,
              due: {
                nextActionAt: new Date(
                  this.deps.clock().getTime(),
                ).toISOString(),
                watchedTrigger: null,
              },
              blockedOn: null,
              reviewAt: null,
              proofDigest: null,
              headOid: branch.tip,
            } as SettlementCase);
            casesByBranch.set(branch.branch, stored);
          }
          continue;
        }
        if (stored.record.worktreePath === null) {
          const assessed = await this.assessStoredCase(stored, null, at);
          // A released case is closed; leaving its snapshot in the map would hand the worktree
          // pass a case that no longer exists, and its compare-and-swap would fail.
          if (assessed.released) {
            settled += 1;
            if (assessed.proof.kind === "safe") {
              settledCases.push(
                settledCaseEvidence(assessed.case, assessed.proof.snapshot),
              );
            }
            casesByBranch.delete(branch.branch);
          } else casesByBranch.set(branch.branch, assessed.case);
        }
        continue;
      }
      const reason = `${branch.unmergedCommits} commit(s) are not accounted for on ${targetBranch}`;
      if (
        stored.record.state !== "needs-integration" ||
        stored.record.reason !== reason ||
        stored.record.headOid !== branch.tip
      ) {
        stored = await this.updateCase(stored, {
          ...stored.record,
          state: "needs-integration",
          owner: "resolver",
          reason,
          due: {
            nextActionAt: new Date(this.deps.clock().getTime()).toISOString(),
            watchedTrigger: null,
          },
          blockedOn: null,
          reviewAt: null,
          proofDigest: null,
          headOid: branch.tip,
        } as SettlementCase);
        casesByBranch.set(branch.branch, stored);
      }
    }
    await this.releaseStaleOwnerRefs().catch((error) => {
      console.error(
        `Hive owner-ref GC failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    const reconciled: WorktreeReconciliationOutcome[] = [];
    for (const outcome of detected.worktrees) {
      if (outcome.action !== "eligible") {
        reconciled.push(outcome);
        continue;
      }
      const agent = agents.find(
        (candidate) =>
          candidate.worktreePath === outcome.path ||
          (outcome.branch !== null && candidate.branch === outcome.branch),
      );
      const existing =
        casesByPath.get(outcome.path) ??
        (outcome.branch === null
          ? undefined
          : casesByBranch.get(outcome.branch));
      if (
        existing !== undefined &&
        OWNED_ELSEWHERE.includes(existing.record.state)
      ) {
        let held = existing;
        if (held.record.evidenceFormat !== "disposition-v1") {
          held = await this.measureResolverCase(
            held,
            agent ?? null,
            targetBranch,
            at,
          );
          casesByPath.set(outcome.path, held);
          if (outcome.branch !== null) {
            casesByBranch.set(outcome.branch, held);
          }
        }
        reconciled.push({
          ...outcome,
          action: "kept",
          rule: "assessment-failed",
          note: `kept under settlement case ${held.record.caseId}: ${held.record.reason}`,
        });
        continue;
      }
      if (agent === undefined) {
        const opened =
          existing ??
          (await this.cases.open({
            agentId: null,
            agentName: null,
            generation: null,
            worktreePath: outcome.path,
            branch: outcome.branch,
            baseOid:
              outcome.branch === null
                ? null
                : await readRefOid(
                    this.deps.repoRoot,
                    `refs/heads/${outcome.branch}`,
                  ),
            now: at,
            reason: "discovered orphan worktree is awaiting liveness proof",
          }));
        const assessed = await this.assessStoredCase(opened, null, at);
        if (assessed.released && assessed.proof.kind === "safe") {
          settled += 1;
          settledCases.push(
            settledCaseEvidence(assessed.case, assessed.proof.snapshot),
          );
          reconciled.push({ ...outcome, action: "released" });
          continue;
        }
        reconciled.push({
          ...outcome,
          action: "kept",
          rule:
            assessed.proof.kind === "kept" &&
            assessed.proof.state === "needs-integration"
              ? "stranded-work"
              : "assessment-failed",
          dirtyFiles:
            assessed.proof.snapshot?.residue.map((path) => path) ?? [],
          note:
            assessed.proof.kind === "kept"
              ? assessed.proof.reason
              : "settlement mutation did not complete",
        });
        continue;
      }
      const result = await this.assessAndMaybeRelease(agent, at);
      if (result.released) {
        settled += 1;
        if (result.proof.kind === "safe") {
          settledCases.push(
            settledCaseEvidence(result.case, result.proof.snapshot),
          );
        }
        reconciled.push({ ...outcome, action: "released" });
        this.deps.db.upsertAgent({
          ...agent,
          worktreePath: null,
          branch: null,
        });
        continue;
      }
      reconciled.push({
        ...outcome,
        action: "kept",
        rule:
          result.proof.kind === "kept" &&
          result.proof.state === "needs-integration"
            ? "stranded-work"
            : "assessment-failed",
        dirtyFiles: result.proof.snapshot?.residue.map((path) => path) ?? [],
        note:
          result.proof.kind === "kept"
            ? result.proof.reason
            : "settlement mutation did not complete",
      });
    }
    const stewardship = await this.listSalvageableRefs();
    for (const entry of stewardship) {
      let stored = await this.caseForStewardshipRef(entry, targetBranch);
      if (OWNED_ELSEWHERE.includes(stored.record.state)) {
        if (stored.record.evidenceFormat !== "disposition-v1") {
          await this.measureResolverCase(
            stored,
            stored.record.agentId === null
              ? null
              : (agents.find(
                  (candidate) => candidate.id === stored.record.agentId,
                ) ?? null),
            targetBranch,
            at,
          );
        }
        continue;
      }
      if (
        entry.kind === "preserved" &&
        detected.preservedRefs.releasable.some(
          (candidate) =>
            candidate.branch === entry.branch && candidate.tip === entry.tip,
        )
      ) {
        try {
          await this.releaseSalvageableRefWrite(entry.ref);
          settled += 1;
          continue;
        } catch {
          // The service records the exact reason and keeps the ref when its
          // second read cannot reproduce the detector's earlier result.
          stored = await this.caseForStewardshipRef(entry, targetBranch);
        }
      }
      if (stored.record.evidenceFormat !== "disposition-v1") {
        await this.measureResolverCase(
          stored,
          stored.record.agentId === null
            ? null
            : (agents.find(
                (candidate) => candidate.id === stored.record.agentId,
              ) ?? null),
          targetBranch,
          at,
        );
      }
    }
    // Every pass above is driven by something the live world still names: a branch in the
    // inventory, a registered worktree, a stewardship ref. A bundle that has vanished in all three
    // directions at once is named by none of them, so nothing re-measures the case and whatever it
    // last recorded — usually an instrument failure taken while the bundle was still there —
    // becomes permanent. The case list is the driver of last resort, so no open case is left
    // without a pass that reaches it. The same proof still decides; a case the world can still
    // name is left to the pass that owns it, and re-listing picks up the writes above rather than
    // handing a stale snapshot to a compare-and-swap.
    const named = {
      branches: new Set(branchInventory.map((entry) => entry.branch)),
      paths: new Set(detected.worktrees.map((entry) => entry.path)),
      refs: new Set(stewardship.map((entry) => entry.ref)),
    };
    for (const stored of await this.cases.list(targetBranch)) {
      const { agentId, branch, worktreePath, preservedRef, salvageRef } =
        stored.record;
      if (
        (branch !== null && named.branches.has(branch)) ||
        (worktreePath !== null && named.paths.has(worktreePath)) ||
        (preservedRef !== null && named.refs.has(preservedRef)) ||
        (salvageRef !== null && named.refs.has(salvageRef))
      ) {
        continue;
      }
      // The case names the agent, so the case is what resolves it. Its worktree and branch columns
      // are already cleared by the teardown that ran, and a lookup through either finds nothing.
      const assessed = await this.assessStoredCase(
        stored,
        agentId === null
          ? null
          : (agents.find((candidate) => candidate.id === agentId) ?? null),
        at,
      );
      if (assessed.released) {
        settled += 1;
        if (assessed.proof.kind === "safe") {
          settledCases.push(
            settledCaseEvidence(assessed.case, assessed.proof.snapshot),
          );
        }
      }
    }
    await this.updateSettlementDebtWrite(settled).catch((error) =>
      this.reportAlertDeliveryFailure(error),
    );
    this.settlementMeasurementFailure = null;
    return {
      worktrees: reconciled,
      preservedRefs: detected.preservedRefs,
      settledCases,
    };
  }

  private async releaseStaleOwnerRefs(): Promise<void> {
    const inventory = await listStaleOwnerRefs(this.deps.repoRoot);
    if (inventory.stale.length === 0) return;
    const digest = createHash("sha256")
      .update(JSON.stringify(inventory.stale))
      .digest("hex");
    const authority = this.settlementIssuer.issue({
      kind: "release-refs",
      repoRoot: this.deps.repoRoot,
      refs: inventory.stale,
      expectedDigest: digest,
      revalidate: async () =>
        createHash("sha256")
          .update(
            JSON.stringify(
              (await listStaleOwnerRefs(this.deps.repoRoot)).stale,
            ),
          )
          .digest("hex"),
    });
    await this.settlementMutator.apply(authority);
  }

  /** List preserved + salvage refs with metadata. Works without an agent row. */
  async listSalvageableRefs(): Promise<StewardshipRef[]> {
    const targetBranch = await resolveLandingTargetBranch(this.deps.repoRoot);
    return listStewardshipRefs(this.deps.repoRoot, targetBranch, {
      now: () => this.deps.clock().getTime(),
    });
  }

  private async caseForStewardshipRef(
    entry: StewardshipRef,
    targetBranch: string,
  ): Promise<StoredSettlementCase> {
    const listed = await this.cases.list(targetBranch);
    const existing = listed.find(
      ({ record }) =>
        record.preservedRef === entry.ref || record.salvageRef === entry.ref,
    );
    if (existing !== undefined) return existing;
    // A case opened for the live worktree never records the ref — only
    // settleTeardownWorktree writes preservedRef. Matching by ref alone
    // therefore minted a second case for the same branch; the assessing
    // write landed on the new one and the agent-owned case stayed active.
    const sameBranch = listed.filter(
      ({ record }) => record.branch === entry.branch,
    );
    const attached =
      sameBranch.find(({ record }) => record.worktreePath !== null) ??
      sameBranch.find(({ record }) => record.agentId !== null) ??
      sameBranch[0];
    if (attached !== undefined) {
      const preservedRef =
        entry.kind === "preserved" ? entry.ref : attached.record.preservedRef;
      const salvageRef =
        entry.kind === "salvage" ? entry.ref : attached.record.salvageRef;
      if (
        attached.record.preservedRef === preservedRef &&
        attached.record.salvageRef === salvageRef
      ) {
        return attached;
      }
      return this.updateCase(attached, {
        ...attached.record,
        preservedRef,
        salvageRef,
        headOid: entry.tip,
      } as SettlementCase);
    }
    const opened = await this.cases.open({
      agentId: null,
      agentName: entry.agentName,
      generation: null,
      worktreePath: null,
      branch: entry.branch,
      baseOid: entry.tip,
      now:
        entry.preservedAt ??
        new Date(this.deps.clock().getTime()).toISOString(),
      reason: "discovered stewardship ref is awaiting settlement",
    });
    return this.updateCase(opened, {
      ...opened.record,
      state: "needs-integration",
      owner: "resolver",
      reason: "stewardship ref has not yet been proved accounted for",
      due: {
        nextActionAt: new Date(this.deps.clock().getTime()).toISOString(),
        watchedTrigger: null,
      },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
      preservedRef: entry.kind === "preserved" ? entry.ref : null,
      salvageRef: entry.kind === "salvage" ? entry.ref : null,
      headOid: entry.tip,
    } as SettlementCase);
  }

  /** A release request succeeds only when the service can mint an exact proof. */
  async releaseSalvageableRef(ref: string): Promise<{ released: string }> {
    return this.runWrite(() => this.releaseSalvageableRefWrite(ref));
  }

  private async releaseSalvageableRefWrite(
    ref: string,
  ): Promise<{ released: string }> {
    const targetBranch = await this.targetBranch();
    const entry = (await this.listSalvageableRefs()).find(
      (candidate) => candidate.ref === ref,
    );
    if (entry === undefined)
      throw new Error(`stewardship ref not found: ${ref}`);
    let stored = await this.caseForStewardshipRef(entry, targetBranch);
    const measureEvidence = async () => {
      const targetOidBefore = await readRefOid(
        this.deps.repoRoot,
        `refs/heads/${targetBranch}`,
      );
      if (targetOidBefore === null) {
        throw new Error(`landing target is absent: ${targetBranch}`);
      }
      const receipt = (await this.cases.list(targetBranch))
        .map(({ record }) => record.landingReceipt)
        .find((candidate) => candidate?.sourceOid === entry.tip);
      const accounted =
        entry.kind === "preserved"
          ? (await countCommitsNotOnMain(
              this.deps.repoRoot,
              targetBranch,
              entry.tip,
            )) === 0
          : receipt !== undefined &&
            receipt !== null &&
            (await countCommitsNotOnMain(
              this.deps.repoRoot,
              targetBranch,
              receipt.targetOid,
            )) === 0 &&
            (await countCommitsNotOnMain(
              this.deps.repoRoot,
              targetBranch,
              receipt.sourceOid,
            )) === 0;
      const targetOidAfter = await readRefOid(
        this.deps.repoRoot,
        `refs/heads/${targetBranch}`,
      );
      if (targetOidAfter !== targetOidBefore) {
        throw new Error("landing target changed during ref accounting");
      }
      const refs = (
        await Promise.all(
          stewardshipBundleRefs(ref).map(async (candidate) => {
            const oid = await readRefOid(this.deps.repoRoot, candidate);
            return oid === null ? null : { ref: candidate, oid };
          }),
        )
      ).filter((candidate): candidate is { ref: string; oid: string } =>
        Boolean(candidate),
      );
      const evidenceDigest = createHash("sha256")
        .update(
          JSON.stringify({
            targetBranch,
            targetOid: targetOidBefore,
            ref,
            receipt: receipt ?? null,
            refs,
          }),
        )
        .digest("hex");
      return { accounted, refs, evidenceDigest };
    };
    const measured = await measureEvidence();
    if (!measured.accounted) {
      stored = await this.updateCase(stored, {
        ...stored.record,
        state: "needs-integration",
        owner: "resolver",
        reason:
          entry.kind === "salvage"
            ? "salvage ref lacks a re-verified landing receipt"
            : "preserved ref is not accounted for on the landing target",
        due: {
          nextActionAt: new Date(this.deps.clock().getTime()).toISOString(),
          watchedTrigger: null,
        },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
      } as SettlementCase);
      throw new Error(
        `ref ${ref} is not provably settled; kept under case ${stored.record.caseId}`,
      );
    }
    const { evidenceDigest, refs } = measured;
    const nextRevision = stored.record.revision + 1;
    stored = await this.updateCase(stored, {
      ...stored.record,
      state: "safe-release",
      owner: "settlement-service",
      reason: "stewardship ref is exactly accounted for",
      due: {
        nextActionAt: new Date(this.deps.clock().getTime()).toISOString(),
        watchedTrigger: null,
      },
      blockedOn: null,
      reviewAt: null,
      proofDigest: createHash("sha256")
        .update(
          `${stored.record.caseId}:${String(nextRevision)}:${evidenceDigest}`,
        )
        .digest("hex"),
      evidenceDigest,
      lastMeasuredAt: new Date(this.deps.clock().getTime()).toISOString(),
    });
    const authority = this.settlementIssuer.issue({
      kind: "release-refs",
      repoRoot: this.deps.repoRoot,
      refs,
      expectedDigest: evidenceDigest,
      revalidate: async () => {
        const current = await this.cases.read(stored.record.caseId);
        if (current?.objectOid !== stored.objectOid) {
          throw new Error("settlement case changed before ref mutation");
        }
        const reread = await measureEvidence();
        if (!reread.accounted) {
          throw new Error("stewardship accounting changed before ref mutation");
        }
        if (
          (await this.cases.read(stored.record.caseId))?.objectOid !==
          stored.objectOid
        ) {
          throw new Error("settlement case changed during ref revalidation");
        }
        return reread.evidenceDigest;
      },
    });
    await this.settlementMutator.apply(authority);
    const branchOid =
      stored.record.branch === null
        ? null
        : await readRefOid(
            this.deps.repoRoot,
            `refs/heads/${stored.record.branch}`,
          );
    const worktreeExists =
      stored.record.worktreePath !== null &&
      existsSync(stored.record.worktreePath);
    if (!worktreeExists && branchOid === null) {
      await this.cases.close(stored);
    } else {
      const removedRefs = new Set(refs.map((candidate) => candidate.ref));
      stored = await this.updateCase(stored, {
        ...stored.record,
        state: "assessing",
        owner: "settlement-service",
        reason:
          "stewardship refs released; the remaining bundle is due for proof",
        due: {
          nextActionAt: new Date(this.deps.clock().getTime()).toISOString(),
          watchedTrigger: null,
        },
        blockedOn: null,
        reviewAt: null,
        proofDigest: null,
        evidenceDigest: null,
        evidenceFormat: null,
        headOid: branchOid,
        preservedRef:
          stored.record.preservedRef !== null &&
          removedRefs.has(stored.record.preservedRef)
            ? null
            : stored.record.preservedRef,
        salvageRef:
          stored.record.salvageRef !== null &&
          removedRefs.has(stored.record.salvageRef)
            ? null
            : stored.record.salvageRef,
      } as SettlementCase);
      const agent =
        stored.record.agentId === null
          ? null
          : this.deps.db.getAgentById(stored.record.agentId);
      await this.assessStoredCase(
        stored,
        agent,
        new Date(this.deps.clock().getTime()).toISOString(),
      );
    }
    return { released: ref };
  }

  /** Explicit keep: leave the ref tip byte-identical; record the decision. */
  async keepSalvageableRef(
    ref: string,
  ): Promise<{ kept: string; tip: string }> {
    return this.runWrite(() => this.keepSalvageableRefWrite(ref));
  }

  private async keepSalvageableRefWrite(
    ref: string,
  ): Promise<{ kept: string; tip: string }> {
    const kept = await keepStewardshipRef(
      this.deps.repoRoot,
      ref,
      new Date(this.deps.clock().getTime()).toISOString(),
    );
    const targetBranch = await this.targetBranch();
    const entry = (await this.listSalvageableRefs()).find(
      (candidate) => candidate.ref === ref,
    );
    if (entry === undefined)
      throw new Error(`stewardship ref not found: ${ref}`);
    const stored = await this.caseForStewardshipRef(entry, targetBranch);
    const reviewAt = new Date(
      this.deps.clock().getTime() + STEWARDSHIP_ESCALATION_MS,
    ).toISOString();
    await this.updateCase(stored, {
      ...stored.record,
      state: "parked",
      owner: "queen",
      reason: "explicit keep decision",
      due: { nextActionAt: null, watchedTrigger: "review-at" },
      blockedOn: null,
      reviewAt,
      proofDigest: null,
    });
    return kept;
  }

  private decisionDigest(
    input: Pick<
      SettlementDecision,
      | "decisionId"
      | "caseId"
      | "caseRevision"
      | "evidenceDigest"
      | "worktreePath"
      | "branch"
      | "branchOid"
      | "refs"
      | "outcome"
      | "expiresAt"
    >,
  ): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }

  async mintDestructiveDecision(input: {
    readonly caseId: string;
    readonly revision: number;
    readonly evidenceDigest: string;
    readonly reason: string;
    readonly expiresAt: string;
    readonly decisionOwner: string;
  }): Promise<SettlementDecision> {
    return this.runWrite(() => this.mintDestructiveDecisionWrite(input));
  }

  private async mintDestructiveDecisionWrite(input: {
    readonly caseId: string;
    readonly revision: number;
    readonly evidenceDigest: string;
    readonly reason: string;
    readonly expiresAt: string;
    readonly decisionOwner: string;
  }): Promise<SettlementDecision> {
    let stored = await this.cases.read(input.caseId);
    if (stored === null)
      throw new Error(`settlement case not found: ${input.caseId}`);
    // The revision tracks workflow updates, including periodic measurements. An older quote stays
    // valid only when its content-addressed evidence is still current and the fresh proof below
    // reproduces it; a revision from the future cannot describe this record.
    if (
      input.revision > stored.record.revision ||
      stored.record.evidenceDigest !== input.evidenceDigest ||
      stored.record.evidenceFormat !== "disposition-v1"
    ) {
      throw new Error("settlement case revision or evidence digest changed");
    }
    const now = this.deps.clock().getTime();
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) {
      throw new Error("settlement decision expiry must be in the future");
    }
    const agent =
      stored.record.agentId === null
        ? null
        : this.deps.db.getAgentById(stored.record.agentId);
    const targetBranch = await this.targetBranch();
    const measured = await measureAutomaticRelease(
      {
        repoRoot: this.deps.repoRoot,
        processLiveness: (candidate) => this.processLiveness(candidate),
      },
      stored.record,
      agent,
      targetBranch,
    );
    if (measured.kind === "safe") {
      throw new Error(
        "this case is automatically releasable and needs no destructive decision",
      );
    }
    if (measured.snapshot === null) {
      throw new Error(
        `settlement inventory is unverified and cannot be summarized: ${measured.reason}`,
      );
    }
    if (measured.snapshot.digest !== input.evidenceDigest) {
      throw new Error("settlement evidence changed before decision minting");
    }
    stored = await this.updateCase(stored, {
      ...stored.record,
      state: "owner-decision",
      owner: "user",
      reason: "the user is deciding the exact measured residue",
      due: { nextActionAt: null, watchedTrigger: "owner-decision" },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
      evidenceDigest: measured.snapshot.digest,
      evidenceFormat: "disposition-v1",
      residue: residueProjection(measured.snapshot, false),
      lastMeasuredAt: new Date(now).toISOString(),
    } as SettlementCase);
    const refNames = [
      ...(stored.record.preservedRef === null
        ? []
        : stewardshipBundleRefs(stored.record.preservedRef)),
      ...(stored.record.salvageRef === null
        ? []
        : stewardshipBundleRefs(stored.record.salvageRef)),
    ];
    const refs = (
      await Promise.all(
        [...new Set(refNames)].map(async (ref) => {
          const oid = await readRefOid(this.deps.repoRoot, ref);
          return oid === null ? null : { ref, oid };
        }),
      )
    ).filter((value): value is { ref: string; oid: string } => value !== null);
    const decision = await this.decisions.mint({
      caseId: stored.record.caseId,
      caseRevision: stored.record.revision,
      evidenceDigest: measured.snapshot.digest,
      worktreePath: stored.record.worktreePath,
      branch: stored.record.branch,
      branchOid: measured.snapshot.branchOid,
      refs,
      residue: [...measured.snapshot.residue],
      outcome: "discard",
      reason: input.reason,
      decisionOwner: input.decisionOwner,
      mintedAt: new Date(now).toISOString(),
      expiresAt: input.expiresAt,
    });
    return decision.record;
  }

  async executeDestructiveDecision(
    decisionId: string,
    executedBy: string,
  ): Promise<SettlementDecision> {
    return this.runWrite(() =>
      this.executeDestructiveDecisionWrite(decisionId, executedBy),
    );
  }

  private async executeDestructiveDecisionWrite(
    decisionId: string,
    executedBy: string,
  ): Promise<SettlementDecision> {
    const decision = await this.decisions.read(decisionId);
    if (decision === null) {
      throw new Error(`settlement decision not found: ${decisionId}`);
    }
    if (decision.record.executedAt !== null) {
      throw new Error(`settlement decision already executed: ${decisionId}`);
    }
    const now = this.deps.clock().getTime();
    if (Date.parse(decision.record.expiresAt) <= now) {
      throw new Error(`settlement decision expired: ${decisionId}`);
    }
    const stored = await this.cases.read(decision.record.caseId);
    // Later revisions may record another identical measurement. The digest binds the content;
    // the proof and ref checks below invalidate the decision on any destructive-subject drift.
    if (
      stored === null ||
      stored.record.revision < decision.record.caseRevision ||
      stored.record.evidenceDigest !== decision.record.evidenceDigest ||
      stored.record.evidenceFormat !== "disposition-v1"
    ) {
      throw new Error("settlement case changed after the decision was minted");
    }
    const expectedDigest = this.decisionDigest(decision.record);
    const authority = this.settlementIssuer.issue({
      kind: "discard-bundle",
      decisionId,
      repoRoot: this.deps.repoRoot,
      worktreePath: decision.record.worktreePath,
      branch: decision.record.branch,
      branchOid: decision.record.branchOid,
      refs: decision.record.refs,
      expectedDigest,
      revalidate: async () => {
        const current = await this.cases.read(decision.record.caseId);
        if (
          current === null ||
          current.objectOid !== stored.objectOid ||
          current.record.evidenceDigest !== decision.record.evidenceDigest
        ) {
          throw new Error(
            "settlement case changed before destructive execution",
          );
        }
        const agent =
          current.record.agentId === null
            ? null
            : this.deps.db.getAgentById(current.record.agentId);
        const measured = await measureAutomaticRelease(
          {
            repoRoot: this.deps.repoRoot,
            processLiveness: (candidate) => this.processLiveness(candidate),
          },
          current.record,
          agent,
          await this.targetBranch(),
        );
        if (
          measured.snapshot === null ||
          measured.snapshot.digest !== decision.record.evidenceDigest
        ) {
          throw new Error(
            "settlement evidence changed before destructive execution",
          );
        }
        const refs = await Promise.all(
          decision.record.refs.map(async ({ ref }) => ({
            ref,
            oid: await readRefOid(this.deps.repoRoot, ref),
          })),
        );
        if (
          refs.some(({ oid }) => oid === null) ||
          refs.some(({ ref, oid }, index) => {
            const expected = decision.record.refs[index];
            return expected?.ref !== ref || expected.oid !== oid;
          })
        ) {
          throw new Error(
            "settlement refs changed before destructive execution",
          );
        }
        if (
          (await this.cases.read(decision.record.caseId))?.objectOid !==
          stored.objectOid
        ) {
          throw new Error(
            "settlement case changed during destructive revalidation",
          );
        }
        return this.decisionDigest(decision.record);
      },
    });
    await this.settlementMutator.apply(authority);
    await this.cases.close(stored);
    if (stored.record.agentId !== null) {
      const agent = this.deps.db.getAgentById(stored.record.agentId);
      if (agent !== null) {
        this.deps.db.upsertAgent({
          ...agent,
          worktreePath: null,
          branch: null,
        });
      }
    }
    const removedRefs = [
      ...(decision.record.branch === null
        ? []
        : [`refs/heads/${decision.record.branch}`]),
      ...decision.record.refs.map(({ ref }) => ref),
    ];
    const executed = await this.decisions.markExecuted(decision, {
      executedAt: new Date(now).toISOString(),
      executedBy,
      removedPaths:
        decision.record.worktreePath === null
          ? []
          : [decision.record.worktreePath],
      removedRefs,
    });
    await this.updateSettlementDebtWrite(1).catch((error) =>
      this.reportAlertDeliveryFailure(error),
    );
    return executed.record;
  }

  async onLanded(agent: AgentRecord, landedCommit: string): Promise<void> {
    return this.runWrite(() => this.onLandedWrite(agent, landedCommit));
  }

  private async onLandedWrite(
    agent: AgentRecord,
    landedCommit: string,
  ): Promise<void> {
    if (
      agent.branch === null ||
      agent.worktreePath === null ||
      !existsSync(agent.worktreePath)
    )
      return;
    const targetBranch = await resolveLandingTargetBranch(this.deps.repoRoot);
    const sourceOid = await readRefOid(
      this.deps.repoRoot,
      `refs/heads/${agent.branch}`,
    );
    const targetOid = await readRefOid(
      this.deps.repoRoot,
      `refs/heads/${targetBranch}`,
    );
    if (sourceOid === null || targetOid === null) {
      throw new Error(
        "landing receipt cannot resolve its source and target refs",
      );
    }
    const recordedAt = new Date(this.deps.clock().getTime()).toISOString();
    this.deps.db.upsertAgent({
      ...agent,
      landedCommit,
      landedAt: recordedAt,
    });
    let stored = await this.adoptCase(agent);
    stored = await this.updateCase(stored, {
      ...stored.record,
      state: "settling",
      owner: "settlement-service",
      reason: "landing receipt is being re-verified before branch reset",
      due: { nextActionAt: recordedAt, watchedTrigger: null },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
      headOid: sourceOid,
      landingReceipt: { sourceOid, targetOid, targetBranch, recordedAt },
    } as SettlementCase);
    const evidenceDigest = createHash("sha256")
      .update(JSON.stringify({ sourceOid, targetOid, targetBranch }))
      .digest("hex");
    const authority = this.settlementIssuer.issue({
      kind: "reset-branch",
      repoRoot: this.deps.repoRoot,
      branch: agent.branch,
      sourceOid,
      targetOid,
      expectedDigest: evidenceDigest,
      revalidate: async () => {
        const current = await this.cases.read(stored.record.caseId);
        const currentSource = await readRefOid(
          this.deps.repoRoot,
          `refs/heads/${agent.branch}`,
        );
        const currentTarget = await readRefOid(
          this.deps.repoRoot,
          `refs/heads/${targetBranch}`,
        );
        if (current?.objectOid !== stored.objectOid) {
          throw new Error("settlement case changed before landing reset");
        }
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              sourceOid: currentSource,
              targetOid: currentTarget,
              targetBranch,
            }),
          )
          .digest("hex");
        if (
          (await this.cases.read(stored.record.caseId))?.objectOid !==
          stored.objectOid
        ) {
          throw new Error("settlement case changed during landing reset");
        }
        return digest;
      },
    });
    await this.settlementMutator.apply(authority);
    await this.updateCase(stored, {
      ...stored.record,
      state: "active",
      owner: "agent",
      reason: "landed branch is ready for follow-up work",
      due: { nextActionAt: null, watchedTrigger: "agent-generation-ended" },
      blockedOn: null,
      reviewAt: null,
      proofDigest: null,
      headOid: targetOid,
      evidenceDigest,
    } as SettlementCase);
  }

  async settleFailedSpawn(
    agent: AgentRecord,
    worktree: { path: string; branch: string } | null,
    keepOnFailure: boolean,
  ): Promise<{
    preserved: string | null;
    removed: boolean;
    cleanupErrors: string[];
  }> {
    return this.runWrite(() =>
      this.settleFailedSpawnWrite(agent, worktree, keepOnFailure),
    );
  }

  private async settleFailedSpawnWrite(
    agent: AgentRecord,
    worktree: { path: string; branch: string } | null,
    keepOnFailure: boolean,
  ): Promise<{
    preserved: string | null;
    removed: boolean;
    cleanupErrors: string[];
  }> {
    if (worktree === null) {
      return { preserved: null, removed: false, cleanupErrors: [] };
    }
    if (keepOnFailure) {
      try {
        const stored = await this.adoptCase(agent);
        const reviewAt = new Date(
          this.deps.clock().getTime() + STEWARDSHIP_ESCALATION_MS,
        ).toISOString();
        await this.updateCase(stored, {
          ...stored.record,
          state: "parked",
          owner: "queen",
          reason:
            "failed-spawn worktree retention was requested by configuration",
          due: { nextActionAt: null, watchedTrigger: "review-at" },
          blockedOn: null,
          reviewAt,
          proofDigest: null,
        });
        await this.updateSettlementDebtWrite().catch((error) =>
          this.reportAlertDeliveryFailure(error),
        );
      } catch (error) {
        return {
          preserved: `Kept the worktree at ${worktree.path} (branch ${worktree.branch}) by configuration.`,
          removed: false,
          cleanupErrors: [errorMessage(error)],
        };
      }
      return {
        preserved: `Kept the worktree at ${worktree.path} (branch ${worktree.branch}) by configuration.`,
        removed: false,
        cleanupErrors: [],
      };
    }
    try {
      const capture = await this.captureFinalWorkManifest(agent);
      const settlement = await this.settleTeardownWorktreeWrite({
        agent,
        updated: agent,
        capture,
        at: new Date(this.deps.clock().getTime()).toISOString(),
        removeWorktree: true,
      });
      return {
        preserved:
          settlement.cleaned.worktreePath !== null
            ? null
            : `Kept the worktree at ${worktree.path} (branch ${worktree.branch}): ${settlement.stranded?.note ?? "automatic release was not proved"}`,
        removed: settlement.cleaned.worktreePath !== null,
        cleanupErrors: [],
      };
    } catch (error) {
      return {
        preserved: `Kept the worktree at ${worktree.path} (branch ${worktree.branch}): settlement failed closed.`,
        removed: false,
        cleanupErrors: [errorMessage(error)],
      };
    }
  }
}
