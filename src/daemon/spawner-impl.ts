import { join } from "node:path";
import { buildScopedBrief } from "../adapters/brief";
import { buildMemoryIndex } from "../adapters/memory";
import {
  buildAgentTerminalTitle,
  type TerminalAdapter,
} from "../adapters/terminal";
import { shellJoin } from "../adapters/tmux";
import type { TmuxAdapter } from "../adapters/tmux";
import {
  buildClaudeSpawnCommand,
  detectClaudeCliVersion,
  resolveClaudeExecutable,
  writeClaudeAgentConfig,
} from "../adapters/tools/claude";
import { CHANNELS_MIN_VERSION, versionAtLeast } from "./channels";
import {
  buildCodexSpawnCommand,
  writeCodexAgentConfig,
} from "../adapters/tools/codex";
import { listInheritedCodexMcpServers } from "../adapters/tools/mcp-scope";
import type { CodexAppServerManager } from "../adapters/tools/codex-app-server";
import { provisionSkills } from "../adapters/skills";
import {
  CLAUDE_BEST_MODEL,
  CLAUDE_OPUS_MODEL,
  resolveConcreteModel,
} from "../adapters/tools/models";
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
import type { QuotaRouteCandidate, QuotaService } from "./quota";
import { agentTmuxSession } from "./tmux-sessions";

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
type ClaudeVersionDetector = () => Promise<string | null>;

/** Mints one agent's capability, writes it to its 0600 credential file, and
 * returns the token. Absent (tests, tooling) the agent is launched with no
 * credential and its daemon calls fail closed rather than fail open. */
export type CredentialIssuer = (
  name: string,
  role: "writer" | "reader",
  epoch: number,
) => string;

