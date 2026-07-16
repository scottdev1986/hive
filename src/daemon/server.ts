import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";
import { z } from "zod";
import { TmuxAdapter } from "../adapters/tmux";
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
import { withFileLock } from "../adapters/file-lock";
import { graphLocate, readGraphifyState } from "../adapters/graphify";
import { GraphifyService } from "./graphify-service";
import {
  landBranch,
  type LandBranch,
  readLandReadiness,
  type ReadLandReadiness,
} from "./landing";
import { checkBuildFreshness, type BuildFreshness } from "./build-freshness";
import { readLiveClaudeModel } from "./live-model";
import {
  reconcileCodexIdentity,
  sameObservedIdentity,
} from "./identity-attestation";
import { codexWriterContainment } from "./codex-containment";
import {
  assessStrandedWork,
  listUnmergedHiveBranches,
  markBranchPreserved,
  observedWorktreeFiles,
  removeWorktree,
  type RemoveWorktreeOptions,
  type StrandedWork,
  type UnmergedBranch,
} from "../adapters/worktrees";
import {
  HookEventSchema,
  ControlIntentSchema,
  compactMemoryWriteResult,
  HandoffSchema,
  MemoryScopeSchema,
  MemoryWriteInputSchema,
  MessagePrioritySchema,
  ORCHESTRATOR_NAME,
  attestationStateOf,
  canonicalOrchestratorName,
  isOrchestratorName,
  QuotaObservationSchema,
  RoutingPolicyMutationSchema,
  StatuslineReportSchema,
  isTerminalAgentStatus,
  unknownVendor,
  type AgentMessage,
  type AgentRecord,
  type HookEvent,
  type IdentityState,
  type MemoryFact,
  type MemoryScope,
  type MemoryWriteInput,
} from "../schemas";
import { isAutonomy, type AutonomyControl } from "../config/autonomy";
import { deriveOrchestratorStatus } from "./orchestrator-status";
import {
  bearerToken,
  CapabilityStore,
  type Action,
  type Capability,
  type Decision,
  type Denial,
  type Role,
} from "./capabilities";
import {
  OPERATOR_SUBJECT,
  removeCredential,
  removeCredentialIfMatches,
  writeCredential,
} from "./credentials";
import {
  agentStateCas,
  HiveDatabase,
  type Approval,
} from "./db";
import {
  RoutingPolicyConflictError,
  RoutingPolicyStore,
} from "./routing-policy-store";
import type { SelectionPreferenceControl } from "./selection-preferences";
import { MemoryIndex } from "./memory-index";
import {
  BunTmuxSender,
  MessageDelivery,
  queuedDeliveryNote,
  type RootProtocolDeliverer,
  type TmuxSender,
} from "./delivery";
import { OrchestratorRootDelivery } from "./orchestrator-root-delivery";
import { readLiveGrokModel } from "../adapters/tools/grok";
import { findCodexRolloutForProcess } from "../adapters/tools/codex";
import {
  clampPct,
  type ClaudeTelemetryReader,
  type GraphifyCallCursor,
  type CodexIdentityObservation,
  type GrokTelemetry,
  type GrokTelemetryReader,
  readClaudeTelemetry,
  readCodexObservedIdentity,
  readCodexTelemetry,
  readGraphifyCalls,
  readGrokTelemetry,
  type TelemetryReader,
  type ToolTelemetry,
} from "./tool-telemetry";
import {
  cleanupLifecycleFiles,
  readConfiguredPort,
  writeLifecycleFiles,
} from "./lifecycle";
import { expectedDaemonHandshake } from "./handshake";
import { listInstances } from "./instances";
import { hiveInstanceSuffix } from "./tmux-sessions";
import {
  compactActiveTeam,
  compactApprovalDescription,
  compactSendResult,
  compactSpawnResult,
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
  defaultReapDependencies,
  reapCapturedTree,
  ResumeRollbackError,
  resumeAgentFromPauseCapture,
  resumeTmuxSession,
  stopAgentSession,
  stopTmuxSession,
  suspendAgentForPause,
  suspendCapturedTree,
  suspendTmuxSession,
  readCodexHostPid,
  type ReapDependencies,
  type ReapOutcome,
  type SessionStopAdapter,
  type SuspendOutcome,
} from "./teardown";
import type { PauseCapture } from "../schemas";
import {
  assessResources,
  paneProcessState,
  parseAvailableMemoryMb,
  parseProcessTable,
  parseStateTable,
  runPs,
  runPsState,
  runVmStat,
  type CommandOutput,
  type SessionProcessRoots,
} from "./resources";
import type { LifecycleConfig, ResourceLimits } from "../schemas";
import { HIVE_VERSION } from "../version";
import type { ModelInventory } from "./model-inventory";
import { TokenUsageStore } from "./token-usage";
import { MachineMutationCoordinator } from "./mutation-lease";

export { HIVE_VERSION };

const OPERATOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Codex app-server hosts drop their pidfiles beside their sockets; the daemon
// reaps children whose host died without running its own cleanup.
//
// This is `tmpdir()`, NOT "/tmp". codexAgentSocketPath binds into the per-user
// temp dir (0700 on macOS, `/var/folders/.../T`) precisely so no other local
// user can pre-bind the name — and this constant said "/tmp", so the reaper
// listed a directory the sockets were never in. It therefore found no pidfiles
// to skip in the first place, which is why the broken agent-id lookup below it
// went unnoticed: two independent bugs, both of which had to be fixed before a
// single orphan could ever be reaped.
const CODEX_SOCKET_DIR = tmpdir();

// An agent in one of these statuses still owns its branch, so unlanded commits
// on it are work in progress rather than stranded work. Every other status —
// done, dead, failed — has closed, and anything it left unmerged is stranded.
// Enumerated on the live side deliberately: a status added later reads as
// closed and gets reported, because a false alert is cheap and silence is what
// loses work.
const LIVE_STATUSES: AgentRecord["status"][] = [
  "spawning",
  "working",
  "idle",
  "awaiting-approval",
  "control-paused",
  "stuck",
];

