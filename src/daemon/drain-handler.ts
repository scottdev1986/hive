import {
  type AgentRecord,
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  isTerminalAgentStatus,
  type ProviderRun,
} from "../schemas";
import type { HiveDatabase } from "./db";
import type { QuotaService } from "./quota";

const isTerminal = (agent: AgentRecord): boolean =>
  agent.status === "held" || isTerminalAgentStatus(agent.status);

/**
 * The drain handler (§R4–R7, docs/design/quota-lifecycle-redesign.html) —
 * the one muscle the quota redesign adds. A mid-work agent whose provider's
 * usage is spent is handled by exactly one of three arms:
 *
 * - HOLD (§R4): the drained window resets within the hour. The agent is
 *   marked `held`; the daemon's existing 30-second maintenance sweep pokes
 *   it with a continue message once the reset has passed. No new timers.
 * - REPLACEMENT (§R5): C4 freezes and retains the source run, then reports the
 *   replacement seam. C5 owns the handoff and replacement itself.
 * - ALL-DRAINED (§R6): no provider has usage — every metered pool is spent
 *   AND every unmetered route has errored. Wait for the nearest 5-hour
 *   reset, or the 7-day reset if it lands within 5 hours; otherwise the
 *   branch is preserved and a memory written so work resumes when
 *   availability returns.
 *
 * Unmetered providers (opencode today) are never held — there is no reset
 * to wait for — and their drain is known only through a vendor rate-limit
 * error, classified by `classifyVendorDrainError`.
 */

const HOLD_WINDOW_MS = 60 * 60_000;
const ALL_DRAINED_WEEKLY_WAIT_MS = 5 * 60 * 60_000;

/** Vendor rate-limit/billing errors that mean DRAIN, not crash. Deliberately
 * small: anything this cannot name stays a crash and feeds the launch-failure
 * quarantine instead. */
const VENDOR_DRAIN_PATTERNS: Record<CapabilityProvider, readonly RegExp[]> = {
  // Anthropic's billing text is "Credit balance is too low"; 429s are
  // rate_limit_error.
  claude: [/rate.?limit/i, /\b429\b/, /credit balance/i, /usage (limit|cap)/i],
  // Codex surfaces "Rate limit reached" and usage-limit errors verbatim.
  codex: [/rate.?limit/i, /\b429\b/, /usage.?limit/i, /quota/i],
  grok: [/rate.?limit/i, /\b429\b/, /quota/i],
  // Kimi's provider errors carry provider.rate_limit (asyncapi spec).
  kimi: [/rate.?limit/i, /rate_limit/, /\b429\b/, /quota/i],
  opencode: [/rate.?limit/i, /\b429\b/, /quota/i],
};

/** Is this failure text the vendor saying "out of usage" — honestly, or not
 * at all? Unknown error shapes are crashes, never drains. */
export function classifyVendorDrainError(
  tool: CapabilityProvider,
  failure: string,
): boolean {
  return VENDOR_DRAIN_PATTERNS[tool].some((pattern) => pattern.test(failure));
}

export interface DrainHandlerDependencies {
  db: HiveDatabase;
  quota: QuotaService | undefined;
  send: (
    from: string,
    to: string,
    body: string,
    options?: { idempotencyKey?: string },
  ) => Promise<unknown>;
  pauseProvider: (agent: AgentRecord, run: ProviderRun) => Promise<boolean>;
  resumeProvider: (agent: AgentRecord, run: ProviderRun) => Promise<boolean>;
  requestReplacement: (
    agent: AgentRecord,
    drain: ReplacementDrain,
  ) => Promise<void>;
  /** EpisodicStore.appendEvent — the all-drained memory. */
  remember?: (event: {
    agent: string | null;
    type: string;
    summary: string;
  }) => void;
  clock?: () => Date;
}

export interface ReplacementDrain {
  provider: CapabilityProvider;
  pool: string | null;
  resetsAt: string | null;
  reason: string;
}