export interface HiveSpawnerDependencies {
  db: AgentStore;
  repoRoot: string;
  port: number;
  issueCredential?: CredentialIssuer;
  config: Pick<HiveConfig, "terminal" | "headless"> & {
    codex?: Pick<HiveConfig["codex"], "driver">;
    /** Writer autonomy. Absent (older callers, tests) fails safe to
     * "sandboxed"; the parsed HiveConfig always supplies a value. */
    autonomy?: HiveConfig["autonomy"];
  };
  routing: RouteResolver;
  tmux: TmuxSessionManager;
  terminal: TerminalAdapter;
  createWorktree?: WorktreeCreator;
  removeWorktree?: WorktreeRemover;
  keepWorktreeOnFailure?: boolean;
  sleep?: Sleep;
  resolveModel?: ModelResolver;
  /** Reads the installed Claude CLI version to gate the Channels preview.
   * Returning null (or an old version) keeps the tmux fallback. */
  detectClaudeVersion?: ClaudeVersionDetector;
  /** Test seam for the daemon-resolved Claude binary. */
  claudeExecutable?: string;
  /** Test seam for reading the user's global Codex MCP server names. */
  listCodexMcpServers?: () => Promise<string[]>;
  /** Operator opt-out for the research preview; the fallback stays maintained. */
  channelsEnabled?: boolean;
  /** Fires after a viewer window is attached so the daemon can re-tile the
   * window wall. */
  onTerminalsChanged?: () => void;
  /** Reports viewer automation failures without treating the detached agent
   * process itself as failed. */
  onTerminalError?: (message: string) => void;
  quota?: QuotaService;
  codexAppServer?: Pick<
    CodexAppServerManager,
    "isAvailable" | "buildHostCommand" | "startAgent" | "disconnect"
  >;
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
  /^\[hive\] process exited with status \d+$/m,
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

/** Tiers whose prompt is trimmed to essentials. A `cheap` agent runs mechanical
 * work on a small model: it needs every *rule* the full prompt carries, but
 * none of the narration that justifies them. The trimmed text below is a
 * rewrite, not a subset — no step, bound, or prohibition is dropped, because
 * the landing protocol is Hive's safety stack and a cheap model is exactly the
 * one that must not have to infer a missing step. */
const CONCISE_TIERS: readonly RoutingTier[] = ["cheap"];

/** Reporting a landing is not finishing. Agents were observed idling at their
 * prompt while still holding authorized work, needing a nudge per stage — the
 * mirror image of the escalate-don't-grind tripwire (grind → escalate;
 * idle-with-work → continue). A live session is also the cheapest place to do
 * the next piece: a respawn re-reads everything from zero. */
const CONTINUOUS_EXECUTION =
  `After reporting a landing or milestone, immediately continue with the next authorized piece of your assignment in this same session. Stop only for a genuine blocker, an escalation, or an explicit hold from "${ORCHESTRATOR_NAME}".`;

export function buildLandingProtocol(
  branch: string,
  repoRoot: string,
  mainBranch = "main",
  agentName = branch.split("/")[1]?.split("-")[0] ?? "agent",
  capabilityEpoch = 0,
  concise = false,
): string {
  if (concise) {
    return [
      `When your task is done and tests are green, land it on ${mainBranch} — unlanded work is lost work:`,
      `1. Commit everything on \`${branch}\`.`,
      `2. \`git rebase ${mainBranch}\` in your worktree. On conflict: \`git rebase --abort\`, message "${ORCHESTRATOR_NAME}" with the conflicting file names, stop. Never force, never resolve another agent's code.`,
      "3. Re-run the tests. Skip that rerun only if `git diff --name-only ORIG_HEAD..HEAD` lists `.md` files alone. Red tests never merge: fix them, or commit and report the failure.",
      `4. Call \`hive_land\` with agent \`${agentName}\`, capabilityEpoch \`${capabilityEpoch}\`. Never merge into the primary checkout yourself.`,
      `5. Rejected because ${mainBranch} moved? Back to step 2, at most ${LANDING_MAX_ATTEMPTS} attempts, then message "${ORCHESTRATOR_NAME}".`,
      `6. Report the merge commit hash. Leave your branch and worktree in place.`,
    ].join("\n");
  }
  return [
    `When your task is complete and the tests are green, land your work on ${mainBranch} immediately — finished work left on your branch is lost work:`,
    `1. Commit everything on your branch (${branch}); never leave work uncommitted.`,
    `2. Rebase onto the latest ${mainBranch}: run \`git rebase ${mainBranch}\` in your worktree. If the rebase hits conflicts, run \`git rebase --abort\` and message "${ORCHESTRATOR_NAME}" naming the conflicting files — never force anything and never resolve another agent's code alone.`,
    "3. Re-run the tests on the rebased branch. You may skip that rerun only when `git diff --name-only ORIG_HEAD..HEAD` — what the rebase pulled in — lists nothing but `.md` files that no test reads: your pre-rebase green run still holds, so go straight to step 4. Red tests never merge: fix them on your branch, or commit what you have and report the failure instead.",
    `4. Land through Hive's capability gate: call \`hive_land\` with agent \`${agentName}\` and capabilityEpoch \`${capabilityEpoch}\`. The daemon performs the fast-forward-only merge of \`${branch}\` into \`${mainBranch}\`; never merge into the primary checkout directly.`,
    `5. If that merge is rejected because ${mainBranch} moved, return to step 2. After ${LANDING_MAX_ATTEMPTS} failed attempts, stop and message "${ORCHESTRATOR_NAME}".`,
    `6. Include the merge commit hash in your completion report. Do not delete your branch or worktree; hive cleans up landed branches.`,
  ].join("\n");
}

export interface AgentPromptOptions {
  /** Drives the prompt diet. Absent (tests, older callers) keeps the full text. */
  tier?: RoutingTier;
  /** Doc sections the task named, extracted at spawn. See adapters/brief.ts. */
  brief?: string;
}

export function buildAgentPrompt(
  name: string,
  task: string,
  worktree: CreatedWorktree,
  repoRoot: string,
  memoryIndex = "",
  options: AgentPromptOptions = {},
): string {
  const concise = options.tier !== undefined &&
    CONCISE_TIERS.includes(options.tier);
  const preamble = concise
    ? [
        `You are ${name}, a Hive writer agent.`,
        `Your task: ${task}`,
        `Work only inside your worktree at ${worktree.path}.`,
        `Report completion, blockers, and findings to "${ORCHESTRATOR_NAME}" with hive_send (hive_inbox and hive_status are also available). Reference artifacts by path; never paste them.`,
        `Read only what the task names. Search for the lines that matter rather than reading files whole. If the task is substantially bigger than briefed, stop and report rather than grinding.`,
        CONTINUOUS_EXECUTION,
      ]
    : [
        `You are ${name}, a Hive writer agent.`,
        `Your task: ${task}`,
        `Your file scope is your worktree at ${worktree.path}; do all code and file work there.`,
        "Use the Hive MCP tools hive_send, hive_inbox, and hive_status to message and coordinate with other named agents.",
        `Send concise completion reports, blockers, and important findings to "${ORCHESTRATOR_NAME}" with hive_send; reference large artifacts instead of pasting them.`,
        `Read only what the task needs: search for the lines that matter instead of reading large files whole, and reuse artifacts other agents already wrote instead of re-deriving them. If the task proves substantially larger than briefed, stop and report to "${ORCHESTRATOR_NAME}" rather than grinding.`,
        CONTINUOUS_EXECUTION,
      ];
  return [
    ...preamble,
    buildLandingProtocol(worktree.branch, repoRoot, "main", name, 0, concise),
    ...(options.brief === undefined || options.brief === ""
      ? []
      : [options.brief]),
    ...(memoryIndex === "" ? [] : [memoryIndex]),
  ].join("\n\n");
}

/** The worktree's own `.mcp.json`, written by `writeClaudeAgentConfig`. Naming
 * it explicitly is what lets `--strict-mcp-config` drop everything else. */
export function claudeMcpConfigPath(worktreePath: string): string {
  return join(worktreePath, ".mcp.json");
}

export class HiveSpawner implements Spawner {
  private readonly makeWorktree: WorktreeCreator;
  private readonly cleanupWorktree: WorktreeRemover;
  private readonly wait: Sleep;
  private readonly modelResolver: ModelResolver;
  private readonly detectClaudeVersion: ClaudeVersionDetector;
  private readonly claudeExecutable: string;

