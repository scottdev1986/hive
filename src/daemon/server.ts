import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";
import { z } from "zod";
import { TmuxAdapter } from "../adapters/tmux";
import {
  closeTerminal,
  type TerminalAdapter,
  type TerminalCloser,
} from "../adapters/terminal";
import {
  CrashRecovery,
  type RecoveryOutcome,
  type SessionResolver,
} from "./recovery";
import {
  deleteMemoryFact as deleteMemoryFactFile,
  readMemoryFact,
  writeMemoryFact as writeMemoryFactFile,
} from "../adapters/memory";
import {
  assessStrandedWork,
  removeWorktree,
  type RemoveWorktreeOptions,
  type StrandedWork,
} from "../adapters/worktrees";
import {
  HookEventSchema,
  ControlIntentSchema,
  MemoryScopeSchema,
  MemoryWriteInputSchema,
  MessagePrioritySchema,
  ORCHESTRATOR_NAME,
  QuotaObservationSchema,
  StatuslineReportSchema,
  TerminalHandleSchema,
  type AgentRecord,
  type HiveConfig,
  type HookEvent,
  type MemoryFact,
  type MemoryScope,
  type MemoryWriteInput,
} from "../schemas";
import { ChannelRegistry } from "./channels";
import { HiveDatabase, type Approval } from "./db";
import type { LayoutCoordinator } from "./layout";
import { MemoryIndex } from "./memory-index";
import {
  BunTmuxSender,
  MessageDelivery,
  type TmuxSender,
} from "./delivery";
import {
  cleanupLifecycleFiles,
  readConfiguredPort,
  writeLifecycleFiles,
} from "./lifecycle";
import {
  compactActiveTeam,
  orchestratorTmuxSession,
} from "./orchestrator-lifecycle";
import {
  SpawnRequestSchema,
  type SpawnRequest,
  type Spawner,
} from "./spawner";
import type { QuotaService } from "./quota";
import {
  reapOrphanCodexHosts,
  type CodexAppServerManager,
  type ReapOrphanDependencies,
} from "../adapters/tools/codex-app-server";
import {
  assessResources,
  parseAvailableMemoryMb,
  parseProcessTable,
  runPs,
  runVmStat,
  type CommandOutput,
  type SessionProcessRoots,
} from "./resources";
import type { ResourceLimits } from "../schemas";

export const HIVE_VERSION = "0.1.0";

// Codex app-server hosts drop their pidfiles beside their sockets in /tmp
// (see defaultSocketPath); the daemon reaps children whose host died without
// running its own cleanup.
const CODEX_SOCKET_DIR = "/tmp";

function defaultOrphanDependencies(): ReapOrphanDependencies {
  return {
    listSocketDir: () => readdir(CODEX_SOCKET_DIR),
    readPidFile: (name) =>
      readFile(join(CODEX_SOCKET_DIR, name), "utf8"),
    removeFile: (name) => rm(join(CODEX_SOCKET_DIR, name), { force: true }),
    processCommand: async (pid) => {
      const child = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const [output, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return exitCode === 0 ? output.trim() : null;
    },
    kill: (pid) => process.kill(pid, "SIGKILL"),
  };
}

const SendRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  body: z.string(),
  priority: MessagePrioritySchema.optional(),
  intent: ControlIntentSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  deadlineMs: z.number().int().positive().optional(),
});

const MessageAcknowledgementSchema = z.object({
  agent: z.string().min(1),
  messageId: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative().optional(),
  applied: z.boolean().optional().default(false),
});

export function inferLegacyControl(body: string):
  { priority: "critical"; intent: "pause" | "stop" | "cancel" | "restrict-writes" } |
  null {
  const value = body.trim().toLowerCase();
  if (/^cancel(?:\s+(?:this task|work|now))?[.!]?$/.test(value)) {
    return { priority: "critical", intent: "cancel" };
  }
  if (/^stop(?:\s+(?:this task|work|now|working))?[.!]?$/.test(value)) {
    return { priority: "critical", intent: "stop" };
  }
  if (/^(?:pause before (?:coding|writing|modifying)|pause work)\b/.test(value)) {
    return { priority: "critical", intent: "pause" };
  }
  if (/^(?:do not|don't) (?:modify|write|edit)\b/.test(value)) {
    return { priority: "critical", intent: "restrict-writes" };
  }
  return null;
}

const InboxRequestSchema = z.object({
  agent: z.string().min(1),
});

const ReadMessageRequestSchema = z.object({
  id: z.string().min(1),
});

const StatusRequestSchema = z.object({
  detail: z.enum(["full", "active"]).optional(),
});

const QuotaObservationRequestSchema = QuotaObservationSchema.omit({
  observedAt: true,
}).extend({
  observedAt: z.iso.datetime({ offset: true }).optional(),
});

const MarkDeadRequestSchema = z.object({
  agent: z.string().min(1),
});

const KillRequestSchema = z.object({
  name: z.string().min(1),
  removeWorktree: z.boolean().optional(),
  discardWork: z.boolean().optional(),
});

const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
});

const OrchestratorTerminalRequestSchema = z.object({
  handle: TerminalHandleSchema,
});

const ViewerRequestSchema = z.object({
  agent: z.string().min(1),
  handle: TerminalHandleSchema,
});

const LandRequestSchema = z.object({
  agent: z.string().min(1),
  capabilityEpoch: z.number().int().nonnegative(),
});

