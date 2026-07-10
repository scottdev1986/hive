import {
  buildAgentTerminalTitle,
  type TerminalAdapter,
} from "../adapters/terminal";
import { shellJoin } from "../adapters/tmux";
import type { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import {
  buildCodexSpawnCommand,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { provisionSkills } from "../adapters/skills";
import { resolveConcreteModel } from "../adapters/tools/models";
import {
  createWorktree,
  removeWorktree,
  slugify,
  type CreatedWorktree,
} from "../adapters/worktrees";
import {
  ORCHESTRATOR_NAME,
  type AgentMessage,
  type AgentRecord,
  type ExecutionIdentity,
  type HiveConfig,
  type Route,
  type RoutingTier,
} from "../schemas";
import type { HiveDatabase } from "./db";
import type { SpawnRequest, Spawner } from "./spawner";
import type { QuotaService } from "./quota";

export const NAME_POOL = [
  "maya",
  "david",
  "sam",
  "john",
  "sarah",
  "alex",
  "nina",
  "leo",
  "anna",
  "james",
  "zoe",
  "omar",
  "lena",
  "noah",
  "priya",
  "liam",
  "emma",
  "lucas",
  "ava",
  "ethan",
  "mia",
  "henry",
  "isla",
  "jack",
  "chloe",
  "ryan",
  "sofia",
  "adam",
  "grace",
  "owen",
  "layla",
  "theo",
  "ruby",
  "caleb",
  "alice",
  "felix",
  "clara",
  "marco",
  "julia",
  "ben",
] as const;

type AgentStore = Pick<
  HiveDatabase,
  | "attachTerminalHandle"
  | "getAgentById"
  | "insertAgent"
  | "listAgents"
  | "releaseAgentName"
  | "reserveAgentName"
>;
type RouteResolver = (tier: RoutingTier) => Promise<Route>;
type WorktreeCreator = (
  repoRoot: string,
  agentName: string,
  taskSlug: string,
) => Promise<CreatedWorktree>;
type WorktreeRemover = typeof removeWorktree;
type TmuxSessionManager = Pick<
  TmuxAdapter,
  "newSession" | "hasSession" | "capturePane" | "killSession"
>;
type Sleep = (milliseconds: number) => Promise<void>;
type ModelResolver = typeof resolveConcreteModel;

export interface HiveSpawnerDependencies {
  db: AgentStore;
  repoRoot: string;
  port: number;
  config: Pick<HiveConfig, "terminal" | "headless">;
  routing: RouteResolver;
  tmux: TmuxSessionManager;
  terminal: TerminalAdapter;
  createWorktree?: WorktreeCreator;
  removeWorktree?: WorktreeRemover;
  keepWorktreeOnFailure?: boolean;
  sleep?: Sleep;
  resolveModel?: ModelResolver;
  /** Fires after a viewer window is attached so the daemon can re-tile the
   * window wall. */
  onTerminalsChanged?: () => void;
  /** Reports viewer automation failures without treating the detached agent
   * process itself as failed. */
  onTerminalError?: (message: string) => void;
  quota?: QuotaService;
}

const isLive = (agent: AgentRecord): boolean =>
  agent.status !== "dead" &&
  agent.status !== "done" &&
  agent.status !== "failed";

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,20}$/;
const READINESS_POLL_MS = 1_000;
const READINESS_ATTEMPTS = 15;
const LAUNCH_FAILURE_PATTERNS = [
  /^(Error|error):/m,
  /command not found/,
  /not supported/i,
  /not found\.?$/m,
];

const sleep: Sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function tailLines(value: string, count: number): string {
  const trimmed = value.trimEnd();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.split(/\r?\n/).slice(-count).join("\n").trim();
}

export function selectAgentName(agents: AgentRecord[]): string {
  const liveNames = new Set(
    agents.filter(isLive).map((agent) => agent.name),
  );
  const name = NAME_POOL.find((candidate) => !liveNames.has(candidate));
  if (name === undefined) {
    throw new Error(
      `Hive agent name pool exhausted (${NAME_POOL.length} live agents)`,
    );
  }
  return name;
}

export function resolveAgentName(
  requestedName: string | undefined,
  agents: AgentRecord[],
): string {
  if (requestedName === undefined) {
    return selectAgentName(agents);
  }

  const normalizedName = requestedName.toLowerCase();
  if (normalizedName === ORCHESTRATOR_NAME) {
    throw new Error(
      `Agent name "${ORCHESTRATOR_NAME}" is reserved for the Hive orchestrator`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(normalizedName)) {
    throw new Error(
      `Invalid agent name "${normalizedName}": after lowercasing, the name must match /^[a-z][a-z0-9-]{1,20}$/`,
    );
  }
  if (
    agents.some((agent) =>
      isLive(agent) && agent.name === normalizedName
    )
  ) {
    throw new Error(
      `Agent name collision: "${normalizedName}" is already assigned to a live agent`,
    );
  }
  return normalizedName;
}

export const LANDING_MAX_ATTEMPTS = 3;

export function buildLandingProtocol(
  branch: string,
  repoRoot: string,
  mainBranch = "main",
  agentName = branch.split("/")[1]?.split("-")[0] ?? "agent",
  capabilityEpoch = 0,
): string {
  return [
    `When your task is complete and the tests are green, land your work on ${mainBranch} immediately — finished work left on your branch is lost work:`,
    `1. Commit everything on your branch (${branch}); never leave work uncommitted.`,
    `2. Rebase onto the latest ${mainBranch}: run \`git rebase ${mainBranch}\` in your worktree. If the rebase hits conflicts, run \`git rebase --abort\` and message "${ORCHESTRATOR_NAME}" naming the conflicting files — never force anything and never resolve another agent's code alone.`,
    "3. Re-run the tests on the rebased branch. Red tests never merge: fix them on your branch, or commit what you have and report the failure instead.",
    `4. Land through Hive's capability gate: call \`hive_land\` with agent \`${agentName}\` and capabilityEpoch \`${capabilityEpoch}\`. The daemon performs the fast-forward-only merge of \`${branch}\` into \`${mainBranch}\`; never merge into the primary checkout directly.`,
    `5. If that merge is rejected because ${mainBranch} moved, return to step 2. After ${LANDING_MAX_ATTEMPTS} failed attempts, stop and message "${ORCHESTRATOR_NAME}".`,
    `6. Include the merge commit hash in your completion report. Do not delete your branch or worktree; hive cleans up landed branches.`,
  ].join("\n");
}

export function buildAgentPrompt(
  name: string,
  task: string,
  worktree: CreatedWorktree,
  repoRoot: string,
): string {
  return [
    `You are ${name}, a Hive writer agent.`,
    `Your task: ${task}`,
    `Your file scope is your worktree at ${worktree.path}; do all code and file work there.`,
    "Use the Hive MCP tools hive_send, hive_inbox, and hive_status to message and coordinate with other named agents.",
    `Send concise completion reports, blockers, and important findings to "${ORCHESTRATOR_NAME}" with hive_send; reference large artifacts instead of pasting them.`,
    buildLandingProtocol(worktree.branch, repoRoot, "main", name, 0),
  ].join("\n\n");
}

export class HiveSpawner implements Spawner {
  private readonly makeWorktree: WorktreeCreator;
  private readonly cleanupWorktree: WorktreeRemover;
  private readonly wait: Sleep;
  private readonly modelResolver: ModelResolver;

  constructor(private readonly dependencies: HiveSpawnerDependencies) {
    this.makeWorktree = dependencies.createWorktree ?? createWorktree;
    this.cleanupWorktree = dependencies.removeWorktree ?? removeWorktree;
    this.wait = dependencies.sleep ?? sleep;
    this.modelResolver = dependencies.resolveModel ?? resolveConcreteModel;
  }

  async restartForControl(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<AgentRecord> {
    if (agent.worktreePath === null) {
      throw new Error(`Cannot restart ${agent.name}: worktree is unavailable`);
    }
    const identity = agent.executionIdentity;
    if (
      identity === undefined || identity.model === "default" ||
      identity.tool !== agent.tool || identity.model !== agent.model
    ) {
      await this.failClosedControlRestart(
        agent,
        message,
        "no complete immutable execution identity is recorded (legacy or unresolved-default agent row)",
      );
      throw new Error(
        `Cannot restart ${agent.name} for critical control: no complete immutable execution identity is recorded. ` +
          "This legacy/unresolved row cannot be restarted safely without risking a model switch; capability remains revoked.",
      );
    }
    if (this.dependencies.quota === undefined) {
      await this.failClosedControlRestart(
        agent,
        message,
        "quota accounting is unavailable for the acknowledgement process",
      );
      throw new Error(
        `Cannot restart ${agent.name} for critical control: quota accounting is unavailable; capability remains revoked`,
      );
    }

    let reservationId: string;
    try {
      const reservation = await this.dependencies.quota.reserveControlRun({
        agentName: agent.name,
        tier: agent.tier,
        tool: identity.tool,
        model: identity.model,
        controlMessageId: message.id,
      });
      reservationId = reservation.id;
    } catch (error) {
      await this.failClosedControlRestart(
        agent,
        message,
        error instanceof Error ? error.message : "control quota reservation failed",
      );
      throw error;
    }

    const prepared = await this.prepareControlRestart(
      agent,
      message,
      reservationId,
    );
    const readOnly = true;
    let argv: string[];
    try {
      await provisionSkills(agent.worktreePath, identity.tool);
      if (identity.tool === "claude") {
        await writeClaudeAgentConfig(agent.worktreePath, {
          daemonPort: this.dependencies.port,
          name: agent.name,
          readOnly,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model: identity.model,
          name: agent.name,
          readOnly,
          worktreePath: agent.worktreePath,
        });
      } else {
        await writeCodexAgentConfig(agent.worktreePath, {
          daemonPort: this.dependencies.port,
          name: agent.name,
          readOnly,
        });
        argv = buildCodexSpawnCommand({
          daemonPort: this.dependencies.port,
          effort: identity.effort,
          model: identity.model,
          name: agent.name,
          readOnly,
          worktreePath: agent.worktreePath,
        });
      }
      argv.push([
        `CRITICAL HIVE CONTROL ${message.id} (capability epoch ${message.capabilityEpoch}).`,
        message.body,
        "Your prior process was stopped and its worktree was preserved.",
        "This process is read-only. Do not resume implementation or landing.",
        `Acknowledge with hive_ack_message using agent=${JSON.stringify(agent.name)}, messageId=${JSON.stringify(message.id)}, capabilityEpoch=${message.capabilityEpoch}.`,
        `Previous assignment for context only: ${agent.taskDescription}`,
      ].join("\n\n"));
      await this.dependencies.tmux.newSession(
        agent.tmuxSession,
        agent.worktreePath,
        shellJoin(argv),
      );
      const failureReason = await this.monitorControlReadiness(prepared.record);
      if (failureReason !== null) throw new Error(failureReason);
      this.dependencies.quota.markStarted(reservationId);
    } catch (error) {
      await this.dependencies.quota.cancel(reservationId);
      await this.dependencies.tmux.killSession(agent.tmuxSession, {
        ignoreMissing: true,
      }).catch(() => undefined);
      const reason = error instanceof Error
        ? error.message
        : "control acknowledgement process failed to launch";
      this.dependencies.db.insertAgent({
        ...prepared.record,
        status: "control-paused",
        writeRevoked: true,
        failureReason: `Critical control ${message.id} restart failed: ${reason}`,
        lastEventAt: new Date().toISOString(),
      });
      if (prepared.viewersChanged) this.dependencies.onTerminalsChanged?.();
      throw new Error(
        `Recorded ${identity.tool}/${identity.model} could not be launched for ${agent.name}: ${reason}`,
      );
    }

    const record = prepared.record;
    let viewersChanged = prepared.viewersChanged;
    if (!this.dependencies.config.headless) {
      let handle: Awaited<ReturnType<TerminalAdapter["openWindow"]>> | null =
        null;
      try {
        handle = await this.dependencies.terminal.openWindow(
          record.tmuxSession,
          buildAgentTerminalTitle(record.name, record.model),
        );
        const attached = this.dependencies.db.attachTerminalHandle(
          record.id,
          handle,
        );
        if (attached === null) {
          const orphanedHandle = handle;
          handle = null;
          await this.dependencies.terminal.closeWindow(orphanedHandle);
        } else {
          handle = null;
          viewersChanged = true;
        }
      } catch (error) {
        // Opening a viewer is cosmetic and does not affect the restart.
        this.dependencies.onTerminalError?.(
          `hive terminal: could not open viewer for ${record.name}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        if (handle !== null) {
          try {
            await this.dependencies.terminal.closeWindow(handle);
          } catch {
            // A viewer that vanished during launch needs no further cleanup.
          }
        }
      }
    }
    if (viewersChanged) {
      this.dependencies.onTerminalsChanged?.();
    }
    return this.dependencies.db.getAgentById(record.id) ?? record;
  }

  private async prepareControlRestart(
    agent: AgentRecord,
    message: AgentMessage,
    reservationId?: string,
    failureReason?: string,
  ): Promise<{ record: AgentRecord; viewersChanged: boolean }> {
    const current = this.dependencies.db.getAgentById(agent.id) ?? agent;
    const previousHandle = current.terminalHandle;
    const record = this.dependencies.db.insertAgent({
      ...current,
      status: "control-paused",
      writeRevoked: true,
      terminalHandle: undefined,
      controlMessageId: message.id,
      controlQuotaReservationId: reservationId,
      failureReason,
      lastEventAt: new Date().toISOString(),
    });
    if (previousHandle !== undefined) {
      try {
        await this.dependencies.terminal.closeWindow(previousHandle);
      } catch {
        // Closing a killed session's viewer is cosmetic; revocation persists.
      }
    }
    return { record, viewersChanged: previousHandle !== undefined };
  }

  private async failClosedControlRestart(
    agent: AgentRecord,
    message: AgentMessage,
    reason: string,
  ): Promise<void> {
    const prepared = await this.prepareControlRestart(
      agent,
      message,
      undefined,
      `Critical control ${message.id} is pending: ${reason}`,
    );
    if (prepared.viewersChanged) this.dependencies.onTerminalsChanged?.();
  }

  private async monitorControlReadiness(
    record: AgentRecord,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      await this.wait(READINESS_POLL_MS);
      const current = this.dependencies.db.getAgentById(record.id);
      if (current !== null && current.lastEventAt > record.lastEventAt) return null;
      if (!(await this.dependencies.tmux.hasSession(record.tmuxSession))) {
        return "tmux session exited";
      }
      try {
        const pane = await this.dependencies.tmux.capturePane(record.tmuxSession);
        const paneTail = tailLines(pane, 5);
        if (LAUNCH_FAILURE_PATTERNS.some((pattern) => pattern.test(paneTail))) {
          return tailLines(pane, 15) || "Control process launch error";
        }
      } catch {
        if (!(await this.dependencies.tmux.hasSession(record.tmuxSession))) {
          return "tmux session exited";
        }
      }
    }
    return null;
  }

  async spawn(request: SpawnRequest): Promise<AgentRecord> {
    const existingAgents = this.dependencies.db.listAgents();
    const name = resolveAgentName(request.name, existingAgents);
    const previousRecord = existingAgents.find((agent) => agent.name === name);
    if (!this.dependencies.db.reserveAgentName(name)) {
      throw new Error(
        `Agent name collision: "${name}" is already being assigned to a spawning agent`,
      );
    }
    try {
      return await this.spawnReserved(request, name, previousRecord);
    } finally {
      this.dependencies.db.releaseAgentName(name);
    }
  }

  private async spawnReserved(
    request: SpawnRequest,
    name: string,
    previousRecord: AgentRecord | undefined,
  ): Promise<AgentRecord> {
    const configuredRoute = await this.dependencies.routing(request.tier);
    let tool = request.tool ?? configuredRoute.tool;
    // The process, durable identity, terminal title, and hive_status all use
    // the same concrete model. A later control restart can therefore replay
    // the launch without consulting aliases or mutable tool defaults.
    let model = await this.modelResolver(tool, configuredRoute);
    let executionIdentity: ExecutionIdentity | undefined;
    let quotaReservationId: string | undefined;
    if (this.dependencies.quota?.config.enabled === true) {
      const [claudeModel, codexModel] = await Promise.all([
        this.modelResolver("claude", configuredRoute),
        this.modelResolver("codex", configuredRoute),
      ]);
      const decision = await this.dependencies.quota.routeAndReserve({
        agentName: name,
        tier: request.tier,
        preferredTool: configuredRoute.tool,
        ...(request.tool === undefined ? {} : { explicitTool: request.tool }),
        ...(request.reviewOfTool === undefined
          ? {}
          : { reviewOfTool: request.reviewOfTool }),
        candidates: [
          { tool: "claude", model: claudeModel },
          { tool: "codex", model: codexModel },
        ],
      });
      tool = decision.tool;
      model = decision.model;
      quotaReservationId = decision.reservation.id;
    }
    if (model !== "default") {
      executionIdentity = tool === "claude"
        ? { tool, model }
        : {
            tool,
            model,
            effort: configuredRoute.codex.effort ?? "medium",
          };
    }
    let worktree: CreatedWorktree;
    try {
      worktree = await this.makeWorktree(
        this.dependencies.repoRoot,
        name,
        slugify(request.task),
      );
    } catch (error) {
      if (quotaReservationId !== undefined) {
        await this.dependencies.quota?.cancel(quotaReservationId);
      }
      throw error;
    }
    const prompt = buildAgentPrompt(
      name,
      request.task,
      worktree,
      this.dependencies.repoRoot,
    );
    const timestamp = new Date().toISOString();
    const record = this.dependencies.db.insertAgent({
      id: previousRecord?.id ?? crypto.randomUUID(),
      name,
      tool,
      model,
      tier: request.tier,
      status: "spawning",
      taskDescription: request.task,
      worktreePath: worktree.path,
      branch: worktree.branch,
      tmuxSession: `hive-${name}`,
      contextPct: 0,
      createdAt: timestamp,
      lastEventAt: timestamp,
      ...(quotaReservationId === undefined ? {} : { quotaReservationId }),
      ...(executionIdentity === undefined ? {} : { executionIdentity }),
      capabilityEpoch: 0,
      writeRevoked: false,
    });

    let argv: string[];
    try {
      await provisionSkills(worktree.path, tool);
      if (tool === "claude") {
        await writeClaudeAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model,
          name,
          readOnly: false,
          worktreePath: worktree.path,
        });
      } else {
        await writeCodexAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
        });
        argv = buildCodexSpawnCommand({
          daemonPort: this.dependencies.port,
          effort: configuredRoute.codex.effort ?? "medium",
          model,
          name,
          readOnly: false,
          worktreePath: worktree.path,
        });
      }
      argv.push(prompt);

      await this.dependencies.tmux.newSession(
        record.tmuxSession,
        worktree.path,
        shellJoin(argv),
      );
      const failureReason = await this.monitorReadiness(record);
      if (failureReason !== null) {
        return await this.failSpawnIfStillSpawning(
          record,
          worktree,
          failureReason,
        );
      }
      if (quotaReservationId !== undefined) {
        this.dependencies.quota?.markStarted(quotaReservationId);
      }
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : "Agent launch failed";
      return await this.failSpawnIfStillSpawning(record, worktree, reason);
    }

    if (!this.dependencies.config.headless) {
      let handle: Awaited<ReturnType<TerminalAdapter["openWindow"]>> | null =
        null;
      try {
        handle = await this.dependencies.terminal.openWindow(
          record.tmuxSession,
          buildAgentTerminalTitle(record.name, record.model),
        );
        const attached = this.dependencies.db.attachTerminalHandle(
          record.id,
          handle,
        );
        if (attached === null) {
          const orphanedHandle = handle;
          handle = null;
          await this.dependencies.terminal.closeWindow(orphanedHandle);
        } else {
          handle = null;
          this.dependencies.onTerminalsChanged?.();
        }
      } catch (error) {
        // Opening a viewer is cosmetic and does not affect agent readiness.
        this.dependencies.onTerminalError?.(
          `hive terminal: could not open viewer for ${record.name}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        if (handle !== null) {
          try {
            await this.dependencies.terminal.closeWindow(handle);
          } catch {
            // A viewer that vanished during launch needs no further cleanup.
          }
        }
      }
    }
    return this.dependencies.db.getAgentById(record.id) ?? record;
  }

  private async monitorReadiness(record: AgentRecord): Promise<string | null> {
    const session = record.tmuxSession;
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      await this.wait(READINESS_POLL_MS);
      if (!this.isStillSpawning(record.id)) {
        return null;
      }
      if (!(await this.dependencies.tmux.hasSession(session))) {
        return "tmux session exited";
      }
      let pane: string;
      try {
        pane = await this.dependencies.tmux.capturePane(session);
      } catch (error) {
        if (!(await this.dependencies.tmux.hasSession(session))) {
          return "tmux session exited";
        }
        continue;
      }
      const paneTail = tailLines(pane, 5);
      if (LAUNCH_FAILURE_PATTERNS.some((pattern) => pattern.test(paneTail))) {
        return tailLines(pane, 15) || "Agent launch error";
      }
    }
    return null;
  }

  private isStillSpawning(agentId: string): boolean {
    const current = this.dependencies.db.getAgentById(agentId);
    return current === null || current.status === "spawning";
  }

  private async failSpawnIfStillSpawning(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
  ): Promise<AgentRecord> {
    const current = this.dependencies.db.getAgentById(record.id);
    if (current !== null && current.status !== "spawning") {
      return current;
    }
    return await this.failSpawn(record, worktree, failureReason);
  }

  private async failSpawn(
    record: AgentRecord,
    worktree: CreatedWorktree,
    failureReason: string,
  ): Promise<AgentRecord> {
    const failedAt = new Date().toISOString();
    let failed = this.dependencies.db.insertAgent({
      ...record,
      status: "failed",
      failureReason,
      failedAt,
      lastEventAt: failedAt,
    });
    if (record.quotaReservationId !== undefined) {
      await this.dependencies.quota?.cancel(record.quotaReservationId, failedAt);
    }
    const cleanupErrors: string[] = [];

    try {
      await this.dependencies.tmux.killSession(record.tmuxSession, {
        ignoreMissing: true,
      });
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : "tmux cleanup failed",
      );
    }

    if (!(this.dependencies.keepWorktreeOnFailure ?? false)) {
      try {
        await this.cleanupWorktree(
          this.dependencies.repoRoot,
          worktree.path,
          { deleteBranch: true },
        );
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error.message : "worktree cleanup failed",
        );
      }
    }

    if (cleanupErrors.length > 0) {
      failed = this.dependencies.db.insertAgent({
        ...failed,
        failureReason: `${failureReason}\nCleanup failed: ${cleanupErrors.join("; ")}`,
      });
    }
    return failed;
  }
}
