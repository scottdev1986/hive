import {
  CAPABILITY_PROVIDERS,
  type AgentRecord,
  type CapabilityProvider,
  isTerminalAgentStatus,
} from "../schemas";
import type { SpawnRequest } from "./spawner";
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
 * - HANDOFF (§R5): the reset is further out, or unknowable. The agent is
 *   closed through the normal teardown (which preserves its branch as a
 *   ref), and a replacement spawns through the normal spawn path with the
 *   branch named in its brief.
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
  send: (from: string, to: string, body: string) => Promise<unknown>;
  /** killAgentTeardown: closes the agent and preserves unlanded work. */
  closeAgent: (
    agent: AgentRecord,
    reason: string,
  ) => Promise<{ preserved: { branch: string; ref: string } | null }>;
  spawn: (request: SpawnRequest) => Promise<AgentRecord>;
  /** EpisodicStore.appendEvent — the all-drained memory. */
  remember?: (event: { agent: string | null; type: string; summary: string }) => void;
  clock?: () => Date;
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
   * is meaningless for a corpse, so the decision is handoff or
   * preserve+memory. */
  async onVendorError(agent: AgentRecord, failure: string): Promise<void> {
    this.drainErrors.set(agent.tool, new Date(this.clock()).toISOString());
    if (this.allDrained()) {
      await this.allDrainedArm(agent, `a ${agent.tool} rate-limit error`);
    } else {
      await this.handoff(agent, `a ${agent.tool} rate-limit error`);
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
          // §R4: the window has reset — the agent will not continue on its
          // own, so it is told, through the same envelope recovery uses.
          this.deps.db.upsertAgent({
            ...agent,
            status: "idle",
            holdReason: null,
            holdResetAt: null,
          });
          await this.deps.send(
            "hive-quota",
            agent.name,
            `Your provider's quota window has reset (${agent.holdReason ?? "usage restored"}). Continue your task.`,
          ).catch(() => undefined);
        }
        continue;
      }
      if (agent.name === "queen") continue;
      if (
        agent.status !== "working" &&
        agent.status !== "idle" &&
        agent.status !== "awaiting-approval"
      ) continue;
      const identity = agent.executionIdentity;
      const model = identity?.model ?? agent.model;
      const drained = quota.drainFor({ tool: agent.tool, model }, now);
      if (drained === null) continue;
      const reason =
        `${agent.tool}'s ${drained.pool} ${drained.window} window is spent` +
        (drained.resetsAt === null
          ? " and the provider does not say when it resets"
          : ` until ${drained.resetsAt}`);
      if (
        drained.resetsAt !== null &&
        new Date(drained.resetsAt).getTime() - now.getTime() <= HOLD_WINDOW_MS
      ) {
        // §R4: a reset within the hour is a hold, never a handoff.
        this.deps.db.upsertAgent({
          ...agent,
          status: "held",
          holdReason: reason,
          holdResetAt: drained.resetsAt,
        });
        continue;
      }
      await this.handle(agent, reason, drained.resetsAt);
    }
  }

  /** The arm decision shared by the sweep and the vendor-error path. */
  private async handle(
    agent: AgentRecord,
    reason: string,
    resetsAt: string | null = null,
  ): Promise<void> {
    const quota = this.deps.quota;
    if (quota === undefined || agent.status === "held") return;
    if (this.allDrained()) {
      await this.allDrainedArm(agent, reason);
      return;
    }
    await this.handoff(agent, reason);
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
  private async allDrainedArm(agent: AgentRecord, reason: string): Promise<void> {
    const quota = this.deps.quota!;
    const now = this.clock();
    const nearest = quota.nearestDrainResets(now);
    const waitFor = nearest.fiveHour ??
      (nearest.weekly !== null &&
        new Date(nearest.weekly).getTime() - now.getTime() <=
          ALL_DRAINED_WEEKLY_WAIT_MS
        ? nearest.weekly
        : null);
    if (waitFor !== null && agent.status !== "held" && !isTerminal(agent)) {
      this.deps.db.upsertAgent({
        ...agent,
        status: "held",
        holdReason:
          `every provider is out of usage (${reason}); nearest window resets ${waitFor}`,
        holdResetAt: waitFor,
      });
      return;
    }
    // Further than any honest wait (or the agent is already down): preserve
    // the branch and write the memory that lets work resume when
    // availability returns.
    const preserved = isTerminal(agent)
      ? null
      : await this.deps.closeAgent(agent, `all providers drained: ${reason}`);
    const branch = preserved?.preserved?.branch ?? agent.branch;
    this.deps.remember?.({
      agent: agent.name,
      type: "quota-drain",
      summary:
        `${agent.name} was closed because every provider ran out of usage (${reason}). ` +
        `Work is preserved on branch ${branch ?? "(none)"} from task: ${agent.taskDescription}. ` +
        "Resume it when any provider's usage returns.",
    });
  }

  /** §R5: close through the normal teardown and respawn the work elsewhere. */
  private async handoff(agent: AgentRecord, reason: string): Promise<void> {
    const quota = this.deps.quota!;
    const now = this.clock();
    const provider = this.pickHandoffProvider(agent.tool, now);
    const preserved = isTerminal(agent)
      ? null
      : await this.deps.closeAgent(agent, `quota drain: ${reason}`);
    const branch = preserved?.preserved?.branch ?? agent.branch;
    const request: SpawnRequest = {
      task:
        `${agent.taskDescription}\n\n` +
        `This continues ${agent.name}'s work after ${agent.tool} ran out of usage (${reason}). ` +
        (branch === null || branch === undefined
          ? "There is no preserved branch; start from the task text."
          : `The work so far is preserved on branch ${branch} — continue it, do not start over.`),
      category: agent.category,
      ...(provider === undefined ? {} : { tool: provider }),
      ...(agent.readOnly ? { readOnly: true } : {}),
    };
    await this.deps.spawn(request);
  }

  /** Any provider that can take the work: the first non-drained metered one,
   * else an unmetered route that has not errored. */
  private pickHandoffProvider(
    drainedTool: CapabilityProvider,
    now: Date,
  ): CapabilityProvider | undefined {
    const quota = this.deps.quota!;
    for (const provider of CAPABILITY_PROVIDERS) {
      if (provider === drainedTool || !quota.isMetered(provider)) continue;
      if (quota.drainFor({ tool: provider, model: "*" }, now) === null) {
        return provider;
      }
    }
    for (const provider of CAPABILITY_PROVIDERS) {
      if (provider === drainedTool || quota.isMetered(provider)) continue;
      if (!this.drainErrors.has(provider)) return provider;
    }
    return undefined;
  }
}
