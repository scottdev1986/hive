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
  type CrashRecoveryDependencies,
  type RecoveryOutcome,
  type SessionResolver,
} from "./recovery";
import {
  deleteMemoryFact as deleteMemoryFactFile,
  readMemoryFact,
  writeMemoryFact as writeMemoryFactFile,
} from "../adapters/memory";
import { bootstrapIfUninitialized, evaluateProfile } from "../adapters/profile";
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
import {
  bearerToken,
  CapabilityStore,
  type Action,
  type Capability,
  type Decision,
  type Denial,
  type Role,
} from "./capabilities";
import { OPERATOR_SUBJECT, removeCredential, writeCredential } from "./credentials";
import { HiveDatabase, type Approval } from "./db";
import type { LayoutCoordinator } from "./layout";
import { WorkspacePresence } from "./workspace-presence";
import { MemoryIndex } from "./memory-index";
import {
  BunTmuxSender,
  MessageDelivery,
  type RootProtocolDeliverer,
  type TmuxSender,
} from "./delivery";
import { CodexRootDelivery } from "./codex-root-delivery";
import {
  readClaudeTelemetry,
  readCodexTelemetry,
  type TelemetryReader,
  type ToolTelemetry,
} from "./tool-telemetry";
import {
  cleanupLifecycleFiles,
  readConfiguredPort,
  writeLifecycleFiles,
} from "./lifecycle";
import { expectedDaemonHandshake } from "./handshake";
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
import { HIVE_VERSION } from "../version";

export { HIVE_VERSION };

const OPERATOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