const MemorySearchRequestSchema = z.object({
  query: z.string().min(1),
  scope: MemoryScopeSchema.optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const MemoryFactRequestSchema = z.object({
  scope: MemoryScopeSchema,
  id: z.string().min(1),
});

const ChannelRegisterSchema = z.object({
  agent: z.string().min(1),
  clientName: z.string().min(1).default("unknown"),
  clientVersion: z.string().min(1),
});

const ChannelPollSchema = z.object({
  agent: z.string().min(1),
  waitMs: z.number().int().nonnegative().max(60_000).default(25_000),
});

const ChannelAckSchema = z.object({
  agent: z.string().min(1),
  deliveryId: z.string().min(1),
  ok: z.boolean(),
});

const ChannelPermissionRequestSchema = z.object({
  agent: z.string().min(1),
  requestId: z.string().min(1),
  toolName: z.string().min(1).default("tool"),
  description: z.string().default(""),
  inputPreview: z.string().default(""),
});

export type LandBranch = (
  repoRoot: string,
  branch: string,
) => Promise<{ commit: string }>;

const landBranch: LandBranch = async (repoRoot, branch) => {
  const merge = Bun.spawn(
    ["git", "-C", repoRoot, "merge", "--ff-only", branch],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    merge.exited,
    new Response(merge.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git merge exited ${exitCode}`);
  }
  const revision = Bun.spawn(
    ["git", "-C", repoRoot, "rev-parse", "HEAD"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [revisionExit, stdout, revisionError] = await Promise.all([
    revision.exited,
    new Response(revision.stdout).text(),
    new Response(revision.stderr).text(),
  ]);
  if (revisionExit !== 0) throw new Error(revisionError.trim());
  return { commit: stdout.trim() };
};

export interface HiveDaemonOptions {
  spawner: Spawner;
  db?: HiveDatabase;
  tmuxSender?: TmuxSender;
  tmux?: Pick<
    TmuxAdapter,
    "hasSession" | "killSession" | "capturePane" | "newSession"
  >;
  closeTerminal?: TerminalCloser;
  /** Viewer adapter for reopening windows on crash-recovered agents; omit in
   * headless setups. */
  terminal?: TerminalAdapter;
  recovery?: {
    resolveClaudeSessionId?: SessionResolver;
    resolveCodexSessionId?: SessionResolver;
    worktreeExists?: (path: string) => boolean;
    sleep?: (milliseconds: number) => Promise<void>;
  };
  /** Writer autonomy, forwarded to crash recovery so a resumed agent relaunches
   * with the posture it spawned with. */
  autonomy?: HiveConfig["autonomy"];
  repoRoot?: string;
  removeWorktree?: (
    repoRoot: string,
    worktreePath: string,
    options?: RemoveWorktreeOptions | boolean,
  ) => Promise<void>;
  assessStrandedWork?: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
  ) => Promise<StrandedWork>;
  landBranch?: LandBranch;
  port?: number;
  hostname?: string;
  manageLifecycle?: boolean;
  layout?: LayoutCoordinator;
  quota?: QuotaService;
  codexControl?: Pick<
    CodexAppServerManager,
    | "hasAgent"
    | "isTurnActive"
    | "deliver"
    | "interrupt"
    | "denyAgentApprovals"
    | "disconnect"
    | "resolveApproval"
    | "close"
  >;
  /** Memory watchdog limits; the sweep stays off when omitted so embedded
   * daemons (tests, tooling) never sample or kill real processes. */
  resources?: ResourceLimits;
  /** Test seams for the resource sweep's process interrogation. */
  resourceRunners?: {
    ps?: CommandOutput;
    vmStat?: CommandOutput;
    panePids?: (session: string) => Promise<number[]>;
    kill?: (pid: number) => void;
    orphans?: ReapOrphanDependencies | null;
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function toolResult(value: unknown, key: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { [key]: value },
  };
}

export class HiveDaemon {
  readonly db: HiveDatabase;
  readonly delivery: MessageDelivery;
  readonly channels: ChannelRegistry;
  readonly spawner: Spawner;
  readonly memory: MemoryIndex;
  private memoryLock: Promise<unknown> = Promise.resolve();
  private readonly ownsDatabase: boolean;
  private readonly port: number;
  private readonly hostname: string;
  private readonly manageLifecycle: boolean;
  private readonly tmux: Pick<
    TmuxAdapter,
    "hasSession" | "killSession" | "capturePane" | "newSession"
  >;
  private readonly recovery: CrashRecovery;
  private readonly repoRoot: string;
  private readonly cleanupWorktree: typeof removeWorktree;
  private readonly assessStranded: NonNullable<
    HiveDaemonOptions["assessStrandedWork"]
  >;
  private readonly closeTerminal: TerminalCloser;
  private readonly layout: LayoutCoordinator | null;
  private readonly quota: QuotaService | undefined;
  private readonly codexControl: HiveDaemonOptions["codexControl"];
  private readonly land: LandBranch;
  private bunServer: Server<undefined> | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunning = false;
  private readonly resources: ResourceLimits | null;
  private readonly psSample: CommandOutput;
  private readonly vmStatSample: CommandOutput;
  private readonly panePids: (session: string) => Promise<number[]>;
  private readonly killProcess: (pid: number) => void;
  private readonly orphanDependencies: ReapOrphanDependencies | null;
  private memoryPressure = false;

  constructor(options: HiveDaemonOptions) {
    this.ownsDatabase = options.db === undefined;
    this.db = options.db ?? new HiveDatabase();
    this.memory = new MemoryIndex(this.db.database);
    this.spawner = options.spawner;
    this.port = options.port ?? readConfiguredPort();
    this.hostname = options.hostname ?? "127.0.0.1";
    this.manageLifecycle = options.manageLifecycle ?? false;
    this.tmux = options.tmux ?? new TmuxAdapter();
    this.quota = options.quota;
    this.codexControl = options.codexControl;
    this.channels = new ChannelRegistry(this.db);
    this.delivery = new MessageDelivery(
      this.db,
      options.tmuxSender ?? new BunTmuxSender(),
      {
        interruptAndRestart: async (agent, message) => {
          const sameControlAttempt = agent.controlMessageId === message.id &&
            agent.controlQuotaReservationId !== undefined &&
            this.quota?.ledger.getReservation(agent.controlQuotaReservationId)
                ?.status === "active";
          if (
            sameControlAttempt &&
            await this.tmux.hasSession(agent.tmuxSession)
          ) {
            // The daemon may have crashed after launch but before advancing the
            // message. Reuse the surviving process and reservation exactly.
            return;
          }
          if (!sameControlAttempt) {
            if (agent.tool === "codex" && this.codexControl?.hasAgent(agent.name)) {
              await this.codexControl.denyAgentApprovals(agent.name);
              await this.codexControl.interrupt(agent).catch(() => undefined);
              this.codexControl.disconnect(agent.name);
            }
            await this.tmux.killSession(agent.tmuxSession, {
              ignoreMissing: true,
            });
            await this.settleAgentQuota(agent);
          }
          if (this.quota === undefined) {
            throw new Error(
              "quota accounting is unavailable; read-only control restart was not launched",
            );
          }
          if (this.spawner.restartForControl === undefined) {
            throw new Error(
              `Spawner cannot restart ${agent.name} for critical control`,
            );
          }
          await this.spawner.restartForControl(agent, message);
        },
      },
      this.codexControl,
      this.channels,
    );
    this.quota?.setAlertSink(async (body) => {
      await this.delivery.send("hive-quota", ORCHESTRATOR_NAME, body);
    });
    this.closeTerminal = options.closeTerminal ?? closeTerminal;
    this.layout = options.layout ?? null;
    this.land = options.landBranch ?? landBranch;
    this.resources = options.resources ?? null;
    this.psSample = options.resourceRunners?.ps ?? runPs;
    this.vmStatSample = options.resourceRunners?.vmStat ?? runVmStat;
    this.panePids = options.resourceRunners?.panePids ??
      ((session) => new TmuxAdapter().listPanePids(session));
    this.killProcess = options.resourceRunners?.kill ??
      ((pid) => process.kill(pid, "SIGKILL"));
    this.orphanDependencies = options.resourceRunners?.orphans === undefined
      ? defaultOrphanDependencies()
      : options.resourceRunners.orphans;
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.cleanupWorktree = options.removeWorktree ?? removeWorktree;
    this.assessStranded = options.assessStrandedWork ?? assessStrandedWork;
    this.recovery = new CrashRecovery({
      db: this.db,
      tmux: this.tmux,
      port: this.port,
      dropChannel: (agentName) => this.channels.drop(agentName),
      closeTerminal: (handle) => this.closeTerminal(handle),
      send: (from, to, body, sendOptions) =>
        this.delivery.send(from, to, body, sendOptions),
      settleQuota: (agent) => this.settleAgentQuota(agent),
      flushQueued: (agentName) => this.delivery.flushQueued(agentName),
      terminal: options.terminal,
      onTerminalsChanged: () => this.layout?.requestLayout(),
      ...(options.recovery?.resolveClaudeSessionId === undefined
        ? {}
        : { resolveClaudeSessionId: options.recovery.resolveClaudeSessionId }),
      ...(options.recovery?.resolveCodexSessionId === undefined
        ? {}
        : { resolveCodexSessionId: options.recovery.resolveCodexSessionId }),
      ...(options.recovery?.worktreeExists === undefined
        ? {}
        : { worktreeExists: options.recovery.worktreeExists }),
      ...(options.recovery?.sleep === undefined
        ? {}
        : { sleep: options.recovery.sleep }),
    });
  }

  get server(): Server<undefined> | null {
    return this.bunServer;
  }

  get listeningPort(): number | null {
    return this.bunServer?.port ?? null;
  }

  start(): Server<undefined> {
    if (this.bunServer !== null) {
      return this.bunServer;
    }
    this.bunServer = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      fetch: (request) => this.fetch(request),
    });
    const listeningPort = this.bunServer.port;
    if (listeningPort === undefined) {
      throw new Error("Hive daemon did not bind to a TCP port");
    }
    if (this.manageLifecycle) {
      writeLifecycleFiles(listeningPort);
    }
    // Spawn-name reservations belong to spawns in flight inside one daemon
    // process; any row present at startup was stranded by a crash and would
    // make its agent look forever in-flight to crash recovery.
    this.db.clearAgentNameReservations();
    this.reconciliationTimer = setInterval(() => {
      void this.runMaintenance().catch((error) => {
        console.error(
          `Hive reconciliation failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      void this.delivery.alertExpiredControls().catch((error) => {
        console.error(
          `Hive control deadline check failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
    }, 30_000);
    this.reconciliationTimer.unref?.();
    void this.runMaintenance().catch((error) => {
      console.error(
        `Hive startup recovery failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    // The Markdown files are authoritative and the FTS index is disposable,
    // so every daemon start rebuilds it rather than trusting whatever the
    // SQLite file happened to have from a previous run.
    void this.rebuildMemoryIndex().catch((error) => {
      console.error(
        `Hive memory reindex failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    return this.bunServer;
  }

  // Memory writes/deletes/reindexes are serialized through one promise
  // chain (SPEC.md decision 5: "the daemon serializes writes") so concurrent
  // MCP calls never race on slug generation or interleave a rebuild with an
  // in-flight upsert.
  private serializeMemory<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.memoryLock.then(operation, operation);
    this.memoryLock = run.then(() => undefined, () => undefined);
    return run;
  }

  async writeMemoryFact(input: MemoryWriteInput): Promise<MemoryFact> {
    return this.serializeMemory(async () => {
      const fact = await writeMemoryFactFile(this.repoRoot, input);
      this.memory.upsertFact(fact);
      return fact;
    });
  }

  async deleteMemoryFact(scope: MemoryScope, id: string): Promise<boolean> {
    return this.serializeMemory(async () => {
      const deleted = await deleteMemoryFactFile(this.repoRoot, scope, id);
      if (deleted) {
        this.memory.removeFact(scope, id);
      }
      return deleted;
    });
  }

  async rebuildMemoryIndex(): Promise<number> {
    return this.serializeMemory(() => this.memory.rebuild(this.repoRoot));
  }

  private async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      await this.recoverQuotaReservations();
      await this.delivery.recoverCriticalControls();
      await this.reconcileAgents();
      await this.sweepResources();
      this.db.pruneHistory(new Date().toISOString());
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * The memory watchdog (SPEC.md "Resource safety"): hard-kill any process
   * under a hive-owned tmux session that exceeds the per-process ceiling,
   * pause spawning while the system is low on reclaimable memory, and reap
   * codex app-server children orphaned by a dead host. Every action lands as
   * a durable orchestrator message, so degradation is visible, not silent.
   */
  async sweepResources(): Promise<void> {
    const limits = this.resources;
    if (limits === null || !limits.enabled) return;
    try {
      const [psRaw, vmRaw] = await Promise.all([
        this.psSample(),
        this.vmStatSample(),
      ]);
      const sessions: SessionProcessRoots[] = [];
      const watched = [
        { owner: ORCHESTRATOR_NAME, session: orchestratorTmuxSession() },
        ...this.db.listAgents()
          .filter((agent) =>
            agent.status !== "dead" && agent.status !== "done" &&
            agent.status !== "failed"
          )
          .map((agent) => ({ owner: agent.name, session: agent.tmuxSession })),
      ];
      for (const target of watched) {
        try {
          sessions.push({
            owner: target.owner,
            rootPids: await this.panePids(target.session),
          });
        } catch {
          // A vanished session has no processes left to watch.
        }
      }
      const assessment = assessResources({
        samples: parseProcessTable(psRaw),
        sessions,
        daemonPid: process.pid,
        availableMb: parseAvailableMemoryMb(vmRaw),
        limits,
      });
      this.memoryPressure = assessment.memoryPressure;
      for (const kill of assessment.kills) {
        try {
          this.killProcess(kill.process.pid);
        } catch {
          continue;
        }
        await this.delivery.send(
          "hive-resources",
          ORCHESTRATOR_NAME,
          `Hive memory watchdog killed pid ${kill.process.pid} under ${kill.owner} ` +
            `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
            `${kill.process.command.slice(0, 160)}. The ${kill.owner} session itself is still running; ` +
            `check whether its work needs to be retried.`,
          { idempotencyKey: `resource-kill:${kill.process.pid}` },
        ).catch(() => undefined);
      }
      if (assessment.memoryPressure && assessment.availableMb !== null) {
        await this.delivery.send(
          "hive-resources",
          ORCHESTRATOR_NAME,
          `Hive paused agent spawning: ${Math.round(assessment.availableMb)} MB of ` +
            `reclaimable system memory is below the ${limits.minSystemAvailableMb} MB floor. ` +
            "Spawns resume automatically once memory pressure clears.",
          // One alert per hour of sustained pressure, not one per sweep.
          { idempotencyKey: `resource-pressure:${new Date().toISOString().slice(0, 13)}` },
        ).catch(() => undefined);
      }
      await this.reapCodexOrphans();
    } catch (error) {
      console.error(
        `Hive resource sweep failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  private async reapCodexOrphans(): Promise<void> {
    if (this.orphanDependencies === null) return;
    const reaped = await reapOrphanCodexHosts((id) => {
      const agent = this.db.getAgentById(id);
      if (agent === null) return "unknown";
      return agent.status === "dead" || agent.status === "done" ||
          agent.status === "failed"
        ? "dead"
        : "live";
    }, this.orphanDependencies);
    for (const pid of reaped) {
      await this.delivery.send(
        "hive-resources",
        ORCHESTRATOR_NAME,
        `Hive reaped an orphaned codex app-server (pid ${pid}) left behind by a dead agent's host process.`,
        { idempotencyKey: `resource-reap:${pid}` },
      ).catch(() => undefined);
    }
  }

  async recoverQuotaReservations(): Promise<number> {
    if (this.quota === undefined) return 0;
    const expired = await this.quota.recoverExpiredReservations();
    let viewersChanged = false;
    for (const reservation of expired) {
      if (reservation.purpose !== "control") continue;
      const agent = this.db.getAgentByName(reservation.agentName);
      if (agent?.controlQuotaReservationId !== reservation.id) continue;
      await this.tmux.killSession(agent.tmuxSession, { ignoreMissing: true });
      const detached = this.db.markAgentDeadAndDetachTerminal(
        agent.id,
        new Date().toISOString(),
        `Critical control acknowledgement process timed out (reservation ${reservation.id})`,
      );
      if (detached?.terminalHandle !== undefined) {
        viewersChanged = true;
        await this.closeTerminal(detached.terminalHandle).catch(() => undefined);
      }
      await this.delivery.send(
        "hive-control",
        ORCHESTRATOR_NAME,
        `Critical control acknowledgement process for ${agent.name} timed out. ` +
          `Reservation ${reservation.id} settled conservatively; the process was stopped, ` +
          "write and landing capability remain revoked, and the worktree is preserved.",
        { idempotencyKey: `control-quota-timeout:${reservation.id}` },
      ).catch(() => undefined);
    }
    if (viewersChanged) this.layout?.requestLayout();
    return expired.length;
  }

  private async settleAgentQuota(
    agent: AgentRecord,
    at?: string,
  ): Promise<void> {
    const reservationId = agent.controlQuotaReservationId ??
      agent.quotaReservationId;
    if (reservationId !== undefined) {
      await this.quota?.cancel(reservationId, at);
    }
  }

  async stop(): Promise<void> {
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    this.bunServer?.stop(true);
    this.bunServer = null;
    this.codexControl?.close();
    if (this.manageLifecycle) {
      cleanupLifecycleFiles();
    }
    if (this.ownsDatabase) {
      this.db.close();
    }
  }

  // Crash detection and recovery: any agent whose status claims a process
  // but whose tmux session is gone gets classified — resumable active work
  // is relaunched with the tool's native resume; everything else is marked
  // dead with its worktree preserved and the stranded state surfaced.
  async reconcileAgents(): Promise<RecoveryOutcome[]> {
    return this.recovery.sweep();
  }

  async recoverCrashedAgents(name?: string): Promise<RecoveryOutcome[]> {
    if (name !== undefined) {
      return [await this.recovery.recoverAgent(name)];
    }
    return this.recovery.sweep();
  }

  async landAgent(
    name: string,
    capabilityEpoch: number,
  ): Promise<{ commit: string }> {
    const agent = this.db.getAgentByName(name);
    if (agent === null || agent.branch === null) {
      throw new Error(`Agent branch not found: ${name}`);
    }
    if (agent.writeRevoked || agent.capabilityEpoch !== capabilityEpoch) {
      throw new Error(
        `Landing capability revoked or stale for ${name}: current epoch ${agent.capabilityEpoch}`,
      );
    }
    return this.land(this.repoRoot, agent.branch);
  }

  async acknowledgeControlMessage(
    agentName: string,
    messageId: string,
    capabilityEpoch: number | undefined,
    applied: boolean,
  ) {
    const message = this.delivery.acknowledge(
      agentName,
      messageId,
      capabilityEpoch,
      applied,
    );
    const record = this.db.getAgentByName(agentName);
    if (
      message.priority === "critical" &&
      record?.controlMessageId === messageId &&
      record.controlQuotaReservationId !== undefined
    ) {
      await this.quota?.cancel(record.controlQuotaReservationId);
    }
    return message;
  }

  async queueCodexApproval(
    agentName: string,
    description: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.insertApproval({
        id,
        agentName,
        description,
        status: "pending",
        createdAt,
        resolvedAt: null,
      });
      const agent = this.db.getAgentByName(agentName);
      if (
        agent !== null && agent.status !== "dead" && agent.status !== "done" &&
        agent.status !== "failed"
      ) {
        this.db.upsertAgent({
          ...agent,
          status: agent.writeRevoked ? "control-paused" : "awaiting-approval",
          lastEventAt: createdAt,
        });
      }
    });
    return id;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, version: HIVE_VERSION });
    }
    if (url.pathname === "/event" && request.method === "POST") {
      return this.receiveEvent(request);
    }
    if (url.pathname === "/orchestrator-terminal") {
      if (request.method === "POST") {
        return this.registerOrchestratorTerminal(request);
      }
      if (request.method === "DELETE") {
        this.db.clearOrchestratorTerminal();
        return json({ ok: true });
      }
    }
    if (url.pathname === "/viewer" && request.method === "POST") {
      return this.attachViewer(request);
    }
    if (url.pathname === "/statusline" && request.method === "POST") {
      return this.receiveStatusline(request);
    }
    if (request.method === "POST" && url.pathname.startsWith("/channel/")) {
      return this.handleChannel(url.pathname, request);
    }
    if (url.pathname === "/recover" && request.method === "POST") {
      return this.recoverEndpoint(request);
    }
    if (url.pathname === "/mcp") {
      return this.handleMcp(request);
    }
    return json({ error: "Not found" }, { status: 404 });
  }

  private async handleChannel(
    pathname: string,
    request: Request,
  ): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid channel request" }, { status: 400 });
    }
    try {
      if (pathname === "/channel/register") {
        const parsed = ChannelRegisterSchema.parse(body);
        return json(this.channels.register(
          parsed.agent,
          parsed.clientName,
          parsed.clientVersion,
        ));
      }
      if (pathname === "/channel/poll") {
        const parsed = ChannelPollSchema.parse(body);
        try {
          const events = await this.channels.poll(parsed.agent, parsed.waitMs);
          return json({ events });
        } catch (error) {
          // An unknown connection (daemon restart) tells the bridge to
          // re-register rather than spin.
          return json(
            {
              error: error instanceof Error
                ? error.message
                : "channel poll failed",
            },
            { status: 404 },
          );
        }
      }
      if (pathname === "/channel/ack") {
        const parsed = ChannelAckSchema.parse(body);
        this.channels.ack(parsed.agent, parsed.deliveryId, parsed.ok);
        return json({ ok: true });
      }
      if (pathname === "/channel/permission-request") {
        const parsed = ChannelPermissionRequestSchema.parse(body);
        return this.receiveChannelPermissionRequest(parsed);
      }
    } catch (error) {
      return json(
        {
          error: error instanceof Error
            ? error.message
            : "Invalid channel request",
        },
        { status: 400 },
      );
    }
    return json({ error: "Not found" }, { status: 404 });
  }

  private receiveChannelPermissionRequest(request: {
    agent: string;
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): Response {
    const agent = this.db.getAgentByName(request.agent);
    if (
      agent === null || agent.status === "dead" || agent.status === "done" ||
      agent.status === "failed"
    ) {
      return json(
        { error: `Hive agent not found or not live: ${request.agent}` },
        { status: 404 },
      );
    }
    const timestamp = new Date().toISOString();
    const approval = this.db.transaction(() => {
      const created = this.db.insertApproval({
        id: crypto.randomUUID(),
        agentName: agent.name,
        description: [
          `${request.toolName}: ${request.description}`.trim(),
          request.inputPreview.slice(0, 500),
        ].filter((part) => part.length > 0).join("\n"),
        status: "pending",
        createdAt: timestamp,
        resolvedAt: null,
      });
      if (!agent.writeRevoked) {
        this.db.upsertAgent({
          ...agent,
          status: "awaiting-approval",
          lastEventAt: timestamp,
        });
      }
      return created;
    });
    this.channels.notePermissionRequest(
      agent.name,
      request.requestId,
      approval.id,
    );
    return json({ approval });
  }

  private async receiveStatusline(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid statusline report" }, { status: 400 });
    }
    const parsed = StatuslineReportSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid statusline report", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const agent = this.db.getAgentByName(parsed.data.agent);
    if (agent === null) {
      return json(
        { error: `Hive agent not found: ${parsed.data.agent}` },
        { status: 404 },
      );
    }
    const observation = await this.quota?.observeStatusline(
      { tool: agent.tool, model: agent.model },
      {
        ...(parsed.data.fiveHour === undefined
          ? {}
          : { fiveHour: parsed.data.fiveHour }),
        ...(parsed.data.sevenDay === undefined
          ? {}
          : { sevenDay: parsed.data.sevenDay }),
        observedAt: parsed.data.observedAt ?? new Date().toISOString(),
      },
    ) ?? null;
    return json({ observation });
  }

  private async registerOrchestratorTerminal(
    request: Request,
  ): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid terminal handle" }, { status: 400 });
    }
    const parsed = OrchestratorTerminalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid terminal handle", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    this.db.setOrchestratorTerminal(parsed.data.handle);
    // Registration alone leaves a lone orchestrator window untouched; the
    // wall only starts moving once agent viewers exist.
    const hasViewers = this.db.listAgents().some((agent) =>
      agent.terminalHandle !== undefined &&
      agent.status !== "dead" && agent.status !== "done" &&
      agent.status !== "failed"
    );
    if (hasViewers) {
      this.layout?.requestLayout();
    }
    return json({ ok: true });
  }

  private async recoverEndpoint(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const parsed = z.object({ agent: z.string().min(1).optional() })
      .safeParse(body ?? {});
    if (!parsed.success) {
      return json(
        { error: "Invalid recover request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    try {
      const outcomes = await this.recoverCrashedAgents(parsed.data.agent);
      return json({ outcomes });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Recovery failed" },
        { status: 500 },
      );
    }
  }

  private async attachViewer(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid viewer request" }, { status: 400 });
    }
    const parsed = ViewerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid viewer request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const agent = this.db.getAgentByName(parsed.data.agent);
    if (agent === null) {
      return json(
        { error: `Hive agent not found: ${parsed.data.agent}` },
        { status: 404 },
      );
    }
    const attached = this.db.attachTerminalHandle(agent.id, parsed.data.handle);
    if (attached === null) {
      return json(
        { error: `Hive agent is no longer live: ${parsed.data.agent}` },
        { status: 409 },
      );
    }
    this.layout?.requestLayout();
    return json({ agent: attached });
  }

  async processEvent(event: HookEvent): Promise<void> {
    const value = HookEventSchema.parse(event);
    this.db.transaction(() => {
      this.db.insertEvent(value);

      const agent = this.db.getAgentByName(value.agentName);
      if (
        agent !== null &&
        agent.status !== "dead" &&
        agent.status !== "done" &&
        agent.status !== "failed"
      ) {
        const updated: AgentRecord = {
          ...agent,
          status: agent.writeRevoked && value.kind !== "dead"
            ? "control-paused"
            : value.kind === "dead"
            ? "dead"
            : value.kind === "turn-start"
              ? "working"
              : value.kind === "approval-request"
                ? "awaiting-approval"
                : value.kind === "notification"
                  ? agent.status
                : "idle",
          contextPct: value.kind === "turn-end" &&
              value.contextPct !== undefined
            ? value.contextPct
            : agent.contextPct,
          lastEventAt: new Date(value.timestamp).toISOString(),
          // The tool-level session identity rides on hook traffic (Claude's
          // stdin payload, Codex's notify thread-id); a resume forks Claude
          // to a fresh id, so the newest observation always wins.
          ...(value.toolSessionId === undefined
            ? {}
            : { toolSessionId: value.toolSessionId }),
          // A completed turn proves the process is genuinely healthy, so the
          // crash-resume budget rearms.
          ...(value.kind === "turn-end" && agent.recoveryAttempts > 0
            ? { recoveryAttempts: 0 }
            : {}),
        };
        this.db.upsertAgent(updated);
      }

      if (value.kind === "approval-request") {
        this.db.insertApproval({
          id: crypto.randomUUID(),
          agentName: value.agentName,
          description: value.description,
          status: "pending",
          createdAt: value.timestamp,
          resolvedAt: null,
        });
      }
    });

    const agent = this.db.getAgentByName(value.agentName);
    const eventReservationId = agent?.controlQuotaReservationId ??
      agent?.quotaReservationId;
    if (eventReservationId !== undefined) {
      if (value.kind === "session-start" || value.kind === "turn-start") {
        this.quota?.markStarted(eventReservationId, value.timestamp);
      } else if (value.kind === "turn-end") {
        await this.quota?.reconcile(
          eventReservationId,
          value.usageUnits,
          value.usageSource ?? "estimated",
          value.timestamp,
        );
      } else if (value.kind === "dead") {
        await this.quota?.cancel(eventReservationId, value.timestamp);
      }
    }

    if (value.kind === "session-start") {
      await this.delivery.recoverCriticalControls();
    }
    if (value.kind === "session-start" || value.kind === "turn-end") {
      await this.delivery.flushQueued(value.agentName);
    }
  }

  private async receiveEvent(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid HookEvent" }, { status: 400 });
    }
    const event = HookEventSchema.safeParse(body);
    if (!event.success) {
      return json(
        { error: "Invalid HookEvent", issues: event.error.issues },
        { status: 400 },
      );
    }
    try {
      await this.processEvent(event.data);
      return json({ ok: true });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Event failed" },
        { status: 500 },
      );
    }
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: "hive-daemon",
      version: HIVE_VERSION,
    });

    server.registerTool("hive_status", {
      title: "Hive agent status",
      description:
        'Fetch agent status on demand. Use detail "active" for a compact active-team summary; omitted detail preserves the full legacy response.',
      inputSchema: StatusRequestSchema,
    }, async ({ detail }) => {
      const agents = this.db.listAgents();
      return toolResult(
        detail === "active" ? compactActiveTeam(agents) : agents,
        "agents",
      );
    });

    server.registerTool("hive_quota_status", {
      title: "Hive quota status",
      description:
        "Show configured provider/account/model-pool capacity, reservations, telemetry confidence, freshness, and reset estimates.",
      inputSchema: z.object({}),
    }, async () => toolResult(this.quota?.statuses() ?? [], "quotas"));

    server.registerTool("hive_quota_reconcile", {
      title: "Reconcile Hive quota",
      description:
        "Record a provider, gateway, or manual usage observation for one configured quota pool.",
      inputSchema: QuotaObservationRequestSchema,
    }, async (observation) => {
      if (this.quota === undefined) {
        throw new Error("Quota tracking is unavailable");
      }
      const value = await this.quota.observe({
        ...observation,
        observedAt: observation.observedAt ?? new Date().toISOString(),
      });
      return toolResult(value, "observation");
    });

    server.registerTool("hive_recover", {
      title: "Recover crashed Hive agents",
      description:
        "Resume crashed agent sessions with their conversation context restored (native tool resume in the same worktree). Omit agent to sweep all recoverable agents; name one — including an agent already marked dead — for a manual retry.",
      inputSchema: z.object({ agent: z.string().min(1).optional() }),
    }, async ({ agent }) =>
      toolResult(await this.recoverCrashedAgents(agent), "outcomes"));

    server.registerTool("hive_mark_dead", {
      title: "Mark Hive agent dead",
      description: "Mark a stopped Hive agent as dead in the status table.",
      inputSchema: MarkDeadRequestSchema,
    }, async ({ agent: agentName }) => {
      const agent = this.db.getAgentByName(agentName);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${agentName}`);
      }
      const updated = this.db.upsertAgent({
        ...agent,
        status: "dead",
        lastEventAt: new Date().toISOString(),
      });
      this.channels.drop(updated.name);
      await this.settleAgentQuota(updated);
      return toolResult(updated, "agent");
    });

    server.registerTool("hive_kill", {
      title: "Kill Hive agent",
      description:
        "Kill a named Hive agent's tmux session, mark it dead, and optionally remove its worktree and branch. Removal refuses to delete unmerged commits or dirty files and reports them as stranded work instead; pass discardWork to delete them anyway.",
      inputSchema: KillRequestSchema,
    }, async ({ name, removeWorktree: shouldRemoveWorktree, discardWork }) => {
      const agent = this.db.getAgentByName(name);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }

      await this.tmux.killSession(agent.tmuxSession, { ignoreMissing: true });
      const timestamp = new Date().toISOString();
      const killed = this.db.markAgentDeadAndDetachTerminal(
        agent.id,
        timestamp,
      );
      if (killed === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }
      this.channels.drop(killed.agent.name);
      await this.settleAgentQuota(killed.agent, timestamp);
      if (killed.terminalHandle !== undefined) {
        try {
          await this.closeTerminal(killed.terminalHandle);
        } catch {
          // Terminal cleanup is best-effort; killing and marking dead must win.
        }
        this.layout?.requestLayout();
      }
      let updated = killed.agent;
      const cleaned: {
        tmuxSession: string;
        worktreePath: string | null;
        branch: string | null;
      } = {
        tmuxSession: agent.tmuxSession,
        worktreePath: null,
        branch: null,
      };

      // Work is either merged or explicitly surfaced — never silently lost.
      // A kill therefore always reports stranded work (unmerged commits or
      // uncommitted files), and removal refuses to delete it unless the
      // caller passes discardWork.
      let stranded:
        | {
          branch: string | null;
          worktreePath: string | null;
          dirtyFiles: string[];
          unmergedCommits: number;
          note: string;
        }
        | null = null;
      if (agent.worktreePath !== null || agent.branch !== null) {
        try {
          const work = await this.assessStranded(
            this.repoRoot,
            agent.worktreePath,
            agent.branch,
          );
          if (work.dirtyFiles.length > 0 || work.unmergedCommits > 0) {
            stranded = {
              branch: agent.branch,
              worktreePath: agent.worktreePath,
              dirtyFiles: work.dirtyFiles,
              unmergedCommits: work.unmergedCommits,
              note:
                `${agent.name} left work that is not on main; merge it via an integrator agent or pass discardWork to delete it.`,
            };
          }
        } catch (error) {
          stranded = {
            branch: agent.branch,
            worktreePath: agent.worktreePath,
            dirtyFiles: [],
            unmergedCommits: 0,
            note: `stranded-work check failed (${
              error instanceof Error ? error.message : "unknown error"
            }); worktree kept.`,
          };
        }
      }

      if (
        (shouldRemoveWorktree ?? false) && agent.worktreePath !== null &&
        (stranded === null || (discardWork ?? false))
      ) {
        await this.cleanupWorktree(this.repoRoot, agent.worktreePath, {
          deleteBranch: true,
          discardTracked: discardWork ?? false,
        });
        cleaned.worktreePath = agent.worktreePath;
        cleaned.branch = agent.branch;
        updated = this.db.upsertAgent({
          ...updated,
          worktreePath: null,
          branch: null,
        });
      }

      return toolResult({ agent: updated, cleaned, stranded }, "result");
    });

    server.registerTool("hive_send", {
      title: "Send agent message",
      description:
        'Send a durable message and return its real lifecycle state. normal waits for an ordinary boundary; urgent interrupts at the next safe boundary and requires acknowledgement; critical revokes write/landing authority and restarts the target read-only. Prefer structured priority and intent. Recipient "orchestrator" wakes the root.',
      inputSchema: SendRequestSchema,
    }, async ({ from, to, body, ...requested }) => {
      const inferred = requested.priority === undefined &&
          requested.intent === undefined
        ? inferLegacyControl(body)
        : null;
      return toolResult(await this.delivery.send(from, to, body, {
        ...requested,
        ...(inferred ?? {}),
      }), "message");
    });

    server.registerTool("hive_ack_message", {
      title: "Acknowledge a control message",
      description:
        "Acknowledge an injected urgent or critical control using its capability epoch; optionally confirm it has been applied.",
      inputSchema: MessageAcknowledgementSchema,
    }, async ({ agent, messageId, capabilityEpoch, applied }) => {
      const message = await this.acknowledgeControlMessage(
        agent,
        messageId,
        capabilityEpoch,
        applied,
      );
      return toolResult(message, "message");
    });

    server.registerTool("hive_inbox", {
      title: "Read agent inbox",
      description:
        'Read and atomically acknowledge queued messages. Recipient "orchestrator" returns bounded envelopes.',
      inputSchema: InboxRequestSchema,
    }, async ({ agent }) => toolResult(
      agent === ORCHESTRATOR_NAME
        ? await this.delivery.orchestratorInbox()
        : this.delivery.inbox(agent),
      "messages",
    ));

    server.registerTool("hive_read_message", {
      title: "Read full orchestrator message",
      description:
        "Read one full agent report by the id referenced in a bounded orchestrator envelope.",
      inputSchema: ReadMessageRequestSchema,
    }, async ({ id }) => {
      const message = this.delivery.readOrchestratorMessage(id);
      if (message === null) {
        throw new Error(`Orchestrator message not found: ${id}`);
      }
      return toolResult(message, "message");
    });

    server.registerTool("hive_spawn", {
      title: "Spawn Hive agent",
      description: "Start a new Hive agent for a delegated task.",
      inputSchema: SpawnRequestSchema,
    }, async (request: SpawnRequest) => {
      if (this.memoryPressure) {
        throw new Error(
          "Hive is refusing to spawn new agents while the system is under " +
            "memory pressure; retry once the resource watchdog reports the " +
            "pressure has cleared.",
        );
      }
      const agent = await this.spawner.spawn(request);
      const current = this.db.getAgentById(agent.id);
      const persisted = current !== null &&
          current.lastEventAt >= agent.lastEventAt
        ? current
        : this.db.upsertAgent(agent);
      if (persisted.status === "failed") {
        throw new Error(
          `Hive agent ${persisted.name} failed to spawn: ${
            persisted.failureReason ?? "unknown launch failure"
          }`,
        );
      }
      return toolResult(persisted, "agent");
    });

    server.registerTool("hive_approvals", {
      title: "List pending approvals",
      description: "List approval requests currently waiting for a decision.",
      inputSchema: z.object({}),
    }, async () =>
      toolResult(this.db.listApprovals("pending"), "approvals"));

    server.registerTool("hive_approve", {
      title: "Resolve agent approval",
      description: "Approve or deny a pending Hive agent approval request.",
      inputSchema: ApprovalDecisionSchema,
    }, async ({ id, decision }) => {
      const approval = this.db.resolveApproval(
        id,
        decision === "approve" ? "approved" : "denied",
        new Date().toISOString(),
      );
      if (approval === null) {
        throw new Error(`Pending approval not found: ${id}`);
      }
      await this.codexControl?.resolveApproval(
        approval.id,
        decision === "approve",
      );
      // A relayed claude/channel permission is actually answered here: the
      // decision rides back to the CLI's still-open dialog (first answer wins).
      const relay = this.channels.takePermissionByApproval(id);
      if (relay !== null) {
        this.channels.pushPermissionDecision(
          relay.agentName,
          relay.requestId,
          decision === "approve" ? "allow" : "deny",
        );
      }
      const agent = this.db.getAgentByName(approval.agentName);
      if (agent?.status === "awaiting-approval") {
        this.db.upsertAgent({
          ...agent,
          status: this.codexControl?.isTurnActive(approval.agentName)
            ? "working"
            : "idle",
        });
        await this.delivery.flushQueued(approval.agentName);
      }
      return toolResult(approval, "approval");
    });

    server.registerTool("hive_land", {
      title: "Land an agent branch",
      description:
        "Fast-forward land a writer branch only when its durable write capability epoch is current and not revoked.",
      inputSchema: LandRequestSchema,
    }, async ({ agent: name, capabilityEpoch }) => {
      return toolResult(
        await this.landAgent(name, capabilityEpoch),
        "result",
      );
    });

    server.registerTool("memory_search", {
      title: "Search Hive memory",
      description:
        'Full-text search durable memory facts across repo (".hive/memory/", committed) and global ("~/.hive/memory/") scope. Returns short snippets only; pull a full fact with memory_read before relying on it.',
      inputSchema: MemorySearchRequestSchema,
    }, async ({ query, scope, limit }) =>
      toolResult(this.memory.search(query, { scope, limit }), "results"));

    server.registerTool("memory_write", {
      title: "Write a Hive memory fact",
      description:
        "Create or update one durable Markdown memory fact. Omit id to create a new fact (a slug is derived from the title); pass an existing scope+id to overwrite that fact in place. Repo scope is committed and travels with the clone; global scope accumulates lessons across every project. Writes are serialized and immediately reflected in search.",
      inputSchema: MemoryWriteInputSchema,
    }, async (input) => toolResult(await this.writeMemoryFact(input), "fact"));

    server.registerTool("memory_read", {
      title: "Read a full Hive memory fact",
      description:
        "Read one full memory fact by scope and id, as referenced by the injected index or a memory_search result.",
      inputSchema: MemoryFactRequestSchema,
    }, async ({ scope, id }) => {
      const fact = await readMemoryFact(this.repoRoot, scope, id);
      if (fact === null) {
        throw new Error(`Memory fact not found: [${scope}] ${id}`);
      }
      return toolResult(fact, "fact");
    });

    server.registerTool("memory_delete", {
      title: "Delete a Hive memory fact",
      description:
        "Delete one memory fact's Markdown file and remove it from the search index. Use for pruning stale facts.",
      inputSchema: MemoryFactRequestSchema,
    }, async ({ scope, id }) =>
      toolResult({ deleted: await this.deleteMemoryFact(scope, id) }, "result"));

    server.registerTool("memory_reindex", {
      title: "Rebuild the Hive memory search index",
      description:
        "Rebuild the SQLite FTS index for this repo's committed and global memory facts from the Markdown files on disk. The files are authoritative and the index is always disposable, so this is safe to call any time.",
      inputSchema: z.object({}),
    }, async () =>
      toolResult({ count: await this.rebuildMemoryIndex() }, "result"));

    return server;
  }

  private async handleMcp(request: Request): Promise<Response> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = this.createMcpServer();
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      return json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
        id: null,
      }, { status: 500 });
    }
  }
}

export function startDaemon(options: HiveDaemonOptions): HiveDaemon {
  const daemon = new HiveDaemon(options);
  daemon.start();
  return daemon;
}

class UnavailableSpawner implements Spawner {
  async spawn(_request: SpawnRequest): Promise<AgentRecord> {
    throw new Error("No concrete spawner is configured");
  }
}

if (import.meta.main) {
  const daemon = startDaemon({
    spawner: new UnavailableSpawner(),
    manageLifecycle: true,
  });
  const stop = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export type { Approval };
