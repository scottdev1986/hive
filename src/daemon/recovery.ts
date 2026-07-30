import { existsSync } from "node:fs";
import {
  discoverClaudeRecoverySessionId,
  resolveWorkingClaudeExecutable,
} from "../adapters/providers/claude-cli";
import { discoverCodexRecoverySessionId } from "../adapters/providers/codex-cli";
import { discoverGrokRecoverySessionId } from "../adapters/providers/grok-cli";
import { discoverKimiRecoverySessionId } from "../adapters/providers/kimi-cli";
import {
  type AgentRecord,
  type ExecutionIdentity,
  ORCHESTRATOR_NAME,
} from "../schemas";
import type { AuthorizedLaunch } from "./authorized-launch";
import type { HiveDatabase } from "./db";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  sessiondAgentProviderRunIsDead,
} from "./session-host/hive-terminal-host";
import type { HiveTerminalTerminationAudit } from "./session-host/terminal-host-binding";
import type { StopAgentSession } from "./teardown";
import { readCodexTelemetry } from "./tool-telemetry";

export type RecoveryOutcome =
  | { agent: string; action: "marked-dead"; reason: string }
  | { agent: string; action: "skipped"; reason: string };

export type SessionResolver = (
  worktreePath: string,
  agentCreatedAt: string,
) => Promise<string | null>;

type RecoveryStore = Pick<
  HiveDatabase,
  | "listAgents"
  | "getAgentByName"
  | "getAgentById"
  | "upsertAgent"
  | "markAgentDead"
  | "isAgentNameReserved"
  | "getUndeliveredMessages"
  | "markMessageAlerted"
  | "listApprovals"
  | "resolveApproval"
  | "getMessage"
  | "getTerminalHostBindingByLocator"
>;

type Sleep = (milliseconds: number) => Promise<void>;

export interface CrashRecoveryDependencies {
  db: RecoveryStore;
  terminalHost?: Pick<
    HiveTerminalHostAdapter,
    "inspect" | "reconcileProviderRun" | "terminate"
  >;
  /** Resolved lazily because a daemon configured with port 0 learns its
   * ephemeral listening port only after Bun.serve() binds. */
  port: number | (() => number);
  send: (
    from: string,
    to: string,
    body: string,
    options?: { idempotencyKey?: string },
  ) => Promise<unknown>;
  settleQuota: (agent: AgentRecord) => Promise<void>;
  stopSession?: StopAgentSession;
  createRecoverySession?: (
    agent: AgentRecord,
    command: string,
    expectedExecutable: string,
    launchGrantId: string,
    providerRunId: string,
  ) => Promise<void>;
  /** Missing or unreadable policy refuses resume. */
  authorizeLaunch?: (
    identity: ExecutionIdentity,
    category: AgentRecord["category"],
  ) => Promise<AuthorizedLaunch | null>;
  flushQueued: (agentName: string) => Promise<unknown>;
  /** Revokes the dead agent's capability subject and deletes its credential
   * file — the same guarantee hive_kill and hive_mark_dead give, so a
   * capability can never outlive its agent through the recovery death path. */
  revokeCapabilities?: (agentName: string) => void;
  resolveClaudeSessionId?: SessionResolver;
  resolveCodexSessionId?: SessionResolver;
  resolveGrokSessionId?: SessionResolver;
  resolveKimiSessionId?: SessionResolver;
  resolveOpencodeSessionId?: SessionResolver;
  worktreeExists?: (path: string) => boolean;
  sleep?: Sleep;
  /** Whether a subject's credential authenticated against the daemon's /mcp
   * at or after a launch baseline. Without this check, reachability is unknown. */
  mcpClientSeen?: (subject: string, since: string) => boolean;
  /** Test seam to collapse the reachability wait's deadline. */
  mcpReportingTimeoutMs?: number;
  claudeExecutable?: string;
  codexExecutable?: string;
  grokExecutable?: string;
  kimiExecutable?: string;
  opencodeExecutable?: string;
  /** Test seam for codex rollout activity during the resume watch. Native
   * SessionStart is the primary signal; a fresh rollout mtime remains an
   * independent fallback when hooks are disabled by policy or fail. Defaults
   * to `readCodexTelemetry`. */
  readCodexActivity?: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
  /** Test seam for the process table the resume watch reads to decide whether a
   * pane redraw belongs to the relaunched agent or to its wrapper. Defaults to
   * the real `ps`. */
  ps?: () => Promise<string>;
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const LIVE_STATUSES: AgentRecord["status"][] = [
  "working",
  "idle",
  "awaiting-approval",
  "stuck",
];

function boundedTask(task: string, limit = 500): string {
  return task.length <= limit ? task : `${task.slice(0, limit)}…`;
}

export class CrashRecovery {
  private readonly worktreeExists: (path: string) => boolean;
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly grokExecutable: string;
  private readonly kimiExecutable: string;
  private readonly opencodeExecutable: string;
  private readonly readCodexActivity: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
  // Agents with a recovery already in flight. The sweep (maintenance tick,
  // startup) and manual recovery (hive_recover) share no other interlock, and
  // resume awaits across its hasSession check — without this, both paths see
  // "no session", both bump recoveryAttempts, and both launch a session
  // for the same conversation.
  private readonly recovering = new Set<string>();
  // Agents a deliberate kill is tearing down right now. killAgentTeardown
  // destroys the process before it writes the dead status, so the row can match
  // the crash predicate during that window. The marker is set
  // before the first destructive step and cleared only after the dead status
  // lands; if the teardown fails in between it stays set, because a
  // deliberately killed agent must never be resurrected by the sweep.
  private readonly deliberateKills = new Set<string>();