const WorkspacePresenceRequestSchema = z.object({
  present: z.boolean(),
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

// A fact id is a filename stem interpolated into `join(root, `${id}.md`)` by
// the memory adapter, so the daemon boundary must refuse anything that could
// name a path component: no slashes, no leading dot, nothing outside the
// slug-plus-punctuation charset slugify and hand-authored facts actually use.
const MemoryIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "memory id must be a filename stem: alphanumeric start, then [a-z0-9._-]",
  );

const MemoryFactRequestSchema = z.object({
  scope: MemoryScopeSchema,
  id: MemoryIdSchema,
});

const MemoryWriteRequestSchema = MemoryWriteInputSchema.extend({
  id: MemoryIdSchema.optional(),
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

// The land-grant re-arm flow (SPEC decision 4's capability discipline without
// the integrator round-trip): a refused land on a spent one-shot files an
// approval, and approving it re-arms exactly one landing. The prefix is the
// contract between the filing site and the approval hook.
export const LAND_REARM_PREFIX = "Re-arm landing";
const LAND_REARM_NOTE =
  "A re-arm approval has been filed; once the orchestrator approves it, " +
  "exactly one more hive_land is granted.";

// Resource and control alerts are the only way daemon degradation reaches the
// orchestrator; a failed alert send must not crash the sweep, but it must not
// vanish either.
function logAlertDeliveryFailure(error: unknown): undefined {
  console.error(
    `Hive failed to deliver a daemon alert to the orchestrator: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
  return undefined;
}

// A hung git (stale index.lock, filesystem stall) must fail the land, not
// wedge the hive_land handler forever; a ff-only merge on a local repo that
// has not finished in 30s is not going to.
const LAND_GIT_TIMEOUT_MS = 30_000;

async function runGit(
  repoRoot: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), LAND_GIT_TIMEOUT_MS);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (proc.killed && exitCode !== 0) {
      throw new Error(
        `git ${args[0]} timed out after ${LAND_GIT_TIMEOUT_MS}ms`,
      );
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

const landBranch: LandBranch = async (repoRoot, branch) => {
  const merge = await runGit(repoRoot, ["merge", "--ff-only", branch]);
  if (merge.exitCode !== 0) {
    throw new Error(
      merge.stderr.trim() || `git merge exited ${merge.exitCode}`,
    );
  }
  const revision = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (revision.exitCode !== 0) throw new Error(revision.stderr.trim());
  return { commit: revision.stdout.trim() };
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
    seedClaudeTrust?: CrashRecoveryDependencies["seedClaudeTrust"];
    writeClaudeConfig?: CrashRecoveryDependencies["writeClaudeConfig"];
    writeCodexConfig?: CrashRecoveryDependencies["writeCodexConfig"];
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
  /** The Workspace-app viewer lease (`POST /workspace`). Shared with the
   * spawner and layout so external viewer windows pause while the app is
   * attached; an embedded daemon gets its own inert instance. */
  workspacePresence?: WorkspacePresence;
  quota?: QuotaService;
  /** Root wake transport override for tests; defaults to the lazy Codex
   * root app-server deliverer, inert when no codex root socket exists. */
  rootProtocol?: RootProtocolDeliverer;
  /** Context/activity artifact readers, injectable for tests; default to the
   * real transcript and rollout sensors. */
  telemetryReaders?: {
    claude?: TelemetryReader;
    codex?: TelemetryReader;
  };
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
  readonly capabilities: CapabilityStore;
  readonly workspacePresence: WorkspacePresence;
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
  private readonly readClaudeTelemetry: TelemetryReader;
  private readonly readCodexTelemetry: TelemetryReader;
  private readonly handshake: () => ReturnType<typeof expectedDaemonHandshake>;
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
    this.capabilities = new CapabilityStore(this.db, (name) => {
      const record = this.db.getAgentByName(name);
      return record === null ? null : {
        capabilityEpoch: record.capabilityEpoch,
        writeRevoked: record.writeRevoked,
      };
    });
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
      // The Codex root wake path (SPEC decision 1): dual-client steering into
      // the root's own app-server. Inert on a Claude-root machine — its
      // socket never exists — and an unconfirmed delivery falls through to
      // Claude Channels inside deliverRootViaChannel. Reads this.repoRoot
      // lazily; it is assigned a few lines below.
      options.rootProtocol ??
        new CodexRootDelivery(() => this.repoRoot),
    );
    this.quota?.setAlertSink(async (body) => {
      await this.delivery.send("hive-quota", ORCHESTRATOR_NAME, body);
    });
    this.closeTerminal = options.closeTerminal ?? closeTerminal;
    this.layout = options.layout ?? null;
    this.workspacePresence = options.workspacePresence ?? new WorkspacePresence();
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
    this.readClaudeTelemetry = options.telemetryReaders?.claude ??
      readClaudeTelemetry;
    this.readCodexTelemetry = options.telemetryReaders?.codex ??
      readCodexTelemetry;
    this.handshake = () => expectedDaemonHandshake(this.repoRoot);
    this.cleanupWorktree = options.removeWorktree ?? removeWorktree;
    this.assessStranded = options.assessStrandedWork ?? assessStrandedWork;
    this.recovery = new CrashRecovery({
      db: this.db,
      tmux: this.tmux,
      port: this.port,
      dropChannel: (agentName) => this.channels.drop(agentName),
      revokeCapabilities: (agentName) => {
        this.capabilities.revokeSubject(agentName);
        removeCredential(agentName);
      },
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
      ...(options.recovery?.seedClaudeTrust === undefined
        ? {}
        : { seedClaudeTrust: options.recovery.seedClaudeTrust }),
      ...(options.recovery?.writeClaudeConfig === undefined
        ? {}
        : { writeClaudeConfig: options.recovery.writeClaudeConfig }),
      ...(options.recovery?.writeCodexConfig === undefined
        ? {}
        : { writeCodexConfig: options.recovery.writeCodexConfig }),
    });
    // The daemon that owns the lifecycle files owns the operator and
    // orchestrator credentials. Embedded daemons (tests, tooling) mint in
    // memory and never touch disk, so an in-process test can never overwrite a
    // live operator's token.
    if (this.manageLifecycle) {
      this.issueCredential(OPERATOR_SUBJECT, "operator", 0, OPERATOR_TTL_MS);
      this.issueCredential(ORCHESTRATOR_NAME, "orchestrator", 0, OPERATOR_TTL_MS);
    }
  }

  /** Mints a credential for one subject and writes it to its 0600 file,
   * revoking whatever that subject held before. This is the only path by which
   * a token comes into existence outside the daemon's own process: there is no
   * mint tool, no token exchange, and no delegation. */
  issueCredential(
    subject: string,
    role: Role,
    epoch: number,
    ttlMs?: number,
  ): string {
    this.capabilities.revokeSubject(subject);
    const { token } = this.capabilities.mint(subject, role, {
      epoch,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
    writeCredential(subject, token);
    return token;
  }

  private denied(decision: Denial): Response {
    return json(
      { error: decision.message, reason: decision.reason },
      { status: decision.status },
    );
  }

  /** Authenticate before touching the request body: a caller with no
   * credential is turned away without the daemon reading what it asked for. */
  private authenticate(request: Request, route: string): Decision {
    return this.capabilities.authenticateAndAudit(bearerToken(request), route);
  }

  private authorize(
    capability: Capability,
    route: string,
    action: Action,
    subject: string | undefined,
    auditAllow = true,
  ): Decision {
    return this.capabilities.authorizeAndAudit(
      capability,
      { route, action, ...(subject === undefined ? {} : { subject }) },
      auditAllow,
    );
  }

  /** The MCP transport has no place for an HTTP status, so a denial becomes a
   * tool error. The message names the rule that refused, never the token. */
  private authorizeTool(
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow = true,
  ): void {
    const decision = this.authorize(
      capability,
      `/mcp:${tool}`,
      action,
      subject,
      auditAllow,
    );
    if (!decision.ok) throw new Error(decision.message);
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
    // Every daemon start reads the providers' real limits before the first spawn
    // can reserve against a number nobody measured. A provider that will not
    // answer leaves its pool honestly unknown rather than blocking startup.
    void this.refreshQuota({ force: true }).catch((error) => {
      console.error(
        `Hive quota discovery failed: ${
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
    // The repo profile (SPEC §14): bootstrap it if this repo has never been met,
    // and — when it exists but the tree has drifted — emit the one durable
    // orchestrator note. Never blocks startup; a repo runs without a profile.
    void this.checkRepoProfile().catch((error) => {
      console.error(
        `Hive repo profile check failed: ${
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

  /**
   * The repo profile's start-time duties the daemon owns (SPEC §14). It has the
   * repo root, the message bus, and no terminal — the complement of `hive init`,
   * which has a terminal but wants the durable note to survive it:
   *   - Uninitialized: write the deterministic profile, so a repo entered through
   *     `hive claude` (never `hive init`) still gets un-hardcoded briefs. The
   *     idempotent, atomic write converges with any concurrent `hive init`.
   *   - Stale: enqueue exactly one durable orchestrator note. The idempotency key
   *     is the profile's own fingerprint, so re-boots at the same staleness never
   *     spam, and a `hive init --refresh` (new fingerprint) re-arms the note.
   */
  private async checkRepoProfile(): Promise<void> {
    const status = await evaluateProfile(this.repoRoot);
    if (status.state === "uninitialized") {
      await bootstrapIfUninitialized(this.repoRoot);
      return;
    }
    if (status.state === "stale") {
      await this.delivery.send("hive-profile", ORCHESTRATOR_NAME, status.note, {
        idempotencyKey: `profile-stale:${status.profile.fingerprint.inputsHash}`,
      });
    }
  }

  /**
   * Re-read live provider limits. Reservations then reconcile against the real
   * numbers on the next status read, because an observation and the local ledger
   * combine by max() — a fresh provider reading tightens the picture, and a
   * missing one never loosens it.
   */
  async refreshQuota(options: { force?: boolean } = {}): Promise<void> {
    if (this.quota === undefined) return;
    await this.quota.refreshFromProviders(undefined, options);
  }

  private async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      if (this.quota?.needsRefresh() === true) {
        await this.refreshQuota().catch((error) => {
          console.error(
            `Hive quota refresh failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        });
      }
      await this.recoverQuotaReservations();
      await this.delivery.recoverCriticalControls();
      // Root wakes deferred behind a human draft are retried only at this
      // bounded daemon boundary. The row remains queued until tmux confirms
      // the composer is empty, so no report silently rots.
      await this.delivery.wakeOrchestrator();
      await this.reconcileAgents();
      await this.refreshToolTelemetry().catch((error) => {
        console.error(
          `Hive tool telemetry sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await this.sweepResources();
      this.db.pruneHistory(new Date().toISOString());
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /** Files (once) the approval whose grant re-arms one landing for an agent
   * whose one-shot branch:land grant is spent. */
  private fileLandRearmApproval(subject: string): void {
    const alreadyPending = this.db.listApprovals("pending").some(
      (approval) =>
        approval.agentName === subject &&
        approval.description.startsWith(LAND_REARM_PREFIX),
    );
    if (alreadyPending) return;
    this.db.insertApproval({
      id: crypto.randomUUID(),
      agentName: subject,
      description:
        `${LAND_REARM_PREFIX}: the one-shot branch:land grant for ${subject} is spent. ` +
        "Approving grants exactly one more landing for this agent.",
      status: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
  }

  /**
   * Pull each live agent's context% and artifact freshness from its tool's
   * durable files (SPEC decision 2): Claude transcripts and Codex rollouts.
   * Hook traffic carries neither, so this sweep is what keeps the status
   * table's context column true. For a Codex TUI agent the rollout mtime is
   * also the only mid-turn liveness signal — a fresh rollout promotes a
   * stuck "spawning" row to working, which is exactly the row the field
   * test saw frozen while the agent had long since landed.
   */
  async refreshToolTelemetry(): Promise<void> {
    for (const agent of this.db.listAgents()) {
      if (
        agent.status === "dead" || agent.status === "done" ||
        agent.status === "failed"
      ) continue;
      const worktree = agent.worktreePath;
      if (worktree === null || worktree === undefined) continue;
      let telemetry: ToolTelemetry;
      try {
        telemetry = agent.tool === "claude"
          ? await this.readClaudeTelemetry(worktree)
          : await this.readCodexTelemetry(worktree);
      } catch {
        continue;
      }
      // Re-read after the file I/O: hook events may have advanced the row.
      const current = this.db.getAgentById(agent.id);
      if (
        current === null || current.status === "dead" ||
        current.status === "done" || current.status === "failed"
      ) continue;
      const updates: Partial<AgentRecord> = {};
      if (
        telemetry.contextPct !== null &&
        telemetry.contextPct !== current.contextPct
      ) {
        updates.contextPct = telemetry.contextPct;
      }
      if (
        current.tool === "codex" && !current.writeRevoked &&
        current.status !== "control-paused" &&
        telemetry.lastActivityAt !== null &&
        telemetry.lastActivityAt > current.lastEventAt
      ) {
        updates.lastEventAt = telemetry.lastActivityAt;
        if (current.status === "spawning") updates.status = "working";
      }
      if (Object.keys(updates).length > 0) {
        this.db.upsertAgent({ ...current, ...updates });
      }
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
        } catch (error) {
          // A kill the watchdog attempted and lost (EPERM, pid raced away)
          // still counts as degradation, and degradation is never silent:
          // the runaway may still be allocating.
          console.error(
            `Hive memory watchdog failed to kill pid ${kill.process.pid} under ${kill.owner}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
          await this.delivery.send(
            "hive-resources",
            ORCHESTRATOR_NAME,
            `Hive memory watchdog FAILED to kill pid ${kill.process.pid} under ${kill.owner} ` +
              `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
              `${kill.process.command.slice(0, 160)}. The process may still be allocating; ` +
              `it may need to be stopped by hand.`,
            { idempotencyKey: `resource-kill-failed:${kill.process.pid}` },
          ).catch(logAlertDeliveryFailure);
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
        ).catch(logAlertDeliveryFailure);
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
        ).catch(logAlertDeliveryFailure);
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
      ).catch(logAlertDeliveryFailure);
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
      ).catch(logAlertDeliveryFailure);
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
      await this.tmux.killSession(orchestratorTmuxSession(), {
        ignoreMissing: true,
      });
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
    // Public and non-authorizing. Health proves liveness and nothing else; it
    // must never grow a side effect, because a route that mutates needs a
    // capability and no launcher has one before it decides to talk to us.
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, version: HIVE_VERSION });
    }
    if (url.pathname === "/handshake" && request.method === "GET") {
      return json(await this.handshake());
    }
    // Everything below mutates state or reads another tenant's data, so every
    // one of them authenticates first. See the capability rights matrix.
    if (url.pathname === "/event" && request.method === "POST") {
      return this.receiveEvent(request);
    }
    if (url.pathname === "/orchestrator-terminal") {
      if (request.method === "POST") {
        return this.registerOrchestratorTerminal(request);
      }
      if (request.method === "DELETE") {
        const authenticated = this.authenticate(request, "/orchestrator-terminal");
        if (!authenticated.ok) return this.denied(authenticated);
        const decision = this.authorize(
          authenticated.capability,
          "/orchestrator-terminal",
          "terminal:register",
          undefined,
        );
        if (!decision.ok) return this.denied(decision);
        this.db.clearOrchestratorTerminal();
        return json({ ok: true });
      }
    }
    if (url.pathname === "/viewer" && request.method === "POST") {
      return this.attachViewer(request);
    }
    if (url.pathname === "/workspace") {
      if (request.method === "POST") {
        return this.setWorkspacePresenceEndpoint(request);
      }
      if (request.method === "GET") {
        return this.readWorkspacePresenceEndpoint(request);
      }
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
    const authenticated = this.authenticate(request, pathname);
    if (!authenticated.ok) return this.denied(authenticated);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid channel request" }, { status: 400 });
    }
    // Every channel route names its agent, and a bridge may only speak for the
    // agent it was launched for. Poll and ack are not audited on allow: they
    // are the long-poll heartbeat and would bury every other row.
    const named = z.object({ agent: z.string().min(1) }).safeParse(body);
    if (named.success) {
      const decision = this.authorize(
        authenticated.capability,
        pathname,
        "channel:use",
        named.data.agent,
        pathname === "/channel/register" ||
          pathname === "/channel/permission-request",
      );
      if (!decision.ok) return this.denied(decision);
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
    const authenticated = this.authenticate(request, "/statusline");
    if (!authenticated.ok) return this.denied(authenticated);
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
    const decision = this.authorize(
      authenticated.capability,
      "/statusline",
      "telemetry:report",
      parsed.data.agent,
      false,
    );
    if (!decision.ok) return this.denied(decision);
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
    const authenticated = this.authenticate(request, "/orchestrator-terminal");
    if (!authenticated.ok) return this.denied(authenticated);
    const authorized = this.authorize(
      authenticated.capability,
      "/orchestrator-terminal",
      "terminal:register",
      undefined,
    );
    if (!authorized.ok) return this.denied(authorized);
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

  /**
   * `POST /workspace` — the Workspace app's viewer lease.
   *
   * `{present: true}` grants (or renews) the lease for one TTL; the feed's
   * heartbeat renews well inside it, and `{present: false}` surrenders it on
   * clean shutdown. Operator-level, like `/orchestrator-terminal`: only the
   * human's own tooling may decide who the viewer is. Allows are audited only
   * when the lease state actually flips — the renewals are a heartbeat and,
   * like channel polls, would bury every other audit row.
   */
  private async setWorkspacePresenceEndpoint(
    request: Request,
  ): Promise<Response> {
    const authenticated = this.authenticate(request, "/workspace");
    if (!authenticated.ok) return this.denied(authenticated);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid workspace presence" }, { status: 400 });
    }
    const parsed = WorkspacePresenceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid workspace presence", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const flips = parsed.data.present !== this.workspacePresence.isPresent();
    const decision = this.authorize(
      authenticated.capability,
      "/workspace",
      "terminal:register",
      undefined,
      flips,
    );
    if (!decision.ok) return this.denied(decision);
    if (parsed.data.present) {
      this.workspacePresence.markPresent();
    } else {
      this.workspacePresence.clear();
      // The app stopped being the viewer; put the window wall back.
      this.layout?.requestLayout();
    }
    return json({
      ok: true,
      present: this.workspacePresence.isPresent(),
      ttlMs: this.workspacePresence.ttlMs,
    });
  }

  /** `GET /workspace` — read the live lease state. A poll, so allows are not
   * audited. */
  private async readWorkspacePresenceEndpoint(
    request: Request,
  ): Promise<Response> {
    const authenticated = this.authenticate(request, "/workspace");
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      "/workspace",
      "status:read",
      undefined,
      false,
    );
    if (!decision.ok) return this.denied(decision);
    return json({ present: this.workspacePresence.isPresent() });
  }

  private async recoverEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/recover");
    if (!authenticated.ok) return this.denied(authenticated);
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
    const decision = this.authorize(
      authenticated.capability,
      "/recover",
      "agent:recover",
      parsed.data.agent,
    );
    if (!decision.ok) return this.denied(decision);
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
    const authenticated = this.authenticate(request, "/viewer");
    if (!authenticated.ok) return this.denied(authenticated);
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
    const decision = this.authorize(
      authenticated.capability,
      "/viewer",
      "viewer:attach",
      parsed.data.agent,
    );
    if (!decision.ok) return this.denied(decision);
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
    if (value.kind === "tool-boundary") {
      // A deep agent fires this on every tool call — hundreds per turn — so
      // it deliberately skips the events table and the quota machinery. It
      // proves the process is alive mid-turn and marks the one safe moment
      // to inject urgent traffic into a busy session.
      const agent = this.db.getAgentByName(value.agentName);
      if (
        agent !== null && agent.status !== "dead" &&
        agent.status !== "done" && agent.status !== "failed"
      ) {
        this.db.upsertAgent({
          ...agent,
          lastEventAt: new Date(value.timestamp).toISOString(),
          ...(value.toolSessionId === undefined
            ? {}
            : { toolSessionId: value.toolSessionId }),
        });
        await this.delivery.flushUrgent(value.agentName);
      }
      return;
    }
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
    const authenticated = this.authenticate(request, "/event");
    if (!authenticated.ok) return this.denied(authenticated);
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
    // A hook may only report on the agent it was installed for. Hooks fire at
    // every turn boundary, so allows are not audited.
    const decision = this.authorize(
      authenticated.capability,
      "/event",
      "event:report",
      event.data.agentName,
      false,
    );
    if (!decision.ok) return this.denied(decision);
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

  private createMcpServer(capability: Capability): McpServer {
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
      this.authorizeTool(capability, "hive_status", "status:read", undefined, false);
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
    }, async () => {
      this.authorizeTool(capability, "hive_quota_status", "quota:read", undefined, false);
      return toolResult(this.quota?.statuses() ?? [], "quotas");
    });

    server.registerTool("hive_quota_reconcile", {
      title: "Reconcile Hive quota",
      description:
        "Record a provider, gateway, or manual usage observation for one configured quota pool.",
      inputSchema: QuotaObservationRequestSchema,
    }, async (observation) => {
      this.authorizeTool(capability, "hive_quota_reconcile", "quota:write");
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
    }, async ({ agent }) => {
      this.authorizeTool(capability, "hive_recover", "agent:recover", agent);
      return toolResult(await this.recoverCrashedAgents(agent), "outcomes");
    });

    server.registerTool("hive_mark_dead", {
      title: "Mark Hive agent dead",
      description: "Mark a stopped Hive agent as dead in the status table.",
      inputSchema: MarkDeadRequestSchema,
    }, async ({ agent: agentName }) => {
      this.authorizeTool(capability, "hive_mark_dead", "agent:mark-dead", agentName);
      const agent = this.db.getAgentByName(agentName);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${agentName}`);
      }
      const updated = this.db.upsertAgent({
        ...agent,
        status: "dead",
        lastEventAt: new Date().toISOString(),
      });
      // A dead agent's credential dies with it, so a surviving descendant of
      // its process cannot keep speaking for a tenant that no longer exists.
      // The token file goes too: revocation already makes it useless, but a
      // plaintext credential for every agent ever spawned must not accumulate
      // on disk for the life of the install.
      this.capabilities.revokeSubject(updated.name);
      removeCredential(updated.name);
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
      this.authorizeTool(capability, "hive_kill", "agent:kill", name);
      const agent = this.db.getAgentByName(name);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }
      this.capabilities.revokeSubject(agent.name);
      removeCredential(agent.name);

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
      // `from` is a claim about identity, so it is checked against the bound
      // subject rather than trusted. No agent can forge a message from another.
      this.authorizeTool(capability, "hive_send", "message:send", from, false);
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
      this.authorizeTool(capability, "hive_ack_message", "message:ack", agent);
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
    }, async ({ agent }) => {
      // The global orchestrator inbox is reachable only by naming the
      // orchestrator, which only the orchestrator's own capability may do.
      this.authorizeTool(capability, "hive_inbox", "inbox:read", agent, false);
      return toolResult(
        agent === ORCHESTRATOR_NAME
          ? await this.delivery.orchestratorInbox()
          : await this.delivery.inbox(agent),
        "messages",
      );
    });

    server.registerTool("hive_read_message", {
      title: "Read full orchestrator message",
      description:
        "Read one full agent report by the id referenced in a bounded orchestrator envelope.",
      inputSchema: ReadMessageRequestSchema,
    }, async ({ id }) => {
      this.authorizeTool(capability, "hive_read_message", "message:read", undefined, false);
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
      this.authorizeTool(capability, "hive_spawn", "agent:spawn");
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
    }, async () => {
      this.authorizeTool(capability, "hive_approvals", "approval:read", undefined, false);
      return toolResult(this.db.listApprovals("pending"), "approvals");
    });

    server.registerTool("hive_approve", {
      title: "Resolve agent approval",
      description: "Approve or deny a pending Hive agent approval request.",
      inputSchema: ApprovalDecisionSchema,
    }, async ({ id, decision }) => {
      // The approval names an agent only indirectly, through its id, so the
      // subject is resolved from the record before it is authorized against.
      const pending = this.db.getApproval(id);
      this.authorizeTool(
        capability,
        "hive_approve",
        "approval:decide",
        pending?.agentName,
      );
      const approval = this.db.resolveApproval(
        id,
        decision === "approve" ? "approved" : "denied",
        new Date().toISOString(),
      );
      if (approval === null) {
        throw new Error(`Pending approval not found: ${id}`);
      }
      if (
        decision === "approve" &&
        approval.description.startsWith(LAND_REARM_PREFIX)
      ) {
        this.capabilities.rearmOneShot(approval.agentName, "branch:land");
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
      try {
        this.authorizeTool(capability, "hive_land", "branch:land", name);
      } catch (error) {
        // A spent grant is a dead end the caller cannot fix alone (a live
        // agent asked to land follow-up work simply stalls); surface it as
        // an approval whose grant re-arms exactly one landing.
        if (error instanceof Error && error.message.includes("already spent")) {
          this.fileLandRearmApproval(capability.subject);
          throw new Error(`${error.message}. ${LAND_REARM_NOTE}`);
        }
        throw error;
      }
      // Reserve the one-shot right before merging, so two concurrent lands
      // cannot both reach git. A lost fast-forward race releases it again:
      // main moved, the writer must rebase, and the retry has to be possible.
      if (!this.capabilities.consumeOneShot(capability, "branch:land")) {
        this.capabilities.audit({
          route: "/mcp:hive_land",
          action: "branch:land",
          callerSubject: capability.subject,
          callerRole: capability.role,
          capabilityId: capability.id,
          requestedSubject: name,
          epoch: capability.epoch,
          decision: "deny",
          reason: "capability.replayed",
        });
        this.fileLandRearmApproval(capability.subject);
        throw new Error(
          `The one-shot branch:land grant for ${capability.subject} is already spent. ${LAND_REARM_NOTE}`,
        );
      }
      try {
        return toolResult(await this.landAgent(name, capabilityEpoch), "result");
      } catch (error) {
        this.capabilities.releaseOneShot(capability, "branch:land");
        throw error;
      }
    });

    server.registerTool("memory_search", {
      title: "Search Hive memory",
      description:
        'Full-text search durable memory facts across repo (".hive/memory/", committed) and global ("~/.hive/memory/") scope. Returns short snippets only; pull a full fact with memory_read before relying on it.',
      inputSchema: MemorySearchRequestSchema,
    }, async ({ query, scope, limit }) => {
      this.authorizeTool(capability, "memory_search", "memory:read", undefined, false);
      return toolResult(this.memory.search(query, { scope, limit }), "results");
    });

    server.registerTool("memory_write", {
      title: "Write a Hive memory fact",
      description:
        "Create or update one durable narrative memory fact. WRITE POLICY (SPEC decision 5): a lesson earns a fact only if it is durable (true past this run), non-derivable (not recoverable from the code, git, or the profile), and load-bearing (it would change what a future agent does) — chit-chat, restatements, and anything a grep or .hive/profile.toml already answers do not qualify, and structured truth (commands, layout, entry points) belongs in the profile, never here. DEDUP-BEFORE-WRITE: memory_search first and pass that fact's scope+id to update it in place rather than adding a near-duplicate. CORRECTION-NOT-APPEND: to fix a wrong fact, overwrite it (same id) or memory_delete it — never append a contradiction; git history is the changelog. Set `source` to who is writing (agent at landing, orchestrator for its decisions, init for seeded facts, human for hand-authored) and `verified` to today when you have confirmed the fact against the repo. Omit id to create (slug derived from title); repo scope is committed and travels with the clone, global accumulates lessons across projects. Writes are serialized and immediately reflected in search.",
      inputSchema: MemoryWriteRequestSchema,
    }, async (input) => {
      this.authorizeTool(capability, "memory_write", "memory:write");
      return toolResult(await this.writeMemoryFact(input), "fact");
    });

    server.registerTool("memory_read", {
      title: "Read a full Hive memory fact",
      description:
        "Read one full memory fact by scope and id, as referenced by the injected index or a memory_search result. The returned fact carries `source` and `verified`; if `verified` is absent or older than `date`, or the fact names a concrete path/command/flag, re-check it against the repo before acting on it (SPEC decision 5: the index is a pointer, the fact is a claim, the repo is truth).",
      inputSchema: MemoryFactRequestSchema,
    }, async ({ scope, id }) => {
      this.authorizeTool(capability, "memory_read", "memory:read", undefined, false);
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
    }, async ({ scope, id }) => {
      this.authorizeTool(capability, "memory_delete", "memory:write");
      return toolResult({ deleted: await this.deleteMemoryFact(scope, id) }, "result");
    });

    server.registerTool("memory_reindex", {
      title: "Rebuild the Hive memory search index",
      description:
        "Rebuild the SQLite FTS index for this repo's committed and global memory facts from the Markdown files on disk. The files are authoritative and the index is always disposable, so this is safe to call any time.",
      inputSchema: z.object({}),
    }, async () => {
      this.authorizeTool(capability, "memory_reindex", "memory:write");
      return toolResult({ count: await this.rebuildMemoryIndex() }, "result");
    });

    return server;
  }

  private async handleMcp(request: Request): Promise<Response> {
    // Authentication gates the whole transport, so an anonymous caller cannot
    // even enumerate the tools it is not allowed to call.
    const authenticated = this.authenticate(request, "/mcp");
    if (!authenticated.ok) {
      return json({
        jsonrpc: "2.0",
        error: { code: -32001, message: authenticated.message },
        id: null,
      }, { status: authenticated.status });
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = this.createMcpServer(authenticated.capability);
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
