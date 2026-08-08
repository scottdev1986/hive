import { type AgentRecord, ORCHESTRATOR_NAME } from "../../schemas/agent";
import type { HiveDatabase } from "../database/hive-database";
import type { SystemMailPublish } from "../../mail-service/service";
import type { MailStore } from "../../mail-service/store";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  sessiondAgentProviderRunIsDead,
} from "../session-host/hive-terminal-host";
import type { HiveTerminalTerminationAudit } from "../session-host/terminal-host-binding";

export type RecoveryOutcome =
  | { agent: string; action: "reported"; reason: string }
  | { agent: string; action: "skipped"; reason: string };

type RecoveryStore = Pick<
  HiveDatabase,
  | "listAgents"
  | "getAgentByName"
  | "getAgentById"
  | "upsertAgent"
  | "isAgentNameReserved"
  | "getTerminalHostBindingByLocator"
>;

export interface CrashRecoveryDependencies {
  db: RecoveryStore;
  terminalHost?: Pick<
    HiveTerminalHostAdapter,
    "inspect" | "reconcileProviderRun" | "terminate"
  >;
  publish: SystemMailPublish;
  mail: Pick<MailStore, "getItem" | "unsettledMailCount">;
}

const AUTOMATIC_RECOVERY_STATUSES: AgentRecord["status"][] = [
  "spawning",
  "working",
  "idle",
  "awaiting-approval",
  "control-paused",
  "stuck",
];

function boundedTask(task: string, limit = 500): string {
  return task.length <= limit ? task : `${task.slice(0, limit)}…`;
}

export class CrashRecovery {
  // The maintenance sweep and manual recovery share no other interlock. Without this set, both paths can observe the same missing session and report it twice.
  private readonly recovering = new Set<string>();
  // Agents a deliberate kill is tearing down right now. killAgentTeardown destroys the process before it writes the dead status, so the row can match the crash predicate during that window. The marker is set before the first destructive step and cleared only after the dead status lands; if the teardown fails in between it stays set, because a deliberately killed agent must never be resurrected by the sweep.
  private readonly deliberateKills = new Set<string>();

  constructor(private readonly deps: CrashRecoveryDependencies) {}

  /** A kill teardown is starting for this agent: the sweep must not read the teardown window as a crash. Called BEFORE the first destructive step. */
  noteDeliberateKill(agentId: string): void {
    this.deliberateKills.add(agentId);
  }

  /** The kill teardown wrote the dead status; the durable row now says what happened and the marker is no longer needed. */
  clearDeliberateKill(agentId: string): void {
    this.deliberateKills.delete(agentId);
  }

  /** The durable half of the same consult: a sessiond session that was torn down through the one kill path carries a termination audit on its terminal-host binding. Recovery reads it before calling a death a crash — this is what survives a daemon restart mid-teardown. Only an *user* audit is deliberate. A `visibility-expiry` audit records infrastructure protecting the visibility invariant — nobody asked for that agent to stop — so it must not suppress recovery. Absent origin means `user` for compatibility. */
  private deliberateTerminationAudit(
    agent: AgentRecord,
  ): HiveTerminalTerminationAudit | null {
    const binding = this.deps.db.getTerminalHostBindingByLocator(
      requireSessiondAgentLocator(agent),
    );
    const audit = binding?.terminationAudit ?? null;
    if (audit?.origin === "visibility-expiry") return null;
    return audit;
  }

  private async sessionContainerPresent(agent: AgentRecord): Promise<boolean> {
    if (this.deps.terminalHost === undefined) {
      throw new Error("session recovery inspection is not configured");
    }
    const locator = requireSessiondAgentLocator(agent);
    const activeRun = this.deps.terminalHost.reconcileProviderRun(locator);
    const inspection = await this.deps.terminalHost.inspect(locator);
    if (sessiondAgentProviderRunIsDead(inspection, activeRun)) return false;
    switch (inspection.presence) {
      case "present":
        return true;
      case "exited":
      case "lost":
        return false;
      case "unknown":
        throw new Error(`Session presence is unknown for ${agent.name}`);
    }
  }

  private async sessionPresent(agent: AgentRecord): Promise<boolean> {
    return this.sessionContainerPresent(agent);
  }

  private runningSessionReason(_agent: AgentRecord): string {
    return "terminal host reports the session is running";
  }