  constructor(private readonly deps: CrashRecoveryDependencies) {
    this.worktreeExists = deps.worktreeExists ?? existsSync;
    this.claudeExecutable =
      deps.claudeExecutable ?? resolveWorkingClaudeExecutable().path;
    this.codexExecutable = deps.codexExecutable ?? "codex";
    this.grokExecutable = deps.grokExecutable ?? "grok";
    this.kimiExecutable = deps.kimiExecutable ?? "kimi";
    this.opencodeExecutable = deps.opencodeExecutable ?? "opencode";
    this.readCodexActivity =
      deps.readCodexActivity ??
      (async (worktreePath, toolSessionId) =>
        (await readCodexTelemetry(worktreePath, toolSessionId)).lastActivityAt);
  }

  /** A kill teardown is starting for this agent: the sweep must not read the
   * teardown window as a crash. Called BEFORE the first destructive step. */
  noteDeliberateKill(agentId: string): void {
    this.deliberateKills.add(agentId);
  }

  /** The kill teardown wrote the dead status; the durable row now says what
   * happened and the marker is no longer needed. */
  clearDeliberateKill(agentId: string): void {
    this.deliberateKills.delete(agentId);
  }

  /** The durable half of the same consult: a sessiond session that was
   * torn down through the one kill path carries a termination audit on its
   * terminal-host binding. Recovery reads it before calling a death a crash —
   * this is what survives a daemon restart mid-teardown.
   *
   * Only an *operator* audit is deliberate. A `visibility-expiry` audit records
   * infrastructure protecting the visibility invariant — nobody asked for that
   * agent to stop — so it must not suppress recovery. Absent origin means
   * `operator` for compatibility. */
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