  constructor(private readonly dependencies: HiveSpawnerDependencies) {
    this.makeWorktree = dependencies.createWorktree ?? createWorktree;
    this.cleanupWorktree = dependencies.removeWorktree ?? removeWorktree;
    this.wait = dependencies.sleep ?? sleep;
    this.modelResolver = dependencies.resolveModel ?? resolveConcreteModel;
    this.claudeExecutable = dependencies.claudeExecutable ??
      resolveClaudeExecutable();
    this.detectClaudeVersion = dependencies.detectClaudeVersion ??
      (() => detectClaudeCliVersion(undefined, this.claudeExecutable));
  }

  /** Servers a Codex spawn would inherit from the user's global config. Read
   * once per spawn, never written. A read failure means "inherit nothing to
   * exclude" — the agent keeps today's surface rather than failing to launch. */
  private async inheritedCodexMcpServers(): Promise<string[]> {
    const list = this.dependencies.listCodexMcpServers ??
      listInheritedCodexMcpServers;
    try {
      return await list();
    } catch {
      return [];
    }
  }

  /**
   * Decide whether this Claude session launches with Channels. The capability
   * handshake still gates delivery at runtime (the bridge must register and
   * the CLI must accept the capability), so a false positive here degrades to
   * the tmux fallback rather than dropping messages.
   */
  private async useChannels(tool: "claude" | "codex"): Promise<boolean> {
    if (tool !== "claude") return false;
    if (this.dependencies.channelsEnabled === false) return false;
    const version = await this.detectClaudeVersion().catch(() => null);
    return version !== null && versionAtLeast(version, CHANNELS_MIN_VERSION);
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
    // The read-only control process carries its instruction in argv and needs
    // no message channel. A safety interruption must not depend on a research
    // preview, so the replacement never launches Channels — ordinary traffic
    // to a control-paused agent queues exactly as it did before.
    const channels = false;
    let argv: string[];
    // The restarted process is read-only, so it re-mints as a reader at the
    // freshly advanced epoch: the critical control that paused it has already
    // revoked its write and landing rights, and its old token is now stale.
    const capabilityToken = this.dependencies.issueCredential?.(
      agent.name,
      "reader",
      prepared.record.capabilityEpoch,
    );
    // The replacement process only has to read the control message and
    // acknowledge it through Hive's own server; the human's servers would be
    // pure context cost on a process that must not act.
    const excludeMcpServers = identity.tool === "codex"
      ? await this.inheritedCodexMcpServers()
      : [];
    try {
      await provisionSkills(agent.worktreePath, identity.tool);
      if (identity.tool === "claude") {
        await writeClaudeAgentConfig(agent.worktreePath, {
          daemonPort: this.dependencies.port,
          name: agent.name,
          readOnly,
          channels,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model: identity.model,
          name: agent.name,
          readOnly,
          worktreePath: agent.worktreePath,
          channels,
          executable: this.claudeExecutable,
          scopedMcpConfigPath: claudeMcpConfigPath(agent.worktreePath),
        });
      } else {
        await writeCodexAgentConfig(agent.worktreePath, {
          daemonPort: this.dependencies.port,
          name: agent.name,
          readOnly,
          ...(capabilityToken === undefined ? {} : { capabilityToken }),
        });
        const useAppServer =
          this.dependencies.config.codex?.driver === "app-server" &&
          (await this.dependencies.codexAppServer?.isAvailable() ?? false);
        if (useAppServer) {
          argv = this.dependencies.codexAppServer!.buildHostCommand(
            prepared.record,
            this.dependencies.port,
          );
        } else {
          argv = buildCodexSpawnCommand({
            daemonPort: this.dependencies.port,
            effort: identity.effort,
            model: identity.model,
            name: agent.name,
            readOnly,
            worktreePath: agent.worktreePath,
            excludeMcpServers,
          });
        }
      }
      const controlPrompt = [
        `CRITICAL HIVE CONTROL ${message.id} (capability epoch ${message.capabilityEpoch}).`,
        message.body,
        "Your prior process was stopped and its worktree was preserved.",
        "This process is read-only. Do not resume implementation or landing.",
        `Acknowledge with hive_ack_message using agent=${JSON.stringify(agent.name)}, messageId=${JSON.stringify(message.id)}, capabilityEpoch=${message.capabilityEpoch}.`,
        `Previous assignment for context only: ${agent.taskDescription}`,
      ].join("\n\n");
      const nativeCodex = identity.tool === "codex" &&
        this.dependencies.codexAppServer !== undefined &&
        argv[1] === "codex-app-server-host";
      if (!nativeCodex) argv.push(controlPrompt);
      await this.dependencies.tmux.newSession(
        agent.tmuxSession,
        agent.worktreePath,
        shellJoin(argv),
      );
      if (nativeCodex) {
        try {
          await this.dependencies.codexAppServer!.startAgent(
            prepared.record,
            controlPrompt,
            readOnly,
            identity.tool === "codex" ? identity.effort : "medium",
          );
        } catch {
          this.dependencies.codexAppServer!.disconnect(agent.name);
          await this.dependencies.tmux.killSession(agent.tmuxSession, {
            ignoreMissing: true,
          });
          const fallback = buildCodexSpawnCommand({
            daemonPort: this.dependencies.port,
            effort: identity.tool === "codex" ? identity.effort : "medium",
            model: identity.model,
            name: agent.name,
            readOnly,
            worktreePath: agent.worktreePath,
            excludeMcpServers,
          });
          fallback.push(controlPrompt);
          await this.dependencies.tmux.newSession(
            agent.tmuxSession,
            agent.worktreePath,
            shellJoin(fallback),
          );
        }
      }
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
      // The replacement process launches without Channels; the record must
      // agree so the registry never accepts a bridge for this session.
      channelsEnabled: false,
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
    // An explicit request model is a user directive: it launches verbatim
    // (no alias resolution) on the spawn's tool and is never substituted.
    let model = request.model ?? await this.modelResolver(tool, configuredRoute);
    let executionIdentity: ExecutionIdentity | undefined;
    let quotaReservationId: string | undefined;
    if (this.dependencies.quota?.config.enabled === true) {
      let candidates: QuotaRouteCandidate[];
      if (request.model !== undefined) {
        // The pinned model is the only candidate, and the spawn is bound to
        // its vendor: switching vendors away from a user-named model would
        // launch something other than what was asked for, and the Fable→Opus
        // release valve is equally a substitution, so neither applies here.
        // Unsafe quota still fails the spawn with the capacity report.
        candidates = [{ tool, model: request.model }];
      } else {
        const [claudeModel, codexModel] = await Promise.all([
          this.modelResolver("claude", configuredRoute),
          this.modelResolver("codex", configuredRoute),
        ]);
        candidates = [
          { tool: "claude", model: claudeModel },
          { tool: "codex", model: codexModel },
        ];
        // Fable draws heavy shared capacity. When a route resolves to it,
        // offer Opus 4.8 as a same-vendor release valve: listed after Fable so
        // ties (including the no-quota-configured default) keep preferring
        // Fable, but real quota pressure on Fable's pool can still pick Opus
        // when it has the better headroom. This does not require the
        // 2026-07-12 default-routing cutover — it applies whenever a route
        // resolves to Fable, explicitly or otherwise.
        if (claudeModel === CLAUDE_BEST_MODEL) {
          candidates.splice(1, 0, { tool: "claude", model: CLAUDE_OPUS_MODEL });
        }
      }
      const explicitTool = request.model !== undefined ? tool : request.tool;
      const decision = await this.dependencies.quota.routeAndReserve({
        agentName: name,
        tier: request.tier,
        preferredTool: configuredRoute.tool,
        ...(explicitTool === undefined ? {} : { explicitTool }),
        ...(request.reviewOfTool === undefined
          ? {}
          : { reviewOfTool: request.reviewOfTool }),
        candidates,
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
    const [memoryIndex, brief] = await Promise.all([
      buildMemoryIndex(worktree.path),
      // The brief reads the repo's own docs, so it is built from the worktree:
      // an agent's excerpt must match the tree it is about to edit.
      buildScopedBrief(worktree.path, request.task).catch(() => ""),
    ]);
    const prompt = buildAgentPrompt(
      name,
      request.task,
      worktree,
      this.dependencies.repoRoot,
      memoryIndex,
      { tier: request.tier, brief },
    );
    const channels = await this.useChannels(tool);
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
      tmuxSession: agentTmuxSession(name),
      contextPct: 0,
      createdAt: timestamp,
      lastEventAt: timestamp,
      ...(quotaReservationId === undefined ? {} : { quotaReservationId }),
      ...(executionIdentity === undefined ? {} : { executionIdentity }),
      recoveryAttempts: 0,
      capabilityEpoch: 0,
      writeRevoked: false,
      channelsEnabled: channels,
    });

    const dangerous = this.dependencies.config.autonomy === "dangerous";
    // Servers the human attached to their own Codex sessions. This agent did
    // not ask for them and pays for them on every message it sends, so the
    // spawn detaches them for its process only.
    const excludeMcpServers = tool === "codex"
      ? await this.inheritedCodexMcpServers()
      : [];
    let argv: string[];
    // A fresh writer is minted at epoch 0 with exactly one landing right, for
    // its own branch. It cannot spawn, approve, kill, or name another agent.
    const capabilityToken = this.dependencies.issueCredential?.(
      name,
      "writer",
      record.capabilityEpoch,
    );
    try {
      await provisionSkills(worktree.path, tool);
      if (tool === "claude") {
        await writeClaudeAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
          dangerous,
          channels,
        });
        argv = buildClaudeSpawnCommand({
          daemonPort: this.dependencies.port,
          model,
          name,
          readOnly: false,
          dangerous,
          worktreePath: worktree.path,
          channels,
          executable: this.claudeExecutable,
          scopedMcpConfigPath: claudeMcpConfigPath(worktree.path),
        });
      } else {
        await writeCodexAgentConfig(worktree.path, {
          daemonPort: this.dependencies.port,
          name,
          readOnly: false,
          ...(capabilityToken === undefined ? {} : { capabilityToken }),
        });
        const useAppServer =
          this.dependencies.config.codex?.driver === "app-server" &&
          (await this.dependencies.codexAppServer?.isAvailable() ?? false);
        argv = useAppServer
          ? this.dependencies.codexAppServer!.buildHostCommand(
              record,
              this.dependencies.port,
            )
          : buildCodexSpawnCommand({
              daemonPort: this.dependencies.port,
              effort: configuredRoute.codex.effort ?? "medium",
              model,
              name,
              readOnly: false,
              dangerous,
              worktreePath: worktree.path,
              excludeMcpServers,
            });
      }
      const nativeCodex = tool === "codex" &&
        this.dependencies.codexAppServer !== undefined &&
        argv[1] === "codex-app-server-host";
      if (!nativeCodex) argv.push(prompt);

      await this.dependencies.tmux.newSession(
        record.tmuxSession,
        worktree.path,
        shellJoin(argv),
      );
      if (nativeCodex) {
        try {
          await this.dependencies.codexAppServer!.startAgent(
            record,
            prompt,
            false,
            configuredRoute.codex.effort ?? "medium",
          );
        } catch {
          // The binary advertised app-server support but the control process
          // could not complete its handshake. Replace it immediately with the
          // maintained TUI path; tmux paste remains the automatic fallback.
          this.dependencies.codexAppServer!.disconnect(name);
          await this.dependencies.tmux.killSession(record.tmuxSession, {
            ignoreMissing: true,
          });
          this.dependencies.db.insertAgent({
            ...record,
            status: "spawning",
            lastEventAt: new Date().toISOString(),
          });
          const fallback = buildCodexSpawnCommand({
            daemonPort: this.dependencies.port,
            effort: configuredRoute.codex.effort ?? "medium",
            model,
            name,
            readOnly: false,
            dangerous,
            worktreePath: worktree.path,
            excludeMcpServers,
          });
          fallback.push(prompt);
          await this.dependencies.tmux.newSession(
            record.tmuxSession,
            worktree.path,
            shellJoin(fallback),
          );
        }
      }
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
