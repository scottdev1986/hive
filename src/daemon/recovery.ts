import { existsSync } from "node:fs";
import { shellJoin } from "../adapters/tmux";
import type { TmuxAdapter } from "../adapters/tmux";
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
import { hiveCliSpawnArgv } from "./lifecycle";
import { IS_RELEASE_BUILD } from "../version";

// Three auto-resumes for one agent means the process is dying on its own,
// not being killed by crashes; after that the sweep stops retrying and
// surfaces the agent for an explicit decision.
export const MAX_AUTO_RESUME_ATTEMPTS = 3;

const RESUME_READY_POLL_MS = 1_000;
const RESUME_READY_ATTEMPTS = 10;
const RESUME_FAILURE_PATTERNS = [
  /^(Error|error):/m,
  /^\[hive\] process exited with status \d+$/m,
  /command not found/,
  /not supported/i,
  /not found\.?$/m,
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
>;

type Sleep = (milliseconds: number) => Promise<void>;

export interface CrashRecoveryDependencies {
  db: RecoveryStore;
  tmux: Pick<
    TmuxAdapter,
    "hasSession" | "newSession" | "killSession" | "capturePane"
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
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const LIVE_STATUSES: AgentRecord["status"][] = [
  "working",
  "idle",
  "awaiting-approval",
  "stuck",
];

function tailLines(value: string, count: number): string {
  const trimmed = value.trimEnd();
  if (trimmed.length === 0) return "";
  return trimmed.split(/\r?\n/).slice(-count).join("\n").trim();
}

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

  constructor(private readonly deps: CrashRecoveryDependencies) {
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
    this.seedClaudeTrust = deps.seedClaudeTrust ?? seedClaudeWorktreeTrust;
    this.writeClaudeConfig = deps.writeClaudeConfig ?? writeClaudeAgentConfig;
    this.writeCodexConfig = deps.writeCodexConfig ?? writeCodexAgentConfig;
    this.writeGrokConfig = deps.writeGrokConfig ?? writeGrokAgentConfig;
    this.readCodexActivity = deps.readCodexActivity ??
      (async (worktreePath, toolSessionId) =>
        (await readCodexTelemetry(worktreePath, toolSessionId)).lastActivityAt);
  }

  private daemonPort(): number {
    const configured = this.deps.port;
    const port = typeof configured === "function" ? configured() : configured;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Hive daemon has no listening port (resolved ${port})`);
    }
    return port;
  }

  // The maintenance sweep: classify every agent whose tmux session is gone
  // and either resume its actual tool conversation or mark it dead with the
  // stranded state surfaced. Runs at daemon startup — the recovery moment
  // after a machine-wide crash — and on the periodic reconciliation tick.
  async sweep(): Promise<RecoveryOutcome[]> {
    const outcomes: RecoveryOutcome[] = [];
    for (const agent of this.deps.db.listAgents()) {
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
      if (await this.deps.tmux.hasSession(agent.tmuxSession)) {
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
    const agent = this.deps.db.getAgentByName(name);
    if (agent === null) {
      throw new Error(`Hive agent not found: ${name}`);
    }
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
    if (await this.deps.tmux.hasSession(agent.tmuxSession)) {
      return {
        agent: name,
        action: "skipped",
        reason: "tmux session is running",
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
    if (await this.deps.tmux.hasSession(agent.tmuxSession)) {
      return {
        agent: agent.name,
        action: "skipped",
        reason: "tmux session is running",
      };
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
    let record = this.deps.db.upsertAgent({
      ...agent,
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
      await this.deps.tmux.newSession(
        record.tmuxSession,
        worktreePath,
        command,
      );
      const failure = await this.monitorResume(record);
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

    // A freshly resumed TUI sits at its prompt with the conversation
    // restored: idle is the honest status until an event says otherwise.
    record = this.deps.db.upsertAgent({
      ...(this.deps.db.getAgentById(record.id) ?? record),
      status: "idle",
      lastEventAt: new Date().toISOString(),
    });

    await this.deps.send(
      "hive-recovery",
      record.name,
      "Your previous process crashed and Hive resumed your tool session with " +
        "its conversation restored. Check hive_inbox for queued messages, " +
        "re-verify any in-flight edits in your worktree, and continue your task.",
      { idempotencyKey: `crash-resume-notice:${record.id}:${record.recoveryAttempts}` },
    ).catch(() => undefined);
    await this.deps.flushQueued(record.name).catch(() => undefined);
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

  private async monitorResume(record: AgentRecord): Promise<string | null> {
    const startedAt = new Date().toISOString();
    let lastPaneTail = "";
    for (let attempt = 0; attempt < RESUME_READY_ATTEMPTS; attempt += 1) {
      await this.wait(RESUME_READY_POLL_MS);
      const current = this.deps.db.getAgentById(record.id);
      if (current !== null && current.lastEventAt > record.lastEventAt) {
        // A hook event arrived from the relaunched process: proof of life.
        return null;
      }
      if (await this.hasFreshCodexActivity(record, startedAt)) return null;
      if (!(await this.deps.tmux.hasSession(record.tmuxSession))) {
        return "tmux session exited";
      }
      try {
        const pane = await this.deps.tmux.capturePane(record.tmuxSession);
        lastPaneTail = tailLines(pane, 15);
        const paneTail = tailLines(pane, 5);
        if (RESUME_FAILURE_PATTERNS.some((pattern) => pattern.test(paneTail))) {
          return lastPaneTail || "resume process launch error";
        }
      } catch {
        if (!(await this.deps.tmux.hasSession(record.tmuxSession))) {
          return "tmux session exited";
        }
      }
    }
    // Poll exhaustion with no positive signal is a failed resume, never a
    // success: an unproven process must not be reported as recovered.
    const seconds = Math.round(
      (RESUME_READY_ATTEMPTS * RESUME_READY_POLL_MS) / 1000,
    );
    const base = `no proof of life within ${seconds}s ` +
      "(no hook event and no fresh tool activity)";
    return lastPaneTail === "" ? base : `${base}; last pane output:\n${lastPaneTail}`;
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

  /** True when a codex agent's rollout file gained activity after this resume
   * watch began — an independent fallback when its native SessionStart hook
   * does not arrive. Read at most once per poll tick, only for codex agents
   * with a worktree; a read failure is simply "no signal yet". */
  private async hasFreshCodexActivity(
    record: AgentRecord,
    monitorStartedAt: string,
  ): Promise<boolean> {
    if (record.tool !== "codex" || record.worktreePath === null) return false;
    try {
      const lastActivityAt = await this.readCodexActivity(
        record.worktreePath,
        record.toolSessionId,
      );
      return lastActivityAt !== null && lastActivityAt > monitorStartedAt;
    } catch {
      return false;
    }
  }

  private async markDead(
    agent: AgentRecord,
    reason: string,
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
    await this.deps.send(
      "hive-recovery",
      ORCHESTRATOR_NAME,
      `${agent.name} died in a crash and could not be resumed: ${reason}. ` +
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
