import type { SystemMailPublish } from "../../mail-service/service";
import { type AgentRecord, isTerminalAgentStatus } from "../../schemas/agent";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../../schemas/capability";
import type { ProviderRun } from "../../schemas/provider-run";
import type { QuotaService } from "../../usage-service/usage-quota";
import { systemClock } from "../../shared/clock";
import type { HiveDatabase } from "../database/hive-database";

const isTerminal = (agent: AgentRecord): boolean =>
  agent.status === "held" || isTerminalAgentStatus(agent.status);

/** The drain handler: a mid-work agent whose provider's usage is spent is handled by exactly one of three arms: - HOLD: the drained window resets within the hour. The agent is marked `held`; the daemon's 30-second maintenance sweep pokes it with a continue message once the reset has passed. No new timers. - REPLACEMENT: the source run is frozen and retained, then the replacement seam is reported; the handoff and replacement itself are owned outside this handler. - ALL-DRAINED: no provider has usage — every metered pool is spent AND every unmetered route has errored. Wait for the nearest 5-hour reset, or the 7-day reset if it lands within 5 hours; otherwise the branch is preserved and a memory written so work resumes when availability returns. Unmetered providers (opencode today) are never held — there is no reset to wait for — and their drain is known only through a vendor rate-limit error, classified by `classifyVendorDrainError`. */

const HOLD_WINDOW_MS = 60 * 60_000;
const ALL_DRAINED_WEEKLY_WAIT_MS = 5 * 60 * 60_000;

/** Vendor rate-limit/billing errors that mean DRAIN, not crash. Deliberately small: anything this cannot name stays a crash and feeds the launch-failure quarantine instead. */
const VENDOR_DRAIN_PATTERNS: Record<CapabilityProvider, readonly RegExp[]> = {
  claude: [/rate.?limit/i, /\b429\b/, /credit balance/i, /usage (limit|cap)/i],
  // Codex surfaces "Rate limit reached" and usage-limit errors verbatim.
  codex: [/rate.?limit/i, /\b429\b/, /usage.?limit/i, /quota/i],
  grok: [/rate.?limit/i, /\b429\b/, /quota/i],
  kimi: [/rate.?limit/i, /rate_limit/, /\b429\b/, /quota/i],
  opencode: [/rate.?limit/i, /\b429\b/, /quota/i],
};

/** Is this failure text the vendor saying "out of usage" — honestly, or not at all? Unknown error shapes are crashes, never drains. */
export function classifyVendorDrainError(
  tool: CapabilityProvider,
  failure: string,
): boolean {
  return VENDOR_DRAIN_PATTERNS[tool].some((pattern) => pattern.test(failure));
}

export interface DrainHandlerDependencies {
  db: HiveDatabase;
  quota: QuotaService | undefined;
  publish: SystemMailPublish;
  pauseProvider: (agent: AgentRecord, run: ProviderRun) => Promise<boolean>;
  resumeProvider: (agent: AgentRecord, run: ProviderRun) => Promise<boolean>;
  requestReplacement: (
    agent: AgentRecord,
    drain: ReplacementDrain,
  ) => Promise<void>;
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
    this.clock = deps.clock ?? systemClock;
  }

  noteProviderAlive(provider: CapabilityProvider): void {
    this.drainErrors.delete(provider);
  }

  /** A spawn or turn failed with a vendor rate-limit error. Routes here INSTEAD of the launch-failure quarantine: the route is not broken, the meter is empty. The agent is already terminal at this point — a hold is meaningless for a corpse, so this reports the replacement seam without destroying its terminal or worktree. */
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
    await this.sweep();
  }

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
        // A reset within the hour is a hold, never a handoff.
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

  /** Wait for the nearest reset, or preserve and remember. */
  private async allDrainedArm(
    agent: AgentRecord,
    drain: ReplacementDrain,
  ): Promise<void> {
    const quota = this.deps.quota;
    if (quota === undefined) return;
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

  /** A hold is a wait: it exists only for a reset the sweep can poke the agent past, so `resetsAt` is required and never invented. */
  private async hold(
    agent: AgentRecord,
    reason: string,
    resetsAt: string,
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
    const quota = this.deps.quota;
    if (quota === undefined) return;
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
      !(await this.deps.resumeProvider(current, run))
    ) {
      return;
    }
    await this.deps.publish(
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

  /** The replacement seam owns freezing the source: it fences the epoch, pauses the run, persists the handoff, and leaves the agent in a state the daemon reports. A hold here would say "waiting for a reset" about an agent with no reset to wait for, and the sweep's resume can never act on that. */
  private async deferReplacement(
    agent: AgentRecord,
    drain: ReplacementDrain,
  ): Promise<void> {
    await this.deps.requestReplacement(agent, drain);
  }
}
