import { existsSync } from "node:fs";
import {
  type AuthorizedLaunch,
  requireAuthorizedLaunch,
} from "./authorized-launch";
import {
  buildClaudeResumeCommand,
  discoverClaudeRecoverySessionId,
  resolveWorkingClaudeExecutable,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  buildCodexResumeCommand,
  discoverCodexRecoverySessionId,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import {
  buildGrokResumeCommand,
  discoverGrokRecoverySessionId,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
} from "../adapters/tools/grok";
import {
  ORCHESTRATOR_NAME,
  CapabilityProviderSchema,
  unknownVendor,
  type AgentRecord,
  type ExecutionIdentity,
  type HiveConfig,
} from "../schemas";
import type { HiveDatabase } from "./db";
import type { StopAgentSession } from "./teardown";
import { readCodexTelemetry } from "./tool-telemetry";
import {
  parseProcessTable,
  runPs,
  treeRunsCommand,
} from "./resources";
import { LAUNCH_FAILURE_PATTERNS, watchForProofOfLife } from "./readiness";
import { hiveCliSpawnArgv } from "./lifecycle";
import { IS_RELEASE_BUILD } from "../version";
import {
  bindAgentSession,
  mintAgentTmuxSessionLocator,
  nextAgentSessionLocator,
  shellJoin,
  tmuxSessionSpec,
  TmuxSessionHost,
  type TmuxEngine,
} from "./session-host/tmux-host";
import {
  requireSessiondAgentLocator,
  sessiondVendorProcessIsDead,
  type HiveTerminalHostAdapter,
} from "./session-host/hive-terminal-host";
import type { HiveTerminalTerminationAudit } from "./session-host/terminal-host-binding";

// Three auto-resumes for one agent means the process is dying on its own,
// not being killed by crashes; after that the sweep stops retrying and
// surfaces the agent for an explicit decision.
export const MAX_AUTO_RESUME_ATTEMPTS = 3;

// A resume can fail in one way a spawn cannot: the conversation it was told to
// restore is gone. Everything else a launch can do wrong is already covered.
const RESUME_FAILURE_PATTERNS = [
  ...LAUNCH_FAILURE_PATTERNS,
  /No conversation found/i,
];

export type RecoveryOutcome =
  | { agent: string; action: "resumed"; sessionId: string }
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
  /** Legacy-only host. Production recovery is sessiond-only. */
  tmux?: TmuxSessionHost | TmuxEngine;
  terminalHost?: Pick<HiveTerminalHostAdapter, "inspect">;
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
  ) => Promise<void>;
  /** PR5 wires the policy-backed full gate. Missing/unreadable refuses resume. */
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
  worktreeExists?: (path: string) => boolean;
  sleep?: Sleep;
  claudeExecutable?: string;
  codexExecutable?: string;
  grokExecutable?: string;
  /** Config-writer seams so tests can resume into synthetic worktrees; the
   * defaults write the real per-worktree agent configs. A failed write fails
   * the resume — the spawn-time config may name a daemon port this restarted
   * daemon no longer holds. */
  seedClaudeTrust?: (worktreePath: string) => Promise<void>;
  writeClaudeConfig?: typeof writeClaudeAgentConfig;
  writeCodexConfig?: typeof writeCodexAgentConfig;
  writeGrokConfig?: typeof writeGrokAgentConfig;
  /** The current writer autonomy, read at resume time so a recovered agent
   * matches the setting the user can see in the Workspace menu — a thunk
   * because the user may flip the dial mid-session. Absent fails safe to the
   * sandboxed approval queue. */
  autonomy?: () => HiveConfig["autonomy"];
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
  /** Provider-process truth for legacy tmux sessions. Null is unmeasurable,
   * never a guess that a surviving wrapper is an agent. */
  processAlive?: (agent: AgentRecord) => Promise<boolean | null>;
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
  private readonly resolveClaude: SessionResolver;
  private readonly resolveCodex: SessionResolver;
  private readonly resolveGrok: SessionResolver;
  private readonly worktreeExists: (path: string) => boolean;
  private readonly wait: Sleep;
  private readonly claudeExecutable: string;
  private readonly codexExecutable: string;
  private readonly grokExecutable: string;
  private readonly seedClaudeTrust: (worktreePath: string) => Promise<void>;
  private readonly writeClaudeConfig: typeof writeClaudeAgentConfig;
  private readonly writeCodexConfig: typeof writeCodexAgentConfig;
  private readonly writeGrokConfig: typeof writeGrokAgentConfig;
  private readonly readCodexActivity: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
  // Agents with a recovery already in flight. The sweep (maintenance tick,
  // startup) and manual recovery (hive_recover) share no other interlock, and
  // resume awaits across its hasSession check — without this, both paths see
  // "no session", both bump recoveryAttempts, and both launch a tmux session
  // for the same conversation.
  private readonly recovering = new Set<string>();
  // Agents a deliberate kill is tearing down RIGHT NOW (#66). killAgentTeardown
  // destroys the process before it writes the dead status, so for 2.5-34s
  // (measured) the row reads live-status + session-absent — bit-for-bit the
  // crash predicate below. A sweep tick inside that window used to resume the
  // corpse (david, 2026-07-20, downgraded sessiond → tmux). The marker is set
  // before the first destructive step and cleared only after the dead status
  // lands; if the teardown fails in between it stays set, because a
  // deliberately killed agent must never be resurrected by the sweep.
  private readonly deliberateKills = new Set<string>();
  private readonly sessions: TmuxSessionHost | null;

  constructor(private readonly deps: CrashRecoveryDependencies) {
    this.sessions = deps.tmux === undefined
      ? null
      : deps.tmux instanceof TmuxSessionHost
      ? deps.tmux
      : new TmuxSessionHost({ adapter: deps.tmux });
    this.resolveClaude = deps.resolveClaudeSessionId ??
      ((worktreePath, agentCreatedAt) =>
        discoverClaudeRecoverySessionId(worktreePath, agentCreatedAt));
    this.resolveCodex = deps.resolveCodexSessionId ??
      ((worktreePath, agentCreatedAt) =>
        discoverCodexRecoverySessionId(worktreePath, agentCreatedAt));
    this.resolveGrok = deps.resolveGrokSessionId ??
      ((worktreePath, agentCreatedAt) =>
        discoverGrokRecoverySessionId(worktreePath, agentCreatedAt));
    this.worktreeExists = deps.worktreeExists ?? existsSync;
    this.wait = deps.sleep ?? defaultSleep;
    this.claudeExecutable = deps.claudeExecutable ?? resolveWorkingClaudeExecutable().path;
    this.codexExecutable = deps.codexExecutable ?? "codex";
    this.grokExecutable = deps.grokExecutable ?? "grok";
    this.seedClaudeTrust = deps.seedClaudeTrust ?? seedClaudeWorktreeTrust;
    this.writeClaudeConfig = deps.writeClaudeConfig ?? writeClaudeAgentConfig;
    this.writeCodexConfig = deps.writeCodexConfig ?? writeCodexAgentConfig;
    this.writeGrokConfig = deps.writeGrokConfig ?? writeGrokAgentConfig;
    this.readCodexActivity = deps.readCodexActivity ??
      (async (worktreePath, toolSessionId) =>
        (await readCodexTelemetry(worktreePath, toolSessionId)).lastActivityAt);
  }

  private requireLegacySessions(agent: AgentRecord): TmuxSessionHost {
    if (this.sessions === null) {
      throw new Error(
        `Agent ${agent.id} has a legacy tmux locator, but production recovery is sessiond-only`,
      );
    }
    return this.sessions;
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

  /** The durable half of the same consult (#66): a sessiond session that was
   * torn down through the one kill path carries a termination audit on its
   * terminal-host binding. Recovery reads it before calling a death a crash —
   * this is what survives a daemon restart mid-teardown.
   *
   * Only an *operator* audit is deliberate. A `visibility-expiry` audit records
   * infrastructure protecting the visibility invariant — nobody asked for that
   * agent to stop — so it must not suppress recovery: on 2026-07-21 the five
   * expired agents were resumed, and treating that kill as deliberate would
   * have made the incident strictly worse. Absent origin is `operator`, which
   * is every row written before the field existed. */
  private deliberateTerminationAudit(
    agent: AgentRecord,
  ): HiveTerminalTerminationAudit | null {
    if (agent.sessionLocator?.hostKind !== "sessiond") return null;
    const binding = this.deps.db.getTerminalHostBindingByLocator(
      requireSessiondAgentLocator(agent),
    );
    const audit = binding?.terminationAudit ?? null;
    if (audit?.origin === "visibility-expiry") return null;
    return audit;
  }

  private daemonPort(): number {
    const configured = this.deps.port;
    const port = typeof configured === "function" ? configured() : configured;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Hive daemon has no listening port (resolved ${port})`);
    }
    return port;
  }

  private migrateSessionLocator(agent: AgentRecord): AgentRecord {
    if (agent.sessionLocator !== undefined) return agent;
    return this.deps.db.upsertAgent({
      ...agent,
      sessionLocator: mintAgentTmuxSessionLocator(agent.id),
    });
  }

  private async sessionContainerPresent(agent: AgentRecord): Promise<boolean> {
    if (agent.sessionLocator?.hostKind === "sessiond") {
      if (this.deps.terminalHost === undefined) {
        throw new Error("sessiond recovery inspection is not configured");
      }
      const inspection = await this.deps.terminalHost.inspect(
        requireSessiondAgentLocator(agent),
      );
      if (sessiondVendorProcessIsDead(inspection)) return false;
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
    const sessions = this.requireLegacySessions(agent);
    const inspection = await sessions.inspect(
      bindAgentSession(sessions, agent),
    );
    if (inspection.presence === "unknown") {
      throw new Error(`Session presence is unknown for ${agent.name}`);
    }
    return inspection.presence === "present";
  }

  private async sessionPresent(agent: AgentRecord): Promise<boolean> {
    if (!await this.sessionContainerPresent(agent)) return false;
    // James's sessiond predicate above is the authoritative process reading.
    // Legacy tmux needs the separate provider-command measurement below.
    if (agent.sessionLocator?.hostKind === "sessiond" ||
      this.deps.processAlive === undefined) {
      return true;
    }
    const alive = await this.deps.processAlive(agent);
    if (alive === null) {
      throw new Error(`Agent process presence is unknown for ${agent.name}`);
    }
    return alive;
  }

  private runningSessionReason(agent: AgentRecord): string {
    return agent.sessionLocator?.hostKind === "sessiond"
      ? "sessiond host reports the session is running"
      : this.deps.processAlive === undefined
      ? "tmux session is running"
      : "agent process is running";
  }

  private async captureVisible(agent: AgentRecord): Promise<string> {
    if (agent.sessionLocator?.hostKind === "sessiond") {
      throw new Error("sessiond visible capture requires the frozen attach stream");
    }
    const sessions = this.requireLegacySessions(agent);
    return (await sessions.capture(
      bindAgentSession(sessions, agent),
      { include: "visible-text", maxRows: 50_000 },
    )).text ?? "";
  }

  // The maintenance sweep: classify every agent whose tmux session is gone
  // and either resume its actual tool conversation or mark it dead with the
  // stranded state surfaced. Runs at daemon startup — the recovery moment
  // after a machine-wide crash — and on the periodic reconciliation tick.
  async sweep(): Promise<RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    for (const candidate of this.deps.db.listAgents()) {
      const agent = this.migrateSessionLocator(candidate);
      const isSpawning = agent.status === "spawning";
      if (!isSpawning && !LIVE_STATUSES.includes(agent.status) &&
        agent.status !== "control-paused") {
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
        if (!(error instanceof Error) ||
          !error.message.startsWith("Agent process presence is unknown for ")) {
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
      // #66: a deliberate kill must never be classified as a crash. The
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
        outcomes.push(await this.markDead(
          agent,
          `audited termination (${terminationAudit.reason}); reconciled as a deliberate kill`,
          { deliberate: true },
        ));
        continue;
      }
      if (
        agent.writeRevoked && agent.controlMessageId !== undefined &&
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
          await this.markDead(agent, "tmux session missing (reconciled)"),
        );
        continue;
      }
      if (agent.writeRevoked) {
        outcomes.push({
          agent: agent.name,
          action: "skipped",
          reason: "write authority is revoked; recovery requires explicit cleanup",
        });
        continue;
      }
      if (isSpawning) {
        // The agent died before its tool session produced anything worth
        // resuming; the orchestrator respawns from the stored task instead.
        outcomes.push(await this.markDead(
          agent,
          "process died during spawn (crash recovery)",
        ));
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
    const agent = this.migrateSessionLocator(found);
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
        reason: "write authority is revoked; recovery requires explicit cleanup",
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
    options: { manual: boolean },
  ): Promise<RecoveryOutcome> {
    // Callers checked hasSession before entering, but that check is stale by
    // now if another recovery finished in between; resuming over a live
    // session would fail the tmux launch and mark a healthy agent dead.
    if (await this.sessionPresent(agent)) {
      return {
        agent: agent.name,
        action: "skipped",
        reason: this.runningSessionReason(agent),
      };
    }
    // A tmux wrapper can outlive its vendor CLI. Remove the dead container
    // before launching the recovered agent into the same session name.
    if (agent.sessionLocator?.hostKind !== "sessiond" &&
      await this.sessionContainerPresent(agent)) {
      if (this.deps.stopSession === undefined) {
        return {
          agent: agent.name,
          action: "skipped",
          reason: "dead agent process remains inside a session that cannot be cleaned",
        };
      }
      const stopped = await this.deps.stopSession(agent);
      if (stopped.survivors.length > 0) {
        return {
          agent: agent.name,
          action: "skipped",
          reason: `${stopped.survivors.length} process(es) survived dead-session cleanup`,
        };
      }
    }
    if (!options.manual && agent.recoveryAttempts >= MAX_AUTO_RESUME_ATTEMPTS) {
      return this.markDead(
        agent,
        `crash recovery gave up after ${agent.recoveryAttempts} resume attempts`,
      );
    }
    if (agent.worktreePath === null || !this.worktreeExists(agent.worktreePath)) {
      return this.markDead(agent, "worktree is missing; session not resumable");
    }
    let sessionId: string | null;
    try {
      sessionId = agent.toolSessionId ??
        await this.resolveSession(
          agent.tool,
          agent.worktreePath,
          agent.createdAt,
        );
    } catch (error) {
      return this.preserveUnverifiedRecovery(
        agent,
        `session discovery refused: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    if (sessionId === null) {
      return this.markDead(
        agent,
        "no resumable tool session was found for this worktree",
      );
    }
    return this.resume(agent, sessionId);
  }

  /**
   * The vendor's session resolver. Exhaustive: a new vendor is a compile error
   * here, and one that slipped past the types throws rather than hunting a
   * Codex rollout in a worktree that never held one — which would resolve
   * nothing, or worse, a stale predecessor's id.
   */
  private resolveSession(
    tool: AgentRecord["tool"],
    worktreePath: string,
    agentCreatedAt: string,
  ): Promise<string | null> {
    switch (tool) {
      case "claude":
        return this.resolveClaude(worktreePath, agentCreatedAt);
      case "codex":
        return this.resolveCodex(worktreePath, agentCreatedAt);
      case "grok":
        return this.resolveGrok(worktreePath, agentCreatedAt);
      default:
        return unknownVendor(tool, "crash recovery session resolver");
    }
  }

  private async resume(
    agent: AgentRecord,
    sessionId: string,
  ): Promise<RecoveryOutcome> {
    // Persist the attempt before launching so a crash mid-launch still
    // counts against the cap.
    const migrated = this.migrateSessionLocator(agent);
    const currentLocator = migrated.sessionLocator!;
    const nextLocator = nextAgentSessionLocator(migrated);
    let record = this.deps.db.upsertAgent({
      ...migrated,
      sessionLocator: currentLocator.hostKind === "sessiond"
        ? {
          ...nextLocator,
          hostKind: "sessiond",
          engineBuildId: currentLocator.engineBuildId,
        }
        : nextLocator,
      toolSessionId: sessionId,
      recoveryAttempts: agent.recoveryAttempts + 1,
      lastEventAt: new Date().toISOString(),
    });
    this.denyPendingApprovals(record.name);

    const identity = record.executionIdentity;
    const model = identity?.model ?? record.model;
    const worktreePath = record.worktreePath!;
    // A resumed writer takes the current autonomy setting — the same one the
    // next spawn would get — or an unattended crash-recovered dangerous agent
    // would silently stall on the first prompt.
    const dangerous = this.deps.autonomy?.() === "dangerous";
    try {
      if (!CapabilityProviderSchema.safeParse(record.tool).success) {
        return unknownVendor(record.tool as never, "crash recovery resume");
      }
      if (identity === undefined) {
        throw new Error("no immutable execution identity is recorded");
      }
      const authorized = await this.deps.authorizeLaunch?.(
        identity,
        record.category,
      ) ?? null;
      if (authorized === null) {
        throw new Error(
          `${identity.model} enablement policy is unreadable; open the Model ` +
            "Control Center and enable it before resuming",
        );
      }
      requireAuthorizedLaunch(authorized);
      // One switch decides both the config the resume writes and the argv it
      // launches: a vendor with no arm gets neither, and the throw lands in
      // the launch-failure catch below naming it. Splitting the two would let
      // a future vendor write one harness's config and launch the other's CLI.
      let argv: string[];
      switch (record.tool) {
        case "claude": {
          // Re-seed rather than assume: the operator's ~/.claude.json may have
          // been reset between the crash and the resume, and an unattended
          // resume that meets the trust dialog stalls exactly like a spawn.
          // Best-effort because the existing file usually already records
          // trust — but never silently: a failed seed is the prime suspect
          // when a resume stalls.
          await this.seedClaudeTrust(worktreePath).catch((error: unknown) => {
            console.error(
              `Hive could not re-seed worktree trust for ${record.name}: ${
                error instanceof Error ? error.message : "unknown error"
              }`,
            );
          });
          // The config write must succeed or the resume must fail: the
          // spawn-time config carries a daemon port this restarted daemon may
          // no longer hold, and an agent whose hooks post to a dead port can
          // never prove life. A throw here lands in the launch-failure catch
          // below.
          await this.writeClaudeConfig(worktreePath, {
            daemonPort: this.daemonPort(),
            name: record.name,
            readOnly: record.readOnly,
            dangerous,
          });
          argv = buildClaudeResumeCommand({
            daemonPort: this.daemonPort(),
            model,
            ...(identity?.tool === "claude" && identity.effort !== undefined
              ? { effort: identity.effort }
              : {}),
            name: record.name,
            readOnly: record.readOnly,
            dangerous,
            worktreePath,
            executable: this.claudeExecutable,
          }, sessionId);
          break;
        }
        case "codex": {
          await this.writeCodexConfig(worktreePath, {
            daemonPort: this.daemonPort(),
            name: record.name,
            readOnly: record.readOnly,
            hiveCommand: hiveCliSpawnArgv(IS_RELEASE_BUILD, process.execPath),
          });
          argv = buildCodexResumeCommand({
            daemonPort: this.daemonPort(),
            effort: identity?.tool === "codex" ? identity.effort : "medium",
            model,
            name: record.name,
            readOnly: record.readOnly,
            dangerous,
            worktreePath,
            executable: this.codexExecutable,
          }, sessionId);
          break;
        }
        case "grok": {
          await this.writeGrokConfig(worktreePath, {
            daemonPort: this.daemonPort(),
          });
          argv = buildGrokResumeCommand({
            model,
            ...(identity?.tool === "grok" && identity.effort !== undefined
              ? { effort: identity.effort }
              : {}),
            worktreePath,
            readOnly: record.readOnly,
            executable: this.grokExecutable,
          }, sessionId);
          break;
        }
        default:
          unknownVendor(record.tool, "crash recovery resume");
      }
      const command = record.tool === "grok"
        ? wrapGrokSpawnWithCompatibilityEnv(shellJoin(argv))
        : shellJoin(argv);
      const revalidated = await this.deps.authorizeLaunch?.(
        identity,
        record.category,
      ) ?? null;
      if (
        revalidated === null || revalidated.tool !== authorized.tool ||
        revalidated.model !== authorized.model ||
        revalidated.effort !== authorized.effort
      ) {
        throw new Error("resume authorization changed before the process adapter");
      }
      requireAuthorizedLaunch(revalidated);
      const launchGrantId = `recovery:${record.id}:${record.recoveryAttempts}`;
      if (this.deps.createRecoverySession !== undefined) {
        await this.deps.createRecoverySession(
          record,
          command,
          argv[0] ?? record.tool,
          launchGrantId,
        );
      } else {
        const sessions = this.requireLegacySessions(record);
        bindAgentSession(sessions, record);
        await sessions.create(
          tmuxSessionSpec(
            record,
            command,
            argv[0] ?? record.tool,
            launchGrantId,
          ),
          new Uint8Array(),
        );
      }
      // A freshly resumed TUI sits at its prompt with the conversation
      // restored: idle is the honest status until an event says otherwise.
      record = this.deps.db.upsertAgent({
        ...(this.deps.db.getAgentById(record.id) ?? record),
        status: "idle",
        lastEventAt: new Date().toISOString(),
      });

      // Wake it, and only then watch. This order is the fix, not a detail.
      //
      // A resume restores a conversation but issues no instruction, so the TUI
      // comes back correctly idle at its prompt: it fires no hook, writes no
      // rollout, and does not redraw. The continuation notice below is the only
      // thing that gives it something to do. Watching first therefore waited
      // for activity that nothing had asked for — the agent had to act to be
      // judged alive, and was given nothing to act on until after it was
      // judged. Measured on instance run-bc65ab00, that deadlock killed 11
      // healthy agents in one night, 5 codex and 6 grok, every one of them
      // sitting at a restored prompt with its work intact.
      await this.wakeResumedAgent(record);

      // Baselined *after* the wake so only the agent's own response counts:
      // anything our own injection stirred up must not read as proof of life.
      const failure = await this.monitorResume(
        record,
        argv[0] ?? record.tool,
        this.deps.db.getAgentById(record.id)?.lastEventAt ?? record.lastEventAt,
      );
      if (failure !== null) {
        return await this.failResume(
          this.deps.db.getAgentById(record.id) ?? record,
          failure,
        );
      }
    } catch (error) {
      return await this.failResume(
        this.deps.db.getAgentById(record.id) ?? record,
        error instanceof Error ? error.message : "unknown error",
      );
    }

    await this.deps.send(
      "hive-recovery",
      ORCHESTRATOR_NAME,
      `Resumed ${record.name} after a crash: relaunched ${record.tool} session ` +
        `${sessionId} in ${worktreePath} with its conversation restored.`,
      { idempotencyKey: `crash-resume:${record.id}:${record.recoveryAttempts}` },
    ).catch(() => undefined);
    return { agent: record.name, action: "resumed", sessionId };
  }

  private async failResume(
    agent: AgentRecord,
    failure: string,
  ): Promise<RecoveryOutcome> {
    const reason = `resume launch failed: ${failure}`;
    if (this.deps.stopSession === undefined) {
      return this.preserveUnverifiedRecovery(
        agent,
        `${reason}; verified teardown is unavailable`,
      );
    }
    try {
      const stopped = await this.deps.stopSession(agent);
      if (stopped.survivors.length > 0) {
        return this.preserveUnverifiedRecovery(
          agent,
          `${reason}; ${stopped.survivors.length} process(es) survived teardown`,
        );
      }
    } catch (error) {
      return this.preserveUnverifiedRecovery(
        agent,
        `${reason}; teardown could not be verified: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    return await this.markDead(agent, reason);
  }

  /**
   * Give a resumed agent something to be alive about.
   *
   * Called before the liveness watch, deliberately — see the call site. The
   * notice reaches the TUI as injected keystrokes, so it is what turns a
   * restored-but-idle prompt into a working agent, which is the only thing the
   * watch can then observe.
   *
   * Failures stay swallowed, as they were when this ran after the watch: a
   * notice that cannot be delivered is not itself a reason to kill a process we
   * have not yet examined. The watch is what decides life, and an agent that
   * never got the notice will fail it on the evidence.
   */
  private async wakeResumedAgent(record: AgentRecord): Promise<void> {
    await this.deps.send(
      "hive-recovery",
      record.name,
      "Your previous process crashed and Hive resumed your tool session with " +
        "its conversation restored. Check hive_inbox for queued messages, " +
        "re-verify any in-flight edits in your worktree, and continue your task.",
      { idempotencyKey: `crash-resume-notice:${record.id}:${record.recoveryAttempts}` },
    ).catch(() => undefined);
    await this.deps.flushQueued(record.name).catch(() => undefined);
  }

  /**
   * Is the resumed process alive?
   *
   * This defers to the same watch the spawn path uses, and the reason is
   * measured rather than tidy. The hand-rolled loop this replaces accepted only
   * two positive signals — a hook event, or a fresh codex rollout — and bounded
   * them with a 10-second stopwatch. On the night of instance run-bc65ab00 that
   * probe killed 11 of 11 non-claude resumes and passed 3 of 3 claude ones,
   * because:
   *
   *   claude  fires a session-start hook          → passed 3/3
   *   codex   hook rides hive's MCP; rollout is
   *           silent until the first tool call    → failed 5/5
   *   grok    emitted 0 events all night, across
   *           11 agents, and has no rollout       → failed 6/6
   *
   * Grok cannot bump `lastEventAt` at all, so of the two signals the old probe
   * accepted, grok could produce neither — its resume was not unlucky, it was
   * impossible. The pane is the only liveness signal grok has, which is exactly
   * what `watchForProofOfLife` reads, and it corroborates every redraw against
   * the process tree so a wrapper animating over a dead child still reads dead.
   *
   * It also drops the stopwatch. No wall-clock number was ever right: a
   * high-effort model reasons past any of them, and readiness.ts measured 15s to
   * first output on gpt-5.6-sol high — so even a woken codex resume would have
   * died on a 10-second bound. Silence is the only honest deadline.
   */
  private async monitorResume(
    record: AgentRecord,
    launchedCommand: string,
    baselineEventAt: string,
  ): Promise<string | null> {
    const proof = await watchForProofOfLife(record, baselineEventAt, {
      hasSession: () => this.sessionPresent(record),
      capturePane: () => this.captureVisible(record),
      lastEventAt: () =>
        this.deps.db.getAgentById(record.id)?.lastEventAt ?? null,
      codexActivity: () => this.readCodexActivityFor(record),
      launchedProcessAlive: () =>
        this.launchedProcessAlive(record, launchedCommand),
      launchedCommand,
      failurePatterns: RESUME_FAILURE_PATTERNS,
      wait: (ms) => this.wait(ms),
    });
    return proof.alive ? null : proof.reason;
  }

  /**
   * Is the binary we relaunched still running inside that pane?
   *
   * Null means we could not tell — no pane, or an unreadable `ps` — and the
   * watch treats unknown as no evidence rather than as life.
   */
  private async launchedProcessAlive(
    record: AgentRecord,
    command: string,
  ): Promise<boolean | null> {
    try {
      const rootPids = record.sessionLocator?.hostKind === "sessiond"
        ? [
          (await this.deps.terminalHost?.inspect(
            requireSessiondAgentLocator(record),
          ))?.providerRoot?.pid,
        ].filter((pid): pid is number => pid !== undefined && pid !== null)
        : await this.requireLegacySessions(record).sessionProcessRoots(
          bindAgentSession(this.requireLegacySessions(record), record),
        );
      if (rootPids.length === 0) return null;
      const samples = parseProcessTable(await (this.deps.ps ?? runPs)());
      if (samples.length === 0) return null;
      return treeRunsCommand(samples, [...rootPids], command);
    } catch {
      return null;
    }
  }

  /** The codex rollout mtime, or null when there is none to read. Still a real
   * signal — it just cannot be the only one, since it stays silent through the
   * whole reasoning phase. */
  private async readCodexActivityFor(
    record: AgentRecord,
  ): Promise<string | null> {
    const current = this.deps.db.getAgentById(record.id) ?? record;
    if (current.tool !== "codex" || current.worktreePath === null) return null;
    try {
      return await this.readCodexActivity(
        current.worktreePath,
        current.toolSessionId,
      );
    } catch {
      return null;
    }
  }

  private async preserveUnverifiedRecovery(
    agent: AgentRecord,
    reason: string,
  ): Promise<RecoveryOutcome> {
    const now = new Date().toISOString();
    const current = this.deps.db.getAgentById(agent.id) ?? agent;
    this.deps.db.upsertAgent({
      ...current,
      status: "stuck",
      writeRevoked: true,
      failureReason: reason,
      lastEventAt: now,
    });
    this.deps.revokeCapabilities?.(agent.name);
    this.denyPendingApprovals(agent.name);
    await this.deps.send(
      "hive-recovery",
      ORCHESTRATOR_NAME,
      `${agent.name} could not be recovered safely: ${reason}. Hive preserved ` +
        "the agent record, worktree, quota reservation, and queued messages; " +
        "retry cleanup or recovery explicitly after verifying process state.",
      {
        idempotencyKey:
          `crash-recovery-preserved:${agent.id}:${current.recoveryAttempts}`,
      },
    ).catch(() => undefined);
    return { agent: agent.name, action: "skipped", reason };
  }

  private async markDead(
    agent: AgentRecord,
    reason: string,
    options: { deliberate?: boolean } = {},
  ): Promise<RecoveryOutcome> {
    const now = new Date().toISOString();
    this.deps.db.markAgentDead(
      agent.id,
      now,
      reason,
    );
    this.deps.revokeCapabilities?.(agent.name);
    await this.deps.settleQuota(agent);
    this.denyPendingApprovals(agent.name);
    // Queued traffic to a dead agent can never inject; flag it once so
    // deadline alarms stop firing and the orchestrator alert names it.
    const stranded = this.deps.db.getUndeliveredMessages(agent.name);
    for (const message of stranded) {
      this.deps.db.markMessageAlerted(message.id, now);
    }
    const strandedNote = stranded.length === 0
      ? ""
      : ` ${stranded.length} queued message(s) were flagged undeliverable.`;
    const worktreeNote = agent.worktreePath === null
      ? "No worktree was recorded."
      : `Worktree preserved at ${agent.worktreePath}` +
        (agent.branch === null ? "." : ` (branch ${agent.branch}).`);
    // An audited kill is not a crash and must not be reported as one (#66):
    // the closure is finished on the killer's behalf and said plainly.
    const headline = options.deliberate === true
      ? `${agent.name} was killed deliberately and its record has been reconciled without a resume: ${reason}.`
      : `${agent.name} died in a crash and could not be resumed: ${reason}.`;
    await this.deps.send(
      "hive-recovery",
      ORCHESTRATOR_NAME,
      `${headline} ` +
        `${worktreeNote}${strandedNote} Respawn with hive_spawn if the work ` +
        `should continue. Stored task: ${boundedTask(agent.taskDescription)}`,
      { idempotencyKey: `crash-dead:${agent.id}:${agent.lastEventAt}` },
    ).catch(() => undefined);
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
