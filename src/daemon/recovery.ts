import { existsSync } from "node:fs";
import {
  buildAgentTerminalTitle,
  type TerminalAdapter,
  type TerminalCloser,
} from "../adapters/terminal";
import { shellJoin } from "../adapters/tmux";
import type { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeResumeCommand,
  findLatestClaudeSessionId,
  resolveWorkingClaudeExecutable,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  buildCodexResumeCommand,
  findLatestCodexSessionId,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { ORCHESTRATOR_NAME, type AgentRecord, type HiveConfig } from "../schemas";
import type { HiveDatabase } from "./db";

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

export type SessionResolver = (worktreePath: string) => Promise<string | null>;

type RecoveryStore = Pick<
  HiveDatabase,
  | "listAgents"
  | "getAgentByName"
  | "getAgentById"
  | "upsertAgent"
  | "markAgentDeadAndDetachTerminal"
  | "attachTerminalHandle"
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
  port: number;
  closeTerminal: TerminalCloser;
  send: (
    from: string,
    to: string,
    body: string,
    options?: { idempotencyKey?: string },
  ) => Promise<unknown>;
  settleQuota: (agent: AgentRecord) => Promise<void>;
  flushQueued: (agentName: string) => Promise<unknown>;
  /** Drops a stale Claude Channels registration: the connection died with
   * the crashed process, and a resumed process re-registers on its own. */
  dropChannel?: (agentName: string) => void;
  /** Absent (headless or unconfigured) means recovered agents run without a
   * viewer until `hive watch` opens one. */
  terminal?: TerminalAdapter | undefined;
  onTerminalsChanged?: (() => void) | undefined;
  resolveClaudeSessionId?: SessionResolver;
  resolveCodexSessionId?: SessionResolver;
  worktreeExists?: (path: string) => boolean;
  sleep?: Sleep;
  claudeExecutable?: string;
  /** Writer autonomy, so a resumed agent regains the launch posture it had at
   * spawn. Absent fails safe to the sandboxed approval queue. */
  autonomy?: HiveConfig["autonomy"];
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
  private readonly worktreeExists: (path: string) => boolean;
  private readonly wait: Sleep;
  private readonly claudeExecutable: string;

  constructor(private readonly deps: CrashRecoveryDependencies) {
    this.resolveClaude = deps.resolveClaudeSessionId ??
      ((worktreePath) => findLatestClaudeSessionId(worktreePath));
    this.resolveCodex = deps.resolveCodexSessionId ??
      ((worktreePath) => findLatestCodexSessionId(worktreePath));
    this.worktreeExists = deps.worktreeExists ?? existsSync;
    this.wait = deps.sleep ?? defaultSleep;
    this.claudeExecutable = deps.claudeExecutable ?? resolveWorkingClaudeExecutable().path;
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
      if (agent.status === "control-paused" || agent.writeRevoked) {
        // Control machinery owns revoked agents; a vanished acknowledgement
        // process is ordinary death, not resumable work.
        outcomes.push(
          await this.markDead(agent, "tmux session missing (reconciled)"),
        );
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
    if (agent.writeRevoked) {
      return {
        agent: name,
        action: "skipped",
        reason: "write authority is revoked; control recovery owns this agent",
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
    if (!options.manual && agent.recoveryAttempts >= MAX_AUTO_RESUME_ATTEMPTS) {
      return this.markDead(
        agent,
        `crash recovery gave up after ${agent.recoveryAttempts} resume attempts`,
      );
    }
    if (agent.worktreePath === null || !this.worktreeExists(agent.worktreePath)) {
      return this.markDead(agent, "worktree is missing; session not resumable");
    }
    const sessionId = agent.toolSessionId ??
      await (agent.tool === "claude" ? this.resolveClaude : this.resolveCodex)(
        agent.worktreePath,
      ).catch(() => null);
    if (sessionId === null) {
      return this.markDead(
        agent,
        "no resumable tool session was found for this worktree",
      );
    }
    return this.resume(agent, sessionId);
  }

  private async resume(
    agent: AgentRecord,
    sessionId: string,
  ): Promise<RecoveryOutcome> {
    // Persist the attempt before launching so a crash mid-launch still
    // counts against the cap, and detach the stale viewer: its tmux client
    // died with the session, so the window shows a dead shell.
    const staleHandle = agent.terminalHandle;
    let record = this.deps.db.upsertAgent({
      ...agent,
      terminalHandle: undefined,
      toolSessionId: sessionId,
      recoveryAttempts: agent.recoveryAttempts + 1,
      lastEventAt: new Date().toISOString(),
    });
    if (staleHandle !== undefined) {
      await this.deps.closeTerminal(staleHandle).catch(() => undefined);
      this.deps.onTerminalsChanged?.();
    }
    this.deps.dropChannel?.(record.name);
    this.denyPendingApprovals(record.name);

    const identity = record.executionIdentity;
    const model = identity?.model ?? record.model;
    const worktreePath = record.worktreePath!;
    // A resumed writer must regain the autonomy it launched with, or an
    // unattended crash-recovered agent silently stalls on the first prompt.
    const dangerous = this.deps.autonomy === "dangerous";
    try {
      if (record.tool === "claude") {
        // Re-seed rather than assume: the operator's ~/.claude.json may have
        // been reset between the crash and the resume, and an unattended
        // resume that meets the trust dialog stalls exactly like a spawn.
        await seedClaudeWorktreeTrust(worktreePath).catch(() => undefined);
        await writeClaudeAgentConfig(worktreePath, {
          daemonPort: this.deps.port,
          name: record.name,
          readOnly: false,
          dangerous,
        }).catch(() => undefined);
        // The spawn-time config in the worktree still carries hooks and
        // permissions; only the resume flag is new.
      } else {
        await writeCodexAgentConfig(worktreePath, {
          daemonPort: this.deps.port,
          name: record.name,
          readOnly: false,
        }).catch(() => undefined);
      }
      const argv = record.tool === "claude"
        ? buildClaudeResumeCommand({
            daemonPort: this.deps.port,
            model,
            name: record.name,
            readOnly: false,
            dangerous,
            worktreePath,
            executable: this.claudeExecutable,
          }, sessionId)
        : buildCodexResumeCommand({
            daemonPort: this.deps.port,
            effort: identity?.tool === "codex" ? identity.effort : "medium",
            model,
            name: record.name,
            readOnly: false,
            dangerous,
            worktreePath,
          }, sessionId);
      await this.deps.tmux.newSession(
        record.tmuxSession,
        worktreePath,
        shellJoin(argv),
      );
      const failure = await this.monitorResume(record);
      if (failure !== null) {
        await this.deps.tmux.killSession(record.tmuxSession, {
          ignoreMissing: true,
        }).catch(() => undefined);
        return await this.markDead(
          this.deps.db.getAgentById(record.id) ?? record,
          `resume launch failed: ${failure}`,
        );
      }
    } catch (error) {
      return await this.markDead(
        this.deps.db.getAgentById(record.id) ?? record,
        `resume launch failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }

    // A freshly resumed TUI sits at its prompt with the conversation
    // restored: idle is the honest status until an event says otherwise.
    record = this.deps.db.upsertAgent({
      ...(this.deps.db.getAgentById(record.id) ?? record),
      status: "idle",
      lastEventAt: new Date().toISOString(),
    });

    if (this.deps.terminal !== undefined) {
      try {
        const handle = await this.deps.terminal.openWindow(
          record.tmuxSession,
          buildAgentTerminalTitle(record.name, record.model),
        );
        if (this.deps.db.attachTerminalHandle(record.id, handle) === null) {
          await this.deps.terminal.closeWindow(handle).catch(() => undefined);
        } else {
          this.deps.onTerminalsChanged?.();
        }
      } catch {
        // A viewer is cosmetic; the resumed session is already healthy.
      }
    }

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

  private async monitorResume(record: AgentRecord): Promise<string | null> {
    for (let attempt = 0; attempt < RESUME_READY_ATTEMPTS; attempt += 1) {
      await this.wait(RESUME_READY_POLL_MS);
      const current = this.deps.db.getAgentById(record.id);
      if (current !== null && current.lastEventAt > record.lastEventAt) {
        // A hook event arrived from the relaunched process: proof of life.
        return null;
      }
      if (!(await this.deps.tmux.hasSession(record.tmuxSession))) {
        return "tmux session exited";
      }
      try {
        const pane = await this.deps.tmux.capturePane(record.tmuxSession);
        const paneTail = tailLines(pane, 5);
        if (RESUME_FAILURE_PATTERNS.some((pattern) => pattern.test(paneTail))) {
          return tailLines(pane, 15) || "resume process launch error";
        }
      } catch {
        if (!(await this.deps.tmux.hasSession(record.tmuxSession))) {
          return "tmux session exited";
        }
      }
    }
    return null;
  }

  private async markDead(
    agent: AgentRecord,
    reason: string,
  ): Promise<RecoveryOutcome> {
    const now = new Date().toISOString();
    const dead = this.deps.db.markAgentDeadAndDetachTerminal(
      agent.id,
      now,
      reason,
    );
    this.deps.dropChannel?.(agent.name);
    await this.deps.settleQuota(agent);
    this.denyPendingApprovals(agent.name);
    // Queued traffic to a dead agent can never inject; flag it once so
    // deadline alarms stop firing and the orchestrator alert names it.
    const stranded = this.deps.db.getUndeliveredMessages(agent.name);
    for (const message of stranded) {
      this.deps.db.markMessageAlerted(message.id, now);
    }
    if (dead?.terminalHandle !== undefined) {
      await this.deps.closeTerminal(dead.terminalHandle).catch(() => undefined);
      this.deps.onTerminalsChanged?.();
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