  // The maintenance sweep: classify every agent whose terminal session is gone
  // and either resume its actual tool conversation or mark it dead with the
  // stranded state surfaced. Runs at daemon startup — the recovery moment
  // after a machine-wide crash — and on the periodic reconciliation tick.
  async sweep(): Promise<RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    for (const candidate of this.deps.db.listAgents()) {
      const agent = candidate;
      const isSpawning = agent.status === "spawning";
      if (
        !isSpawning &&
        !LIVE_STATUSES.includes(agent.status) &&
        agent.status !== "control-paused"
      ) {
        continue;
      }
      // A reservation marks a spawn in flight inside this daemon process;
      // its monitored launch owns the outcome. Stranded reservations from a
      // crashed daemon were cleared at startup, so anything still reserved
      // is genuinely in flight.
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
      // A deliberate kill must never be classified as a crash. The
      // in-memory marker covers the live teardown window; the binding's
      // termination audit covers a teardown the daemon did not survive.
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
          await this.markDead(
            agent,
            `audited termination (${terminationAudit.reason}); reconciled as a deliberate kill`,
            { deliberate: true },
          ),
        );
        continue;
      }
      if (
        agent.writeRevoked &&
        agent.controlMessageId !== undefined &&
        this.deps.db.getMessage(agent.controlMessageId)?.state === "queued"
      ) {
        // A quota- or identity-blocked critical control remains durable and
        // retryable. Never convert that fail-closed state into ordinary
        // death, and never resume around a revocation.
        continue;
      }
      if (
        agent.status === "control-paused" ||
        (agent.writeRevoked && agent.controlMessageId !== undefined)
      ) {
        // Control machinery owns revoked agents; a vanished acknowledgement
        // process is ordinary death, not resumable work.
        outcomes.push(
          await this.markDead(agent, "terminal session missing (reconciled)"),
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
        // The agent died before its tool session produced anything worth
        // resuming; the orchestrator respawns from the stored task instead.
        outcomes.push(
          await this.markDead(
            agent,
            "process died during spawn (crash recovery)",
          ),
        );
        continue;
      }
      outcomes.push(await this.recoverOne(agent, { manual: false }));
    }
    return outcomes;
  }

  // Manual per-agent recovery (`hive recover maya` / hive_recover): also
  // accepts agents already marked dead or failed — the "bring her back" path
  // after a sweep or an operator gave up — and bypasses the attempt cap,
  // because a human explicitly asked for one more try.
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
    // A terminal is alive or it is dead. There is no third state to restore it
    // to, so recovery observes and records what it saw. Do not relaunch the
    // conversation: replacing its generation can kill a healthy agent.
    if (await this.sessionPresent(agent)) {
      return {
        agent: agent.name,
        action: "skipped",
        reason: this.runningSessionReason(agent),
      };
    }
    return this.markDead(agent, "its terminal is gone");
  }

  private async markDead(
    agent: AgentRecord,
    reason: string,
    options: { deliberate?: boolean } = {},
  ): Promise<RecoveryOutcome> {
    const now = new Date().toISOString();
    this.deps.db.markAgentDead(agent.id, now, reason);
    this.deps.revokeCapabilities?.(agent.name);
    await this.deps.settleQuota(agent);
    this.denyPendingApprovals(agent.name);
    // Queued traffic to a dead agent can never inject; flag it once so
    // deadline alarms stop firing and the orchestrator alert names it.
    const stranded = this.deps.db.getUndeliveredMessages(agent.name);
    for (const message of stranded) {
      this.deps.db.markMessageAlerted(message.id, now);
    }
    const strandedNote =
      stranded.length === 0
        ? ""
        : ` ${stranded.length} queued message(s) were flagged undeliverable.`;
    const worktreeNote =
      agent.worktreePath === null
        ? "No worktree was recorded."
        : `Worktree preserved at ${agent.worktreePath}` +
          (agent.branch === null ? "." : ` (branch ${agent.branch}).`);
    // An audited kill is not a crash and must not be reported as one:
    // the closure is finished on the killer's behalf and said plainly.
    const headline =
      options.deliberate === true
        ? `${agent.name} was killed deliberately and its record has been reconciled without a resume: ${reason}.`
        : `${agent.name} died in a crash and could not be resumed: ${reason}.`;
    await this.deps
      .send(
        "hive-recovery",
        ORCHESTRATOR_NAME,
        `${headline} ` +
          `${worktreeNote}${strandedNote} Respawn with hive_spawn if the work ` +
          `should continue. Stored task: ${boundedTask(agent.taskDescription)}`,
        { idempotencyKey: `crash-dead:${agent.id}:${agent.lastEventAt}` },
      )
      .catch(() => undefined);
    return { agent: agent.name, action: "marked-dead", reason };
  }

  private denyPendingApprovals(agentName: string): void {
    const now = new Date().toISOString();
    for (const approval of this.deps.db.listApprovals("pending")) {
      if (approval.agentName === agentName) {
        this.deps.db.resolveApproval(approval.id, "denied", now);
      }
    }
  }
}