export class DrainHandler {
  private readonly drainErrors = new Map<CapabilityProvider, string>();
  private readonly clock: () => Date;

  constructor(private readonly deps: DrainHandlerDependencies) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** A provider proved it has usage again: a spawn on it started. */
  noteProviderAlive(provider: CapabilityProvider): void {
    this.drainErrors.delete(provider);
  }

  /** A spawn or turn failed with a vendor rate-limit error (§06). Routes
   * here INSTEAD of the launch-failure quarantine: the route is not broken,
   * the meter is empty. The agent is already terminal at this point — a hold
   * is meaningless for a corpse, so C4 reports the replacement seam without
   * destroying its terminal or worktree. */
  async onVendorError(agent: AgentRecord, failure: string): Promise<void> {
    this.drainErrors.set(agent.tool, new Date(this.clock()).toISOString());
    const drain: ReplacementDrain = {
      provider: agent.tool,
      pool: null,
      resetsAt: null,
      reason: `a ${agent.tool} rate-limit error: ${failure}`,
    };
    if (this.allDrained()) {
      await this.allDrainedArm(agent, drain);
    } else {
      await this.deferReplacement(agent, drain);
    }
    // The error may have changed the all-drained verdict for every live
    // agent too — evaluate them through the normal sweep now, not 30s late.
    await this.sweep();
  }

  /** The 30-second maintenance sweep calls this: poke held agents whose
   * reset has passed, then look for newly drained running agents. */
  async sweep(now = this.clock()): Promise<void> {
    const quota = this.deps.quota;
    if (quota === undefined) return;
    for (const agent of this.deps.db.listAgents()) {
      if (agent.status === "held") {
        if (
          agent.holdResetAt !== null &&
          agent.holdResetAt !== undefined &&
          new Date(agent.holdResetAt) <= now
        ) {
          await this.resumeHeld(agent, now);
        }
        continue;
      }
      if (agent.name === "queen") continue;
      if (
        agent.status !== "working" &&
        agent.status !== "idle" &&
        agent.status !== "awaiting-approval"
      )
        continue;
      const identity = agent.executionIdentity;
      const model = identity?.model ?? agent.model;
      const drained = quota.drainFor({ tool: agent.tool, model }, now);
      if (drained === null) continue;
      const reason =
        `${agent.tool}'s ${drained.pool} ${drained.window} window is spent` +
        (drained.resetsAt === null
          ? " and the provider does not say when it resets"
          : ` until ${drained.resetsAt}`);
      const drain: ReplacementDrain = {
        provider: agent.tool,
        pool: drained.pool,
        resetsAt: drained.resetsAt,
        reason,
      };
      if (
        drained.resetsAt !== null &&
        new Date(drained.resetsAt).getTime() - now.getTime() <= HOLD_WINDOW_MS
      ) {
        // §R4: a reset within the hour is a hold, never a handoff.
        if (!(await this.hold(agent, reason, drained.resetsAt))) {
          await this.deps.requestReplacement(agent, {
            ...drain,
            reason: `${reason}; the source provider could not be held`,
          });
        }
        continue;
      }
      await this.handle(agent, drain);
    }
  }

  /** The arm decision shared by the sweep and the vendor-error path. */
  private async handle(
    agent: AgentRecord,
    drain: ReplacementDrain,
  ): Promise<void> {
    const quota = this.deps.quota;
    if (quota === undefined || agent.status === "held") return;
    if (this.allDrained()) {
      await this.allDrainedArm(agent, drain);
      return;
    }
    await this.deferReplacement(agent, drain);
  }

  /** Every metered provider drained AND every unmetered route errored (§R6). */
  private allDrained(): boolean {
    const quota = this.deps.quota;
    if (quota === undefined) return false;
    if (!quota.allMeteredDrained(this.clock())) return false;
    const unmetered = CAPABILITY_PROVIDERS.filter(
      (provider) => !this.providerIsMetered(provider),
    );
    return unmetered.every((provider) => this.drainErrors.has(provider));
  }

