import { createHash } from "node:crypto";
import type { SettlementCase } from "./settlement-case-store";

const ESCALATION_AGES_MS = [
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
] as const;

export interface SettlementDebtAggregate {
  readonly total: number;
  readonly active: number;
  readonly settling: number;
  readonly autoSettled: number;
  readonly resolving: number;
  /**
   * Resolving cases whose agent is still alive. A resolving case is work the
   * sweep has filed as awaiting integration by someone other than its author,
   * so one owned by a live agent is a contradiction rather than a status: a
   * branch is being written to and queued for integration at the same time.
   * Any non-zero value is actionable on its own, which is why this is a count
   * and not a list.
   */
  readonly resolvingLiveAgent: number;
  readonly blocked: number;
  readonly ownerDecision: number;
  readonly measurementBlocked: number;
  readonly oldestAgeMs: number;
  readonly namePoolFree: number;
  readonly namePoolTotal: number;
  readonly noticeDigest: string;
  readonly digest: string;
}

export function escalationTier(firstSeenAt: string, now: number): number {
  const age = Math.max(0, now - Date.parse(firstSeenAt));
  return ESCALATION_AGES_MS.filter((threshold) => age >= threshold).length;
}

/**
 * Waiting on someone other than the case's own author to move the work. Named
 * once because the aggregate counts these cases twice: all of them, and the
 * live-agent subset that contradicts the state.
 */
function isResolving(record: SettlementCase): boolean {
  return (
    record.state === "needs-integration" ||
    record.state === "resolution-in-progress"
  );
}

export function projectSettlementDebt(
  cases: readonly SettlementCase[],
  input: {
    readonly now: number;
    readonly autoSettled: number;
    readonly unavailableNames: number;
    readonly namePoolTotal: number;
    /**
     * Ids of the agents that are live right now, supplied by the caller that
     * already holds the agent rows. Liveness is decided there, so projecting
     * the debt stays a function of its arguments and never reaches into agent
     * state to render a number.
     */
    readonly liveAgentIds: ReadonlySet<string>;
  },
): SettlementDebtAggregate {
  const ages = cases.map((record) =>
    Math.max(0, input.now - Date.parse(record.firstSeenAt)),
  );
  const base = {
    total: cases.length + input.autoSettled,
    active: cases.filter((record) => record.state === "active").length,
    settling: cases.filter(
      (record) =>
        record.state === "settling" ||
        record.state === "assessing" ||
        record.state === "safe-release",
    ).length,
    autoSettled: input.autoSettled,
    resolving: cases.filter(isResolving).length,
    resolvingLiveAgent: cases.filter(
      (record) =>
        isResolving(record) &&
        record.agentId !== null &&
        input.liveAgentIds.has(record.agentId),
    ).length,
    blocked: cases.filter(
      (record) => record.state === "blocked" || record.state === "parked",
    ).length,
    ownerDecision: cases.filter((record) => record.state === "owner-decision")
      .length,
    measurementBlocked: cases.filter(
      (record) => record.state === "measurement-blocked",
    ).length,
    oldestAgeMs: ages.length === 0 ? 0 : Math.max(...ages),
    namePoolFree: Math.max(0, input.namePoolTotal - input.unavailableNames),
    namePoolTotal: input.namePoolTotal,
  };
  const noticeInput = {
    ...base,
    oldestAgeMs: undefined,
    cases: cases.map((record) => ({
      caseId: record.caseId,
      state: record.state,
      owner: record.owner,
      reason: record.reason,
      due: record.due,
      blockedOn: record.blockedOn,
      reviewAt: record.reviewAt,
      escalationTier: record.escalationTier,
    })),
  };
  const noticeDigest = createHash("sha256")
    .update(JSON.stringify(noticeInput))
    .digest("hex");
  return {
    ...base,
    noticeDigest,
    digest: createHash("sha256")
      .update(
        JSON.stringify({
          noticeDigest,
          revisions: cases.map((record) => ({
            caseId: record.caseId,
            revision: record.revision,
          })),
        }),
      )
      .digest("hex"),
  };
}

/** Decision-relevant snapshot of settlement debt. Counts the orchestrator
 * already saw, not the case-revision digest (that moves whenever any case
 * revision moves) and not age (that moves every millisecond). */
export function settlementDebtCondition(
  aggregate: Omit<
    SettlementDebtAggregate,
    "noticeDigest" | "digest" | "oldestAgeMs"
  >,
): string {
  return JSON.stringify({
    total: aggregate.total,
    active: aggregate.active,
    settling: aggregate.settling,
    autoSettled: aggregate.autoSettled,
    resolving: aggregate.resolving,
    resolvingLiveAgent: aggregate.resolvingLiveAgent,
    blocked: aggregate.blocked,
    ownerDecision: aggregate.ownerDecision,
    measurementBlocked: aggregate.measurementBlocked,
    namePoolFree: aggregate.namePoolFree,
    namePoolTotal: aggregate.namePoolTotal,
  });
}

/**
 * Whether the aggregate may wake the orchestrator.
 *
 * The notice is a work-lane poke ("read hive_status and compare the digest"),
 * not a report to act from. A wake still costs a full orchestrator turn, so
 * only counts that can require a decision justify one. `blocked` already
 * includes parked cases. Age is not a fourth trigger here: the escalation
 * sweep promotes an unattended wait to owner-decision before this is asked,
 * and using raw oldestAgeMs would wake on any live agent older than a day.
 *
 * Ordinary resolving cases are still excluded, and deliberately: they wait on
 * a resolver and need no decision. `resolvingLiveAgent` is the strict subset
 * that contradicts itself, so it narrows that exclusion rather than lifting
 * it — the aggregate cannot see plain `resolving` at all.
 */
export function settlementDebtNeedsNotice(
  aggregate: Pick<
    SettlementDebtAggregate,
    "blocked" | "ownerDecision" | "measurementBlocked" | "resolvingLiveAgent"
  >,
): boolean {
  return (
    aggregate.blocked > 0 ||
    aggregate.ownerDecision > 0 ||
    aggregate.measurementBlocked > 0 ||
    aggregate.resolvingLiveAgent > 0
  );
}

export function renderSettlementDebt(
  aggregate: SettlementDebtAggregate,
): string {
  const oldestDays = Math.floor(aggregate.oldestAgeMs / (24 * 60 * 60_000));
  return (
    `${aggregate.total} cases: ${aggregate.active} active · ` +
    `${aggregate.settling} settling · ` +
    `${aggregate.autoSettled} auto-settled · ${aggregate.resolving} resolving` +
    (aggregate.resolvingLiveAgent > 0
      ? ` (${aggregate.resolvingLiveAgent} live-agent)`
      : "") +
    " · " +
    `${aggregate.blocked} blocked · ${aggregate.ownerDecision} owner decision · ` +
    `${aggregate.measurementBlocked} measurement blocked · oldest ${oldestDays}d · ` +
    `name-pool ${aggregate.namePoolFree}/${aggregate.namePoolTotal} free`
  );
}