function defaultOrphanDependencies(): ReapOrphanDependencies {
  return {
    listSocketDir: () => readdir(CODEX_SOCKET_DIR),
    readPidFile: (name) =>
      readFile(join(CODEX_SOCKET_DIR, name), "utf8"),
    removeFile: (name) => rm(join(CODEX_SOCKET_DIR, name), { force: true }),
    fileState: async (name) => {
      try {
        await lstat(join(CODEX_SOCKET_DIR, name));
        return "present";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "absent"
          : "unknown";
      }
    },
    processCommand: async (pid) => {
      const child = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const [output, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return exitCode === 0 && output.trim() !== "" ? output.trim() : null;
    },
    processState: async (pid) => {
      try {
        process.kill(pid, 0);
        return "live";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
          ? "dead"
          : "unknown";
      }
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

/**
 * A capability escalation is a typed claim with evidence, not a vibe: the
 * reason says why the task exceeds the model, and `failedApproaches` must name at least one
 * concrete attempt — an agent that has tried nothing has nothing to escalate.
 * The remaining fields are the handoff the replacement resumes from.
 */
const EscalationRequestSchema = z.object({
  agent: z.string().min(1),
  reason: z.string().min(1),
  goal: z.string().min(1),
  done: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  failedApproaches: z.array(z.string().min(1)).min(1),
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
  history: z.boolean().optional(),
  fields: z.array(z.string().min(1)).max(32).optional(),
});

const QuotaObservationRequestSchema = QuotaObservationSchema.omit({
  observedAt: true,
}).extend({
  observedAt: z.iso.datetime({ offset: true }).optional(),
});

const TokenUsageSessionRequestSchema = z.object({
  repoRoot: z.string().min(1),
});

const TokenUsageOrchestratorRequestSchema = z.object({
  provider: z.string().min(1),
  cwd: z.string().min(1),
});

const MarkDeadRequestSchema = z.object({
  agent: z.string().min(1),
});

const KillRequestSchema = z.object({
  name: z.string().min(1),
  removeWorktree: z.boolean().optional(),
  discardWork: z.boolean().optional(),
});

const PreserveBranchRequestSchema = z.object({
  agent: z.string().min(1),
  preserved: z.boolean().default(true),
});

const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "deny"]),
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

const MemoryWriteRequestSchema = MemoryWriteInputSchema.safeExtend({
  id: MemoryIdSchema.optional(),
});

export type { LandBranch };

// The land-grant re-arm flow (SPEC decision 4's capability discipline without
// the integrator round-trip): a refused land on a spent one-shot files an
// approval, and approving it re-arms exactly one landing. The prefix is the
// contract between the filing site and the approval hook.
export const LAND_REARM_PREFIX = "Re-arm landing";
const LAND_REARM_NOTE =
  "Hive has already filed the re-arm approval for you — there is no command to run.\n" +
  "Fix: the orchestrator approves that request, which grants exactly one more hive_land.";

// How many landings past the first Hive will re-arm on its own evidence, per
// agent — so a productive agent is not a human bottleneck, while an agent still
// cannot merge an unbounded stream of unreviewed increments: the fifth landing
// of a task asks a person, and so does every landing after it. The budget is a
// per-agent (therefore per-task) count read back from the audit log.
export const AUTO_REARM_BUDGET = 3;
export const AUTO_REARM_REASON = "capability.auto-rearm";

/** An agent whose work is already on main is not blocked by a spent grant — it
 * is finished. Saying so, and filing nothing, is the whole fix for the no-op
 * re-arms a human kept being asked to clear. */
const nothingToLand = (name: string, branch: string | null): Error =>
  new Error(
    `Nothing to land for ${name}: every commit on ${
      branch ?? "its branch"
    } is already on main, so there is no diff to merge.\n` +
      "No re-arm approval was filed — a landing grant is not needed to merge nothing.\n" +
      "Fix: if you have new work, commit it on your branch and land again; otherwise you are done.",
  );

// Claude's `notification_type` when the CLI is holding a native permission
// dialog open and waiting on a human. Measured against claude 2.1.207, where
// the only other type an agent emits is `idle_prompt` — so this string, and not
// the mere arrival of a Notification hook, is what "blocked" means.
//
// Hive can SEE this dialog but cannot ANSWER it: the hook carries no request id
// and there is no supported reply path to the TUI. So a permission_prompt makes
// an agent visible, and a human still has to clear it at the pane.
const CLAUDE_PERMISSION_PROMPT = "permission_prompt";

const isPermissionPrompt = (event: HookEvent): boolean =>
  event.kind === "notification" &&
  event.notificationType === CLAUDE_PERMISSION_PROMPT;

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

export interface HiveDaemonOptions {
  spawner: Spawner;
  db?: HiveDatabase;
  tmuxSender?: TmuxSender;
  tmux?: Pick<
    TmuxAdapter,
    "hasSession" | "killSession" | "capturePane" | "newSession"
  >;
  recovery?: {
    resolveClaudeSessionId?: SessionResolver;
    resolveCodexSessionId?: SessionResolver;
    resolveGrokSessionId?: SessionResolver;
    worktreeExists?: (path: string) => boolean;
    sleep?: (milliseconds: number) => Promise<void>;
    seedClaudeTrust?: CrashRecoveryDependencies["seedClaudeTrust"];
    writeClaudeConfig?: CrashRecoveryDependencies["writeClaudeConfig"];
    writeCodexConfig?: CrashRecoveryDependencies["writeCodexConfig"];
    writeGrokConfig?: CrashRecoveryDependencies["writeGrokConfig"];
    readCodexActivity?: CrashRecoveryDependencies["readCodexActivity"];
  };
  /** The live autonomy dial: read by `/autonomy` and by crash recovery (so a
   * resume matches the setting the user can see), written only through the
   * operator-gated `/autonomy` endpoint, which persists before it applies. */
  autonomy?: AutonomyControl;
  /** Ordinary Workspace selection persistence; absent for named/default homes. */
  selectionPreferences?: SelectionPreferenceControl;
  /** The per-repo graphify MCP server, when this repo opted in
   * (docs/graphify/integration.md). The daemon owns its
   * lifecycle: up on start, down on stop, rebuilt-and-reloaded after each
   * landing — all fire-and-forget, never in a caller's latency. */
  graphify?: GraphifyService;
  /** Is the binary this daemon runs older than main? Injectable so a test can
   * exercise a stale release without building one (see build-freshness.ts). */
  buildFreshness?: () => Promise<BuildFreshness>;
  repoRoot?: string;
  // Non-destructive process-tree suspend/resume for a critical pause; injectable
  // so tests can drive pause/resume without real SIGSTOP.
  suspendProcesses?: (session: string) => Promise<SuspendOutcome>;
  resumeProcesses?: (session: string) => Promise<void>;
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
  listUnmergedHiveBranches?: (repoRoot: string) => Promise<UnmergedBranch[]>;
  liveInstanceIds?: () => Promise<ReadonlySet<string>>;
  landBranch?: LandBranch;
  readLandReadiness?: ReadLandReadiness;
  port?: number;
  hostname?: string;
  manageLifecycle?: boolean;
  machineMutations?: Pick<MachineMutationCoordinator, "beginOperation">;
  quota?: QuotaService;
  /** Durable provider-reported token accounting. Injectable so collector and
   * lifecycle tests never read the developer's real CLI artifacts. */
  tokenUsage?: TokenUsageStore;
  /** Complete live model inventory for the read-only orchestrator surface. */
  modelInventory?: () => Promise<ModelInventory>;
  /** Root wake transport override for tests; defaults to the lazy Codex
   * root app-server deliverer, inert when no codex root socket exists. */
  rootProtocol?: RootProtocolDeliverer;
  /** Context/activity artifact readers, injectable for tests; default to the
   * real transcript and rollout sensors. `liveModel` reads the model an agent is
   * *running* out of its transcript, and returns null when there is nothing to
   * observe (see ./live-model). */
  telemetryReaders?: {
    claude?: ClaudeTelemetryReader;
    codex?: TelemetryReader;
    grok?: GrokTelemetryReader;
    liveModel?: (
      worktreePath: string,
      toolSessionId: string | undefined,
    ) => Promise<string | null>;
    grokLiveModel?: (
      worktreePath: string,
      toolSessionId: string | undefined,
    ) => Promise<string | null>;
    codexIdentity?: (
      worktreePath: string,
      toolSessionId: string | undefined,
    ) => Promise<CodexIdentityObservation>;
    codexSession?: (
      worktreePath: string,
      processStartedAt: string,
    ) => Promise<string | null>;
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
  /** Idle-agent reap sweep (config `[lifecycle]`); stays off when omitted so
   * embedded daemons (tests, tooling) never close an agent unasked. */
  lifecycle?: LifecycleConfig;
  /** Test seams for the resource sweep's process interrogation. */
  resourceRunners?: {
    ps?: CommandOutput;
    vmStat?: CommandOutput;
    panePids?: (session: string) => Promise<number[]>;
    kill?: (pid: number) => void;
    orphans?: ReapOrphanDependencies | null;
    /** Test seam for the kill path's process-tree reap. */
    reap?: ReapDependencies;
  };
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

/**
 * A `note` rides as a second text block rather than inside the payload: every
 * caller of these tools parses `content[0]` or `structuredContent[key]`, so a
 * warning added there would be a shape change, while a model reading the result
 * sees both blocks. That is exactly what a staleness warning needs — impossible
 * for the reader to miss, invisible to the parsers.
 */
function toolResult(value: unknown, key: string, note?: string | null) {
  const payload = { type: "text" as const, text: JSON.stringify(value) };
  return {
    content: note === undefined || note === null
      ? [payload]
      : [payload, { type: "text" as const, text: note }],
    structuredContent: { [key]: value },
  };
}

export class HiveDaemon {
  readonly db: HiveDatabase;
  readonly delivery: MessageDelivery;
  readonly spawner: Spawner;
  readonly memory: MemoryIndex;
  readonly capabilities: CapabilityStore;
  private memoryLock: Promise<unknown> = Promise.resolve();
  private readonly ownsDatabase: boolean;
  private readonly port: number;
  private readonly hostname: string;
  private readonly manageLifecycle: boolean;
  private readonly machineMutations:
    | Pick<MachineMutationCoordinator, "beginOperation">
    | null;
  private readonly ownedMachineMutations: MachineMutationCoordinator | null;
  private readonly tmux: Pick<
    TmuxAdapter,
    "hasSession" | "killSession" | "capturePane" | "newSession"
  >;
  private readonly recovery: CrashRecovery;
  private readonly repoRoot: string;
  private readonly readClaudeTelemetry: ClaudeTelemetryReader;
  private readonly readCodexTelemetry: TelemetryReader;
  private readonly readGrokTelemetry: GrokTelemetryReader;
  private readonly readLiveModel: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
  private readonly readGrokLiveModel: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<string | null>;
  private readonly readCodexIdentity: (
    worktreePath: string,
    toolSessionId: string | undefined,
  ) => Promise<CodexIdentityObservation>;
  private readonly readCodexProcessSession: (
    worktreePath: string,
    processStartedAt: string,
  ) => Promise<string | null>;
  private readonly handshake: () => ReturnType<typeof expectedDaemonHandshake>;
  private readonly buildFreshness: () => Promise<BuildFreshness>;
  private readonly cleanupWorktree: typeof removeWorktree;
  private readonly assessStranded: NonNullable<
    HiveDaemonOptions["assessStrandedWork"]
  >;
  private readonly listUnmergedBranches: NonNullable<
    HiveDaemonOptions["listUnmergedHiveBranches"]
  >;
  private readonly liveInstanceIds: () => Promise<ReadonlySet<string>>;
  /** Stranded branches already reported this boot, keyed by branch and tip.
   * In memory on purpose: a restart must re-report, because the orchestrator
   * that heard the first alert did not survive it. */
  private readonly alertedStrandedBranches = new Set<string>();
  private readonly bootId = crypto.randomUUID();
  private readonly quota: QuotaService | undefined;
  private readonly tokenUsage: TokenUsageStore;
  private readonly modelInventory: HiveDaemonOptions["modelInventory"];
  private routingPolicy: RoutingPolicyStore | null = null;
  private readonly codexControl: HiveDaemonOptions["codexControl"];
  private readonly autonomy: AutonomyControl | undefined;
  private readonly selectionPreferences: SelectionPreferenceControl | undefined;
  private readonly graphify: GraphifyService | undefined;
  /** Per-agent graphify MCP call counts (integration doc, layer 3). Keyed by
   * AgentUUID, in memory on purpose: the transcripts are durable, so a
   * restart recounts from offset zero instead of trusting a stale number. */
  private readonly graphifyCalls = new Map<string, GraphifyCallCursor>();
  private readonly land: LandBranch;
  private readonly landReadiness: ReadLandReadiness;
  private bunServer: Server<undefined> | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunning = false;
  private maintenanceHealth:
    | { status: "unknown" }
    | { status: "ok" }
    | { status: "error"; error: string } = { status: "unknown" };
  private readonly resources: ResourceLimits | null;
  private readonly lifecycleConfig: LifecycleConfig | null;
  private readonly psSample: CommandOutput;
  private readonly vmStatSample: CommandOutput;
  private readonly panePids: (session: string) => Promise<number[]>;
  private readonly killProcess: (pid: number) => void;
  private readonly orphanDependencies: ReapOrphanDependencies | null;
  private readonly reapDependencies: ReapDependencies;
  private readonly stopAgentProcesses: (
    agent: AgentRecord,
    beforeKill?: () => void | Promise<void>,
  ) => Promise<ReapOutcome>;
  private readonly stopTmuxProcesses: (
    session: string,
  ) => Promise<ReapOutcome>;
  // Non-destructive halt/resume of an agent's process tree — the mechanism a
  // pause uses to freeze a writer without terminating it. Injectable for tests.
  private readonly suspendAgentProcesses: (
    session: string,
    agent?: AgentRecord,
  ) => Promise<SuspendOutcome>;
  private readonly resumeAgentProcesses: (
    session: string,
    agent?: AgentRecord,
  ) => Promise<void>;
  private readonly usesInjectedSuspend: boolean;
  private readonly usesInjectedResume: boolean;
  private readonly teardownTmux: SessionStopAdapter;
  private memoryPressure = false;

  constructor(options: HiveDaemonOptions) {
    this.ownsDatabase = options.db === undefined;
    this.db = options.db ?? new HiveDatabase();
    this.memory = new MemoryIndex(this.db.database);
    this.spawner = options.spawner;
    this.capabilities = new CapabilityStore(this.db, (name) => {
      const record = this.db.getAgentByName(name);
      if (record === null) return null;
      // Terminal is independently authority-revoking: even a legacy dead row
      // that never had writeRevoked flipped cannot authorize write/land.
      const terminal = isTerminalAgentStatus(record.status);
      return {
        id: record.id,
        processIncarnation: record.processIncarnation ?? 0,
        capabilityEpoch: record.capabilityEpoch,
        writeRevoked: record.writeRevoked || terminal,
      };
    });
    this.port = options.port ?? readConfiguredPort();
    this.hostname = options.hostname ?? "127.0.0.1";
    this.manageLifecycle = options.manageLifecycle ?? false;
    if (options.machineMutations !== undefined) {
      this.machineMutations = options.machineMutations;
      this.ownedMachineMutations = null;
    } else if (this.manageLifecycle) {
      const coordinator = new MachineMutationCoordinator();
      this.machineMutations = coordinator;
      this.ownedMachineMutations = coordinator;
    } else {
      this.machineMutations = null;
      this.ownedMachineMutations = null;
    }
    this.tmux = options.tmux ?? new TmuxAdapter();
    this.quota = options.quota;
    this.tokenUsage = options.tokenUsage ?? new TokenUsageStore(this.db);
    this.modelInventory = options.modelInventory;
    this.codexControl = options.codexControl;
    this.autonomy = options.autonomy;
    this.selectionPreferences = options.selectionPreferences;
    this.graphify = options.graphify;
    const tmuxSender = options.tmuxSender ?? new BunTmuxSender();
    this.delivery = new MessageDelivery(
      this.db,
      tmuxSender,
      {
        interruptAndRestart: async (agent, message) => {
          const sameControlAttempt = agent.status === "control-paused" &&
            agent.controlMessageId === message.id &&
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
          // A critical `pause` is non-destructive: it must NOT kill the agent or
          // replace it with a fresh read-only process (that destroyed live
          // context in the field). Freeze the SAME process instead — capability
          // is already revoked by delivery — and preserve the session for an
          // authorized reattesting resume. stop/cancel/restrict-writes keep the
          // existing revoke-and-replace path below.
          if (message.intent === "pause") {
            await this.pauseAgentForControl(agent, message);
            return;
          }
          if (!sameControlAttempt) {
            if (agent.tool === "codex" && this.codexControl?.hasAgent(agent.name)) {
              await this.codexControl.denyAgentApprovals(agent.name);
              await this.codexControl.interrupt(agent).catch(() => undefined);
              this.codexControl.disconnect(agent.name);
            }
            const stopped = await this.stopAgentProcesses(agent);
            if (stopped.survivors.length > 0) {
              throw new Error(
                `${stopped.survivors.length} process(es) survived critical-control teardown for ${agent.name}`,
              );
            }
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
          try {
            await this.spawner.restartForControl(agent, message);
          } catch (error) {
            const current = this.db.getAgentById(agent.id) ?? agent;
            if (current.status === "stuck") throw error;
            // The old writer is already gone, so rolling back across the OS
            // boundary is impossible. Finish the control into a coherent,
            // terminal fail-closed state and release what the ledger says this
            // agent still holds; a queued control must not strand capacity or
            // invite an identical recovery attempt forever.
            await this.settleAgentQuota(
              current,
            ).catch(() => undefined);
            const reason = error instanceof Error
              ? error.message
              : "control acknowledgement process failed to launch";
            const failedAt = new Date().toISOString();
            this.db.markAgentTerminal(current.id, failedAt, "failed", {
              failureReason:
                `Critical control ${message.id} restart failed: ${reason}`,
              failedAt,
            });
            throw error;
          }
        },
      },
      this.codexControl,
      // All visible roots use their instance-scoped terminal. Delivery holds
      // the composer lease so a report cannot overwrite human input.
      options.rootProtocol ??
        new OrchestratorRootDelivery({
          tmux: tmuxSender,
        }),
      {},
      // The stalled-message triage's OS probe: what `ps` says about the
      // recipient's pane tree. Reads this.panePids/this.tmux lazily — both
      // are assigned below, and the sweep runs long after construction. A
      // pane whose pids cannot be listed is judged by whether the session
      // still exists at all; a session that vanished mid-probe is honestly
      // "gone".
      async (tmuxSession) => {
        let pids: number[];
        try {
          pids = await this.panePids(tmuxSession);
        } catch {
          return (await this.tmux.hasSession(tmuxSession)) ? "running" : "gone";
        }
        if (pids.length === 0) return "gone";
        return paneProcessState(parseStateTable(await runPsState()), pids);
      },
    );
    this.quota?.setAlertSink(async (body) => {
      await this.delivery.send("hive-quota", ORCHESTRATOR_NAME, body);
    });
    this.land = options.landBranch ?? landBranch;
    this.landReadiness = options.readLandReadiness ?? readLandReadiness;
    this.resources = options.resources ?? null;
    this.lifecycleConfig = options.lifecycle ?? null;
    this.psSample = options.resourceRunners?.ps ?? runPs;
    this.vmStatSample = options.resourceRunners?.vmStat ?? runVmStat;
    this.panePids = options.resourceRunners?.panePids ??
      ((session) => new TmuxAdapter().listPanePids(session));
    this.killProcess = options.resourceRunners?.kill ??
      ((pid) => process.kill(pid, "SIGKILL"));
    this.orphanDependencies = options.resourceRunners?.orphans === undefined
      ? defaultOrphanDependencies()
      : options.resourceRunners.orphans;
    this.reapDependencies = options.resourceRunners?.reap ??
      defaultReapDependencies();
    const teardownTmux: SessionStopAdapter = {
      hasSession: (session) => this.tmux.hasSession(session),
      listPanePids: (session) => this.panePids(session),
      killSession: (session, killOptions) =>
        this.tmux.killSession(session, killOptions),
    };
    this.stopAgentProcesses = (agent, beforeKill) =>
      stopAgentSession(
        agent,
        { tmux: teardownTmux, reap: this.reapDependencies },
        beforeKill,
      );
    this.stopTmuxProcesses = (session) =>
      stopTmuxSession(session, {
        tmux: teardownTmux,
        reap: this.reapDependencies,
      });
    this.usesInjectedSuspend = options.suspendProcesses !== undefined;
    this.usesInjectedResume = options.resumeProcesses !== undefined;
    this.teardownTmux = teardownTmux;
    this.suspendAgentProcesses = options.suspendProcesses ??
      (async (session, agent) => {
        const hostPid = agent === undefined
          ? null
          : await readCodexHostPid(agent);
        return suspendTmuxSession(session, {
          tmux: teardownTmux,
          reap: this.reapDependencies,
        }, hostPid === null ? [] : [hostPid]);
      });
    this.resumeAgentProcesses = options.resumeProcesses ??
      (async (session, agent) => {
        const hostPid = agent === undefined
          ? null
          : await readCodexHostPid(agent);
        return resumeTmuxSession(session, {
          tmux: teardownTmux,
          reap: this.reapDependencies,
        }, hostPid === null ? [] : [hostPid]);
      });
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.readClaudeTelemetry = options.telemetryReaders?.claude ??
      readClaudeTelemetry;
    this.readCodexTelemetry = options.telemetryReaders?.codex ??
      readCodexTelemetry;
    this.readGrokTelemetry = options.telemetryReaders?.grok ??
      ((worktreePath, toolSessionId) =>
        readGrokTelemetry(worktreePath, toolSessionId));
    this.readLiveModel = options.telemetryReaders?.liveModel ??
      ((worktreePath, toolSessionId) =>
        readLiveClaudeModel(worktreePath, toolSessionId));
    this.readGrokLiveModel = options.telemetryReaders?.grokLiveModel ??
      ((worktreePath, toolSessionId) =>
        toolSessionId === undefined
          ? Promise.resolve(null)
          : readLiveGrokModel(worktreePath, toolSessionId));
    this.readCodexIdentity = options.telemetryReaders?.codexIdentity ??
      ((worktreePath, toolSessionId) =>
        readCodexObservedIdentity(worktreePath, toolSessionId));
    this.readCodexProcessSession = options.telemetryReaders?.codexSession ??
      (async (worktreePath, processStartedAt) =>
        (await findCodexRolloutForProcess(worktreePath, processStartedAt))
          ?.sessionId ?? null);
    this.handshake = () => expectedDaemonHandshake(this.repoRoot);
    this.buildFreshness = options.buildFreshness ??
      (() => checkBuildFreshness(this.repoRoot));
    this.cleanupWorktree = options.removeWorktree ?? removeWorktree;
    this.assessStranded = options.assessStrandedWork ?? assessStrandedWork;
    this.listUnmergedBranches = options.listUnmergedHiveBranches ??
      listUnmergedHiveBranches;
    this.liveInstanceIds = options.liveInstanceIds ?? (async () =>
      new Set(
        (await listInstances())
          .filter((instance) => instance.running)
          .map((instance) => instance.instanceId),
      ));
    this.recovery = new CrashRecovery({
      db: this.db,
      tmux: this.tmux,
      port: () => this.listeningPort ?? this.port,
      revokeCapabilities: (agentName) => {
        this.capabilities.revokeSubject(agentName);
        removeCredential(agentName);
      },
      reauthorizeAgent: (agent) => {
        return this.issueAgentCredential(
          agent,
          agent.readOnly ? "reader" : "writer",
          agent.capabilityEpoch,
        );
      },
      stopSession: (agent) =>
        this.stopAgentProcesses(agent, () => {
          this.capabilities.revokeSubject(agent.name);
          removeCredential(agent.name);
        }),
      send: (from, to, body, sendOptions) =>
        this.delivery.send(from, to, body, sendOptions),
      settleQuota: (agent) => this.settleAgentQuota(agent),
      authorizeLaunch: async (identity) =>
        await this.spawner.authorizeLaunch?.(identity) ?? null,
      flushQueued: (agentName) => this.delivery.flushQueued(agentName),
      // A thunk, not a value: a resume launched after the user flips the
      // Agents-menu dial must match the setting the user can see, not the one
      // the daemon booted with.
      ...(options.autonomy === undefined
        ? {}
        : { autonomy: () => options.autonomy!.get() }),
      ...(options.recovery?.resolveClaudeSessionId === undefined
        ? {}
        : { resolveClaudeSessionId: options.recovery.resolveClaudeSessionId }),
      ...(options.recovery?.resolveCodexSessionId === undefined
        ? {}
        : { resolveCodexSessionId: options.recovery.resolveCodexSessionId }),
      ...(options.recovery?.resolveGrokSessionId === undefined
        ? {}
        : { resolveGrokSessionId: options.recovery.resolveGrokSessionId }),
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
      ...(options.recovery?.writeGrokConfig === undefined
        ? {}
        : { writeGrokConfig: options.recovery.writeGrokConfig }),
      ...(options.recovery?.readCodexActivity === undefined
        ? {}
        : { readCodexActivity: options.recovery.readCodexActivity }),
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

  private async failClosedUnsafeResume(
    agent: AgentRecord,
    detail: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const current = this.db.getAgentById(agent.id);
    if (current !== null && !isTerminalAgentStatus(current.status)) {
      this.db.updateAgentIfCurrent(agentStateCas(current), {
        status: "stuck",
        writeRevoked: true,
        capabilityEpoch: current.writeRevoked
          ? current.capabilityEpoch
          : current.capabilityEpoch + 1,
        failureReason:
          `Resume rollback could not prove the process stopped: ${detail}`,
        lastEventAt: now,
      });
    }
    this.capabilities.revokeAgentHolder(
      agent.id,
      agent.processIncarnation ?? 0,
    );
    await this.delivery.send(
      "hive-resume-guard",
      ORCHESTRATOR_NAME,
      `${agent.name} resume FAILED CLOSED: Hive could not prove the continued ` +
        `process tree was stopped again (${detail}). Write/landing authority ` +
        `is revoked and the row is stuck, not paused. Treat the process as ` +
        `potentially running until it is killed or physically verified stopped.`,
      {
        idempotencyKey:
          `unsafe-resume:${agent.id}:${agent.processIncarnation ?? 0}`,
      },
    ).catch(logAlertDeliveryFailure);
  }

  /** Mints a credential for one subject and writes it to its 0600 file,
   * revoking whatever that subject held before. Tokens come into existence
   * only from the daemon: here at spawn, and through the single sanctioned
   * launcher request (`POST /codex-root-token`) that mints the codex root's
   * local control-plane capability. There is no delegation and no attenuation. */
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

  /** Mint for one exact durable process holder. Rollback revokes only this
   * capability id and removes only this token object, never a same-name
   * successor's capability or replacement credential. */
  private issueAgentCredential(
    agent: AgentRecord,
    role: "reader" | "writer",
    epoch: number,
  ): { rollback: () => void } | null {
    const expected = agentStateCas(agent);
    if (this.db.updateAgentIfCurrent(expected, {}) === null) return null;
    const { token, capability } = this.capabilities.mint(agent.name, role, {
      epoch,
      holder: {
        agentId: agent.id,
        processIncarnation: agent.processIncarnation ?? 0,
      },
    });
    const rollback = () => {
      this.capabilities.revoke(capability.id);
      removeCredentialIfMatches(agent.name, token);
    };
    try {
      writeCredential(agent.name, token);
    } catch (error) {
      this.capabilities.revoke(capability.id);
      throw error;
    }
    if (this.db.updateAgentIfCurrent(expected, {}) === null) {
      rollback();
      return null;
    }
    return { rollback };
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
    // The graphify MCP server, for repos that opted in. Same posture as the
    // reindex above: a repo whose graph will not build or serve runs exactly
    // as it would without graphify, and the failure is logged, not raised.
    void this.graphify?.start().catch((error) => {
      console.error(
        `Hive graphify start failed: ${
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
    const locked = async (): Promise<T> => {
      const directory = join(this.repoRoot, ".hive");
      await mkdir(directory, { recursive: true });
      return withFileLock(join(directory, "memory.lock"), operation);
    };
    const run = this.memoryLock.then(locked, locked);
    this.memoryLock = run.then(() => undefined, () => undefined);
    return run;
  }

  async writeMemoryFact(input: MemoryWriteInput) {
    return this.serializeMemory(async () => {
      const written = await writeMemoryFactFile(this.repoRoot, input);
      for (const id of written.supersededIds) {
        this.memory.removeFact(input.scope, id);
      }
      this.memory.upsertFact(written);
      return written;
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

  async rebuildMemoryIndex() {
    return this.serializeMemory(() => this.memory.rebuild(this.repoRoot));
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

  /**
   * The daemon's one recurring sweep: every 30s, and once at startup.
   *
   * Public because it is the seam a test drives. That is not a cosmetic detail —
   * the reconciliation below hung off the interval callback instead of living
   * here, which put it in the one place no test can reach, and so the only thing
   * standing between "injected" and a state nothing ever reads again was a line
   * that could be deleted without turning anything red. It is inside maintenance
   * now, and a test drives maintenance.
   */
  async runMaintenance(): Promise<void> {
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
      // Close the loop on every message we handed over. Runs after the wake, so a
      // message injected on this very tick is judged against the deadline it was
      // actually given rather than the instant it was handed over.
      await this.delivery.reconcileInjected().catch((error) => {
        console.error(
          `Hive delivery reconciliation failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await this.reconcileAgents();
      await this.refreshToolTelemetry().catch((error) => {
        console.error(
          `Hive tool telemetry sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await this.tokenUsage.refreshCurrent(this.repoRoot).catch((error) => {
        console.error(
          `Hive token-usage sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      // An idle agent makes no tool calls and reaches no turn boundaries, and
      // those are the only things that ever triggered a redelivery — so mail
      // queued at a busy agent stayed queued once it went quiet. The daemon
      // knows the agent is idle and knows the message is waiting; it wakes it
      // rather than waiting for an event that is not coming. Runs after the
      // telemetry sweep, because for a vendor with no hook stream that sweep is
      // what makes the row say "idle" in the first place.
      await this.delivery.wakeIdleRecipients().catch((error) => {
        console.error(
          `Hive idle wake failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await this.sweepResources();
      await this.reapIdleAgents().catch((error) => {
        console.error(
          `Hive idle-reap sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      // Runs at startup, which is the moment that matters: a restart is
      // precisely when work whose agent row is gone would otherwise fall out
      // of the world unannounced.
      await this.reconcileStrandedBranches().catch((error) => {
        console.error(
          `Hive stranded-branch reconciliation failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      this.db.pruneHistory(new Date().toISOString());
      this.maintenanceHealth = { status: "ok" };
    } catch (error) {
      this.maintenanceHealth = {
        status: "error",
        error: error instanceof Error ? error.message : "unknown error",
      };
      throw error;
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * A spent land grant is not automatically a human's problem, and this is
   * where Hive stops making it one. Three answers, in order of how much
   * evidence they need:
   *
   * - `nothing-to-land`: the branch has no commit the primary lacks. There is
   *   nothing to merge, so there is nothing to grant, so no approval is filed.
   *   This is the no-op re-arm Hive kept asking humans to clear — agents
   *   checked `main..branch`, found it empty, and correctly refused the grant
   *   Hive had just filed for them.
   * - `rearmed`: Hive measured, in the primary checkout, the two things the
   *   human was being asked to eyeball — the branch has work (`pending > 0`)
   *   and it is rebased on current main, so the merge is a real fast-forward —
   *   and the agent is still inside its auto-re-arm budget. It re-arms itself
   *   and audits the grant.
   * - `ask`: everything else, including every unknown. A branch we could not
   *   read, a `null` from either measurement, a divergent branch, an exhausted
   *   budget: file the approval and let a person decide. Unknown must never
   *   read as permission — a `null` that means "we could not tell" is not a
   *   yes, and this is the guard that would be disarmed if it were.
   *
   * What is deliberately NOT checked is the test suite: the daemon cannot run
   * it in a land handler, and an agent's *claim* that it is green is an act,
   * not a state. So the suite is not pretended to be verified — the budget is
   * the containment instead, and beyond it a human sees the work.
   */
  private async decideSpentLandGrant(
    capability: Capability,
    branch: string | null,
    mayAutoRearm: boolean,
  ): Promise<"nothing-to-land" | "rearmed" | "ask"> {
    if (branch === null) return "ask";
    const readiness = await this.landReadiness(this.repoRoot, branch)
      .catch(() => ({ pending: null, rebased: null }));
    if (readiness.pending === 0) return "nothing-to-land";
    if (!mayAutoRearm) return "ask";
    if (readiness.pending === null || readiness.rebased !== true) return "ask";
    const spent = this.db.countAuditEntries(
      capability.subject,
      "branch:land",
      AUTO_REARM_REASON,
    );
    if (spent >= AUTO_REARM_BUDGET) return "ask";
    this.capabilities.rearmOneShot(capability.subject, "branch:land");
    this.capabilities.audit({
      route: "/mcp:hive_land",
      action: "branch:land",
      callerSubject: capability.subject,
      callerRole: capability.role,
      capabilityId: capability.id,
      requestedSubject: capability.subject,
      epoch: capability.epoch,
      decision: "allow",
      reason: AUTO_REARM_REASON,
    });
    return "rearmed";
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
      // Fixed boilerplate around the agent name: safe to trim on the polled
      // MCP surface.
      kind: "land-rearm",
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
  /**
   * Fail-closed, NON-DESTRUCTIVE response to a Codex writer whose observed
   * identity has drifted from its authorized launch identity. Order matters and
   * is load-bearing:
   *   1. Revoke write/landing capability FIRST, durably and atomically — a
   *      revoked-but-still-running writer can still mutate through local shell,
   *      so revocation alone is not enough, but it must land before the freeze
   *      so no window exists where a stale token could land.
   *   2. Freeze the process non-destructively: a native turn interrupt for an
   *      app-server session, then SIGSTOP the whole process tree. The process,
   *      rollout, thread, tmux holder, and toolSession are all preserved.
   *   3. Wake queen with a durable report. Control success is measured by the
   *      daemon/process state, never by an acknowledgement — a suspended
   *      process cannot ack.
   * The drift is durable on the row (identityState + observedIdentity + the
   * revocation), so a daemon restart still sees a paused, revoked agent and
   * crash recovery never resumes it into mutation.
   */
  /**
   * Non-destructively freeze an agent's process tree: a provider-native turn
   * interrupt for an app-server session, then a SIGSTOP of the whole tree. The
   * process, rollout/thread, tmux holder, and toolSession are preserved. Shared
   * by every pause path (identity drift and operator control). Returns the
   * suspend outcome, or null when the suspension itself failed — either of which
   * a caller must treat as unsafe if any process was left running.
   */
  /**
   * Capture the exact pause-bound tree (tmux roots + app-server host, with
   * stable birth identities), SIGSTOP it, and return the durable capture.
   * Callers must persist `capture` on the agent row so resume never re-samples
   * current PIDs.
   */
  private async freezeAgentProcessTree(
    agent: AgentRecord,
  ): Promise<{ outcome: SuspendOutcome; capture: PauseCapture } | null> {
    if (agent.tool === "codex" && this.codexControl?.hasAgent(agent.name)) {
      await this.codexControl.interrupt(agent).catch(() => undefined);
    }
    try {
      // Prefer the injected test hook when present; production uses the
      // birth-bound suspendAgentForPause path exclusively.
      if (this.usesInjectedSuspend) {
        const outcome = await this.suspendAgentProcesses(
          agent.tmuxSession,
          agent,
        );
        if (outcome.suspended.length === 0 && outcome.unstopped.length === 0) {
          throw new Error(
            `pause capture for ${agent.name} was empty (session missing, incomplete, or vanished)`,
          );
        }
        // Tests inject suspend without a real tree; synthesize a capture from
        // the suspended list so resume still goes through capture validation.
        const capture: PauseCapture = {
          agentId: agent.id,
          agentName: agent.name,
          tmuxSession: agent.tmuxSession,
          toolSessionId: agent.toolSessionId ?? null,
          processIncarnation: agent.processIncarnation ?? 0,
          hostPid: null,
          tree: outcome.suspended.map((entry) => ({
            pid: entry.pid,
            command: entry.command,
            birth: `test-birth-${entry.pid}`,
            role: "tmux-root" as const,
          })),
          capturedAt: new Date().toISOString(),
        };
        if (capture.tree.length === 0) {
          throw new Error(`pause capture for ${agent.name} was empty`);
        }
        return { outcome, capture };
      }
      const requireHost = agent.tool === "codex" &&
        this.codexControl?.hasAgent(agent.name) === true;
      const { capture, outcome } = await suspendAgentForPause(agent, {
        tmux: this.teardownTmux,
        reap: this.reapDependencies,
        readHostPid: readCodexHostPid,
        requireAppServerHost: requireHost,
      });
      if (outcome.unstopped.length > 0) {
        return { outcome, capture };
      }
      if (outcome.suspended.length === 0) {
        throw new Error(
          `pause capture for ${agent.name} was empty (session missing, incomplete, or vanished)`,
        );
      }
      return { outcome, capture };
    } catch (error) {
      console.error(
        `Hive could not suspend ${agent.name}'s process tree: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return null;
    }
  }

  /**
   * Non-destructive handler for a critical control whose intent is `pause`. The
   * revoke-first is already durable when this runs: delivery's
   * `revokeAgentCapabilities` advanced the epoch, set writeRevoked, moved the
   * row to control-paused, and denied pending approvals in one transaction
   * BEFORE the process is touched. This then freezes the SAME process
   * non-destructively and binds the control to the row. It never kills the
   * process, never spawns a replacement, and reserves no control quota — a
   * paused agent runs no turn. A suspension that leaves any process running
   * throws, so the control is not falsely recorded as applied.
   */
  private async pauseAgentForControl(
    agent: AgentRecord,
    message: AgentMessage,
  ): Promise<void> {
    const expected = agentStateCas(agent);
    const frozen = await this.freezeAgentProcessTree(agent);
    const unsafe = frozen === null || frozen.outcome.unstopped.length > 0;
    const current = this.db.updateAgentIfCurrent(expected, {
      status: unsafe ? "stuck" : "control-paused",
      writeRevoked: true,
      controlMessageId: message.id,
      failureReason: unsafe
        ? frozen === null
          ? `Pause suspension failed for ${agent.name}; process state is unknown`
          : `${frozen.outcome.unstopped.length} process(es) survived pause suspension`
        : undefined,
      ...(frozen === null ? {} : { pauseCapture: frozen.capture }),
    });
    if (current === null) {
      throw new Error(
        `Pause aborted for ${agent.name}: exact session/incarnation/authority tuple changed during freeze`,
      );
    }
    if (unsafe) {
      throw new Error(
        frozen === null
          ? `Pause suspension failed for ${agent.name}; the process may still be running`
          : `${frozen.outcome.unstopped.length} process(es) survived pause suspension for ${agent.name}`,
      );
    }
  }

  private async pauseWriterForIdentityDrift(
    agent: AgentRecord,
    detail: string,
  ): Promise<void> {
    const nextEpoch = agent.capabilityEpoch + 1;
    const paused = this.db.updateAgentIfCurrent(agentStateCas(agent), {
      status: "control-paused",
      writeRevoked: true,
      capabilityEpoch: nextEpoch,
      identityState: agent.identityState,
      observedIdentity: agent.observedIdentity,
      liveModel: agent.liveModel,
      liveEffort: agent.liveEffort,
    });
    if (paused === null) {
      return; // concurrent kill/terminal wins
    }
    this.capabilities.revokeSubject(agent.name);
    removeCredential(agent.name);
    const frozen = await this.freezeAgentProcessTree(paused);
    const current = this.db.updateAgentIfCurrent(agentStateCas(paused), {
      status: frozen === null || frozen.outcome.unstopped.length > 0
        ? "stuck"
        : "control-paused",
      failureReason: frozen === null
        ? "identity guard could not verify process suspension"
        : frozen.outcome.unstopped.length > 0
        ? `identity guard left ${frozen.outcome.unstopped.length} process(es) running`
        : undefined,
      ...(frozen === null ? {} : { pauseCapture: frozen.capture }),
    });
    if (current === null) {
      return; // concurrent kill won after freeze
    }
    const halt = frozen === null
      ? "process suspension FAILED (see daemon log) — treat as unsafe"
      : frozen.outcome.unstopped.length > 0
      ? `process suspension left ${frozen.outcome.unstopped.length} process(es) still running`
      : "process tree suspended";
    await this.delivery.send(
      "hive-identity-guard",
      ORCHESTRATOR_NAME,
      `Codex writer ${agent.name} ${current.status === "control-paused" ? "PAUSED" : "STUCK"} ` +
        `for execution-identity drift: ${detail}. Write/landing capability ` +
        `revoked (epoch ${nextEpoch}); ${halt}. Durable status is ${current.status}; ` +
        (current.status === "control-paused"
          ? "session/process/tmux/toolSession are preserved for an authorized reattesting resume."
          : "do not call this paused: process suspension was not proven; kill or verify it physically."),
    );
  }

  /**
   * Authorized, reattesting resume of a non-destructively paused agent. It
   * reattests the running identity and only if it now MATCHES the launch
   * identity does it reissue a fresh capability epoch + credential, clear the
   * revocation, SIGCONT the exact same process, and return the agent to idle. A
   * still-drifted or unreadable identity keeps it paused — resume never returns
   * write authority to an unattested writer. Nothing is relaunched: because the
   * agent CLI reads its credential from a file at write time, reissuing to the
   * same subject restores authority to the surviving process.
   */
  async resumeAgentAfterPause(
    name: string,
  ): Promise<{ resumed: boolean; identityState: IdentityState; reason: string }> {
    const agent = this.db.getAgentByName(name);
    if (agent === null) throw new Error(`Hive agent not found: ${name}`);
    if (agent.status !== "control-paused") {
      return {
        resumed: false,
        identityState: attestationStateOf(agent),
        reason: `${name} is not paused (status ${agent.status})`,
      };
    }
    // Codex writer authoring is contained: a paused Codex writer must not have
    // its write authority reissued (defense-in-depth for legacy paused writers;
    // Codex writers can no longer be launched at all).
    const containment = codexWriterContainment(agent.tool, agent.readOnly);
    if (containment !== null) {
      return {
        resumed: false,
        identityState: attestationStateOf(agent),
        reason: containment,
      };
    }
    let identityState: IdentityState = attestationStateOf(agent);
    let observed = agent.observedIdentity;
    let liveModel = agent.liveModel;
    let liveEffort = agent.liveEffort;
    // Reattest a Codex agent from its own rollout; a non-Codex paused agent has
    // no identity attestation and resumes on its existing row.
    if (agent.tool === "codex" && agent.worktreePath !== null) {
      const launch = agent.executionIdentity;
      if (launch === undefined) {
        return {
          resumed: false,
          identityState: "unknown",
          reason: `${name} has no immutable launch identity; resume refused`,
        };
      }
      const attestation = reconcileCodexIdentity(
        launch,
        await this.readCodexIdentity(agent.worktreePath, agent.toolSessionId),
      );
      identityState = attestation.identityState;
      if (attestation.observedIdentity !== null) {
        observed = attestation.observedIdentity;
      }
      if (attestation.liveModel !== null) liveModel = attestation.liveModel;
      if (attestation.liveEffort !== null) liveEffort = attestation.liveEffort;
      if (identityState !== "matching") {
        this.db.updateAgentIfCurrent(agentStateCas(agent), {
          identityState,
          ...(observed === undefined ? {} : { observedIdentity: observed }),
          ...(liveModel === undefined ? {} : { liveModel }),
          ...(liveEffort === undefined ? {} : { liveEffort }),
        });
        return {
          resumed: false,
          identityState,
          reason:
            `reattestation is ${identityState}, not matching; write authority withheld`,
        };
      }
    }
    // Resume the EXACT pause-time capture — never re-sample current PIDs.
    // Missing/vanished/reused/stale/replaced roots or host fail closed and
    // leave the agent paused/revoked.
    const capture = agent.pauseCapture;
    if (capture === undefined) {
      return {
        resumed: false,
        identityState,
        reason:
          "no pause capture is bound to this agent; resume refused (cannot prove same process tree)",
      };
    }
    try {
      if (this.usesInjectedResume) {
        await this.resumeAgentProcesses(agent.tmuxSession, agent);
      } else {
        await resumeAgentFromPauseCapture(agent, capture, {
          tmux: this.teardownTmux,
          reap: this.reapDependencies,
          readHostPid: readCodexHostPid,
        });
      }
    } catch (error) {
      if (
        error instanceof ResumeRollbackError && !error.rollbackVerified
      ) {
        await this.failClosedUnsafeResume(agent, error.message);
      }
      return {
        resumed: false,
        identityState,
        reason:
          `exact-tree resume failed; write authority withheld: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
      };
    }
    // Final exact CAS after identity/tree/SIGCONT. Mint for this UUID/process
    // holder at the next epoch while the row is still revoked; a failed CAS
    // rolls back only that exact grant.
    const nextEpoch = agent.capabilityEpoch + 1;
    const grant = this.issueAgentCredential(
      agent,
      agent.readOnly ? "reader" : "writer",
      nextEpoch,
    );
    const resumed = grant === null
      ? null
      : this.db.updateAgentIfCurrent(agentStateCas(agent), {
      status: "idle",
      writeRevoked: false,
      capabilityEpoch: nextEpoch,
      identityState,
      controlMessageId: undefined,
      pauseCapture: undefined,
      ...(observed === undefined ? {} : { observedIdentity: observed }),
      ...(liveModel === undefined ? {} : { liveModel }),
      ...(liveEffort === undefined ? {} : { liveEffort }),
      });
    if (resumed === null) {
      grant?.rollback();
      let rollbackVerified = false;
      let rollbackDetail = "no production process readback was available";
      if (!this.usesInjectedResume) {
        try {
          const rollback = await suspendCapturedTree(
            capture.tree.map((entry) => ({
              pid: entry.pid,
              command: entry.command,
            })),
            this.reapDependencies,
          );
          rollbackVerified = rollback.unstopped.length === 0;
          rollbackDetail = rollbackVerified
            ? "continued tree was re-stopped and read back"
            : `${rollback.unstopped.length} process(es) remained running`;
        } catch (error) {
          rollbackDetail = error instanceof Error
            ? error.message
            : "rollback readback failed";
        }
      }
      if (!rollbackVerified) {
        await this.failClosedUnsafeResume(agent, rollbackDetail);
      }
      const fresh = this.db.getAgentById(agent.id);
      return {
        resumed: false,
        identityState,
        reason:
          `resume refused after SIGCONT: row is no longer the paused incarnation ` +
          `(status=${fresh?.status ?? "missing"}, epoch=${fresh?.capabilityEpoch ?? "?"}); ` +
          rollbackDetail,
      };
    }
    return {
      resumed: true,
      identityState,
      reason:
        "reattested matching; exact pause capture SIGCONT'd; capability reissued at a fresh epoch",
    };
  }

  async refreshToolTelemetry(): Promise<void> {
    for (const agent of this.db.listAgents()) {
      if (
        agent.status === "dead" || agent.status === "done" ||
        agent.status === "failed"
      ) continue;
      const worktree = agent.worktreePath;
      if (worktree === null || worktree === undefined) continue;
      let telemetry: ToolTelemetry | null = null;
      let claudeContext: number | null = null;
      let grokTelemetry: GrokTelemetry | null = null;
      let codexIdentity: CodexIdentityObservation | null = null;
      let codexSession: string | null = null;
      let codexSessionTrusted = false;
      // The vendor switch sits outside the read's catch: a failed read is
      // routine and skips the agent, but a vendor with no reader is a bug that
      // must be heard — swallowing it would report this agent's context off
      // Codex's rollout parser and call the wrong number telemetry.
      switch (agent.tool) {
        case "claude":
          try {
            claudeContext = (await this
              .readClaudeTelemetry(worktree, agent.toolSessionId)).contextTokens;
          } catch {
            continue;
          }
          break;
        case "codex":
          try {
            codexSession = agent.processStartedAt === undefined
              ? null
              : await this.readCodexProcessSession(
                worktree,
                agent.processStartedAt,
              );
            codexSessionTrusted = codexSession !== null &&
              (agent.toolSessionId === undefined ||
                agent.toolSessionId === codexSession);
            if (codexSessionTrusted) {
              telemetry = await this.readCodexTelemetry(worktree, codexSession!);
              // The running identity is a different fact from occupancy: the
              // exact process-bound rollout proves which model+effort is
              // actually executing. Hook payloads never choose this session.
              codexIdentity = await this.readCodexIdentity(
                worktree,
                codexSession!,
              );
            }
          } catch {
            codexSession = null;
            codexSessionTrusted = false;
          }
          break;
        case "grok":
          try {
            grokTelemetry = await this.readGrokTelemetry(
              worktree,
              agent.toolSessionId,
            );
          } catch {
            continue;
          }
          break;
        default:
          unknownVendor(agent.tool, "refreshToolTelemetry");
      }
      // Layer-3 graphify adoption count, off the same artifacts. Only when
      // this daemon has a graphify service at all. An unreadable known
      // artifact keeps its measured cursor; no exact session clears it.
      if (this.graphify !== undefined) {
        const cursor = await readGraphifyCalls(
          agent.tool,
          worktree,
          agent.toolSessionId,
          this.graphifyCalls.get(agent.id),
        ).catch(() => null);
        if (cursor === null) this.graphifyCalls.delete(agent.id);
        else this.graphifyCalls.set(agent.id, cursor);
      }
      // Re-read after the file I/O: hook events may have advanced the row.
      const current = this.db.getAgentById(agent.id);
      if (
        current === null || current.status === "dead" ||
        current.status === "done" || current.status === "failed"
      ) continue;
      const updates: Partial<AgentRecord> = {};
      // What each vendor's read *means* for the row, dispatched once. The two
      // arms are not symmetric and must not be written as claude-or-else: what
      // Claude's transcript yields is a token count that still needs a window,
      // and what Codex's rollout yields is a percentage and an mtime. A third
      // vendor has neither until someone measures it, so it gets an arm of its
      // own or it gets a compile error — never Codex's arm by default, which
      // would write a percentage nothing computed.
      switch (current.tool) {
        case "claude": {
          // Claude occupancy: the transcript's measured token count over a
          // measured window — never a guessed denominator. The window is the one
          // the statusline payload carried (contextWindow on the row); when no
          // report has ever carried it, a token count that exceeds 200k is itself
          // proof of the 1M window, because the API served a request no 200k
          // window could hold. With neither, occupancy is unknown and the sweep
          // writes nothing: unlike the codex arm it never records null over a
          // number, because the statusline handler's direct reading may be the
          // only observation there is, and a null contextPct marks an agent
          // ineligible for reuse, so the flicker would not be cosmetic.
          if (claudeContext !== null) {
            const window = current.contextWindow ??
              (claudeContext > 200_000 ? 1_000_000 : undefined);
            if (window !== undefined) {
              const pct = clampPct((100 * claudeContext) / window);
              if (pct !== current.contextPct) updates.contextPct = pct;
            }
          }
          // The model the agent is *running*. The statusline handler observes
          // this too, but only for agents whose statusline reports actually
          // arrive — which is a subscriber-only path — so the sweep is what
          // makes it true for everyone. A row nobody corrects is a row
          // `hive status` lies from.
          if (current.worktreePath !== null) {
            const live = await this
              .readLiveModel(current.worktreePath, current.toolSessionId)
              .catch(() => null);
            if (live !== null && live !== current.liveModel) {
              updates.liveModel = live;
            }
          }
          break;
        }
        case "codex": {
          if (
            codexSessionTrusted && current.toolSessionId === undefined &&
            codexSession !== null
          ) {
            updates.toolSessionId = codexSession;
          }
          // The sweep writes what it *observed*, including "nothing" — a null
          // used to be skipped as "no new information", which quietly meant the
          // last number stood forever, and for an agent whose telemetry can
          // never be read, the number that stood forever was the 0 it was born
          // with. Unknown is a finding, not the absence of one, so it is
          // recorded like any other.
          if (
            telemetry !== null && telemetry.contextPct !== current.contextPct
          ) {
            updates.contextPct = telemetry.contextPct;
          }
          if (
            !current.writeRevoked && current.status !== "control-paused" &&
            telemetry !== null && telemetry.lastActivityAt !== null &&
            telemetry.lastActivityAt > current.lastEventAt
          ) {
            updates.lastEventAt = telemetry.lastActivityAt;
            if (current.status === "spawning") updates.status = "working";
          }
          // Execution-identity attestation. The launch identity is an intention;
          // this records what the process is *observed* running and the verdict
          // comparing them. The observation is never synthesized from the launch
          // request — an absent/unknown reading leaves observedIdentity alone and
          // only marks the verdict, which fails closed for a writer.
          {
            const launch = current.executionIdentity;
            const attestation = !codexSessionTrusted
              ? {
                identityState: "unknown" as const,
                observedIdentity: null,
                liveModel: null,
                liveEffort: null,
              }
              : launch === undefined
              ? {
                identityState: (codexIdentity?.status === "absent"
                  ? "unattested"
                  : "unknown") as IdentityState,
                observedIdentity: null,
                liveModel: null,
                liveEffort: null,
              }
              : reconcileCodexIdentity(
                launch,
                codexIdentity ?? { status: "absent" },
              );
            if (attestation.identityState !== attestationStateOf(current)) {
              updates.identityState = attestation.identityState;
            }
            if (
              attestation.observedIdentity !== null &&
              !sameObservedIdentity(
                current.observedIdentity,
                attestation.observedIdentity,
              )
            ) {
              updates.observedIdentity = attestation.observedIdentity;
            }
            if (
              attestation.liveModel !== null &&
              attestation.liveModel !== current.liveModel
            ) updates.liveModel = attestation.liveModel;
            if (
              attestation.liveEffort !== null &&
              attestation.liveEffort !== current.liveEffort
            ) updates.liveEffort = attestation.liveEffort;
          }
          break;
        }
        case "grok": {
          // Grok's occupancy is the vendor's own reading, and like the codex
          // arm the sweep records what it observed *including* "nothing": a
          // null that is skipped as "no new information" leaves whatever the
          // row was born with standing forever.
          if (
            grokTelemetry !== null &&
            grokTelemetry.contextPct !== current.contextPct
          ) {
            updates.contextPct = grokTelemetry.contextPct;
          }
          // The turn boundary nothing else reports. Grok drives no lifecycle
          // hooks, so no turn-start ever promoted these rows off "spawning"
          // and no turn-end ever settled them to "idle" — bridget sat at
          // "spawning" long after her turn had ended with end_turn. The
          // session's own updates.jsonl is the observable: its last record
          // says whether a turn is streaming or finished. Unknown
          // (turnCompleted null) writes nothing rather than guessing a state.
          if (
            !current.writeRevoked && current.status !== "control-paused" &&
            current.status !== "awaiting-approval" &&
            grokTelemetry !== null && grokTelemetry.lastActivityAt !== null &&
            grokTelemetry.lastActivityAt > current.lastEventAt
          ) {
            updates.lastEventAt = grokTelemetry.lastActivityAt;
            if (grokTelemetry.turnCompleted === true) updates.status = "idle";
            else if (grokTelemetry.turnCompleted === false) {
              updates.status = "working";
            }
          }
          if (current.worktreePath !== null) {
            const live = await this
              .readGrokLiveModel(current.worktreePath, current.toolSessionId)
              .catch(() => null);
            if (live !== null && live !== current.liveModel) {
              updates.liveModel = live;
            }
          }
          break;
        }
        default:
          unknownVendor(current.tool, "refreshToolTelemetry");
      }
      let persisted = current;
      if (Object.keys(updates).length > 0) {
        const updated = this.db.updateAgentIfCurrent(
          agentStateCas(current),
          updates,
        );
        if (updated === null) continue;
        persisted = updated;
      }
      // Fail-closed enforcement (maintenance backstop): every Codex writer
      // without a process-bound, matching provider identity is paused without
      // waiting for a turn. This includes migrated/unattested rows.
      if (
        current.tool === "codex" && !current.readOnly && !current.writeRevoked &&
        attestationStateOf(persisted) !== "matching"
      ) {
        const observed = updates.observedIdentity ?? persisted.observedIdentity;
        const launch = persisted.executionIdentity;
        const state = attestationStateOf(persisted);
        const detail = observed === undefined
          ? `process-bound provider session/identity is ${state}`
          : `authorized ${launch?.model ?? current.model}/${launch?.effort ?? "?"}` +
            `, observed ${observed.model}/${observed.effort ?? "?"}`;
        await this.pauseWriterForIdentityDrift(persisted, detail);
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
        let reaped: ReapOutcome;
        try {
          reaped = await reapCapturedTree([{
            pid: kill.process.pid,
            command: kill.process.command,
          }], {
            ...this.reapDependencies,
            kill: (pid) => this.killProcess(pid),
          });
        } catch (error) {
          console.error(
            `Hive memory watchdog could not verify pid ${kill.process.pid} under ${kill.owner}: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
          await this.delivery.send(
            "hive-resources",
            ORCHESTRATOR_NAME,
            `Hive memory watchdog FAILED to verify whether pid ${kill.process.pid} under ${kill.owner} stopped ` +
              `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
              `${kill.process.command.slice(0, 160)}. The process may still be allocating; ` +
              `it may need to be stopped by hand.`,
            { idempotencyKey: `resource-kill-failed:${kill.process.pid}` },
          ).catch(logAlertDeliveryFailure);
          continue;
        }
        if (reaped.survivors.length > 0) {
          console.error(
            `Hive memory watchdog failed to kill pid ${kill.process.pid} under ${kill.owner}: process survived SIGKILL`,
          );
          await this.delivery.send(
            "hive-resources",
            ORCHESTRATOR_NAME,
            `Hive memory watchdog FAILED to kill pid ${kill.process.pid} under ${kill.owner} ` +
              `(${Math.round(kill.process.rssMb)} MB resident, limit ${limits.perProcessMemoryMb} MB): ` +
              `${kill.process.command.slice(0, 160)}. The process survived SIGKILL and may still be allocating; ` +
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
        // The agent whose child died sees only an opaque failed command, so it
        // reads the death as "my command was wrong" and retries — the 2026-07-12
        // incident was three escalating OOM kills in 90 seconds, each a wider
        // search than the last. A killed process cannot report its own cause of
        // death; only the killer can, and it must tell the agent, not just the
        // orchestrator watching it.
        if (kill.owner !== ORCHESTRATOR_NAME) {
          await this.delivery.send(
            "hive-resources",
            kill.owner,
            `Hive's memory watchdog KILLED a process you started — the command did not fail on its own. ` +
              `pid ${kill.process.pid} reached ${Math.round(kill.process.rssMb)} MB resident, ` +
              `past the ${limits.perProcessMemoryMb} MB per-process ceiling that keeps this machine alive: ` +
              `${kill.process.command.slice(0, 160)}. Do NOT retry it as written, and do not widen it — ` +
              `a bigger version of the same command hits the same ceiling faster. Make it cheaper: ` +
              `narrow the input (scope a search to a subdirectory), anchor patterns on real literals ` +
              `instead of leading with \`.*\` or \`.{0,N}\`, or use a different tool. Your session is fine; ` +
              `only that process was killed.`,
            { idempotencyKey: `resource-kill-owner:${kill.process.pid}` },
          ).catch(logAlertDeliveryFailure);
        }
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
    const expired = await this.quota.listExpiredReservations();
    for (const reservation of expired) {
      if (reservation.purpose === "control") {
        const agent = this.db.getAgentByName(reservation.agentName);
        if (agent?.controlQuotaReservationId === reservation.id) {
          const teardown = await this.killAgentTeardown(agent, {
            failureReason:
              `Critical control acknowledgement process timed out (reservation ${reservation.id})`,
          });
          const processOutcome = teardown.reaped.survivors.length === 0
            ? "all captured processes were stopped"
            : `${teardown.reaped.survivors.length} captured process(es) survived SIGKILL and remain running`;
          await this.delivery.send(
            "hive-control",
            ORCHESTRATOR_NAME,
            `Critical control acknowledgement process for ${agent.name} timed out. ` +
              `Reservation ${reservation.id} settled conservatively; ${processOutcome}, ` +
              "write and landing capability remain revoked, and the worktree is preserved.",
            { idempotencyKey: `control-quota-timeout:${reservation.id}` },
          ).catch(logAlertDeliveryFailure);
          continue;
        }
      }
      await this.quota.cancel(reservation.id);
    }
    await this.settleReservationsOfDeadAgents();
    return expired.length;
  }

  /**
   * A dead agent may not hold capacity. This asks the reservations themselves
   * who is still running, rather than trusting each agent row to have named its
   * live booking correctly — the pointer is what went stale before, and the TTL
   * that eventually caught it is six hours wide, long enough for the leak to
   * refuse a spawn Hive had room for.
   *
   * A reservation whose agent has no row at all is a spawn still in flight: the
   * booking is made before the row is written, so settling it here would cancel
   * a live agent's quota. Those stay with the TTL sweep, which is what it is for.
   */
  private async settleReservationsOfDeadAgents(): Promise<void> {
    if (this.quota === undefined) return;
    for (const reservation of this.quota.ledger.activeReservations()) {
      const agent = this.db.getAgentByName(reservation.agentName);
      if (agent === null) continue;
      const dead = agent.status === "dead" || agent.status === "done" ||
        agent.status === "failed";
      if (!dead) continue;
      await this.quota.cancel(reservation.id);
    }
  }

  private async settleAgentQuota(
    agent: AgentRecord,
    at?: string,
  ): Promise<void> {
    // Reservation ids are durable ownership evidence; a name is not. Teardown
    // may await process stop after terminalizing this row, during which a new
    // UUID can legitimately reuse the name and reserve its own quota.
    const owned = new Set([
      agent.quotaReservationId,
      agent.controlQuotaReservationId,
    ].filter((id): id is string => id !== undefined));
    for (const reservationId of owned) {
      await this.quota?.cancel(reservationId, at);
    }
  }

  /**
   * The one teardown path for closing a live agent. `hive_kill`, the pane X
   * (POST /agents/:name/kill), the idle-reap sweep, and daemon shutdown all
   * funnel through here, so there is exactly one place that can kill an agent,
   * exactly one guard protecting a worktree, and one policy for unlanded work.
   *
   * The sequence is fixed by what each step destroys:
   *
   *   1. capture the process tree      (the pane pids die with the session)
   *   2. kill the tmux session         (tears down the pane)
   *   3. SIGKILL the captured tree     (what tmux does not reach: vendor CLI,
   *                                     Codex host, MCP children) and VERIFY
   *   4. mark dead, settle quota
   *   5. assess unlanded work, and preserve it as a ref if there is any —
   *      before step 7 can remove the worktree it lives in
   *   6. tell the orchestrator what was preserved, and what would not die
   *   7. remove the worktree only when asked, and never over stranded work
   *
   * Killing is immediate and unconditional — no confirmation, no delay. That
   * is a UX decision, and it is explicitly NOT permission to destroy: work
   * that is not on main is preserved as a git ref and reported. Removal of the
   * worktree still refuses to delete stranded work unless the caller passes
   * discardWork.
   */
  private async killAgentTeardown(
    agent: AgentRecord,
    options: {
      removeWorktree?: boolean;
      discardWork?: boolean;
      failureReason?: string;
      at?: string;
    } = {},
  ): Promise<{
    agent: AgentRecord;
    cleaned: {
      tmuxSession: string;
      worktreePath: string | null;
      branch: string | null;
    };
    reaped: ReapOutcome;
    preserved: { branch: string; ref: string } | null;
    stranded: {
      branch: string | null;
      worktreePath: string | null;
      dirtyFiles: string[];
      unmergedCommits: number;
      note: string;
    } | null;
  }> {
    // Make the terminal reap intent durable BEFORE the process teardown is
    // observable. A recovery sweep that races the teardown must read a closed
    // row and refuse to resurrect a deliberately reaped agent — the incident
    // where a finished, clean agent killed with removeWorktree was relaunched
    // as a crash recovery. The recovery sweep additionally re-proves this row
    // is not closed immediately before any relaunch.
    const timestamp = options.at ?? new Date().toISOString();
    const killed = this.db.markAgentDead(
      agent.id,
      timestamp,
      options.failureReason,
    );
    if (killed === null) {
      throw new Error(`Hive agent not found: ${agent.name}`);
    }
    // Revoke in-memory capability and on-disk credential immediately after the
    // durable terminal mark (which already bumped epoch + writeRevoked). Do not
    // wait for process-tree capture — that window is the durable crash hole.
    this.capabilities.revokeSubject(agent.name);
    removeCredential(agent.name);
    let reaped: ReapOutcome;
    try {
      reaped = await this.stopAgentProcesses(killed);
    } catch (error) {
      // Teardown could not be verified. Terminal truth and revoked authority
      // stay: never restore the pre-kill live row or re-issue credentials. A
      // still-running process is credential-less; recovery will not relaunch a
      // deliberately closed agent.
      throw error;
    }
    await this.settleAgentQuota(killed, timestamp);
    let updated = killed;
    const cleaned: {
      tmuxSession: string;
      worktreePath: string | null;
      branch: string | null;
    } = {
      tmuxSession: agent.tmuxSession,
      worktreePath: null,
      branch: null,
    };

    let stranded:
      | {
        branch: string | null;
        worktreePath: string | null;
        dirtyFiles: string[];
        unmergedCommits: number;
        note: string;
      }
      | null = null;
    let preserved: { branch: string; ref: string } | null = null;
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
          // The kill is immediate, so nobody was asked whether this work
          // mattered. Preserve it as a ref before anything else can decide it
          // did not: the ref outlives the branch, the worktree and the daemon,
          // and it is the only thing standing between "closed a pane" and
          // "destroyed an afternoon".
          if (agent.branch !== null) {
            try {
              await markBranchPreserved(this.repoRoot, agent.branch, true);
              preserved = {
                branch: agent.branch,
                ref: `refs/hive-preserved/${agent.branch}`,
              };
            } catch (error) {
              stranded.note += ` Preserving the branch FAILED (${
                error instanceof Error ? error.message : "unknown error"
              }); the branch itself was not deleted.`;
            }
          }
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

    const discarding = (options.discardWork ?? false) && stranded !== null;

    if (
      (options.removeWorktree ?? false) && agent.worktreePath !== null &&
      (stranded === null || discarding)
    ) {
      await this.cleanupWorktree(this.repoRoot, agent.worktreePath, {
        deleteBranch: true,
        discardTracked: options.discardWork ?? false,
        // The branch comes from the agent record, not from git's worktree
        // list: once the worktree directory is gone that list is empty, and a
        // delete that can only see the list deletes nothing at all.
        ...(agent.branch !== null ? { branch: agent.branch } : {}),
      });
      // discardWork means delete the work, so the preservation ref goes too.
      // Left behind, it still points at every commit the branch held: the
      // caller who asked for a discard would get a rename.
      if (discarding && stranded !== null) {
        if (preserved !== null) {
          await markBranchPreserved(this.repoRoot, preserved.branch, false);
          preserved = null;
        }
        stranded = {
          ...stranded,
          note: `${agent.name} left work that is not on main; it was DELETED ` +
            "as requested (discardWork)" +
            (agent.branch !== null
              ? `: branch ${agent.branch} and its preservation ref are gone.`
              : "."),
        };
      }
      cleaned.worktreePath = agent.worktreePath;
      cleaned.branch = agent.branch;
      updated = this.db.updateTerminalAgentIfCurrent(agentStateCas(updated), {
        worktreePath: null,
        branch: null,
      }) ?? updated;
    }

    // Reported last, so it reports what happened: a discard deletes the branch
    // and its ref, and telling the orchestrator "Nothing was deleted" over the
    // top of that is how a kill that obeyed reads as a kill that refused.
    await this.reportKill(agent, reaped, preserved, stranded);

    return { agent: updated, cleaned, reaped, preserved, stranded };
  }

  /**
   * Tell the orchestrator what a kill actually did.
   *
   * Two things are worth a durable message and nothing else is. Preserved work,
   * because an immediate kill gives nobody the chance to ask — the orchestrator
   * has to learn that a branch was saved and where to find it, or preservation
   * is just a ref nobody reads. And survivors, because a process that would not
   * die is the failure this whole path exists to prevent, and the one thing we
   * must never do is report a clean kill over the top of it.
   *
   * A clean kill of a clean agent says nothing. There is nothing to say, and
   * the root's context is the scarcest thing in the system.
   */
  private async reportKill(
    agent: AgentRecord,
    reaped: ReapOutcome,
    preserved: { branch: string; ref: string } | null,
    stranded: { unmergedCommits: number; dirtyFiles: string[] } | null,
  ): Promise<void> {
    if (preserved !== null && stranded !== null) {
      await this.delivery.send(
        "hive-lifecycle",
        ORCHESTRATOR_NAME,
        `${agent.name} was killed with work that is not on main. ` +
          `Its branch ${preserved.branch} is PRESERVED at ${preserved.ref} ` +
          `(${stranded.unmergedCommits} unmerged commit(s), ` +
          `${stranded.dirtyFiles.length} uncommitted file(s)). ` +
          "Nothing was deleted. Land it with an integrator agent, or discard it " +
          "explicitly with hive_kill discardWork.",
        { idempotencyKey: `kill-preserved:${agent.id}` },
      ).catch(() => undefined);
    }
    if (reaped.survivors.length > 0) {
      await this.delivery.send(
        "hive-lifecycle",
        ORCHESTRATOR_NAME,
        `${agent.name} was killed but ${reaped.survivors.length} of its ` +
          "process(es) SURVIVED SIGKILL and are still running: " +
          reaped.survivors
            .map((process) => `pid ${process.pid} (${process.command})`)
            .join(", ") +
          ". These are orphans; they may still hold a model session open.",
        { idempotencyKey: `kill-survivors:${agent.id}` },
      ).catch(() => undefined);
    }
  }

  /**
   * Close every live agent. Shutdown's first act, and the reason quitting the
   * app cannot orphan anything.
   *
   * One agent that refuses to die must not strand the others, so a failure is
   * reported and the loop continues — the alternative is a half-torn-down
   * machine whose remaining agents nobody ever asked to close.
   */
  private async killAllAgents(): Promise<void> {
    const failures: string[] = [];
    for (const agent of this.db.listAgents()) {
      if (!LIVE_STATUSES.includes(agent.status)) continue;
      try {
        await this.killAgentTeardown(agent);
      } catch (error) {
        failures.push(
          `${agent.name}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Hive refused shutdown because agent teardown failed: ${
          failures.join("; ")
        }`,
      );
    }
  }

  /**
   * Stopping the daemon stops the MACHINE, not just the process.
   *
   * This used to kill the orchestrator's tmux session and exit, which left
   * every agent — its vendor CLI, its Codex host, its MCP children — running
   * with nothing left alive to supervise, message, meter or reap them. Quitting
   * the app is the ordinary way a user ends a session, so that was the ordinary
   * way Hive orphaned processes that go on spending money against the account.
   *
   * So: close every agent first, through the same one kill path the pane X
   * uses, and only then take the daemon down. Agents are reaped before the
   * timers stop, because teardown needs delivery and quota to still be alive.
   */
  async stop(): Promise<void> {
    if (this.manageLifecycle) {
      await this.killAllAgents();
      const session = orchestratorTmuxSession();
      const reaped = await this.stopTmuxProcesses(session);
      if (reaped.survivors.length > 0) {
        throw new Error(
          `Hive refused shutdown because ${reaped.survivors.length} orchestrator process(es) survived SIGKILL`,
        );
      }
    }
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    this.bunServer?.stop(true);
    this.bunServer = null;
    this.codexControl?.close();
    await this.graphify?.stop();
    if (this.manageLifecycle) {
      cleanupLifecycleFiles();
    }
    if (this.ownsDatabase) {
      this.db.close();
    }
    this.ownedMachineMutations?.close();
  }

  // Crash detection and recovery: any agent whose status claims a process
  // but whose tmux session is gone gets classified — resumable active work
  // is relaunched with the tool's native resume; everything else is marked
  // dead with its worktree preserved and the stranded state surfaced.
  async reconcileAgents(): Promise<RecoveryOutcome[]> {
    return this.recovery.sweep();
  }

  /**
   * The idle-reap sweep (config `[lifecycle]`, off entirely when the daemon
   * is not given a lifecycle config — embedded daemons in tests and tooling
   * must never close an agent unasked). An agent earns closure only when its
   * work is already off its plate: idle, nothing queued or injected for it,
   * a clean worktree, and no commits main hasn't seen — for at least
   * idleReapMinutes. Any one of those failing leaves the agent alone; the
   * orchestrator keeps deciding for everything short of "there is nothing
   * left to decide". Reuses killAgentTeardown (hive_kill's own path) so the
   * same stranded-work guard that protects a manual kill protects this sweep
   * — unmerged commits or dirty files are never discarded, reap or not.
   */
  async reapIdleAgents(): Promise<void> {
    const lifecycle = this.lifecycleConfig;
    if (lifecycle === null || !lifecycle.idleReap) return;
    const thresholdMs = lifecycle.idleReapMinutes * 60_000;
    const now = Date.now();
    for (const record of this.db.listAgents()) {
      if (record.name === ORCHESTRATOR_NAME) continue;
      if (record.status !== "idle") continue;
      const idleMs = now - Date.parse(record.lastEventAt);
      if (!(idleMs >= thresholdMs)) continue;
      if (this.db.hasPendingMessages(record.name)) continue;
      const idleMinutes = Math.floor(idleMs / 60_000);
      let stranded: StrandedWork;
      try {
        stranded = await this.assessStranded(
          this.repoRoot,
          record.worktreePath,
          record.branch,
        );
      } catch (error) {
        // Cannot prove the worktree is clean, so it is not reaped this tick.
        // "I could not tell" is not permission to say nothing: an agent that
        // never becomes assessable would otherwise idle here forever, unreaped
        // and unreported.
        await this.delivery.send(
          "hive-lifecycle",
          ORCHESTRATOR_NAME,
          `${record.name} is idle ${idleMinutes}m and cannot be reaped: its stranded-work check failed (${
            error instanceof Error ? error.message : "unknown error"
          }), so Hive cannot prove the worktree is clean. Nothing was deleted. Inspect ${
            record.worktreePath ?? "its worktree"
          } and land or discard it explicitly.`,
          { idempotencyKey: `stranded-idle-unknown:${record.id}` },
        ).catch(logAlertDeliveryFailure);
        continue;
      }
      if (stranded.dirtyFiles.length > 0 || stranded.unmergedCommits > 0) {
        // The guard that protects unlanded work must not also hide it. The
        // reaper never deletes this agent, so without an alert it simply sits
        // here every tick until a daemon restart drops it from the world.
        await this.delivery.send(
          "hive-lifecycle",
          ORCHESTRATOR_NAME,
          `${record.name} is idle ${idleMinutes}m and was NOT reaped: it holds ${stranded.unmergedCommits} unmerged commit(s) on ${
            record.branch ?? "no branch"
          } and ${stranded.dirtyFiles.length} uncommitted file(s). Nothing was deleted. Land it with an integrator agent, or discard it explicitly with hive_kill discardWork.`,
          {
            // Re-alerts when the work grows, so a stranded agent that keeps
            // committing is reported again rather than silenced by the first
            // alert; identical state does not re-alert every tick.
            idempotencyKey:
              `stranded-idle:${record.id}:${stranded.unmergedCommits}:${stranded.dirtyFiles.length}`,
          },
        ).catch(logAlertDeliveryFailure);
        continue;
      }
      const warningKey = `idle-reap-warning:${record.id}`;
      if (
        this.db.findMessageByIdempotency("hive-lifecycle", warningKey) === null
      ) {
        await this.delivery.send(
          "hive-lifecycle",
          record.name,
          "Hive is about to reap this idle session. Persist any findings or design that exist only in your context or scratchpad now; if there is nothing to keep, no action is needed.",
          { idempotencyKey: warningKey },
        ).catch(logAlertDeliveryFailure);
        continue;
      }
      try {
        await this.killAgentTeardown(record, { removeWorktree: true });
        await this.delivery.send(
          "hive-lifecycle",
          ORCHESTRATOR_NAME,
          `Reaped ${record.name}: idle ${idleMinutes}m with a clean worktree and nothing unmerged.`,
          { idempotencyKey: `idle-reap:${record.id}` },
        ).catch(logAlertDeliveryFailure);
      } catch (error) {
        console.error(
          `Hive idle-reap of ${record.name} failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
  }

  /**
   * Reports every hive/* branch holding unlanded commits that no live agent
   * owns.
   *
   * Every other safety mechanism here — the reaper, crash recovery, agent
   * reconciliation — iterates the agents table, so a branch whose row is gone
   * is invisible to all of them. That is not hypothetical: a branch outlives
   * the database, so a reset (or a lost row) strands its work permanently and
   * silently, with no row left to iterate. This sweep is the one check that
   * derives from git instead, which is why it can see work the agents table
   * has forgotten.
   *
   * It never deletes. Unlanded work is reported, and a human or an integrator
   * decides.
   */
  async reconcileStrandedBranches(): Promise<void> {
    const branches = await this.listUnmergedBranches(this.repoRoot);
    if (branches.length === 0) return;
    const agents = this.db.listAgents();
    const liveInstances = await this.liveInstanceIds().catch(() => new Set<string>());
    const ownInstanceId = hiveInstanceSuffix();

    for (const { branch, tip, unmergedCommits, preserved, ownerInstanceId } of branches) {
      if (preserved) continue;
      if (
        ownerInstanceId !== undefined && ownerInstanceId !== ownInstanceId &&
        liveInstances.has(ownerInstanceId)
      ) continue;
      const owners = agents.filter((agent) => agent.branch === branch);
      // A live agent is still working on its own branch; that is not stranded
      // work, it is work in progress.
      if (owners.some((agent) => LIVE_STATUSES.includes(agent.status))) {
        continue;
      }
      // Alert once per branch tip per daemon boot. A restarted daemon reports
      // it again on purpose: the orchestrator that was told is gone, and the
      // new one has never heard of this work. A durable idempotency key would
      // silence exactly the restart that made the work invisible in the first
      // place.
      const alertKey = `${branch}:${tip}`;
      if (this.alertedStrandedBranches.has(alertKey)) continue;
      this.alertedStrandedBranches.add(alertKey);

      const closed = owners[0];
      const detail = closed === undefined
        // The case that stranded david: a branch with unlanded commits and no
        // agent row at all. Nothing in the agents table can ever surface this.
        ? `no agent row owns it (its row predates this database or was lost), so nothing in the agent table can account for it`
        : `its agent ${closed.name} is ${closed.status} and left it behind`;
      await this.delivery.send(
        "hive-lifecycle",
        ORCHESTRATOR_NAME,
        `Stranded work: ${branch} holds ${unmergedCommits} commit(s) not on main and ${detail}. Nothing was deleted. Assess it with an integrator agent and land or discard it explicitly.`,
        { idempotencyKey: `stranded-branch:${alertKey}:${this.bootId}` },
      ).catch(logAlertDeliveryFailure);
    }
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
    // Each refusal below names the one thing that is wrong and, where a person
    // has to act, says so in a single labeled line. "Landing capability revoked
    // or stale" told an agent neither which of the two it was nor what to do,
    // and they need opposite things: a stale epoch is the agent's own to fix by
    // re-reading it, while a revocation is authority it no longer has.
    const agent = this.db.getAgentByName(name);
    if (agent === null) {
      throw new Error(
        `Cannot land ${name}: no agent by that name is registered with this daemon.`,
      );
    }
    if (agent.branch === null) {
      throw new Error(
        `Cannot land ${name}: it has no branch — it was spawned without a worktree, so there is nothing to merge.`,
      );
    }
    if (agent.readOnly) {
      throw new Error(
        `Cannot land ${name}: it was launched read-only and has no landing authority.`,
      );
    }
    if (agent.tool === "codex") {
      throw new Error(
        `Cannot land ${name}: Codex 0.144.4 does not expose an independent process binding for rollout/session identity, so reader-only containment mechanically forbids every Codex writer landing before attestation or Git.\n` +
          `Fix: have a non-Codex integrator revalidate and land this preserved branch.`,
      );
    }
    if (isTerminalAgentStatus(agent.status)) {
      throw new Error(
        `Cannot land ${name}: its status is ${agent.status} (terminal). A terminal agent has no landing authority.`,
      );
    }
    if (agent.writeRevoked) {
      throw new Error(
        `Cannot land ${name}: its write authority was revoked by a critical control message, so it may not merge.\n` +
          `Fix: the orchestrator must restore ${name}'s authority (or land the work through an integrator) before this can proceed.`,
      );
    }
    if (agent.capabilityEpoch !== capabilityEpoch) {
      throw new Error(
        `Cannot land ${name}: the capabilityEpoch passed (${capabilityEpoch}) is not ${name}'s current epoch (${agent.capabilityEpoch}) — a control message re-issued its capability since this one was minted.\n` +
          `Fix: call hive_land again with capabilityEpoch ${agent.capabilityEpoch}.`,
      );
    }
    // Final CAS immediately before Git. Codex writers were refused above;
    // Claude/Grok still require the exact row to remain current through every
    // later lease and process boundary.
    const authorityRow = agent;
    const finalRow = this.db.updateAgentIfCurrent(
      agentStateCas(authorityRow),
      {},
    );
    if (finalRow === null || finalRow.branch === null) {
      const current = this.db.getAgentById(agent.id);
      throw new Error(
        `Cannot land ${name}: final pre-Git authority check failed ` +
          `(status=${current?.status ?? "missing"}, epoch=${current?.capabilityEpoch ?? "?"}, ` +
          `revoked=${current?.writeRevoked ?? "?"}, ` +
          `processIncarnation=${current?.processIncarnation ?? "?"}).`,
      );
    }
    const operation = await this.machineMutations?.beginOperation("landing");
    const authoritySnapshot = agentStateCas(finalRow);
    const branch = finalRow.branch;
    const assertLandAuthority = () => {
      const row = this.db.updateAgentIfCurrent(
        authoritySnapshot,
        {},
      );
      if (row === null) {
        const current = this.db.getAgentById(authoritySnapshot.id);
        throw new Error(
          `Cannot land ${name}: authority/incarnation check failed at the Git boundary ` +
            `(status=${current?.status ?? "missing"}, epoch=${current?.capabilityEpoch ?? "?"}, ` +
            `processIncarnation=${current?.processIncarnation ?? "?"}, ` +
            `session=${current?.toolSessionId ?? "?"}).`,
        );
      }
    };
    try {
      assertLandAuthority();
      const landed = await this.land(this.repoRoot, branch, {
        preMergeCheck: assertLandAuthority,
      });
      this.graphify?.scheduleRebuild();
      return landed;
    } finally {
      operation?.release();
    }
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
    const current = this.db.getAgentByName(agentName);
    if (current?.readOnly) {
      throw new Error(
        `Cannot queue a mutation approval for read-only agent ${agentName}; the request is denied mechanically.`,
      );
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.insertApproval({
        id,
        agentName,
        // The description is the command Codex wants to run (`describeApproval`,
        // src/adapters/tools/codex-app-server.ts) — the thing being decided.
        // Never trimmed.
        kind: "tool-permission",
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
    // Public and non-authorizing. The DB probe is read-only, because a route
    // that mutates needs a capability and no launcher has one before it
    // decides to talk to us.
    if (url.pathname === "/health" && request.method === "GET") {
      let database:
        | { status: "ok" }
        | { status: "degraded"; errors: string[] }
        | { status: "unreadable"; error: string };
      try {
        const result = this.db.quickCheck();
        database = result.length === 1 && result[0] === "ok"
          ? { status: "ok" }
          : { status: "degraded", errors: result };
      } catch (error) {
        database = {
          status: "unreadable",
          error: error instanceof Error ? error.message : "unknown error",
        };
      }
      const ok = database.status === "ok" &&
        this.maintenanceHealth.status !== "error";
      return json(
        {
          ok,
          version: HIVE_VERSION,
          database,
          maintenance: this.maintenanceHealth,
        },
        { status: ok ? 200 : 503 },
      );
    }
    if (url.pathname === "/handshake" && request.method === "GET") {
      return json(await this.handshake());
    }
    // Everything below mutates state or reads another tenant's data, so every
    // one of them authenticates first. See the capability rights matrix.
    if (url.pathname === "/event" && request.method === "POST") {
      return this.receiveEvent(request);
    }
    if (url.pathname === "/statusline" && request.method === "POST") {
      return this.receiveStatusline(request);
    }
    if (
      url.pathname === "/autonomy" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return this.autonomyEndpoint(request);
    }
    if (
      url.pathname === "/routing/policy" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return this.routingPolicyEndpoint(request);
    }
    if (url.pathname === "/orchestrator-status" && request.method === "GET") {
      return this.orchestratorStatusEndpoint(request);
    }
    if (url.pathname === "/token-usage" && request.method === "GET") {
      return this.tokenUsageEndpoint(url, request);
    }
    if (url.pathname === "/token-usage/sessions" && request.method === "POST") {
      return this.startTokenUsageSession(request);
    }
    const tokenSession = url.pathname.match(
      /^\/token-usage\/sessions\/([^/]+)\/(orchestrators|end)$/,
    );
    if (tokenSession !== null && request.method === "POST") {
      return tokenSession[2] === "orchestrators"
        ? this.startTokenUsageOrchestrator(tokenSession[1]!, request)
        : this.endTokenUsageSession(tokenSession[1]!, request);
    }
    const tokenSubject = url.pathname.match(
      /^\/token-usage\/subjects\/([^/]+)\/end$/,
    );
    if (tokenSubject !== null && request.method === "POST") {
      return this.endTokenUsageSubject(tokenSubject[1]!, request);
    }
    if (url.pathname === "/graphify" && request.method === "POST") {
      return this.graphifyEndpoint(request);
    }
    if (url.pathname === "/recover" && request.method === "POST") {
      return this.recoverEndpoint(request);
    }
    if (url.pathname === "/codex-root-token" && request.method === "POST") {
      return this.mintCodexRootToken(request);
    }
    if (
      url.pathname.startsWith("/agents/") &&
      url.pathname.endsWith("/kill") && request.method === "POST"
    ) {
      return this.killEndpoint(url.pathname, request);
    }
    if (url.pathname === "/mcp") {
      return this.handleMcp(request);
    }
    return json({ error: "Not found" }, { status: 404 });
  }

  /** POST /codex-root-token — the operator's launcher (`hive codex`) asks the
   * daemon to mint the orchestrator credential the codex root will present.
   * The stateless MCP transport authenticates every request, so this remains
   * valid for the same bounded session window as the other orchestrator
   * capability instead of expiring after launch. This is the
   * one sanctioned issuance outside the daemon's own spawn path (the
   * `root-token:mint` carve-out in capabilities.ts). */
  private mintCodexRootToken(request: Request): Response {
    const authenticated = this.authenticate(request, "/codex-root-token");
    if (!authenticated.ok) return this.denied(authenticated);
    const authorized = this.authorize(
      authenticated.capability,
      "/codex-root-token",
      "root-token:mint",
      undefined,
    );
    if (!authorized.ok) return this.denied(authorized);
    const ttlMs = OPERATOR_TTL_MS;
    const { token } = this.capabilities.mint(ORCHESTRATOR_NAME, "orchestrator", {
      epoch: 0,
      ttlMs,
    });
    return json({
      token,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
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
    if (
      parsed.data.effort !== undefined &&
      (agent.tool === "claude" || agent.tool === "grok")
    ) {
      await this.reconcileClaudeEffort(agent, parsed.data.effort);
    }
    // Claude's own occupancy figure, landed on the row exactly as measured —
    // and the window it was measured against. The window is the fact the
    // telemetry sweep cannot obtain anywhere else: once one report has ever
    // carried it, the sweep can keep contextPct current from the transcript
    // alone (tool-telemetry.ts), so a statusline that afterwards goes quiet
    // no longer freezes the reading.
    if (
      parsed.data.contextUsedPct !== undefined ||
      parsed.data.contextWindow !== undefined
    ) {
      this.reconcileContext(
        agent,
        parsed.data.contextUsedPct,
        parsed.data.contextWindow,
      );
    }
    // Bind this observation to the model the agent is *running*, not the one it
    // was spawned with. `agent.model` is a spawn-time intention that a `/model`
    // inside the session silently invalidates, and quota charged to a model
    // nobody is running is quota charged to nobody.
    const model = await this.reconcileModel(agent);
    if (model === null) {
      return json(
        { error: `Statusline agent/session changed while telemetry was being read for ${agent.name}.` },
        { status: 409 },
      );
    }
    const observation = await this.quota?.observeStatusline(
      { tool: agent.tool, model },
      {
        ...(parsed.data.fiveHour === undefined
          ? {}
          : { fiveHour: parsed.data.fiveHour }),
        ...(parsed.data.sevenDay === undefined
          ? {}
          : { sevenDay: parsed.data.sevenDay }),
        observedAt: parsed.data.observedAt ?? new Date().toISOString(),
        // The re-key chain moves an in-flight reservation onto the meter the run
        // is really spending from, and it needs the name and the model together
        // or it deliberately does nothing. Both come from here: the model is the
        // one we just reconciled from the transcript, not the one the statusLine
        // payload happened to carry — that payload is absent entirely on an
        // API-key account, and one fact with two sources is two facts waiting to
        // disagree.
        agent: agent.name,
        model,
        reservationId: agent.quotaReservationId ?? null,
        acceptReservationRekey: (reservations) => {
          const replacement = reservations[0];
          if (replacement === undefined) return false;
          const updates = replacement.purpose === "control"
            ? { controlQuotaReservationId: replacement.id }
            : { quotaReservationId: replacement.id };
          return this.db.updateAgentIfCurrent(agentStateCas(agent), updates) !== null;
        },
      },
    ) ?? null;
    return json({ observation });
  }

  /**
   * Freeze Claude's first measured effort into launch identity. Later status
   * line values are current mutable state (`/effort` changes them), so a
   * disagreement is durable drift, never permission to rewrite the identity.
   */
  private async reconcileClaudeEffort(
    agent: AgentRecord,
    observedEffort: string,
  ): Promise<void> {
    const current = agent;
    if (current.tool !== "claude" && current.tool !== "grok") return;
    const identity = current.executionIdentity;
    if (identity === undefined) {
      if (current.tool === "grok") {
        console.error(
          `Cannot reconcile Grok effort for ${current.name}: execution identity is absent`,
        );
        return;
      }
      if (current.model === "default") return;
      this.db.updateAgentIfCurrent(agentStateCas(current), {
        executionIdentity: {
          tool: "claude",
          model: current.model,
          effort: observedEffort,
        },
      });
      return;
    }
    if (identity.tool !== current.tool) return;
    if (identity.effort === undefined) {
      this.db.updateAgentIfCurrent(agentStateCas(current), {
        executionIdentity: { ...identity, effort: observedEffort },
      });
      return;
    }
    if (identity.effort === observedEffort) return;

    const description =
      `Execution effort drifted from immutable launch value ${identity.effort} ` +
      `to observed current value ${observedEffort}`;
    const alreadyRecorded = this.db.listEvents(current.name).some((event) =>
      event.kind === "effort-drift" && event.description === description
    );
    if (alreadyRecorded) return;
    const timestamp = new Date().toISOString();
    this.db.insertEvent({
      kind: "effort-drift",
      agentName: current.name,
      timestamp,
      description,
    });
    await this.delivery.send(
      "hive-effort",
      ORCHESTRATOR_NAME,
      `Effort drift observed for ${current.name}: ${description}. ` +
        "ExecutionIdentity was not changed.",
      {
        idempotencyKey:
          `effort-drift:${current.id}:${identity.effort}:${observedEffort}`,
      },
    ).catch(() => undefined);
  }

  /**
   * Point the agent row at the reservation the run is actually holding.
   *
   * A model re-key releases the booking the row names and writes a fresh one.
   * The row kept naming the released id, and every terminal path dereferences
   * exactly that id — `markStarted`, the turn-end reconcile, and the cancel on
   * kill/death/recovery/restart all early-return on a settled reservation. So
   * the replacement was never started, never reconciled, and never released: it
   * sat `active` until its six-hour TTL, and `reserved` counted it the whole
   * time. Spawning with a model alias (`sonnet`) re-keys on the first statusLine
   * report — the live model is the canonical id — so this leaked once per agent.
   */
  /**
   * Land Claude Code's own occupancy figure and its measured context window
   * onto the agent row.
   *
   * Every write uses the exact process/authority tuple captured when the
   * statusline request was authorized. A replacement process wins the CAS.
   */
  private reconcileContext(
    agent: AgentRecord,
    contextUsedPct: number | undefined,
    contextWindow: number | undefined,
  ): void {
    const updates: {
      contextPct?: number | null;
      contextWindow?: number;
    } = {};
    if (contextUsedPct !== undefined && agent.contextPct !== contextUsedPct) {
      updates.contextPct = contextUsedPct;
    }
    if (contextWindow !== undefined && agent.contextWindow !== contextWindow) {
      updates.contextWindow = contextWindow;
    }
    if (Object.keys(updates).length > 0) {
      this.db.updateAgentIfCurrent(agentStateCas(agent), updates);
    }
  }

  /**
   * The model `agent` is actually running, observed and persisted onto its row.
   *
   * Two things were wrong and they were the same thing: quota was observed
   * against the spawn-time model, and `hive status` reported the spawn-time
   * model to the orchestrator, which routes off it. Fixing only the ledger
   * would leave the display lying.
   *
   * The observation is written to `liveModel`, never over `model`. They are
   * different facts and the difference is load-bearing: `model` is decision 6's
   * immutable execution identity, and `restartForControl` refuses to restart an
   * agent whose recorded identity and row disagree — so overwriting `model`
   * would have left every agent whose user typed `/model` permanently
   * unrestartable, capability revoked, on the next critical control. The bug was
   * born of conflating an intention with an observation; the fix does not repeat
   * it in the other direction.
   *
   * For Claude and Grok, no observation — a session that has not answered yet —
   * leaves `liveModel` untouched and the launch model stands. An unknown model
   * is unknown, never a guess. Codex statusline-shaped requests never infer a
   * model; provider rollout identity is handled by the separate fail-closed
   * attestation sweep.
   */
  private async reconcileModel(agent: AgentRecord): Promise<string | null> {
    const known = agent.liveModel ?? agent.model;
    const stillCurrent = (): boolean =>
      this.db.updateAgentIfCurrent(agentStateCas(agent), {}) !== null;
    if (agent.worktreePath === null) return stillCurrent() ? known : null;

    let live: string | null;
    switch (agent.tool) {
      case "claude":
        live = await this
          .readLiveModel(agent.worktreePath, agent.toolSessionId)
          .catch(() => null);
        break;
      case "grok":
        live = await this
          .readGrokLiveModel(agent.worktreePath, agent.toolSessionId)
          .catch(() => null);
        break;
      case "codex":
        // Attested by refreshToolTelemetry from the newest turn_context, not
        // from this statusline-shaped path.
        return stillCurrent() ? known : null;
      default:
        return unknownVendor(agent.tool, "live model reconciliation");
    }
    if (live === null) return stillCurrent() ? known : null;
    if (live !== agent.liveModel) {
      const updated = this.db.updateAgentIfCurrent(agentStateCas(agent), {
        liveModel: live,
      });
      if (updated === null) return null;
    } else if (!stillCurrent()) {
      return null;
    }
    return live;
  }

  /**
   * `GET /orchestrator-status` — what the root is doing, for the Workspace dot.
   *
   * The root has no agents-table row, so it is absent from `hive_status` by
   * construction and the Workspace had nothing to render; it invented a status
   * word instead, and got a permanently gray (unknown) dot for it. This is the
   * honest surface: derived from the root's own turn-boundary events, and
   * `{"status": null}` whenever they cannot be trusted — an absent status is
   * unknown, never a flattering guess. See orchestrator-status.ts.
   *
   * Gated on `status:read`, the same action `hive_status` needs: this is the
   * root's status, not a new kind of authority, and the feed already holds it.
   */
  private orchestratorStatusEndpoint(request: Request): Response {
    const authenticated = this.authenticate(request, "/orchestrator-status");
    if (!authenticated.ok) return this.denied(authenticated);
    // A poll surface (the feed asks every second): don't audit allows.
    const decision = this.authorize(
      authenticated.capability,
      "/orchestrator-status",
      "status:read",
      undefined,
      false,
    );
    if (!decision.ok) return this.denied(decision);
    return json({
      status: deriveOrchestratorStatus(
        this.db.recentOrchestratorSignals(ORCHESTRATOR_NAME),
      ),
    });
  }

  private async tokenUsageEndpoint(
    url: URL,
    request: Request,
  ): Promise<Response> {
    const authenticated = this.authenticate(request, "/token-usage");
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      "/token-usage",
      "token-usage:read",
      undefined,
      false,
    );
    if (!decision.ok) return this.denied(decision);
    try {
      return json(await this.tokenUsage.snapshot(
        url.searchParams.get("repoRoot") ?? undefined,
      ));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  private async startTokenUsageSession(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/token-usage/sessions");
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      "/token-usage/sessions",
      "token-usage:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    const body = TokenUsageSessionRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) return json({ error: body.error.message }, { status: 400 });
    return json({ sessionId: await this.tokenUsage.startSession(body.data.repoRoot) });
  }

  private async startTokenUsageOrchestrator(
    sessionId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/sessions/${sessionId}/orchestrators`;
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      route,
      "token-usage:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    const body = TokenUsageOrchestratorRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success) return json({ error: body.error.message }, { status: 400 });
    try {
      return json({
        subjectId: this.tokenUsage.startOrchestrator(
          sessionId,
          body.data.provider,
          body.data.cwd,
        ),
      });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  private async endTokenUsageSubject(
    subjectId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/subjects/${subjectId}/end`;
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      route,
      "token-usage:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    await this.tokenUsage.endSubject(subjectId);
    return json({ ok: true });
  }

  private async endTokenUsageSession(
    sessionId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/sessions/${sessionId}/end`;
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      route,
      "token-usage:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    await this.tokenUsage.endSession(sessionId);
    return json({ ok: true });
  }

  /**
   * `/autonomy` — the agent-autonomy dial.
   *
   * GET reads the live value: the one the next spawn or resume will actually
   * use, which is what the Workspace menu checkmark and `hive autonomy`
   * display. POST sets it, operator-only: the Workspace and the user's CLI
   * hold the operator credential, agents never do, so no agent can raise its
   * own autonomy. The control persists to `~/.hive/config.toml` before the
   * live value changes — a set that could not be made durable is refused
   * whole, never applied for this daemon's lifetime only.
   */
  private async autonomyEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/autonomy");
    if (!authenticated.ok) return this.denied(authenticated);
    if (request.method === "GET") {
      // A poll surface (the feed asks every second): don't audit allows.
      const decision = this.authorize(
        authenticated.capability,
        "/autonomy",
        "autonomy:read",
        undefined,
        false,
      );
      if (!decision.ok) return this.denied(decision);
      return json({ autonomy: this.autonomy?.get() ?? null });
    }
    const decision = this.authorize(
      authenticated.capability,
      "/autonomy",
      "autonomy:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    if (this.autonomy === undefined) {
      return json(
        { error: "this daemon has no autonomy control configured" },
        { status: 503 },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid autonomy request" }, { status: 400 });
    }
    const requested = (body as { autonomy?: unknown } | null)?.autonomy;
    if (!isAutonomy(requested)) {
      return json(
        { error: 'autonomy must be "sandboxed" or "dangerous"' },
        { status: 400 },
      );
    }
    try {
      await this.autonomy.set(requested);
    } catch (error) {
      return json(
        {
          error: `could not persist autonomy: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        { status: 500 },
      );
    }
    return json({ autonomy: this.autonomy.get() });
  }

  /**
   * `GET`/`POST /routing/policy` — the Model Control Center's contract, via
   * the `hive routing …` CLI. GET returns the whole policy document; POST
   * applies one validated mutation with compare-and-set and returns the
   * updated document. Operator-only in BOTH directions: with the approval
   * prompts retired, an enabled model here IS consent to spend, and an agent
   * granting itself consent would be self-authorization.
   */
  private async routingPolicyEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/routing/policy");
    if (!authenticated.ok) return this.denied(authenticated);
    const store = this.routingPolicy ??= new RoutingPolicyStore(this.db);
    if (request.method === "GET") {
      const decision = this.authorize(
        authenticated.capability,
        "/routing/policy",
        "routing-policy:read",
        undefined,
        false,
      );
      if (!decision.ok) return this.denied(decision);
      try {
        return json(store.read());
      } catch (error) {
        // A corrupt policy is a refusal, never an empty (permissive-looking)
        // document — the error names the state so the user can repair it.
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    const decision = this.authorize(
      authenticated.capability,
      "/routing/policy",
      "routing-policy:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid routing policy request" }, { status: 400 });
    }
    const mutation = RoutingPolicyMutationSchema.safeParse(body);
    if (!mutation.success) {
      return json({ error: mutation.error.message }, { status: 400 });
    }
    try {
      const policy = store.apply(mutation.data, authenticated.capability.subject);
      if (mutation.data.op === "set-selection") {
        try {
          await this.selectionPreferences?.apply(mutation.data, policy.selection);
        } catch (error) {
          return json({
            error:
              "selection was saved in this Workspace but could not be saved " +
              `for future ordinary Workspace sessions: ${
                error instanceof Error ? error.message : String(error)
              }`,
          }, { status: 500 });
        }
      }
      return json(policy);
    } catch (error) {
      if (error instanceof RoutingPolicyConflictError) {
        return json(
          { error: error.message, currentRevision: error.currentRevision },
          { status: 409 },
        );
      }
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  /** `POST /graphify` — converge the per-repo server on the persisted opt-in
   * state (integration doc). The CLI writes the state file first and then
   * pokes this; the body carries nothing because the file is the single
   * source of truth and the daemon's job is to match it. Operator-only, like
   * autonomy: enabling a code-indexing service is the human's dial. */
  private async graphifyEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/graphify");
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      "/graphify",
      "graphify:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    if (this.graphify === undefined) {
      return json(
        { error: "this daemon has no graphify service configured" },
        { status: 503 },
      );
    }
    const state = await readGraphifyState(this.repoRoot);
    if (state.enabled) {
      // stop() then start() so a re-enable also swaps in a fresh install or
      // graph; both are idempotent and the window without a server only costs
      // spawns the attach, never anything else.
      await this.graphify.stop();
      await this.graphify.start();
    } else {
      await this.graphify.stop();
    }
    return json({ enabled: state.enabled, ...this.graphify.status() });
  }

  /**
   * POST /agents/<name>/kill — the pane's X button.
   *
   * The Workspace needs a kill it can call without an MCP client, and it must
   * be the SAME kill: a second teardown path is how one of them quietly stops
   * reaping something. So this is a thin authorization shell over
   * killAgentTeardown and holds no policy of its own.
   *
   * Idempotent, because a UI cannot be. The user can click X on a pane whose
   * agent died a second ago, or click it twice; an already-dead agent is the
   * outcome the caller wanted, so it is a 200 and not an error.
   */
  private async killEndpoint(
    pathname: string,
    request: Request,
  ): Promise<Response> {
    const authenticated = this.authenticate(request, "/agents/kill");
    if (!authenticated.ok) return this.denied(authenticated);
    const name = decodeURIComponent(
      pathname.slice("/agents/".length, -"/kill".length),
    );
    if (name === "") {
      return json({ error: "Invalid kill request: no agent" }, { status: 400 });
    }
    const decision = this.authorize(
      authenticated.capability,
      "/agents/kill",
      "agent:kill",
      name,
    );
    if (!decision.ok) return this.denied(decision);
    const agent = this.db.getAgentByName(name);
    if (agent === null) {
      return json({ error: `Hive agent not found: ${name}` }, { status: 404 });
    }
    try {
      return json(await this.killAgentTeardown(agent));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Kill failed" },
        { status: 500 },
      );
    }
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

  async processEvent(event: HookEvent): Promise<void> {
    const parsed = HookEventSchema.parse(event);
    // One root identity at ingress: legacy/case-varied orchestrator events
    // register and store as queen so status, token usage, and consumers agree.
    const value = {
      ...parsed,
      agentName: canonicalOrchestratorName(parsed.agentName),
    };
    if (
      value.agentName === ORCHESTRATOR_NAME &&
      value.toolSessionId !== undefined
    ) {
      this.tokenUsage.registerOrchestratorProviderSession(
        value.toolSessionId,
        this.repoRoot,
      );
    }
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
          // A tool ran to completion, so any native permission dialog that was
          // holding this agent has been answered. This is the only honest way
          // back out of `awaiting-approval` for a vendor-raised dialog: Hive
          // cannot answer that dialog, so it must wait to OBSERVE it gone
          // rather than assume. Left alone, a reader that a human unblocked at
          // the pane would keep reporting "blocked" for the rest of its turn.
          ...(agent.status === "awaiting-approval" ? { status: "working" } : {}),
          ...(value.toolSessionId === undefined
            ? {}
            : agent.tool !== "codex"
            ? { toolSessionId: value.toolSessionId }
            : {}),
        });
        this.delivery.confirmSteerAtToolBoundary(value.agentName, value.timestamp);
        await this.delivery.flushUrgent(value.agentName);
        await this.delivery.flushSteer(value.agentName);
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
          status: agent.writeRevoked && agent.controlMessageId !== undefined &&
              value.kind !== "dead"
            ? "control-paused"
            : value.kind === "dead"
            ? agent.status  // terminalization is markAgentDead in killAgentTeardown only
            : value.kind === "turn-start"
              ? "working"
              : value.kind === "approval-request"
                ? (agent.readOnly ? agent.status : "awaiting-approval")
                : value.kind === "notification"
                  // The vendor's own dialog. Claude raises this hook when it is
                  // BLOCKED asking for permission, and Hive used to hold the
                  // agent's status here — so a session parked on a dialog went
                  // on reporting "working" forever and told nobody. Any other
                  // notification (notably idle_prompt, which an idle agent
                  // emits while doing nothing) still changes nothing.
                  ? (isPermissionPrompt(value)
                    ? "awaiting-approval"
                    : agent.status)
                : value.kind === "session-launch" || value.kind === "session-end"
                  // Only the orchestrator supervisor emits this today. If a
                  // future worker reports either supervisor lifecycle event,
                  // process teardown remains the authority for that worker.
                  ? agent.status
                : "idle",
          contextPct: value.kind === "turn-end" &&
              value.contextPct !== undefined
            ? value.contextPct
            : agent.contextPct,
          lastEventAt: new Date(value.timestamp).toISOString(),
          // Codex hook traffic is authenticated to the agent name, not to a
          // provider process/session, so it never binds toolSessionId. The
          // telemetry sweep binds only validated rollout session_meta.
          // Claude/Grok may rebind on resume through their native contracts.
          ...(value.toolSessionId === undefined
            ? {}
            : agent.tool !== "codex"
            ? { toolSessionId: value.toolSessionId }
            : {}),
          // A completed turn proves the process is genuinely healthy, so the
          // crash-resume budget rearms.
          ...(value.kind === "turn-end" && agent.recoveryAttempts > 0
            ? { recoveryAttempts: 0 }
            : {}),
        };
        this.db.upsertAgent(updated);
      }

      if (value.kind === "approval-request" && agent?.readOnly !== true) {
        this.db.insertApproval({
          id: crypto.randomUUID(),
          agentName: value.agentName,
          // A tool's own permission prompt, relayed by the agent's hook: the
          // description names what the tool wants to do. Never trimmed.
          kind: "tool-permission",
          description: value.description,
          status: "pending",
          createdAt: value.timestamp,
          resolvedAt: null,
        });
      }
    });

    if (value.kind === "dead") {
      const dead = this.db.getAgentByName(value.agentName);
      if (dead !== null) {
        await this.killAgentTeardown(dead, { at: value.timestamp });
      }
    }

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

    // Fail-closed at the turn boundary for legacy Codex writers: any non-matching
    // reattestation (or missing launch identity/path) immediately persists
    // unknown/unattested, revokes, and pauses. Concurrent kill during the awaited
    // read wins via pauseWriterForIdentityDrift CAS.
    if (
      value.kind === "turn-start" && agent !== null && agent !== undefined &&
      agent.tool === "codex" && !agent.readOnly && !agent.writeRevoked
    ) {
      const epochAtStart = agent.capabilityEpoch;
      const toolSessionAtStart = agent.toolSessionId ?? null;
      if (
        agent.executionIdentity === undefined || agent.worktreePath === null ||
        agent.toolSessionId === undefined || agent.processStartedAt === undefined
      ) {
        await this.pauseWriterForIdentityDrift({
          ...agent,
          identityState: "unknown",
        }, "turn-start: no immutable launch identity or worktree (legacy/migrated writer)");
      } else {
        const launch = agent.executionIdentity;
        let attestation;
        try {
          attestation = reconcileCodexIdentity(
            launch,
            await this.readCodexIdentity(agent.worktreePath, agent.toolSessionId),
          );
        } catch {
          attestation = {
            identityState: "unknown" as const,
            observedIdentity: null,
            liveModel: null,
            liveEffort: null,
          };
        }
        // Post-await CAS snapshot before pause mutation.
        const mid = this.db.getAgentById(agent.id);
        if (
          mid === null ||
          isTerminalAgentStatus(mid.status) ||
          mid.capabilityEpoch !== epochAtStart ||
          (mid.toolSessionId ?? null) !== toolSessionAtStart
        ) {
          // concurrent kill/terminal/incarnation change wins
        } else if (attestation.identityState !== "matching") {
          const observed = attestation.observedIdentity;
          const state = attestation.identityState === "unattested"
            ? "unknown" as const
            : attestation.identityState;
          await this.pauseWriterForIdentityDrift({
            ...mid,
            identityState: state,
            ...(observed === null ? {} : { observedIdentity: observed }),
            ...(attestation.liveModel === null
              ? {}
              : { liveModel: attestation.liveModel }),
            ...(attestation.liveEffort === null
              ? {}
              : { liveEffort: attestation.liveEffort }),
          }, `turn-start reattestation is ${state}, not matching`);
        }
      }
    }

    // Visibility is the whole point: a status nobody reads is not a fix. The
    // agent cannot report this itself — it is blocked mid-turn, which is
    // precisely why this went unnoticed — so the daemon speaks for it.
    // Idempotent per agent per dialog: the hook fires once when the dialog
    // opens, and re-notifying on a status Hive cannot clear on its own would
    // spam the orchestrator.
    if (
      isPermissionPrompt(value) && agent !== undefined && agent !== null &&
      agent.name !== ORCHESTRATOR_NAME
    ) {
      await this.delivery.send(
        "hive-resources",
        ORCHESTRATOR_NAME,
        `${value.agentName} is BLOCKED on a Claude Code permission dialog in its own tmux pane ` +
          `(session ${agent.tmuxSession ?? "unknown"}) and cannot proceed until a human answers it. ` +
          `Hive can see this dialog but cannot answer it: the notification hook carries no request id, ` +
          `so there is no reply path back to the TUI. Someone must clear it at the pane ` +
          `(\`tmux attach -t ${agent.tmuxSession ?? "<session>"}\`).\n` +
          `An agent under full autonomy should never reach this: it means the session launched ` +
          `without bypassPermissions, so check its spawn.`,
        { idempotencyKey: `permission-dialog:${agent.id}:${value.timestamp}` },
      ).catch(logAlertDeliveryFailure);
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
    // Normalize root address before authorize + process so synonym and
    // case variants share the queen subject with minted root credentials.
    const normalized = {
      ...event.data,
      agentName: canonicalOrchestratorName(event.data.agentName),
    };
    // A hook may only report on the agent it was installed for. Hooks fire at
    // every turn boundary, so allows are not audited.
    const decision = this.authorize(
      authenticated.capability,
      "/event",
      "event:report",
      normalized.agentName,
      false,
    );
    if (!decision.ok) return this.denied(decision);
    try {
      await this.processEvent(normalized);
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
        'Fetch bounded live-agent status on demand. The compact default reports spawn-task provenance, later orchestrator instructions, observed Git paths, and overlaps. Use detail "full" for full live records, fields for a projection, and history:true only when terminal history is explicitly needed.',
      inputSchema: StatusRequestSchema,
    }, async ({ detail, history, fields }) => {
      this.authorizeTool(capability, "hive_status", "status:read", undefined, false);
      // graphifyCalls says whether the graph tools are earning their context
      // cost (integration doc, layer 3). Null is unknown — no observation —
      // never zero; only rendered at all when this daemon runs graphify.
      let agents = this.db.listAgents().map((agent) => (
        this.graphify === undefined ? agent : {
          ...agent,
          graphifyCalls: this.graphifyCalls.get(agent.id)?.count ?? null,
        }
      ));
      if (history !== true) {
        agents = agents.filter((agent) =>
          !["dead", "done", "failed"].includes(agent.status)
        );
      }
      const messages = this.db.listMessages();
      const evidence = new Map<
        string,
        { instructions: string[]; files: string[] }
      >();
      await Promise.all(agents.map(async (agent) => {
        evidence.set(agent.name, {
          instructions: messages.filter((message) =>
            isOrchestratorName(message.from) &&
            message.to === agent.name && message.intent === "instruction" &&
            Date.parse(message.createdAt) > Date.parse(agent.createdAt)
          ).map((message) => message.body),
          files: await observedWorktreeFiles(
            this.repoRoot,
            agent.worktreePath,
            agent.branch,
          ).catch(() => []),
        });
      }));
      // Landed is not live: the daemon runs a compiled binary, so main can be
      // ahead of the code answering this call. Status says so unasked — the
      // failure mode is precisely that nobody thinks to ask.
      const build = await this.buildFreshness();
      let result = (detail === "full"
        ? agents
        : compactActiveTeam(agents, evidence)) as unknown as Array<
          Record<string, unknown>
        >;
      if (fields !== undefined) {
        result = result.map((record) => Object.fromEntries(fields
          .filter((field) => field in record)
          .map((field) => [field, record[field]])));
      }
      return toolResult(
        result,
        "agents",
        build.message,
      );
    });

    server.registerTool("hive_preserve_branch", {
      title: "Mark intentionally preserved branch",
      description: "Mark or unmark a closed agent branch as intentionally preserved so stranded-work reconciliation does not repeatedly alarm on a deliberate state.",
      inputSchema: PreserveBranchRequestSchema,
    }, async ({ agent, preserved }) => {
      this.authorizeTool(capability, "hive_preserve_branch", "agent:kill", agent, false);
      const record = this.db.getAgentByName(agent);
      if (record?.branch === null || record?.branch === undefined) {
        throw new Error(`Agent ${agent} has no branch to preserve`);
      }
      if (LIVE_STATUSES.includes(record.status)) {
        throw new Error(`Agent ${agent} is still live; its branch is active work`);
      }
      await markBranchPreserved(this.repoRoot, record.branch, preserved);
      return toolResult({ branch: record.branch, preserved }, "result");
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

    server.registerTool("hive_token_usage", {
      title: "Hive token usage",
      description:
        "Show provider-reported input/output token totals by Hive session, with exact orchestrator control usage separated from mixed worker-session usage.",
      inputSchema: z.object({
        repoRoot: z.string().min(1).optional(),
      }),
    }, async ({ repoRoot }) => {
      this.authorizeTool(
        capability,
        "hive_token_usage",
        "token-usage:read",
        undefined,
        false,
      );
      return toolResult(await this.tokenUsage.snapshot(repoRoot), "tokenUsage");
    });

    server.registerTool("hive_models", {
      title: "Hive model inventory",
      description:
        "List every model discovered from Claude and Codex, including hidden and unrouted models, with effort levels, plan status, routing roles, and when Hive would use each one.",
      inputSchema: z.object({}),
    }, async () => {
      this.authorizeTool(capability, "hive_models", "status:read", undefined, false);
      if (this.modelInventory === undefined) {
        throw new Error("Live model inventory is unavailable");
      }
      return toolResult(await this.modelInventory(), "inventory");
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

    server.registerTool("hive_resume", {
      title: "Resume a paused Hive agent",
      description:
        "Resume a non-destructively paused agent (e.g. one paused for execution-identity drift). Reattests the running model+effort against the authorized launch identity; only on a match does it reissue capability at a fresh epoch and SIGCONT the SAME preserved process. A still-drifted or unreadable identity keeps the agent paused with write authority withheld. Nothing is relaunched.",
      inputSchema: z.object({ agent: z.string().min(1) }),
    }, async ({ agent }) => {
      this.authorizeTool(capability, "hive_resume", "agent:recover", agent);
      return toolResult(await this.resumeAgentAfterPause(agent), "resume");
    });

    server.registerTool("hive_mark_dead", {
      title: "Mark Hive agent dead",
      description:
        "Mark a confirmed-stopped Hive agent dead after cleaning its residual resources and viewer. Refuses while the tmux session still exists; use hive_kill to stop a live agent.",
      inputSchema: MarkDeadRequestSchema,
    }, async ({ agent: agentName }) => {
      this.authorizeTool(capability, "hive_mark_dead", "agent:mark-dead", agentName);
      const agent = this.db.getAgentByName(agentName);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${agentName}`);
      }
      if (await this.tmux.hasSession(agent.tmuxSession)) {
        throw new Error(
          `Cannot mark ${agentName} dead: tmux session ${agent.tmuxSession} is still running. Use hive_kill to stop a live agent.`,
        );
      }
      return toolResult((await this.killAgentTeardown(agent)).agent, "agent");
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
      return toolResult(
        await this.killAgentTeardown(agent, {
          removeWorktree: shouldRemoveWorktree,
          discardWork,
        }),
        "result",
      );
    });

    server.registerTool("hive_send", {
      title: "Send agent message",
      description:
        'Send a durable message and return its real lifecycle state. normal is ordinary guidance and lands at a turn boundary. steer is prompt, NON-DESTRUCTIVE guidance: Claude and Codex receive it mid-turn at the next tool boundary without cancellation; Grok has no tool-hook or native steer surface, so it honestly degrades to the next turn. urgent CANCELS the in-flight turn, which is never resumed, and discards its reasoning; use it only when the current work must STOP. critical is unchanged: it also revokes write/landing authority and restarts the target read-only. "queued" means not delivered, "injected" means handed to the vendor, and "applied" means receipt measured on the vendor\'s own boundary/transcript surface; queued/injected is SENT, not RECEIVED and not STOPPED. Never report a target as informed from enqueue or transport silence. Recipient queen wakes the root (preferred name; synonym "orchestrator" is still accepted). The returned body is a short head-and-tail preview; read the durable message for the full body.',
      inputSchema: SendRequestSchema,
    }, async ({ from, to, body, ...requested }) => {
      // `from` is a claim about identity, so it is checked against the bound
      // subject rather than trusted. No agent can forge a message from another.
      this.authorizeTool(capability, "hive_send", "message:send", from, false);
      const inferred = requested.priority === undefined &&
          requested.intent === undefined
        ? inferLegacyControl(body)
        : null;
      const message = await this.delivery.send(from, to, body, {
        ...requested,
        ...(inferred ?? {}),
      });
      // A send that left the message queued tells the sender what queued means
      // for THIS recipient right now — measured from its row, not implied by
      // the state name. "Queued" read as "delivered" is how an agent shipped a
      // migration without the safety requirements sent nine minutes earlier.
      const note = queuedDeliveryNote(
        message,
        isOrchestratorName(to) ? null : this.db.getAgentByName(to),
      );
      return toolResult(
        note === undefined
          ? compactSendResult(message)
          : { ...compactSendResult(message), delivery: note },
        "message",
      );
    });

    server.registerTool("hive_escalate", {
      title: "Escalate: wrong model for this task",
      description:
        "Raise a typed capability escalation: this task exceeds the model you were launched on. " +
        "Carry evidence (why, and at least one concrete failed approach) plus a handoff " +
        "(goal, done, remaining, decisions) the replacement resumes from. Commit your WIP " +
        "to your branch FIRST — the handoff points at it. The orchestrator decides: it may " +
        "respawn the task on a stronger route with your handoff, or tell you to continue. " +
        "Keep working until it answers. Escalations are recorded and measured per model " +
        "and category; escalate once per genuine wall, not to shop for a bigger model.",
      inputSchema: EscalationRequestSchema,
    }, async ({ agent, reason, goal, done, remaining, decisions, failedApproaches }) => {
      // The claimed identity is checked, not trusted, exactly as in hive_send:
      // an escalation is a structured send plus a telemetry row.
      this.authorizeTool(capability, "hive_escalate", "message:send", agent, false);
      const record = this.db.getAgentByName(agent);
      if (record === null) {
        throw new Error(`Cannot escalate: no agent named ${agent} exists`);
      }
      if (record.branch === null) {
        throw new Error(
          `Cannot escalate: ${agent} has no branch to hand off. Only spawned ` +
            "writer agents with a worktree can escalate",
        );
      }
      const now = new Date().toISOString();
      const handoff = HandoffSchema.parse({
        agentName: agent,
        goal,
        done,
        remaining,
        decisions,
        failedApproaches,
        branch: record.branch,
        timestamp: now,
      });
      // Measured BEFORE this row lands, so the message reports prior attempts.
      const prior = this.db.countEscalationsForAgent(record.id);
      const escalation = this.db.insertEscalation({
        id: crypto.randomUUID(),
        agentId: record.id,
        agentName: agent,
        // The launch identity: the row must join the routing decision that
        // produced it, and that decision chose the launch model.
        model: record.model,
        category: record.category,
        reason,
        createdAt: now,
      });
      const message = await this.delivery.send(
        agent,
        ORCHESTRATOR_NAME,
        [
          `CAPABILITY ESCALATION from ${agent} (category=${record.category}, model=${record.model}` +
          `${prior > 0 ? `; escalation #${prior + 1} from this agent` : ""}): ${reason}`,
          `Tried and failed: ${failedApproaches.join("; ")}`,
          `HANDOFF — goal: ${goal}`,
          `  done: ${done.join("; ") || "nothing yet"}`,
          `  remaining: ${remaining.join("; ") || "unstated"}`,
          `  decisions: ${decisions.join("; ") || "none recorded"}`,
          `  branch: ${record.branch} (WIP committed by the agent before escalating)`,
          "You decide: respawn the task with a stronger chain or model and this handoff, " +
          `kill ${agent} once the replacement confirms pickup — or tell ${agent} ` +
          "to continue. Do not leave it unanswered; it keeps working meanwhile.",
        ].join("\n"),
      );
      return toolResult(
        { escalation, handoff, priorEscalations: prior, message },
        "escalation",
      );
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
        'Read and atomically acknowledge queued messages. Recipient queen returns bounded envelopes (synonym "orchestrator" is still accepted).',
      inputSchema: InboxRequestSchema,
    }, async ({ agent }) => {
      // The global root inbox is reachable only by naming queen (or the
      // accepted synonym), which only the root's own capability may do.
      this.authorizeTool(capability, "hive_inbox", "inbox:read", agent, false);
      return toolResult(
        isOrchestratorName(agent)
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
      description:
        "Start a new Hive agent for a delegated task. Name the task's category " +
        "— complex_coding (multi-file builds, hard changes), simple_coding " +
        "(small mechanical edits), debugging (root-causing a defect), " +
        "code_review (independent review), planning (design before code), " +
        "heavy_research (deep investigation), light_research (quick lookups), " +
        "summarization (condensing text) — and the user's routing policy " +
        "chain for that category decides the model: first enabled link that " +
        "clears the launch gate runs. Optional: tool/model pin an explicit " +
        "user choice (never substituted); minContextTokens filters links for " +
        "long-context work (any category); effort overrides the link's. " +
        "Returns identity and state, not the task brief you just wrote — " +
        "taskDescription comes back truncated (taskDescriptionLength carries " +
        "the full count); read it in full via hive_status if ever needed.",
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
      const operation = await this.machineMutations?.beginOperation("spawn");
      try {
        const agent = await this.spawner.spawn(request);
        const current = this.db.getAgentById(agent.id);
        const persisted = current !== null &&
            current.lastEventAt >= agent.lastEventAt
          ? current
          : this.db.upsertAgent(agent);
        if (persisted.status === "failed" || persisted.status === "stuck") {
          const outcome = persisted.status === "stuck"
            ? "could not verify cleanup after spawn"
            : "failed to spawn";
          throw new Error(
            `Hive agent ${persisted.name} ${outcome}: ${
              persisted.failureReason ?? "unknown launch failure"
            }`,
          );
        }
        // An agent spawned to test a fix that is not in the running binary is
        // wasted money, so a spawn that Hive cannot vouch for carries the reason
        // with it. Warn, never block: the caller stays in control.
        const build = await this.buildFreshness();
        return toolResult(
          compactSpawnResult(persisted),
          "agent",
          build.state === "current" ? null : build.message,
        );
      } finally {
        operation?.release();
      }
    });

    server.registerTool("hive_approvals", {
      title: "List pending approvals",
      description:
        "List approval requests currently waiting for a decision. Each carries " +
        "a kind: tool-permission approvals (a command or tool call an agent " +
        "wants to run) return their description IN FULL — that text is what you " +
        "are deciding on. Boilerplate kinds (cost-consent, land-rearm) are " +
        "truncated to ~200 characters, since the same pending requests are " +
        "re-listed on every poll; truncated is true when the text was cut.",
      inputSchema: z.object({}),
    }, async () => {
      this.authorizeTool(capability, "hive_approvals", "approval:read", undefined, false);
      return toolResult(
        this.db.listApprovals("pending").map(compactApprovalDescription),
        "approvals",
      );
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
      const target = pending === null
        ? null
        : this.db.getAgentByName(pending.agentName);
      const readerMutationApproval = decision === "approve" &&
        pending?.kind === "tool-permission" && target?.readOnly === true;
      const approved = decision === "approve" && !readerMutationApproval;
      const approval = this.db.resolveApproval(
        id,
        approved ? "approved" : "denied",
        new Date().toISOString(),
      );
      if (approval === null) {
        throw new Error(`Pending approval not found: ${id}`);
      }
      if (
        approved &&
        approval.description.startsWith(LAND_REARM_PREFIX)
      ) {
        this.capabilities.rearmOneShot(approval.agentName, "branch:land");
      }
      await this.codexControl?.resolveApproval(
        approval.id,
        approved,
      );
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
      // A resolution the requesting agent is never told about is a resolution
      // it cannot act on: an agent whose land-rearm approval was silently
      // granted has no reason to retry hive_land, so it just sits idle until a
      // human notices and prods it with an urgent message. Every resolution —
      // approve or deny — gets an explicit envelope naming the approval and
      // the outcome, independent of whatever status-flush path
      // above already applies.
      const resolutionBody = approved
        ? approval.description.startsWith(LAND_REARM_PREFIX)
          ? `Your approval request "${approval.description}" was approved — re-arm granted, retry hive_land now.`
          : `Your approval request "${approval.description}" was approved.`
        : `Your approval request "${approval.description}" was denied — do not retry it; report back with the blocker instead.`;
      // Not awaited: delivery may wait for a terminal turn boundary, and
      // hive_approve's response must not hang on that. The message row itself
      // is written synchronously before send() reaches its first await, so it
      // is durable the instant this call is made.
      void this.delivery.send(
        "hive-approvals",
        approval.agentName,
        resolutionBody,
        { idempotencyKey: `approval-resolved:${approval.id}` },
      ).catch(logAlertDeliveryFailure);
      return toolResult(approval, "approval");
    });

    server.registerTool("hive_land", {
      title: "Land an agent branch",
      description:
        "Fast-forward land a writer branch only when its durable write capability epoch is current and not revoked.",
      inputSchema: LandRequestSchema,
    }, async ({ agent: name, capabilityEpoch }) => {
      const branch = this.db.getAgentByName(name)?.branch ?? null;
      try {
        this.authorizeTool(capability, "hive_land", "branch:land", name);
      } catch (error) {
        // A spent grant is a dead end the caller cannot fix alone (a live
        // agent asked to land follow-up work simply stalls). Measure before
        // spending a human on it: an empty branch needs no grant at all, and a
        // rebased branch with real work re-arms on Hive's own evidence.
        if (error instanceof Error && error.message.includes("already spent")) {
          const outcome = await this.decideSpentLandGrant(capability, branch, true);
          if (outcome === "nothing-to-land") throw nothingToLand(name, branch);
          if (outcome === "ask") {
            this.fileLandRearmApproval(capability.subject);
            throw new Error(`${error.message}. ${LAND_REARM_NOTE}`);
          }
          // Re-armed: the one-shot is available again and the land proceeds.
        } else {
          throw error;
        }
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
        // A lost reservation race means another land of this same branch is in
        // flight, so this one is never auto-re-armed — but if that land already
        // merged everything, there is still nothing here to grant.
        if (
          await this.decideSpentLandGrant(capability, branch, false) ===
            "nothing-to-land"
        ) {
          throw nothingToLand(name, branch);
        }
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
        'Full-text search compiled memory articles across repo (".hive/memory/wiki/") and global ("~/.hive/memory/wiki/") scope. Raw observations are immutable evidence and are not search results. Returns short snippets only; pull a full article with memory_read before relying on it.',
      inputSchema: MemorySearchRequestSchema,
    }, async ({ query, scope, limit }) => {
      this.authorizeTool(capability, "memory_search", "memory:read", undefined, false);
      return toolResult(this.memory.search(query, { scope, limit }), "results");
    });

    server.registerTool("memory_write", {
      title: "Write a Hive memory observation and article",
      description:
        "Record one immutable raw observation and create or update its compiled memory article. The schema is enforced here: topic, source provenance, evidence, verification status, and supersedes relationships are required. Search first; update a matching id instead of adding a duplicate. For a correction, pass the corrected article id in supersedes, make body state current truth, and preserve prior reasoning through the raw history. status=verified requires verified=YYYY-MM-DD; conflicted means the article must describe the unresolved disagreement. Repo scope lives under .hive/memory/{raw,wiki}; global under ~/.hive/memory/{raw,wiki}. Writes are serialized, rebuild wiki/index.md, append wiki/log.md, and immediately update compiled-article search.",
      inputSchema: MemoryWriteRequestSchema,
    }, async (input) => {
      this.authorizeTool(capability, "memory_write", "memory:write");
      const written = await this.writeMemoryFact(input);
      return toolResult(
        compactMemoryWriteResult(written, written.rawPath),
        "fact",
      );
    });

    server.registerTool("memory_read", {
      title: "Read a compiled Hive memory article",
      description:
        "Read one compiled memory article by scope and id, as referenced by the injected wiki index or memory_search. The result includes topic, evidence, verification status, supersedes relationships, and links to immutable raw observations. Reconcile unverified, stale, or conflicted knowledge before acting.",
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
      title: "Delete a compiled Hive memory article",
      description:
        "Delete one compiled article and remove it from the index. Immutable raw observations remain as audit evidence.",
      inputSchema: MemoryFactRequestSchema,
    }, async ({ scope, id }) => {
      this.authorizeTool(capability, "memory_delete", "memory:write");
      return toolResult({ deleted: await this.deleteMemoryFact(scope, id) }, "result");
    });

    server.registerTool("memory_reindex", {
      title: "Rebuild the Hive memory search index",
      description:
        "Non-destructively migrate legacy flat facts, rebuild each scope's wiki/index.md, and rebuild disposable SQLite FTS from compiled wiki articles. The first migration backs up the complete scope before writing, preserves every flat source, and returns the backup path; later rebuilds detect the completion marker and do not migrate again.",
      inputSchema: z.object({}),
    }, async () => {
      this.authorizeTool(capability, "memory_reindex", "memory:write");
      return toolResult(await this.rebuildMemoryIndex(), "result");
    });

    // The mid-task half of the graph-first mandate: the same locate the spawn
    // brief runs (Hive-side seeding + expansion over graph.json), callable
    // with a natural-language question. Lives on Hive's server, not
    // graphify's — that surface is pre-1.0 and not ours — and never blocks:
    // every failure is an honest "use grep" answer, not an error.
    server.registerTool("graph_locate", {
      title: "Locate files for a question via the code knowledge graph",
      description:
        "Find where something lives or happens in this repo: returns the files, symbols (with file:line citations), and import edges (with EXTRACTED/INFERRED provenance tags) that best match a natural-language question, using the repo's local knowledge graph. Use it for locate- and structure-questions before grep; it matches names and structure, not file contents, so exact-string hunts and vocabulary the code does not use still belong to grep/rg. Answers are leads to verify, never authority.",
      inputSchema: z.object({
        question: z.string().min(3).describe(
          "What you are trying to find, in plain words — e.g. \"where does the daemon attach the MCP server to a spawning agent\"",
        ),
      }),
    }, async ({ question }) => {
      this.authorizeTool(capability, "graph_locate", "status:read", undefined, false);
      return toolResult(await graphLocate(this.repoRoot, question), "locate");
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