  private providerIsMetered(provider: CapabilityProvider): boolean {
    return this.deps.quota?.isMetered(provider) ?? false;
  }

  /** §R6: wait for the nearest reset, or preserve and remember. */
  private async allDrainedArm(
    agent: AgentRecord,
    drain: ReplacementDrain,
  ): Promise<void> {
    const quota = this.deps.quota!;
    const now = this.clock();
    const nearest = quota.nearestDrainResets(now);
    const waitFor =
      nearest.fiveHour ??
      (nearest.weekly !== null &&
      new Date(nearest.weekly).getTime() - now.getTime() <=
        ALL_DRAINED_WEEKLY_WAIT_MS
        ? nearest.weekly
        : null);
    if (waitFor !== null && agent.status !== "held" && !isTerminal(agent)) {
      const held = await this.hold(
        agent,
        `every provider is out of usage (${drain.reason}); nearest window resets ${waitFor}`,
        waitFor,
      );
      if (!held) {
        await this.deps.requestReplacement(agent, {
          ...drain,
          reason: `${drain.reason}; the source provider could not be held`,
        });
      }
      return;
    }
    if (!isTerminal(agent)) {
      await this.hold(agent, `all providers drained: ${drain.reason}`, null);
    }
    this.deps.remember?.({
      agent: agent.name,
      type: "quota-drain",
      summary:
        `${agent.name} is retained because every provider ran out of usage (${drain.reason}). ` +
        `Work remains on branch ${agent.branch ?? "(none)"} from task: ${agent.taskDescription}. ` +
        "Resume it when any provider's usage returns.",
    });
    await this.deps.requestReplacement(agent, drain);
  }

  private async hold(
    agent: AgentRecord,
    reason: string,
    resetsAt: string | null,
  ): Promise<boolean> {
    const run = this.deps.db.getActiveProviderRunForAgent(agent.id);
    if (run === null || !(await this.deps.pauseProvider(agent, run)))
      return false;
    this.deps.db.upsertAgent({
      ...agent,
      status: "held",
      holdReason: reason,
      holdResetAt: resetsAt,
      holdProviderRunId: run.runId,
    });
    return true;
  }

  private async resumeHeld(agent: AgentRecord, now: Date): Promise<void> {
    const quota = this.deps.quota!;
    await quota.refreshFromProviders(undefined, { providers: [agent.tool] });
    const current = this.deps.db.getAgentById(agent.id);
    if (current?.status !== "held") return;
    const model = current.executionIdentity?.model ?? current.model;
    if (quota.drainFor({ tool: current.tool, model }, now) !== null) return;
    const run = this.deps.db.getActiveProviderRunForAgent(current.id);
    if (
      run === null ||
      current.holdProviderRunId !== run.runId ||
      current.capabilityEpoch !== run.capabilityEpoch ||
      // Two overlapping sweeps may both reach SIGCONT. Repeating SIGCONT on
      // this already verified group is harmless; the durable delivery key
      // below is the once-only boundary for the provider wake.
      !(await this.deps.resumeProvider(current, run))
    ) {
      return;
    }
    await this.deps.send(
      "hive-quota",
      current.name,
      `Your provider's quota window has reset (${current.holdReason ?? "usage restored"}). Continue your task.`,
      {
        idempotencyKey: `quota-resume:${current.id}:${run.runId}:${current.holdResetAt}`,
      },
    );
    this.deps.db.upsertAgent({
      ...current,
      status: "idle",
      holdReason: null,
      holdResetAt: null,
      holdProviderRunId: null,
    });
  }

  private async deferReplacement(
    agent: AgentRecord,
    drain: ReplacementDrain,
  ): Promise<void> {
    if (!isTerminal(agent)) await this.hold(agent, drain.reason, null);
    await this.deps.requestReplacement(agent, drain);
  }
}