  // The maintenance sweep: classify every agent whose terminal session is gone and report the evidence to the orchestrator, which decides whether to close or revive it. The sweep itself never writes a row, revokes a capability, or touches a worktree. Runs at daemon startup — the recovery moment after a machine-wide crash — and on the periodic reconciliation tick.
  async sweep(): Promise<RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    for (const candidate of this.deps.db.listAgents()) {
      const agent = candidate;
      const isSpawning = agent.status === "spawning";
      if (!AUTOMATIC_RECOVERY_STATUSES.includes(agent.status)) {
        continue;
      }
      // A reservation marks a spawn in flight inside this daemon process; its monitored launch owns the outcome. Stranded reservations from a crashed daemon were cleared at startup, so anything still reserved is genuinely in flight.
      if (isSpawning && this.deps.db.isAgentNameReserved(agent.name)) {
        continue;
      }
      let sessionPresent: boolean;
      try {
        sessionPresent = await this.sessionPresent(agent);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith("Agent process presence is unknown for ")
        ) {
          throw error;
        }
        outcomes.push({
          agent: agent.name,
          action: "skipped",
          reason: "agent process presence is unknown",
        });
        continue;
      }
      if (sessionPresent) {
        continue;
      }
      // A deliberate kill must never be classified as a crash. The in-memory marker covers the live teardown window; the binding's termination audit covers a teardown the daemon did not survive.
      if (this.deliberateKills.has(agent.id)) {
        outcomes.push({
          agent: agent.name,
          action: "skipped",
          reason: "deliberate kill in progress; teardown owns the outcome",
        });
        continue;
      }
      const terminationAudit = this.deliberateTerminationAudit(agent);
      if (terminationAudit !== null) {
        outcomes.push(
          await this.reportDeathEvidence(
            agent,
            `its terminal session is gone and its terminal-host binding carries a termination audit (${terminationAudit.reason})`,
            { deliberate: true },
          ),
        );
        continue;
      }
      if (
        agent.writeRevoked &&
        agent.controlMessageId !== undefined &&
        this.deps.mail.getItem(agent.controlMessageId) !== null
      ) {
        // A quota- or identity-blocked critical control remains durable and retryable. Never convert that fail-closed state into ordinary death, and never resume around a revocation.
        continue;
      }
      if (
        agent.status === "control-paused" ||
        (agent.writeRevoked && agent.controlMessageId !== undefined)
      ) {
        outcomes.push(
          await this.reportDeathEvidence(
            agent,
            "its terminal session is gone while its write authority was revoked",
          ),
        );
        continue;
      }
      if (agent.writeRevoked) {
        outcomes.push({
          agent: agent.name,
          action: "skipped",
          reason:
            "write authority is revoked; recovery requires explicit cleanup",
        });
        continue;
      }
      if (isSpawning) {
        outcomes.push(
          await this.reportDeathEvidence(
            agent,
            "its terminal session is gone and the spawn never completed",
          ),
        );
        continue;
      }
      outcomes.push(await this.recoverOne(agent, { manual: false }));
    }
    return outcomes;
  }

  async recoverAgent(name: string): Promise<RecoveryOutcome> {
    const found = this.deps.db.getAgentByName(name);
    if (found === null) {
      throw new Error(`Hive agent not found: ${name}`);
    }
    const agent = found;
    if (agent.status === "done") {
      return { agent: name, action: "skipped", reason: "agent is done" };
    }
    if (
      agent.status === "control-paused" ||
      (agent.writeRevoked && agent.controlMessageId !== undefined)
    ) {
      return {
        agent: name,
        action: "skipped",
        reason: "write authority is revoked; control recovery owns this agent",
      };
    }
    if (agent.writeRevoked) {
      return {
        agent: name,
        action: "skipped",
        reason:
          "write authority is revoked; recovery requires explicit cleanup",
      };
    }
    if (await this.sessionPresent(agent)) {
      return {
        agent: name,
        action: "skipped",
        reason: this.runningSessionReason(agent),
      };
    }
    return this.recoverOne(agent, { manual: true });
  }

  private async recoverOne(
    agent: AgentRecord,
    options: { manual: boolean },
  ): Promise<RecoveryOutcome> {
    if (this.recovering.has(agent.id)) {
      return {
        agent: agent.name,
        action: "skipped",
        reason: "a recovery for this agent is already in flight",
      };
    }
    this.recovering.add(agent.id);
    try {
      return await this.recoverOneExclusive(agent, options);
    } finally {
      this.recovering.delete(agent.id);
    }
  }

  private async recoverOneExclusive(
    agent: AgentRecord,
    _options: { manual: boolean },
  ): Promise<RecoveryOutcome> {
    // A terminal is alive or it is dead. There is no third state to restore it to, so recovery observes and records what it saw. Do not relaunch the conversation: replacing its generation can kill a healthy agent.
    if (await this.sessionPresent(agent)) {
      return {
        agent: agent.name,
        action: "skipped",
        reason: this.runningSessionReason(agent),
      };
    }
    return this.reportDeathEvidence(agent, "its terminal is gone");
  }

  /** Hands the owner the positive evidence and the two dispositions, and changes nothing itself. The evidence is always something observed to be gone — a terminal session, a provider run — never an absent heartbeat: a clock that has stopped ticking is a report about instrumentation, not about an agent. Closure (row, capabilities, quota, approvals) belongs to the owner-commanded kill path alone. */
  private async reportDeathEvidence(
    agent: AgentRecord,
    evidence: string,
    options: { deliberate?: boolean } = {},
  ): Promise<RecoveryOutcome> {
    // Mail addressed to an agent that cannot answer has nobody left to settle it; the count tells the owner how much closing this agent strands.
    const strandedMail = this.deps.mail.unsettledMailCount(agent.name);
    const strandedNote =
      strandedMail === 0
        ? ""
        : ` ${strandedMail} unsettled message(s) remain in its mailbox.`;
    const worktreeNote =
      agent.worktreePath === null
        ? "No worktree was recorded."
        : `Worktree untouched at ${agent.worktreePath}` +
          (agent.branch === null ? "." : ` (branch ${agent.branch}).`);
    // An audited kill is not a crash and must not be reported as one: the owner already commanded this death and only needs the record closed.
    const headline =
      options.deliberate === true
        ? `${agent.name} looks dead after a deliberate kill: ${evidence}.`
        : `${agent.name} looks dead: ${evidence}.`;
    await this.deps
      .publish(
        "hive-lifecycle",
        ORCHESTRATOR_NAME,
        `${headline} Its record is unchanged — nothing was closed, revoked, or ` +
          `deleted. ${worktreeNote}${strandedNote} Close it with ` +
          `hive_mark_dead agent=${agent.name} (or hive_kill name=${agent.name}). ` +
          `Stored task: ${boundedTask(agent.taskDescription)}`,
        { idempotencyKey: `death-evidence:${agent.id}` },
      )
      .catch(() => undefined);
    return { agent: agent.name, action: "reported", reason: evidence };
  }
}
