import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport as StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";
import { z } from "zod";
import { withFileLock } from "../adapters/file-lock";
import { graphLocate } from "../adapters/graphify";
import {
  deleteMemoryFact as deleteMemoryFactFile,
  listMemoryFacts,
  normalizeTitle,
  readMemoryFact,
  writeMemoryFact as writeMemoryFactFile,
} from "../adapters/memory";
import { CODEX_TUI_APPROVAL_KEYS } from "../adapters/providers/codex-cli";
import { readLiveGrokModel } from "../adapters/providers/grok-cli";
import {
  assessStrandedWork,
  listUnmergedHiveBranches,
  markBranchPreserved,
  observedWorktreeFiles,
  type RemoveWorktreeOptions,
  reconcileOrphanedWorktrees as reconcileWorktrees,
  removeWorktree,
  type StrandedWork,
  type UnmergedBranch,
  type WorktreeReconciliationReport,
} from "../adapters/worktrees";
import { type AutonomyControl, isAutonomy } from "../config/autonomy";
import type {
  LifecycleConfig,
  MemoryRetentionConfig,
  ResourceLimits,
} from "../schemas";
import {
  type ActivitySnapshot,
  type AgentRecord,
  type CapabilityProvider,
  ControlIntentSchema,
  canonicalOrchestratorName,
  compactMemoryWriteResult,
  HandoffSchema,
  HiveTerminalObserveInputSchema,
  HiveUpdateStatusAdvertisedSchema,
  type HookEvent,
  HookEventSchema,
  isOrchestratorName,
  isTerminalAgentStatus,
  type MemoryScope,
  MemoryScopeSchema,
  type MemoryWriteInput,
  MemoryWriteInputSchema,
  MessagePrioritySchema,
  ORCHESTRATOR_NAME,
  QuotaObservationSchema,
  RoutingPolicyMutationSchema,
  SessionLocatorSchema,
  StatuslineReportSchema,
  type TerminalGeometry,
  TerminalGeometrySchema,
  unknownVendor,
} from "../schemas";
import type { WorkspaceEventV2 } from "../schemas/status-envelope";
import { HIVE_VERSION } from "../version";
import { buildActivitySnapshot } from "./activity-snapshot";
import {
  type Action,
  bearerToken,
  type Capability,
  CapabilityStore,
  type Decision,
  type Denial,
  permitsTerminalObservation,
  type Role,
} from "./capabilities";
import {
  OPERATOR_SUBJECT,
  removeCredential,
  writeCredential,
} from "./credentials";
import { DaemonLog } from "./daemon-log";
import { type Approval, HiveDatabase } from "./db";
import {
  MessageDelivery,
  queuedDeliveryNote,
  type RootProtocolDeliverer,
  type SessionSender,
} from "./delivery";
import { DrainHandler, type ReplacementDrain } from "./drain-handler";
import {
  compileDigest,
  isDigestBoundaryEvent,
  MemoryDigestInputSchema,
  runMemoryDigest,
} from "./episodic-digest";
import {
  estimateTokens,
  MemoryQueryInputSchema,
  runMemoryQuery,
} from "./episodic-projections";
import type { EpisodicStore } from "./episodic-store";
import type { GraphifyService } from "./graphify-service";
import { buildHandoffBundle, measureHandoffWorktree } from "./handoff";
import { expectedDaemonHandshake } from "./handshake";
import { hiveInstanceSuffix } from "./instance-identity";
import { listInstances } from "./instances";
import {
  type LandBranch,
  landBranch,
  type ReadLandReadiness,
  readLandReadiness,
  resolveLandingTargetBranch,
} from "./landing";
import {
  cleanupLifecycleFiles,
  readConfiguredPort,
  writeLifecycleFiles,
} from "./lifecycle";
import { readLiveClaudeModel } from "./live-model";
import { createWakeDeltaProvider } from "./memory-delta";
import {
  embeddingsRuntimeDir,
  type MemoryEmbedderLoad,
  type MemoryEmbeddingConfig,
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
  type MemoryEmbeddingWriteOutcome,
} from "./memory-embeddings";
import { findSimilarMemoryCandidates, MemoryIndex } from "./memory-index";
import {
  promotionProvenanceBlock,
  promotionSource,
  scanPromotionRedaction,
} from "./memory-promote";
import {
  type RetentionSweepReport,
  runRetentionSweep,
} from "./memory-retention";
import {
  buildMemoryRecallBundle,
  createMemoryTriggerExecutor,
  MEMORY_RECALL_HINT_NOTE,
  memoryRecallDegradedWarning,
} from "./memory-triggers";
import type { ModelInventory } from "./model-inventory";
import { MachineMutationCoordinator } from "./mutation-lease";
import {
  compactActiveTeam,
  compactApprovalDescription,
  compactSendResult,
  compactSpawnResult,
} from "./orchestrator-lifecycle";
import { SessiondOrchestratorRootDelivery } from "./orchestrator-root-delivery";
import {
  OrchestratorSessiondController,
  OrchestratorSessiondLaunchSchema,
} from "./orchestrator-sessiond";
import { deriveOrchestratorStatus } from "./orchestrator-status";
import { harvestPitfalls } from "./pitfall-harvest";
import { logAlertDeliveryFailure } from "./alert-log";
import { registerMemoryTools } from "./memory-tools";
import { registerAgentControlTools } from "./agent-control-tools";
import {
  LAND_REARM_PREFIX,
  registerSpawnApprovalTools,
} from "./spawn-approval-tools";
import { registerGraphTool } from "./graph-tool";
import { registerLandTool } from "./land-tool";
import { LIVE_STATUSES, registerStatusTools } from "./status-tools";
import { registerMessagingTools } from "./messaging-tools";
import { registerQuotaTools } from "./quota-tools";
import { toolResult } from "./tool-result";
import { attachGrantEndpoint as attachGrantRoute } from "./attach-grant-endpoint";
import { sweepResources as sweepResourcesCycle } from "./sweep-resources";
import { checkWakePaths as checkWakePathsSweep } from "./wake-path-check";
import { processEvent as processHookEvent } from "./process-event";
import { projectHiveUuid } from "./project-state";
import { recordProviderHookEvent } from "./provider-events";
import type { QuotaService } from "./quota";
import {
  CrashRecovery,
  type CrashRecoveryDependencies,
  type RecoveryOutcome,
  type SessionResolver,
} from "./recovery";
import {
  assessResources,
  type CommandOutput,
  foregroundJobState,
  type PaneProcessState,
  parseAvailableMemoryMb,
  parseForegroundProcessTable,
  parseProcessTable,
  runPs,
  runPsForeground,
  runVmStat,
} from "./resources";
import {
  RoutingPolicyConflictError,
  RoutingPolicyStore,
} from "./routing-policy-store";
import type { SelectionPreferenceControl } from "./selection-preferences";
import type { SessionHost, SessionLocator } from "./session-host/contract";
import {
  HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
  sessiondAgentProviderRunIsDead,
  sessiondTerminalIsDead,
} from "./session-host/hive-terminal-host";
import {
  mintSessionRequestId,
  sameSessionLocator,
} from "./session-host/locators";
import {
  type SessiondAgentInput,
  type SessiondRootInput,
  SessiondViewerAgentInput,
} from "./session-host/sessiond-agent-input";
import {
  type LandedTerminalHost,
  SessiondHost,
} from "./session-host/sessiond-host";
import type { SessiondOutputObservation } from "./session-host/sessiond-output-observer";
import {
  ROOT_VISIBILITY_ID,
  WorkspaceOwnerSchema,
  type WorkspaceVisibilityAdmission,
  type WorkspaceVisibilityAuthority,
  type WorkspaceVisibilityCandidate,
  type WorkspaceVisibilitySnapshot,
  WorkspaceVisibilitySnapshotSchema,
} from "./session-host/workspace-visibility";
import {
  type SpawnBatchRequest,
  SpawnBatchRequestSchema,
  type Spawner,
  type SpawnRequest,
  SpawnRequestSchema,
} from "./spawner";
import { fuseAgentStatus } from "./status-fusion";
import {
  type StatusIncarnationGenerationSource,
  StatusIncarnationUnavailableError,
  unavailableStatusIncarnationGenerationSource,
} from "./status-generation";
import { StatusStore } from "./status-store";
import {
  defaultReapDependencies,
  type ReapDependencies,
  type ReapOutcome,
  reapCapturedTree,
  stopSessiondAgentSession,
} from "./teardown";
import { TokenUsageStore } from "./token-usage";
import { refreshToolTelemetry as refreshToolTelemetrySweep } from "./tool-telemetry-refresh";
import {
  type ClaudeTelemetryReader,
  clampPct,
  type GraphifyCallCursor,
  type GrokTelemetry,
  type GrokTelemetryReader,
  readClaudeTelemetry,
  readCodexTelemetry,
  readGraphifyCalls,
  readGrokTelemetry,
  type TelemetryReader,
  type ToolTelemetry,
} from "./tool-telemetry";

export { HIVE_VERSION };

const OPERATOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often the daemon checks that the Workspace it serves is still running.
 * Nothing a terminal needs rides on this tick: terminals observe their own
 * supervisor and outlive any number of missed ones. */
export const WORKSPACE_OWNER_WATCH_MS = 5_000;
export const WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS = 15_000;

const TokenUsageSessionRequestSchema = z.object({
  repoRoot: z.string().min(1),
});

const TokenUsageOrchestratorRequestSchema = z.object({
  provider: z.string().min(1),
  cwd: z.string().min(1),
});

// A fact id becomes a filename under the memory root, so the daemon boundary
// must refuse anything that could
// name a path component: no slashes, no leading dot, nothing outside the
// slug-plus-punctuation charset slugify and hand-authored facts actually use.

export type { LandBranch };

// A refused land on a spent one-shot files an
// approval, and approving it re-arms exactly one landing. The prefix is the
// contract between the filing site and the approval hook.
// How many landings past the first Hive will re-arm on its own evidence, per
// agent — so a productive agent is not a human bottleneck, while an agent still
// cannot merge an unbounded stream of unreviewed increments: the fifth landing
// of a task asks a person, and so does every landing after it. The budget is a
// per-agent (therefore per-task) count read back from the audit log.
export const AUTO_REARM_BUDGET = 3;
export const AUTO_REARM_REASON = "capability.auto-rearm";

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

export interface HiveDaemonOptions {
  spawner: Spawner;
  db?: HiveDatabase;
  statusStore?: StatusStore;
  /** The per-project episodic memory store. The daemon
   * projects its status/observation events into it and closes it in stop().
   * Production opens it via EpisodicStore.forProjectRoot so the store's
   * location comes from the daemon's own project identity. */
  episodicStore?: EpisodicStore;
  /** Visible-text capture for the separately authorized terminal-observe tool. */
  sessionHost?: Pick<SessionHost, "capture">;
  /** Bounded raw output used by passive fleet activity observation. */
  observeTerminalOutput?: (
    locator: SessionLocator,
    geometry: TerminalGeometry,
  ) => Promise<SessiondOutputObservation | null>;
  /** Frozen neutral sessiond backend; Hive policy is applied by its binding adapter. */
  terminalHost?: LandedTerminalHost;
  /** Live Workspace-owned full inventory. Absent keeps sessiond admission closed. */
  workspaceVisibility?: WorkspaceVisibilityAuthority;
  resolveSessionLocator?: (
    sessionId: string,
    generation: number,
  ) => Promise<SessionLocator | null>;
  statusIncarnationGenerationSource: StatusIncarnationGenerationSource;
  sessionSender?: SessionSender;
  recovery?: {
    resolveClaudeSessionId?: SessionResolver;
    resolveCodexSessionId?: SessionResolver;
    resolveGrokSessionId?: SessionResolver;
    worktreeExists?: (path: string) => boolean;
    sleep?: (milliseconds: number) => Promise<void>;
    claudeExecutable?: string;
    codexExecutable?: string;
    grokExecutable?: string;
    readCodexActivity?: CrashRecoveryDependencies["readCodexActivity"];
  };
  /** The live autonomy dial: read by `/autonomy` and by crash recovery (so a
   * resume matches the setting the user can see), written only through the
   * operator-gated `/autonomy` endpoint, which persists before it applies. */
  autonomy?: AutonomyControl;
  /** Ordinary Workspace selection persistence; absent for named/default homes. */
  selectionPreferences?: SelectionPreferenceControl;
  /** The per-repo graphify MCP server, when this repo opted in. The daemon owns its
   * lifecycle: up on start, down on stop, rebuilt-and-reloaded after each
   * landing — all fire-and-forget, never in a caller's latency. */
  graphify?: GraphifyService;
  repoRoot?: string;
  removeWorktree?: (
    repoRoot: string,
    worktreePath: string,
    options?: RemoveWorktreeOptions,
  ) => Promise<void>;
  assessStrandedWork?: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
    mainBranch?: string,
  ) => Promise<StrandedWork>;
  listUnmergedHiveBranches?: (
    repoRoot: string,
    mainBranch?: string,
  ) => Promise<UnmergedBranch[]>;
  reconcileOrphanedWorktrees?: typeof reconcileWorktrees;
  liveInstanceIds?: () => Promise<ReadonlySet<string>>;
  landBranch?: LandBranch;
  readLandReadiness?: ReadLandReadiness;
  port?: number;
  hostname?: string;
  manageLifecycle?: boolean;
  /** How POST /stop takes the daemon itself down once every agent is torn
   * down. Defaults to SIGTERMing this process when it manages its own
   * lifecycle — the exact path the signal handlers already own — and to a
   * no-op for embedded daemons, whose host process owns its own lifetime.
   * Injectable so a test can prove the sequence without dying. */
  initiateShutdown?: () => void;
  /**
   * Production owner of `hive-sessiond serve`. Started by the daemon entry
   * before listen; torn down after agent kill so terminate still has a broker.
   * Embedded tests omit this.
   */
  machineMutations?: Pick<MachineMutationCoordinator, "beginOperation">;
  quota?: QuotaService;
  /** Durable provider-reported token accounting. Injectable so collector and
   * lifecycle tests never read the developer's real CLI artifacts. */
  tokenUsage?: TokenUsageStore;
  /** Complete live model inventory for the read-only orchestrator surface. */
  modelInventory?: () => Promise<ModelInventory>;
  /** Root wake transport override for tests; defaults to terminal delivery. */
  rootProtocol?: RootProtocolDeliverer;
  /** Daemon→idle-sessiond-agent input override for tests; defaults to the
   * neutral viewer-attach wire over the landed terminal host. */
  sessiondInput?: SessiondAgentInput;
  /** Context/activity artifact readers, injectable for tests; default to the
   * real transcript and rollout sensors. `liveModel` reads the model an agent is
   * *running* out of its transcript, and returns null when there is nothing to
   * observe. */
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
  };
  /** Memory watchdog limits; the sweep stays off when omitted so embedded
   * daemons (tests, tooling) never sample or kill real processes. */
  resources?: ResourceLimits;
  /** Idle-agent reap sweep (config `[lifecycle]`); stays off when omitted so
   * embedded daemons (tests, tooling) never close an agent unasked. */
  lifecycle?: LifecycleConfig;
  /** Memory retention sweep configured by `[memory.retention]`; stays off when
   * omitted so embedded daemons never age out memory
   * state unasked. Also inert without an episodic store. */
  retention?: MemoryRetentionConfig;
  /** Wake-delta memory injection budget configured by `[memory]
   * wake_budget_tokens`. The delta rides the
   * send lane only when a budget AND an episodic store (the high-water
   * marks) are both present, so embedded daemons never inject unasked. */
  wakeBudgetTokens?: number;
  /** Semantic recall leg configured by `[memory] embedding_provider` and
   * `embedding_model`. Active only with an
   * episodic store (the vector table lives there); the model loads lazily on
   * first use and a load failure degrades recall to the FTS-only bundle —
   * it never crashes the daemon. */
  memoryEmbeddings?: MemoryEmbeddingConfig;
  /** Test seam: substitute the embedder factory so daemon-level tests never
   * load a real model. */
  memoryEmbeddingLoad?: MemoryEmbedderLoad;
  /** Durable warning sink: startup config lines, embedding state
   * transitions, sweep reports, and trigger/delta failures are appended here
   * in addition to the console. Defaults to $HIVE_HOME/logs/daemon.log with
   * a size-capped rollover; tests substitute to capture lines. */
  daemonLog?: (line: string) => void;
  /** Test seams for the resource sweep's process interrogation. */
  resourceRunners?: {
    ps?: CommandOutput;
    vmStat?: CommandOutput;
    kill?: (pid: number) => void;
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
export class HiveDaemon {
  static readonly statusGenerationUnavailable =
    unavailableStatusIncarnationGenerationSource;

  readonly db: HiveDatabase;
  readonly delivery: MessageDelivery;
  readonly spawner: Spawner;
  readonly memory: MemoryIndex;
  readonly capabilities: CapabilityStore;
  readonly status: StatusStore;
  /** Per-project episodic memory; null when no store was provided. */
  readonly episodic: EpisodicStore | null;
  private memoryLock: Promise<unknown> = Promise.resolve();
  private readonly ownsDatabase: boolean;
  private readonly port: number;
  private readonly hostname: string;
  private readonly manageLifecycle: boolean;
  private readonly initiateShutdown: () => void;
  /** Shutdown latch shared by POST /stop and Workspace-death detection. */
  private stopInProgress = false;
  private readonly machineMutations: Pick<
    MachineMutationCoordinator,
    "beginOperation"
  > | null;
  private readonly ownedMachineMutations: MachineMutationCoordinator | null;
  private readonly terminalHost: HiveTerminalHostAdapter;
  private readonly workspaceVisibility: WorkspaceVisibilityAuthority | null;
  private readonly orchestratorSessiond: OrchestratorSessiondController | null;
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
  private readonly handshake: () => ReturnType<typeof expectedDaemonHandshake>;
  private readonly cleanupWorktree: typeof removeWorktree;
  private readonly assessStranded: NonNullable<
    HiveDaemonOptions["assessStrandedWork"]
  >;
  private readonly listUnmergedBranches: NonNullable<
    HiveDaemonOptions["listUnmergedHiveBranches"]
  >;
  private readonly reconcileWorktrees: typeof reconcileWorktrees;
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
  /** The same daemon→session input wire delivery uses; a TUI-hosted vendor
   * approval is a keystroke, not a message. */
  private readonly sessiondInput: SessiondAgentInput &
    Partial<SessiondRootInput>;
  /** Approval ids currently crossing an awaited vendor delivery boundary. */
  private readonly resolvingApprovals = new Set<string>();
  private readonly autonomy: AutonomyControl | undefined;
  private readonly selectionPreferences: SelectionPreferenceControl | undefined;
  private readonly graphify: GraphifyService | undefined;
  /** Per-agent graphify MCP call counts. Keyed by
   * AgentUUID, in memory on purpose: the transcripts are durable, so a
   * restart recounts from offset zero instead of trusting a stale number. */
  private readonly graphifyCalls = new Map<string, GraphifyCallCursor>();
  /** Subjects whose credential has authenticated against /mcp, last-seen
   * timestamp per subject. In memory on purpose: it answers "has this
   * incarnation reported since its launch", which a restart re-asks anyway. */
  private readonly mcpClientsSeen = new Map<string, string>();
  private readonly land: LandBranch;
  private readonly landReadiness: ReadLandReadiness;
  private bunServer: Server<undefined> | null = null;
  private readonly drainHandler: DrainHandler;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceOwnerTimer: ReturnType<typeof setInterval> | null = null;
  private ownerRegistrationTimer: ReturnType<typeof setTimeout> | null = null;
  private maintenanceRunning = false;
  /** Wake-path faults already reported, so a persistent one alerts once. */
  private readonly alertedWakeFaults = new Set<string>();
  private maintenanceHealth:
    | { status: "unknown" }
    | { status: "ok" }
    | { status: "error"; error: string } = { status: "unknown" };
  private readonly resources: ResourceLimits | null;
  private readonly lifecycleConfig: LifecycleConfig | null;
  private readonly retentionConfig: MemoryRetentionConfig | null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private retentionRunning = false;
  private readonly wakeBudgetTokens: number | null;
  private readonly embeddingService: MemoryEmbeddingService | null;
  readonly embeddingIndex: MemoryEmbeddingIndex | null;
  /** Console lines that must survive
   * past the detached daemon's unread stdout. */
  private readonly writeDaemonLog: (line: string) => void;
  private readonly psSample: CommandOutput;
  private readonly vmStatSample: CommandOutput;
  private readonly killProcess: (pid: number) => void;
  private readonly reapDependencies: ReapDependencies;
  private readonly stopAgentProcesses: (
    agent: AgentRecord,
    beforeKill?: () => void | Promise<void>,
  ) => Promise<ReapOutcome>;
  private readonly sessionHost: Pick<SessionHost, "capture"> | null;
  private readonly observeTerminalOutput: NonNullable<
    HiveDaemonOptions["observeTerminalOutput"]
  > | null;
  private readonly resolveSessionLocator: NonNullable<
    HiveDaemonOptions["resolveSessionLocator"]
  > | null;
  private readonly statusIncarnationGenerationSource: StatusIncarnationGenerationSource;
  private memoryPressure = false;

  constructor(options: HiveDaemonOptions) {
    this.ownsDatabase = options.db === undefined;
    this.db = options.db ?? new HiveDatabase();
    this.status =
      options.statusStore ?? new StatusStore(this.db, hiveInstanceSuffix());
    for (const agent of this.db.listAgents()) {
      if (
        !isTerminalAgentStatus(agent.status) &&
        !this.status.hasAssignmentHistory(agent.id)
      ) {
        this.status.openAssignment(agent.id, agent.createdAt);
      }
    }
    this.memory = new MemoryIndex(this.db.database);
    this.episodic = options.episodicStore ?? null;
    const daemonLogFile = new DaemonLog();
    this.writeDaemonLog =
      options.daemonLog ?? ((line) => daemonLogFile.write(line));
    // The semantic leg is wired only with an episodic store
    // (its vector table lives there) and an embedding config. Lazy — nothing
    // loads here; the surface reports itself at start and on first use.
    this.embeddingService =
      this.episodic !== null && options.memoryEmbeddings !== undefined
        ? new MemoryEmbeddingService(options.memoryEmbeddings, {
            ...(options.memoryEmbeddingLoad === undefined
              ? {}
              : { load: options.memoryEmbeddingLoad }),
            // Load transitions persist to the daemon log because the
            // console line alone has no reader on the deployed daemon.
            log: (message) => this.writeDaemonLog(message),
          })
        : null;
    this.embeddingIndex =
      this.embeddingService !== null && this.episodic !== null
        ? new MemoryEmbeddingIndex({
            store: this.episodic,
            service: this.embeddingService,
            log: (message) => {
              console.error(message);
              this.writeDaemonLog(message);
            },
          })
        : null;
    // Every status-store write — agent reports, source events, and the
    // terminal observation audit — is also projected into episodic memory.
    // The listener runs synchronously on the status write path, so the
    // projection isolates its own failures inside ingestEpisodicEvent.
    if (this.episodic !== null) {
      this.status.onEvent((event) => this.ingestEpisodicEvent(event));
    }
    this.spawner = options.spawner;
    this.sessionHost = options.sessionHost ?? null;
    this.observeTerminalOutput = options.observeTerminalOutput ?? null;
    this.resolveSessionLocator = options.resolveSessionLocator ?? null;
    this.statusIncarnationGenerationSource =
      options.statusIncarnationGenerationSource;
    this.capabilities = new CapabilityStore(this.db, (name) => {
      const record = this.db.getAgentByName(name);
      return record === null
        ? null
        : {
            capabilityEpoch: record.capabilityEpoch,
            writeRevoked: record.writeRevoked,
          };
    });
    this.port = options.port ?? readConfiguredPort();
    this.hostname = options.hostname ?? "127.0.0.1";
    this.manageLifecycle = options.manageLifecycle ?? false;
    this.initiateShutdown =
      options.initiateShutdown ??
      (() => {
        // The short delay lets the /stop response flush before stop() force-closes
        // the listener; the signal handlers own the rest of the teardown.
        if (this.manageLifecycle) {
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
        }
      });
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
    const landedTerminalHost =
      options.terminalHost ??
      new SessiondHost({
        repoRoot: options.repoRoot,
        pendingBindings: this.db,
      });
    this.terminalHost = new HiveTerminalHostAdapter(
      landedTerminalHost,
      this.db,
      hiveInstanceSuffix(),
      { providerRuns: this.db },
    );
    this.workspaceVisibility = options.workspaceVisibility ?? null;
    this.quota = options.quota;
    this.tokenUsage = options.tokenUsage ?? new TokenUsageStore(this.db);
    this.modelInventory = options.modelInventory;
    this.sessiondInput =
      options.sessiondInput ??
      new SessiondViewerAgentInput(
        landedTerminalHost,
        `hive-daemon:${hiveInstanceSuffix()}`,
        undefined,
        // Orphan discard lives on the real sessiond client only; an
        // injected test host keeps the pre-fix decline-and-queue behaviour.
        landedTerminalHost instanceof SessiondHost
          ? (locator, mode) =>
              landedTerminalHost.discardInputOrphan(locator, mode)
          : undefined,
      );
    this.orchestratorSessiond =
      this.workspaceVisibility === null
        ? null
        : new OrchestratorSessiondController({
            terminalHost: this.terminalHost,
            providerRuns: this.db,
            bindings: this.db,
            visibility: this.workspaceVisibility,
            instanceId: hiveInstanceSuffix(),
          });
    this.autonomy = options.autonomy;
    this.selectionPreferences = options.selectionPreferences;
    this.graphify = options.graphify;
    const sessionSender: SessionSender = options.sessionSender ?? {
      sendSessionMessage: async () => {
        throw new Error("terminal input is unavailable");
      },
    };
    const deliverySessiondInput =
      options.sessiondInput ??
      (options.sessionSender === undefined ? this.sessiondInput : undefined);
    this.delivery = new MessageDelivery(
      this.db,
      sessionSender,
      {
        apply: async (agent, message) => {
          if (message.intent === "pause" || message.intent === "stop") {
            const locator = requireSessiondAgentLocator(agent);
            const run = this.db.getActiveProviderRunByTerminal(locator);
            if (run === null) {
              throw new Error(
                `${agent.name} has no active provider run to ${message.intent}`,
              );
            }
            const applied =
              message.intent === "pause"
                ? await this.terminalHost.pauseProvider(locator, run)
                : await this.terminalHost.stopProvider(locator, run);
            if (!applied) {
              throw new Error(
                `${agent.name}'s foreground provider identity changed before ${message.intent}`,
              );
            }
            return;
          }
          if (message.intent === "cancel") {
            throw new Error(
              `${agent.tool} terminal sessions have no provider-native turn cancel surface; use pause or stop`,
            );
          }
          const sameControlAttempt =
            agent.status === "control-paused" &&
            agent.controlMessageId === message.id &&
            agent.controlQuotaReservationId !== undefined &&
            this.quota?.ledger.getReservation(agent.controlQuotaReservationId)
              ?.status === "active";
          if (sameControlAttempt && (await this.agentSessionPresent(agent))) {
            // The daemon may have crashed after launch but before advancing the
            // message. Reuse the surviving process and reservation exactly.
            return;
          }
          if (!sameControlAttempt) {
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
            // The writer is already gone, so rolling back across the OS
            // boundary is impossible. Finish the control into a coherent,
            // terminal fail-closed state and release what the ledger says this
            // agent still holds; a queued control must not strand capacity or
            // invite an identical recovery attempt forever.
            await this.settleAgentQuota(current).catch(() => undefined);
            const reason =
              error instanceof Error
                ? error.message
                : "control acknowledgement process failed to launch";
            this.db.insertAgent({
              ...current,
              status: "failed",
              writeRevoked: true,
              failureReason: `Critical control ${message.id} restart failed: ${reason}`,
              failedAt: new Date().toISOString(),
              lastEventAt: new Date().toISOString(),
            });
            throw error;
          }
        },
      },
      // All visible roots use their instance-scoped terminal. Delivery holds
      // the composer lease so a report cannot overwrite human input.
      options.rootProtocol ??
        new SessiondOrchestratorRootDelivery({
          db: this.db,
          current: () => this.orchestratorSessiond?.snapshot() ?? null,
          ready: () => this.orchestratorSessiond?.isInputReady() ?? false,
          canInject: () => this.rootProviderAcceptsInput(),
          input: {
            writeAutomated: async (input) =>
              this.sessiondInput.writeAutomated === undefined
                ? {
                    outcome: "declined" as const,
                    reason: "root input is not wired on this host",
                  }
                : await this.sessiondInput.writeAutomated(input),
          },
        }),
      {},
      (agent) => this.agentProcessState(agent),
      undefined,
      // Daemon-to-idle-sessiond-agent input uses the neutral
      // viewer wire. The broker RPCs (issueAttach/list) are the landed host;
      // the viewer wire is the interim addition.
      deliverySessiondInput,
      // Wake-delta memory injection: every delivery to
      // an agent — an ordinary message, a queued flush, or the resume wake —
      // carries the bounded delta since the agent's high-water mark, over the
      // send lane so no vendor hook is required. repoRoot is read lazily
      // because it is assigned later in this constructor.
      this.episodic !== null && options.wakeBudgetTokens !== undefined
        ? createWakeDeltaProvider({
            repoRoot: () => this.repoRoot,
            store: this.episodic,
            memory: this.memory,
            budgetTokens: options.wakeBudgetTokens,
          })
        : undefined,
      // Queen and operator trigger words
      // execute memory recall/writes at the daemon and their labeled result
      // replaces the delivered body. repoRoot is read lazily because it is
      // assigned later in this constructor; writes ride the daemon's
      // serialized writeMemoryFact so the FTS index stays current.
      this.episodic !== null
        ? createMemoryTriggerExecutor({
            repoRoot: () => this.repoRoot,
            memory: this.memory,
            semantic: this.semanticRecall(),
            semanticStatus: this.semanticRecallState(),
            write: (input) => this.writeMemoryFact(input),
            episodic: this.episodic,
            log: (message) => this.writeDaemonLog(message),
          })
        : undefined,
      // Durable warning sink (defect D2): trigger and wake-delta failures
      // persist to the daemon log, not only the unread console.
      (line) => this.writeDaemonLog(line),
      // Submit-time foreground measurement: the run row's launch-time
      // identity goes stale the moment the vendor forks a child that takes
      // the terminal's foreground group, and a fence built from it refuses
      // every injection to a live agent.
      async (agent) => {
        const inspection = await this.terminalHost.inspect(
          requireSessiondAgentLocator(agent),
        );
        const foreground = inspection.foreground;
        if (
          foreground.state !== "unmanaged" &&
          foreground.state !== "managed"
        ) {
          return undefined;
        }
        return {
          pid: foreground.pid,
          startToken: foreground.startToken,
          processGroupId: foreground.foregroundProcessGroupId,
        };
      },
    );
    this.quota?.setAlertSink(async (body) => {
      await this.delivery.send("hive-quota", ORCHESTRATOR_NAME, body);
    });
    this.land = options.landBranch ?? landBranch;
    this.landReadiness = options.readLandReadiness ?? readLandReadiness;
    this.resources = options.resources ?? null;
    this.lifecycleConfig = options.lifecycle ?? null;
    this.retentionConfig = options.retention ?? null;
    this.wakeBudgetTokens = options.wakeBudgetTokens ?? null;
    this.psSample = options.resourceRunners?.ps ?? runPs;
    this.vmStatSample = options.resourceRunners?.vmStat ?? runVmStat;
    this.killProcess =
      options.resourceRunners?.kill ?? ((pid) => process.kill(pid, "SIGKILL"));
    this.reapDependencies =
      options.resourceRunners?.reap ?? defaultReapDependencies();
    this.stopAgentProcesses = (agent, beforeKill) =>
      stopSessiondAgentSession(
        agent,
        {
          terminalHost: this.terminalHost,
          reap: this.reapDependencies,
          readHostPid: async (record) =>
            (
              await this.terminalHost.inspect(
                requireSessiondAgentLocator(record),
              )
            ).hostPid,
        },
        beforeKill,
      );
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.readClaudeTelemetry =
      options.telemetryReaders?.claude ?? readClaudeTelemetry;
    this.readCodexTelemetry =
      options.telemetryReaders?.codex ?? readCodexTelemetry;
    this.readGrokTelemetry =
      options.telemetryReaders?.grok ??
      ((worktreePath, toolSessionId) =>
        readGrokTelemetry(worktreePath, toolSessionId));
    this.readLiveModel =
      options.telemetryReaders?.liveModel ??
      ((worktreePath, toolSessionId) =>
        readLiveClaudeModel(worktreePath, toolSessionId));
    this.readGrokLiveModel =
      options.telemetryReaders?.grokLiveModel ??
      ((worktreePath, toolSessionId) =>
        toolSessionId === undefined
          ? Promise.resolve(null)
          : readLiveGrokModel(worktreePath, toolSessionId));
    this.handshake = () => expectedDaemonHandshake(this.repoRoot);
    this.cleanupWorktree = options.removeWorktree ?? removeWorktree;
    this.assessStranded = options.assessStrandedWork ?? assessStrandedWork;
    this.listUnmergedBranches =
      options.listUnmergedHiveBranches ?? listUnmergedHiveBranches;
    this.reconcileWorktrees =
      options.reconcileOrphanedWorktrees ?? reconcileWorktrees;
    this.liveInstanceIds =
      options.liveInstanceIds ??
      (async () =>
        new Set(
          (await listInstances())
            .filter((instance) => instance.running)
            .map((instance) => instance.instanceId),
        ));
    const autonomy = options.autonomy;
    this.drainHandler = new DrainHandler({
      db: this.db,
      quota: this.quota,
      send: (from, to, body, sendOptions) =>
        this.delivery.send(from, to, body, sendOptions),
      pauseProvider: (agent, run) =>
        this.terminalHost.pauseProvider(
          requireSessiondAgentLocator(agent),
          run,
        ),
      resumeProvider: (agent, run) =>
        this.terminalHost.resumeProvider(
          requireSessiondAgentLocator(agent),
          run,
        ),
      requestReplacement: async (agent, drain) => {
        await this.replaceWithHandoff(agent, drain);
      },
      ...(this.episodic === null
        ? {}
        : {
            remember: (event) => this.episodic!.appendEvent(event),
          }),
    });
    this.recovery = new CrashRecovery({
      db: this.db,
      terminalHost: this.terminalHost,
      port: () => this.listeningPort ?? this.port,
      // A resume whose Hive MCP never answers is refused, not recorded.
      mcpClientSeen: (subject, since) => this.mcpClientSeen(subject, since),
      revokeCapabilities: (agentName) => {
        this.capabilities.revokeSubject(agentName);
        removeCredential(agentName);
      },
      stopSession: (agent) =>
        this.stopAgentProcesses(agent, () => {
          this.capabilities.revokeSubject(agent.name);
          removeCredential(agent.name);
        }),
      // Called on the spawner, never as a detached reference: the method body
      // uses `this`, and a hoisted `const fn = this.spawner.method` type-checks
      // while silently losing the receiver. Presence is still probed on the spawner, so an
      // implementation that does not offer the method stays absent here.
      ...(this.spawner.createRecoverySession === undefined
        ? {}
        : {
            createRecoverySession: async (
              agent,
              command,
              expectedExecutable,
              launchGrantId,
              providerRunId,
            ) => {
              await this.spawner.createRecoverySession?.(
                agent,
                command,
                expectedExecutable,
                launchGrantId,
                providerRunId,
              );
            },
          }),
      send: (from, to, body, sendOptions) =>
        this.delivery.send(from, to, body, sendOptions),
      settleQuota: (agent) => this.settleAgentQuota(agent),
      authorizeLaunch: async (identity) =>
        (await this.spawner.authorizeLaunch?.(identity)) ?? null,
      flushQueued: (agentName) => this.delivery.flushQueued(agentName),
      // A thunk, not a value: a resume launched after the user flips the
      // Agents-menu dial must match the setting the user can see, not the one
      // the daemon booted with.
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
      ...(options.recovery?.claudeExecutable === undefined
        ? {}
        : { claudeExecutable: options.recovery.claudeExecutable }),
      ...(options.recovery?.codexExecutable === undefined
        ? {}
        : { codexExecutable: options.recovery.codexExecutable }),
      ...(options.recovery?.grokExecutable === undefined
        ? {}
        : { grokExecutable: options.recovery.grokExecutable }),
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
      this.issueCredential(
        ORCHESTRATOR_NAME,
        "orchestrator",
        0,
        OPERATOR_TTL_MS,
      );
    }
  }

  private async replaceWithHandoff(
    agent: AgentRecord,
    drain: ReplacementDrain,
  ): Promise<void> {
    const runs = this.db.listProviderRunsForAgent(agent.id);
    const run = runs.at(-1);
    if (run === undefined) {
      throw new Error(
        `Cannot hand off ${agent.name}: no provider run is recorded; terminal and worktree remain retained`,
      );
    }
    const existing = this.db.getHandoffForSourceRun(run.runId);
    if (existing !== null) return;

    // Fence the source epoch before asking the terminal to pause. This is the
    // durable write boundary; process control then targets the exact old run.
    const fenced =
      this.db.revokeAgentCapabilities(agent.name, new Date().toISOString()) ??
      agent;
    this.capabilities.revokeSubject(agent.name);
    removeCredential(agent.name);
    const locator = requireSessiondAgentLocator(agent);
    const paused =
      run.state === "running"
        ? await this.terminalHost.pauseProvider(locator, run)
        : false;

    const inspection = await this.terminalHost
      .inspect(locator)
      .catch(() => null);
    const output =
      this.observeTerminalOutput === null || inspection === null
        ? null
        : await this.observeTerminalOutput(locator, inspection.geometry).catch(
            () => null,
          );
    const measurement =
      agent.worktreePath === null || agent.branch === null
        ? null
        : await measureHandoffWorktree(
            this.repoRoot,
            agent.worktreePath,
            agent.branch,
          ).catch(() => null);
    const bundle = await buildHandoffBundle({
      handoffId: crypto.randomUUID(),
      reason: "quota-drain",
      agent: fenced,
      run,
      measurement,
      messages: this.db.listMessages(),
      providerEvents: this.db.listProviderEvents(run.runId),
      statusEvents: this.status.listEventsForAgent(agent.id),
      output,
      memory: await listMemoryFacts(this.repoRoot).catch(() => []),
      createdAt: new Date().toISOString(),
    });
    this.db.insertHandoff(bundle);

    // Persistence is the boundary: failure from here onward cannot erase the
    // task, worktree measurements, or evidence needed by another provider.
    if (paused) await this.terminalHost.stopProvider(locator, run);
    // TODO(router): launch automatically only after quota lifecycle can enforce
    // this measured provider/pool exclusion through the replacement decision.
    await this.delivery.send(
      "hive-handoff",
      ORCHESTRATOR_NAME,
      `${agent.name}'s quota handoff ${bundle.handoffId} is durable; the source terminal and worktree remain retained. ` +
        `Automatic replacement is deferred until quota routing can exclude the proven drained ${
          drain.pool === null
            ? `${drain.provider} route`
            : `${drain.provider}/${drain.pool} pool`
        }${drain.resetsAt === null ? "" : ` until ${drain.resetsAt}`}. ${drain.reason}`,
      {
        idempotencyKey: `handoff-awaiting-route:${bundle.handoffId}`,
      },
    );
  }

  private async agentSessionPresent(agent: AgentRecord): Promise<boolean> {
    const locator = requireSessiondAgentLocator(agent);
    const activeRun = this.terminalHost.reconcileProviderRun(locator);
    const inspection = await this.terminalHost.inspect(locator);
    return (
      inspection.presence === "present" &&
      !sessiondAgentProviderRunIsDead(inspection, activeRun)
    );
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
    allowReason: string | null = null,
  ): Decision {
    return this.capabilities.authorizeAndAudit(
      capability,
      { route, action, ...(subject === undefined ? {} : { subject }) },
      auditAllow,
      allowReason,
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

  get sessiondTerminalHost(): Pick<
    HiveTerminalHostAdapter,
    "create" | "inspect" | "terminate"
  > {
    return this.terminalHost;
  }

  /** Has this subject's credential authenticated against /mcp at or
   * after `since`? The spawn/resume reachability check reads exactly this —
   * the agent's own reporting channel, proven on the receiving side. */
  mcpClientSeen(subject: string, since: string): boolean {
    const seen = this.mcpClientsSeen.get(subject);
    return seen !== undefined && seen >= since;
  }

  prepareSessiondSpawn(): Promise<Readonly<{ engineBuildId: string }> | null> {
    return this.workspaceVisibility?.prepare() ?? Promise.resolve(null);
  }

  prepareAgentSessiondSpawn(): Promise<WorkspaceVisibilityAdmission | null> {
    return (
      this.workspaceVisibility?.prepareAgentCreation() ?? Promise.resolve(null)
    );
  }

  admitSessiondSpawn(
    candidate: WorkspaceVisibilityCandidate,
  ): Promise<WorkspaceVisibilityAdmission | null> {
    return this.workspaceVisibility?.admit(candidate) ?? Promise.resolve(null);
  }

  start(): Server<undefined> {
    if (this.bunServer !== null) {
      return this.bunServer;
    }
    this.bunServer = Bun.serve({
      port: this.port,
      hostname: this.hostname,
      // Fleet shutdown verifies each captured process tree in sequence. The
      // default 10-second request timeout can sever a healthy /stop before
      // that verification finishes, even though teardown continues server-side.
      idleTimeout: 60,
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
    // process. Clear startup rows so crash recovery does not treat their agents
    // as forever in flight.
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
      void this.delivery.alertStuckDeliveries().catch((error) => {
        console.error(
          `Hive stuck-delivery check failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      void this.checkWakePaths().catch((error) => {
        console.error(
          `Hive wake-path self-check failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
    }, 30_000);
    this.reconciliationTimer.unref?.();
    this.workspaceOwnerTimer = setInterval(() => {
      this.checkWorkspaceOwnerAlive();
    }, WORKSPACE_OWNER_WATCH_MS);
    this.workspaceOwnerTimer.unref?.();
    if (this.manageLifecycle && this.workspaceVisibility !== null) {
      this.ownerRegistrationTimer = setTimeout(() => {
        this.ownerRegistrationTimer = null;
        if (
          !this.workspaceVisibility?.ownerRegistered() &&
          !this.stopInProgress
        ) {
          this.stopInProgress = true;
          this.initiateShutdown();
        }
      }, WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS);
    }
    // Memory retention uses a periodic timer on
    // sweep_interval_hours, plus one sweep at start so a daemon that was down
    // past its cadence does not wait a full interval to age anything out.
    // Log the effective config every start so retention policy changes are loud.
    if (this.retentionConfig !== null && this.episodic !== null) {
      const retention = this.retentionConfig;
      const line =
        `Hive memory retention: events hot for ${retention.events_hot_days}d, ` +
        `verified articles demote to stale after ${retention.stale_after_days}d, ` +
        `sweep every ${retention.sweep_interval_hours}h; ` +
        "facts and digests are kept forever (invariant, not a setting)";
      console.log(line);
      this.writeDaemonLog(line);
      this.retentionTimer = setInterval(() => {
        this.triggerMemoryRetentionSweep("periodic");
      }, retention.sweep_interval_hours * 3_600_000);
      this.retentionTimer.unref?.();
      this.triggerMemoryRetentionSweep("startup");
    }
    // Log the effective wake-delta budget every start so changes are loud, the
    // same posture as the retention config.
    if (this.wakeBudgetTokens !== null && this.episodic !== null) {
      const line =
        `Hive memory wake deltas: ${this.wakeBudgetTokens}-token budget, ` +
        "injected over the send lane on message delivery and resume " +
        "([memory] wake_budget_tokens)";
      console.log(line);
      this.writeDaemonLog(line);
    }
    // Log the effective semantic-recall provider and model every start, matching the
    // other memory config. The model itself loads lazily on first embed; an
    // already-known unavailable state (the api knob) is reported here, a
    // load failure is reported when it happens.
    if (this.embeddingService !== null) {
      const status = this.embeddingService.status();
      const line =
        status.state === "unavailable"
          ? `Hive memory embeddings: UNAVAILABLE — ${status.detail}`
          : `Hive memory embeddings: provider=${this.embeddingService.provider} ` +
            `model=${this.embeddingService.model} (loads lazily on first use; ` +
            "[memory] embedding_provider / embedding_model)";
      console.log(line);
      this.writeDaemonLog(line);
    }
    void this.runMaintenance().catch((error) => {
      console.error(
        `Hive startup recovery failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    void this.checkWakePaths().catch((error) => {
      console.error(
        `Hive wake-path self-check failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    // Every daemon start reads the providers' real limits before the first spawn
    // can reserve against a number nobody measured. A provider that will not
    // answer leaves its pool honestly unknown rather than blocking startup.
    this.quotaBootRefresh = this.refreshQuota({ force: true }).catch(
      (error) => {
        console.error(
          `Hive quota discovery failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
    );
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

  // Memory writes, deletes, and reindexes share one promise chain so concurrent
  // MCP calls never race on slug generation or interleave a rebuild with an
  // in-flight upsert.
  private serializeMemory<T>(operation: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      const directory = join(this.repoRoot, ".hive");
      await mkdir(directory, { recursive: true });
      return withFileLock(join(directory, "memory.lock"), operation);
    };
    const run = this.memoryLock.then(locked, locked);
    this.memoryLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The semantic leg of the recall bundle. When unwired,
   * buildMemoryRecallBundle renders
   * byte-identical FTS-only output. */
  private semanticRecall():
    | ((
        query: string,
        limit: number,
      ) => Promise<Array<{
        scope: string;
        id: string;
        score: number;
      }> | null>)
    | undefined {
    const index = this.embeddingIndex;
    if (index === null) return undefined;
    return (query, limit) => index.searchArticles(query, limit);
  }

  /** The semantic leg's one-word state for the recall envelope's degraded
   * label (defect D2); undefined when the leg is unwired. */
  private semanticRecallState(): (() => string) | undefined {
    const service = this.embeddingService;
    if (service === null) return undefined;
    return () => service.stateLabel();
  }

  /** The memory.embeddings status section (defect D2): provider, model, the
   * one-word state, vector-row counts, and the runtime dir in use — an
   * operator sees degradation here without reading code or logs. */
  private memoryEmbeddingsStatusSection() {
    const service = this.embeddingService;
    if (service === null) {
      return {
        state: "disabled",
        detail:
          "semantic leg is not wired on this daemon (no episodic store or " +
          "no [memory] embedding config)",
      };
    }
    const status = service.status();
    const counts = this.episodic?.memoryEmbeddingCounts() ?? {
      articles: 0,
      facts: 0,
    };
    return {
      provider: service.provider,
      model: service.model,
      state: service.stateLabel(),
      ...(status.state === "unavailable" ? { detail: status.detail } : {}),
      runtimeDir: embeddingsRuntimeDir(),
      vectors: {
        articles: counts.articles,
        facts: counts.facts,
        total: counts.articles + counts.facts,
      },
    };
  }

  async writeMemoryFact(input: MemoryWriteInput) {
    return this.serializeMemory(async () => {
      const written = await writeMemoryFactFile(this.repoRoot, input);
      for (const id of written.supersededIds) {
        this.memory.removeFact(input.scope, id);
        this.embeddingIndex?.removeArticle(input.scope, id);
      }
      this.memory.upsertFact(written);
      // Index maintenance for the semantic leg (HM-5): failure-isolated
      // inside the index — the write above is the truth, the vector is a
      // projection. The outcome rides the response (defect D2) so a caller
      // can SEE when its write is keyword-searchable only.
      const embedding: MemoryEmbeddingWriteOutcome =
        this.embeddingIndex === null
          ? "unavailable:disabled"
          : await this.embeddingIndex.upsertArticle(
              written.scope,
              written.id,
              MemoryEmbeddingIndex.articleText(written),
            );
      return { ...written, embedding };
    });
  }

  async deleteMemoryFact(scope: MemoryScope, id: string): Promise<boolean> {
    return this.serializeMemory(async () => {
      const deleted = await deleteMemoryFactFile(this.repoRoot, scope, id);
      if (deleted) {
        this.memory.removeFact(scope, id);
        this.embeddingIndex?.removeArticle(scope, id);
      }
      return deleted;
    });
  }

  async rebuildMemoryIndex() {
    return this.serializeMemory(async () => {
      const result = await this.memory.rebuild(this.repoRoot);
      if (this.embeddingIndex !== null && this.episodic !== null) {
        // Stale-row maintenance (HM-5): vector rows are a projection, so any
        // whose source disappeared — a deleted article, an invalidated or
        // expired fact (only currently-believed facts stay indexed) — is
        // pruned here, on the same rebuild boundary the FTS index uses.
        const facts = await listMemoryFacts(this.repoRoot);
        this.embeddingIndex.prune({
          articles: new Set(facts.map((fact) => `${fact.scope}:${fact.id}`)),
          facts: new Set(this.episodic.currentFacts().map((fact) => fact.id)),
        });
      }
      return result;
    });
  }

  /**
   * Re-read live provider limits. Reservations then reconcile against the real
   * numbers on the next status read, because an observation and the local ledger
   * combine by max() — a fresh provider reading tightens the picture, and a
   * missing one never loosens it.
   */
  async refreshQuota(
    options: {
      force?: boolean;
      providers?: readonly CapabilityProvider[];
    } = {},
  ): Promise<void> {
    if (this.quota === undefined) return;
    await this.quota.refreshFromProviders(undefined, options);
  }

  /**
   * The boot refresh is a gate, not a background task. The first spawn
   * awaits this before it routes — one settled promise, no retry framework.
   */
  async quotaReady(): Promise<void> {
    await this.quotaBootRefresh;
  }

  /** Vendor rate-limit failures route to the drain handler, never the
   * launch-failure quarantine. */
  async onVendorDrainError(agent: AgentRecord, failure: string): Promise<void> {
    await this.drainHandler.onVendorError(agent, failure);
  }

  private quotaBootRefresh: Promise<void> = Promise.resolve();

  /**
   * The daemon's one recurring sweep: every 30s, and once at startup.
   *
   * Public so tests drive the same reconciliation path as the recurring timer.
   */
  /**
   * Self-check of the two wake paths, on daemon start and on every tick.
   *
   * Check before delivery so a launcher/daemon endpoint mismatch or unreachable
   * agent session is visible instead of leaving its diagnostic on discarded stderr.
   *
   * Faults alert once through the same hive-control → queen wire as the
   * stuck-delivery check, and re-arm when the fault clears, so a persistent
   * fault is one message rather than one every thirty seconds.
   */
  async checkWakePaths(): Promise<readonly string[]> {
    return checkWakePathsSweep({
      alertedWakeFaults: this.alertedWakeFaults,
      db: this.db,
      delivery: this.delivery,
      orchestratorSessiond: this.orchestratorSessiond,
      terminalHost: this.terminalHost,
      hasCompletedSessiondBinding: (agent) =>
        this.hasCompletedSessiondBinding(agent),
    });
  }

  private hasCompletedSessiondBinding(agent: AgentRecord): boolean {
    return (
      this.db.getTerminalHostBindingByLocator(
        requireSessiondAgentLocator(agent),
      )?.createEvidence !== undefined
    );
  }

  private async agentProcessState(
    agent: AgentRecord,
  ): Promise<PaneProcessState | "unknown"> {
    try {
      const locator = requireSessiondAgentLocator(agent);
      const activeRun = this.terminalHost.reconcileProviderRun(locator);
      const inspection = await this.terminalHost.inspect(locator);
      if (sessiondAgentProviderRunIsDead(inspection, activeRun)) return "gone";
      const shellPid = inspection.shellRoot?.pid;
      if (shellPid === null || shellPid === undefined) return "unknown";
      return foregroundJobState(
        parseForegroundProcessTable(await runPsForeground()),
        shellPid,
      );
    } catch {
      return "unknown";
    }
  }

  private async rootProviderAcceptsInput(): Promise<boolean> {
    const current = this.orchestratorSessiond?.snapshot() ?? null;
    if (
      current?.state !== "running" ||
      !this.orchestratorSessiond?.isInputReady()
    ) {
      return false;
    }
    try {
      const inspection = await this.terminalHost.inspect(
        requireSessiondRootLocator(current.locator),
      );
      const shellPid = inspection.shellRoot?.pid;
      if (shellPid === null || shellPid === undefined) return false;
      return (
        foregroundJobState(
          parseForegroundProcessTable(await runPsForeground()),
          shellPid,
        ) === "running"
      );
    } catch {
      return false;
    }
  }

  private statusLiveness(
    agent: AgentRecord,
    sessions: Awaited<ReturnType<HiveTerminalHostAdapter["list"]>> | null,
  ): AgentRecord {
    if (
      agent.status !== "working" ||
      !this.hasCompletedSessiondBinding(agent)
    ) {
      return agent;
    }
    if (sessions === null) return agent;
    const inspection = sessions.find(
      (candidate) =>
        candidate.locator.sessionId === agent.sessionLocator?.sessionId,
    );
    if (
      inspection !== undefined &&
      !sessiondAgentProviderRunIsDead(
        inspection,
        this.db.getActiveProviderRunByTerminal(
          requireSessiondAgentLocator(agent),
        ),
      )
    ) {
      return agent;
    }
    return {
      ...agent,
      status: "stuck",
      failureReason:
        inspection === undefined
          ? "sessiond measured the vendor session absent; run hive_recover to resume it"
          : "sessiond measured the vendor process as dead; run hive_recover to resume it",
    };
  }

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
      // Poke held agents past their reset, then handle newly drained
      // running agents. Runs on the existing sweep — no new timers.
      await this.drainHandler.sweep().catch((error) => {
        console.error(
          `Hive quota drain sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await this.delivery.recoverCriticalControls();
      // Root wakes deferred behind a human draft are retried only at this
      // bounded daemon boundary. The row remains queued until the terminal confirms
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
      await this.reconcileAgents().catch((error) => {
        console.error(
          `Hive agent reconciliation failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
      await this.sweepStrandedWorktrees().catch((error) => {
        console.error(
          `Hive stranded-worktree sweep failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
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
      // An idle agent makes no tool calls and reaches no turn boundaries. The
      // daemon knows the agent is idle and a message is waiting, so it wakes it
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
      // Like idle reap, repository cleanup is off for embedded daemons that
      // were not given lifecycle policy. Production always receives the
      // schema-default lifecycle config.
      if (this.lifecycleConfig !== null) {
        await this.reconcileOrphanedWorktrees().catch((error) => {
          console.error(
            `Hive worktree reconciliation failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        });
      }
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
   *   Do not file a no-op re-arm for an empty `main..branch` range.
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
    const readiness = await this.landReadiness(this.repoRoot, branch).catch(
      () => ({ pending: null, rebased: null }),
    );
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
    const alreadyPending = this.db
      .listApprovals("pending")
      .some(
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
   * durable files: Claude transcripts and Codex rollouts.
   * Hook traffic carries neither, so this sweep is what keeps the status
   * table's context column true. For a Codex TUI agent the rollout mtime is
   * also the only mid-turn liveness signal — a fresh rollout promotes a
   * stuck "spawning" row to working.
   */
  async refreshToolTelemetry(): Promise<void> {
    return refreshToolTelemetrySweep({
      db: this.db,
      graphify: this.graphify,
      graphifyCalls: this.graphifyCalls,
      readClaudeTelemetry: this.readClaudeTelemetry,
      readCodexTelemetry: this.readCodexTelemetry,
      readGrokTelemetry: this.readGrokTelemetry,
      readLiveModel: this.readLiveModel,
      readGrokLiveModel: this.readGrokLiveModel,
    });
  }

  /**
   * The memory watchdog hard-kills any process
   * under a Hive-owned terminal session that exceeds the per-process ceiling,
   * pause spawning while the system is low on reclaimable memory. Every action
   * lands as a durable orchestrator message, so degradation is visible.
   */
  async sweepResources(): Promise<void> {
    return sweepResourcesCycle({
      db: this.db,
      delivery: this.delivery,
      orchestratorSessiond: this.orchestratorSessiond,
      terminalHost: this.terminalHost,
      resources: this.resources,
      psSample: this.psSample,
      vmStatSample: this.vmStatSample,
      killProcess: this.killProcess,
      reapDependencies: this.reapDependencies,
      setMemoryPressure: (value) => {
        this.memoryPressure = value;
      },
    });
  }

  async recoverQuotaReservations(): Promise<number> {
    if (this.quota === undefined) return 0;
    const expired = await this.quota.listExpiredReservations();
    for (const reservation of expired) {
      if (reservation.purpose === "control") {
        const agent = this.db.getAgentByName(reservation.agentName);
        if (agent?.controlQuotaReservationId === reservation.id) {
          const teardown = await this.killAgentTeardown(agent, {
            failureReason: `Critical control acknowledgement process timed out (reservation ${reservation.id})`,
          });
          const processOutcome =
            teardown.reaped.survivors.length === 0
              ? "all captured processes were stopped"
              : `${teardown.reaped.survivors.length} captured process(es) survived SIGKILL and remain running`;
          await this.delivery
            .send(
              "hive-control",
              ORCHESTRATOR_NAME,
              `Critical control acknowledgement process for ${agent.name} timed out. ` +
                `Reservation ${reservation.id} settled conservatively; ${processOutcome}, ` +
                "write and landing capability remain revoked, and the worktree is preserved.",
              { idempotencyKey: `control-quota-timeout:${reservation.id}` },
            )
            .catch(logAlertDeliveryFailure);
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
   * live booking correctly. A stale pointer otherwise leaves capacity reserved
   * until the six-hour TTL and can refuse a valid spawn.
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
      const dead =
        agent.status === "dead" ||
        agent.status === "done" ||
        agent.status === "failed";
      if (!dead) continue;
      await this.quota.cancel(reservation.id);
    }
  }

  private async settleAgentQuota(
    agent: AgentRecord,
    at?: string,
  ): Promise<void> {
    const held = this.quota?.ledger.getActiveReservationForAgent(agent.name);
    if (held !== null && held !== undefined)
      await this.quota?.cancel(held.id, at);
  }

  /**
   * The one teardown path for closing a live agent. `hive_kill`, the pane X
   * (POST /agents/:name/kill), the idle-reap sweep, and daemon shutdown all
   * funnel through here, so there is exactly one place that can kill an agent,
   * exactly one guard protecting a worktree, and one policy for unlanded work.
   *
   * The sequence is fixed by what each step destroys:
   *
   *   1. terminate the terminal session and capture survivors
   *   2. SIGKILL and verify any surviving vendor or MCP processes
   *   3. mark dead, settle quota
   *   4. assess unlanded work, and preserve it as a ref if there is any —
   *      before step 7 can remove the worktree it lives in
   *   5. tell the orchestrator what was preserved, and what would not die
   *   6. remove the worktree only when asked, and never over stranded work
   *
   * Killing is immediate and unconditional — no confirmation, no delay. That
   * is a UX decision, and it is explicitly NOT permission to destroy: work
   * that is not on main is preserved as a git ref and reported. Removal of the
   * worktree still refuses to delete stranded work unless the caller passes
   * discardWork.
   */
  /** Can this agent's process tree be positively read as gone? Fail closed:
   * an unreachable host or broker proves nothing. */
  private async agentTreeAbsent(agent: AgentRecord): Promise<boolean> {
    try {
      const inspection = await this.terminalHost.inspect(
        requireSessiondAgentLocator(agent),
      );
      return sessiondTerminalIsDead(inspection);
    } catch {
      return false;
    }
  }

  /** A sessiond host binding is written before the host is created. Its absence
   * therefore proves this generation never acquired a process tree; unlike an
   * unreachable bound host, it is safe to clean the failed spawn row. */
  private hasNeverBoundSessiondGeneration(agent: AgentRecord): boolean {
    const locator = requireSessiondAgentLocator(agent);
    return this.db.getTerminalHostBindingByLocator(locator) === null;
  }

  /**
   * Re-asks git about each stranded worktree, and releases the ones that are
   * no longer stranded.
   *
   * A worktree recorded when its agent died is not a permanent verdict: work
   * gets merged, or cherry-picked onto main afterwards, and the answer changes
   * without anyone touching the row. Nobody is left to ask — the agent is gone
   * — so the daemon asks for itself. This is what keeps the digest short
   * enough that the queen still reads it: a list whose steady state is
   * non-empty is one she correctly learns to ignore.
   *
   * Removal happens only when git says there is nothing left, so this can
   * delete a worktree but never work.
   */
  async sweepStrandedWorktrees(): Promise<number> {
    const entries = this.db.listStrandedWorktrees();
    if (entries.length === 0) return 0;
    // Resolved once for the sweep, not once per worktree. A repo that cannot
    // answer falls back to the assessment's own default rather than failing
    // the sweep, since being unable to name the branch is not evidence about
    // anyone's work.
    const mainBranch = await resolveLandingTargetBranch(this.repoRoot).catch(
      () => undefined,
    );
    let released = 0;
    for (const entry of entries) {
      let work: { dirtyFiles: readonly string[]; unmergedCommits: number };
      try {
        work = await this.assessStranded(
          this.repoRoot,
          entry.worktreePath,
          entry.branch,
          mainBranch,
        );
      } catch {
        // A worktree git cannot answer for stays recorded. Unreadable is not
        // empty, and this is the one place that would act on the difference.
        continue;
      }
      if (work.dirtyFiles.length > 0 || work.unmergedCommits > 0) {
        this.db.recordStrandedWorktree({
          branch: entry.branch,
          agentName: entry.agentName,
          worktreePath: entry.worktreePath,
          unmergedCommits: work.unmergedCommits,
          dirtyFileCount: work.dirtyFiles.length,
        });
        continue;
      }
      // Nothing to lose: git has just reported no dirty files and no commit
      // whose change is missing from the main branch. The branch itself is
      // left alone — deleting a ref is a separate decision, and the worktree
      // directory is what actually accumulates.
      try {
        await this.cleanupWorktree(this.repoRoot, entry.worktreePath, {
          deleteBranch: false,
        });
      } catch (error) {
        // A worktree that cannot be removed stays recorded rather than being
        // quietly forgotten, or it becomes a directory nothing tracks.
        console.error(
          `Hive could not remove ${entry.agentName}'s settled worktree ${entry.worktreePath}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
        continue;
      }
      this.db.clearStrandedWorktree(entry.branch);
      released += 1;
      this.writeDaemonLog(
        `Hive removed ${entry.agentName}'s worktree ${entry.branch}: its work is on the main branch. The name is available again.`,
      );
    }
    return released;
  }

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
      sessionId: string;
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
    // Register deliberate-kill intent BEFORE the first destructive step. While
    // the process is dead but markAgentDead has not landed, the row matches the
    // recovery sweep's crash predicate. The marker is cleared only after dead status is
    // durable; a teardown that fails in between leaves it set, because a
    // deliberately killed agent must never be resurrected by the sweep.
    this.recovery.noteDeliberateKill(agent.id);
    let reaped: ReapOutcome;
    const revoke = () => {
      this.capabilities.revokeSubject(agent.name);
      removeCredential(agent.name);
    };
    if (this.hasNeverBoundSessiondGeneration(agent)) {
      revoke();
      reaped = { killed: [], survivors: [] };
    } else {
      try {
        reaped = await this.stopAgentProcesses(agent, revoke);
      } catch (error) {
        // If teardown throws after the processes are gone, the agent is dead;
        // record that and finish the
        // teardown. A tree whose absence cannot be proved keeps the failure:
        // unreachable is not dead.
        if (!(await this.agentTreeAbsent(agent))) throw error;
        revoke();
        reaped = { killed: [], survivors: [] };
      }
    }
    const timestamp = options.at ?? new Date().toISOString();
    const killed = this.db.markAgentDead(
      agent.id,
      timestamp,
      options.failureReason,
    );
    if (killed === null) {
      throw new Error(`Hive agent not found: ${agent.name}`);
    }
    this.recovery.clearDeliberateKill(agent.id);
    const closedAssignment = this.status.closeAssignment(agent.id, timestamp);
    await this.settleAgentQuota(killed, timestamp);
    // An agent's last spend lands on the provider's counter only when it
    // closes, so a close is a refresh trigger for that provider.
    void this.refreshQuota({ force: true, providers: [agent.tool] }).catch(
      (error) => {
        console.error(
          `Hive quota refresh after ${agent.name} closed failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
    );
    let updated = killed;
    const cleaned: {
      sessionId: string;
      worktreePath: string | null;
      branch: string | null;
    } = {
      sessionId: requireSessiondAgentLocator(agent).sessionId,
      worktreePath: null,
      branch: null,
    };

    let stranded: {
      branch: string | null;
      worktreePath: string | null;
      dirtyFiles: string[];
      unmergedCommits: number;
      note: string;
    } | null = null;
    let preserved: { branch: string; ref: string } | null = null;
    let targetBranch = "main";
    if (agent.worktreePath !== null || agent.branch !== null) {
      try {
        targetBranch = await resolveLandingTargetBranch(this.repoRoot);
        const work = await this.assessStranded(
          this.repoRoot,
          agent.worktreePath,
          agent.branch,
          targetBranch,
        );
        if (work.dirtyFiles.length > 0 || work.unmergedCommits > 0) {
          stranded = {
            branch: agent.branch,
            worktreePath: agent.worktreePath,
            dirtyFiles: work.dirtyFiles,
            unmergedCommits: work.unmergedCommits,
            note: `${agent.name} left work that is not on ${targetBranch}; merge it via an integrator agent or pass discardWork to delete it.`,
          };
          // The row holds the name until the work is accounted for, and is the
          // only durable record that this worktree exists — without it every
          // stranded worktree needs a fresh investigation to identify.
          if (agent.branch !== null && agent.worktreePath !== null) {
            this.db.recordStrandedWorktree({
              branch: agent.branch,
              agentName: agent.name,
              worktreePath: agent.worktreePath,
              unmergedCommits: work.unmergedCommits,
              dirtyFileCount: work.dirtyFiles.length,
              at: timestamp,
            });
          }
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
      (options.removeWorktree ?? false) &&
      agent.worktreePath !== null &&
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
          note:
            `${agent.name} left work that is not on ${targetBranch}; it was DELETED ` +
            "as requested (discardWork)" +
            (agent.branch !== null
              ? `: branch ${agent.branch} and its preservation ref are gone.`
              : "."),
        };
      }
      cleaned.worktreePath = agent.worktreePath;
      cleaned.branch = agent.branch;
      updated = this.db.upsertAgent({
        ...updated,
        worktreePath: null,
        branch: null,
      });
    }

    // Reported last, so it reports what happened: a discard deletes the branch
    // and its ref, and telling the orchestrator "Nothing was deleted" over the
    // top of that is how a kill that obeyed reads as a kill that refused.
    await this.reportKill(agent, reaped, preserved, stranded, targetBranch);

    // A session end is a digest activity boundary;
    // S3.7 DoD 1-2): re-synthesize the agent's session digest from the typed
    // record BEFORE the retention sweep runs, so the digest's provenance
    // pins its drill-down events against the hot-tier cutoff. Failure-isolated
    // like the sweep — a compile failure must never add failure modes to a
    // kill.
    this.compileSessionDigest(
      agent.id,
      closedAssignment?.assignmentId ?? null,
      "agent session end",
    );
    // The mistake harvest rides the same boundary, strictly after the digest
    // compile: failure clusters become unverified
    // pitfall candidates citing the digest's provenance.
    this.harvestSessionPitfalls(
      agent.id,
      closedAssignment?.assignmentId ?? null,
      "agent session end",
    );

    // A session end is a retention lifecycle boundary (S3.7 DoD 5): the sweep
    // rides it. Fire-and-forget — retention is maintenance and must never add
    // failure modes to a kill.
    this.triggerMemoryRetentionSweep("agent session end");

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
    targetBranch: string,
  ): Promise<void> {
    if (preserved !== null && stranded !== null) {
      await this.delivery
        .send(
          "hive-lifecycle",
          ORCHESTRATOR_NAME,
          `${agent.name} was killed with work that is not on ${targetBranch}. ` +
            `Its branch ${preserved.branch} is PRESERVED at ${preserved.ref} ` +
            `(${stranded.unmergedCommits} unmerged commit(s), ` +
            `${stranded.dirtyFiles.length} uncommitted file(s)). ` +
            "Nothing was deleted. Land it with an integrator agent, or discard it " +
            "explicitly with hive_kill discardWork.",
          { idempotencyKey: `kill-preserved:${agent.id}` },
        )
        .catch(() => undefined);
    }
    if (reaped.survivors.length > 0) {
      await this.delivery
        .send(
          "hive-lifecycle",
          ORCHESTRATOR_NAME,
          `${agent.name} was killed but ${reaped.survivors.length} of its ` +
            "process(es) SURVIVED SIGKILL and are still running: " +
            reaped.survivors
              .map((process) => `pid ${process.pid} (${process.command})`)
              .join(", ") +
            ". These are orphans; they may still hold a model session open.",
          { idempotencyKey: `kill-survivors:${agent.id}` },
        )
        .catch(() => undefined);
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
        `Hive refused shutdown because agent teardown failed: ${failures.join(
          "; ",
        )}`,
      );
    }
  }

  /**
   * Project one published status event into the episodic store as a compact
   * typed row. Episodic memory is a derived projection of the primary record,
   * so a failure here logs and continues — it must never break the status
   * write that published the event.
   */
  private ingestEpisodicEvent(event: WorkspaceEventV2): void {
    if (this.episodic === null) return;
    try {
      const summary =
        typeof event.data.summary === "string"
          ? event.data.summary
          : event.kind;
      const agentId =
        event.entity.kind === "agent"
          ? event.entity.id
          : typeof event.data.agentId === "string"
            ? event.data.agentId
            : null;
      this.episodic.appendEvent({
        ts: event.occurredAt,
        agent: agentId,
        type: event.kind,
        summary: summary.slice(0, 500),
        provenance: {
          eventId: event.eventId,
          seq: event.seq,
          entity: event.entity,
          source: event.source,
        },
      });
      // A landing/completion event is a digest activity boundary (S3.7
      // DoD 2): re-synthesize the agent's rolling digest from the typed
      // record. Failure-isolated separately so a compile failure is never
      // reported as an ingest failure.
      if (agentId !== null && isDigestBoundaryEvent(event.kind, event.data)) {
        const sessionId =
          this.status.currentAssignment(agentId)?.assignmentId ?? null;
        this.compileSessionDigest(
          agentId,
          sessionId,
          `landing/completion event ${event.kind}`,
        );
        // The mistake harvest rides the same boundary, after the digest.
        this.harvestSessionPitfalls(
          agentId,
          sessionId,
          `landing/completion event ${event.kind}`,
        );
      }
    } catch (error) {
      console.error(
        `Hive episodic ingest failed for ${event.kind} (${event.eventId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Stopping the daemon stops the MACHINE, not just the process.
   *
   * Close every agent first, through the same kill path the pane X
   * uses, and only then take the daemon down. Agents are reaped before the
   * timers stop, because teardown needs delivery and quota to still be alive.
   */
  async stop(): Promise<void> {
    // A refusal is a report to the caller, not a reason to stay half-alive.
    // Release daemon resources either way, then rethrow so teardown failure is
    // still a failed quit.
    let refusal: unknown;
    this.orchestratorSessiond?.cancel("Hive daemon shutdown");
    if (this.manageLifecycle) {
      try {
        await this.killAllAgents();
        const root = this.orchestratorSessiond?.snapshot() ?? null;
        if (
          root !== null &&
          this.db.getTerminalHostBindingByLocator(root.locator)
            ?.createEvidence !== undefined
        ) {
          const terminated = await this.terminalHost.terminate(
            requireSessiondRootLocator(root.locator),
            {
              mode: "immediate",
              reason: "Hive daemon shutdown",
              requestId: mintSessionRequestId(),
            },
          );
          if (
            terminated.state !== "terminated" ||
            terminated.survivors.length > 0
          ) {
            throw new Error(
              `Hive refused shutdown because the queen termination is ${terminated.state} with ${terminated.survivors.length} survivor(s)`,
            );
          }
        }
      } catch (error) {
        refusal = error;
      }
    }
    // Broker dies after agents: terminate still needs a live socket. Heidi's
    // teardown already treats an unreachable broker as a dead session rather
    // than a refusal, so a race here cannot wedge shutdown.
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    if (this.workspaceOwnerTimer !== null) {
      clearInterval(this.workspaceOwnerTimer);
      this.workspaceOwnerTimer = null;
    }
    if (this.ownerRegistrationTimer !== null) {
      clearTimeout(this.ownerRegistrationTimer);
      this.ownerRegistrationTimer = null;
    }
    if (this.retentionTimer !== null) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    this.bunServer?.stop(true);
    this.bunServer = null;
    await this.graphify?.stop();
    if (this.manageLifecycle) {
      cleanupLifecycleFiles();
    }
    if (this.ownsDatabase) {
      this.db.close();
    }
    this.episodic?.close();
    this.ownedMachineMutations?.close();
    if (refusal !== undefined) throw refusal;
  }

  // Crash detection and recovery: any agent whose status claims a process
  // but whose terminal session is gone gets classified — resumable active work
  // is relaunched with the tool's native resume; everything else is marked
  // dead with its worktree preserved and the stranded state surfaced.
  async reconcileAgents(): Promise<RecoveryOutcome[]> {
    return this.recovery.sweep();
  }

  /**
   * The memory retention sweep is configured by `[memory.retention]` and stays
   * off when the daemon is not given a
   * retention config or an episodic store — embedded daemons in tests and
   * tooling must never age out memory state unasked). Aged hot-tier events
   * are deleted (digest-referenced rows survive), facts and digests are kept
   * forever by invariant, and verified wiki articles past `stale_after_days`
   * demote to stale. Runs on the periodic timer, once at start, and on every
   * agent session end (killAgentTeardown fires the trigger); overlapping runs
   * collapse onto the latch. Returns the report, or null when the sweep is
   * off or already running.
   */
  async runMemoryRetentionSweep(): Promise<RetentionSweepReport | null> {
    const config = this.retentionConfig;
    const episodic = this.episodic;
    if (config === null || episodic === null) return null;
    if (this.retentionRunning) return null;
    this.retentionRunning = true;
    try {
      // The demotion half writes article files, so the sweep takes the same
      // serialized memory write path as memory_write; a
      // retention pass must never interleave with an agent's write. The FTS
      // rebuild below re-enters the lock after this one releases, so it
      // cannot live inside.
      const report = await this.serializeMemory(() =>
        runRetentionSweep({
          episodic,
          repoRoot: this.repoRoot,
          config,
          now: new Date(),
        }),
      );
      if (
        report.eventsDeleted > 0 ||
        report.articlesDemoted.length > 0 ||
        report.consolidationCandidates > 0
      ) {
        const line =
          `Hive memory retention sweep: deleted ${report.eventsDeleted} ` +
          `aged event(s), demoted ${report.articlesDemoted.length} ` +
          "verified article(s) to stale, " +
          `${report.consolidationCandidates} consolidation candidate ` +
          "pair(s) in the vector store (hive memory consolidate to review)";
        console.log(line);
        this.writeDaemonLog(line);
      }
      if (report.articlesDemoted.length > 0) {
        // The FTS index is a disposable projection of the article files and
        // the demotions just rewrote files; reproject so a stale status is
        // visible to memory_search right away. A failure here is logged by
        // the caller's catch like any other sweep failure.
        await this.rebuildMemoryIndex();
      }
      return report;
    } finally {
      this.retentionRunning = false;
    }
  }

  /** Fire-and-forget trigger for the event-driven retention paths (agent
   * session end, daemon start, the periodic timer). A sweep failure is
   * maintenance noise, never a daemon failure: log and move on. */
  private triggerMemoryRetentionSweep(reason: string): void {
    void this.runMemoryRetentionSweep().catch((error) => {
      const line = `Hive memory retention sweep (${reason}) failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`;
      console.error(line);
      this.writeDaemonLog(line);
    });
  }

  /** Rolling digest re-synthesis at an activity boundary: agent session end,
   * kill, and landing/completion
   * events. The compiler is a deterministic fold over the typed episodic
   * record — daemon code, never the session's own agent, never an LLM on
   * the hot path — and it REPLACES the agent+session digest row rather than
   * merging. Failure-isolated like the other memory projections: a compile
   * failure logs and never breaks the lifecycle path that triggered it. */
  private compileSessionDigest(
    agentId: string,
    sessionId: string | null,
    reason: string,
  ): void {
    if (this.episodic === null) return;
    try {
      compileDigest(this.episodic, { agent: agentId, sessionId });
    } catch (error) {
      const line = `Hive session digest compile (${reason}) failed for ${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(line);
      this.writeDaemonLog(line);
    }
  }

  /** The mistake harvest runs at the same session
   * boundaries as the digest compile, strictly AFTER it, so the harvested
   * candidate's provenance can cite the digest id. Fire-and-forget like the
   * retention sweep: the harvester already captures per-candidate failures
   * in its report, and anything that escapes is maintenance noise, never a
   * failure of the lifecycle path that triggered it. Writes go through the
   * serialized memory write path so a harvest can never
   * interleave with an agent's own memory_write. */
  private harvestSessionPitfalls(
    agentId: string,
    sessionId: string | null,
    reason: string,
  ): void {
    const episodic = this.episodic;
    if (episodic === null) return;
    void harvestPitfalls({
      store: episodic,
      repoRoot: this.repoRoot,
      agent: agentId,
      sessionId,
      write: (input) => this.writeMemoryFact(input),
      search: (query) => this.memory.search(query, { limit: 5 }),
    }).catch((error) => {
      const line = `Hive pitfall harvest (${reason}) failed for ${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(line);
      this.writeDaemonLog(line);
    });
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
    const targetBranch = await resolveLandingTargetBranch(this.repoRoot);
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
          targetBranch,
        );
      } catch (error) {
        // Cannot prove the worktree is clean, so it is not reaped this tick.
        // "I could not tell" is not permission to say nothing: an agent that
        // never becomes assessable would otherwise idle here forever, unreaped
        // and unreported.
        await this.delivery
          .send(
            "hive-lifecycle",
            ORCHESTRATOR_NAME,
            `${record.name} is idle ${idleMinutes}m and cannot be reaped: its stranded-work check failed (${
              error instanceof Error ? error.message : "unknown error"
            }), so Hive cannot prove the worktree is clean. Nothing was deleted. Inspect ${
              record.worktreePath ?? "its worktree"
            } and land or discard it explicitly.`,
            { idempotencyKey: `stranded-idle-unknown:${record.id}` },
          )
          .catch(logAlertDeliveryFailure);
        continue;
      }
      if (stranded.dirtyFiles.length > 0 || stranded.unmergedCommits > 0) {
        // The guard that protects unlanded work must not also hide it. The
        // reaper never deletes this agent, so without an alert it simply sits
        // here every tick until a daemon restart drops it from the world.
        await this.delivery
          .send(
            "hive-lifecycle",
            ORCHESTRATOR_NAME,
            `${record.name} is idle ${idleMinutes}m and was NOT reaped: it holds ${stranded.unmergedCommits} unmerged commit(s) on ${
              record.branch ?? "no branch"
            } and ${stranded.dirtyFiles.length} uncommitted file(s). Nothing was deleted. Land it with an integrator agent, or discard it explicitly with hive_kill discardWork.`,
            {
              // Re-alerts when the work grows, so a stranded agent that keeps
              // committing is reported again rather than silenced by the first
              // alert; identical state does not re-alert every tick.
              idempotencyKey: `stranded-idle:${record.id}:${stranded.unmergedCommits}:${stranded.dirtyFiles.length}`,
            },
          )
          .catch(logAlertDeliveryFailure);
        continue;
      }
      const warningKey = `idle-reap-warning:${record.id}`;
      if (
        this.db.findMessageByIdempotency("hive-lifecycle", warningKey) === null
      ) {
        await this.delivery
          .send(
            "hive-lifecycle",
            record.name,
            "Hive is about to reap this idle session. Persist any findings or design that exist only in your context or scratchpad now; if there is nothing to keep, no action is needed.",
            { idempotencyKey: warningKey },
          )
          .catch(logAlertDeliveryFailure);
        continue;
      }
      try {
        await this.killAgentTeardown(record, { removeWorktree: true });
        await this.delivery
          .send(
            "hive-lifecycle",
            ORCHESTRATOR_NAME,
            `Reaped ${record.name}: idle ${idleMinutes}m with a clean worktree and nothing unmerged.`,
            { idempotencyKey: `idle-reap:${record.id}` },
          )
          .catch(logAlertDeliveryFailure);
      } catch (error) {
        console.error(
          `Hive idle-reap of ${record.name} failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
  }

  async reconcileOrphanedWorktrees(): Promise<WorktreeReconciliationReport> {
    const agents = this.db.listAgents();
    const targetBranch = await resolveLandingTargetBranch(this.repoRoot);
    const report = await this.reconcileWorktrees(
      this.repoRoot,
      agents,
      targetBranch,
      {
        assess: this.assessStranded,
        remove: this.cleanupWorktree,
      },
    );
    for (const outcome of report.worktrees) {
      if (outcome.action !== "removed") continue;
      const owner = agents.find(
        (agent) =>
          agent.worktreePath === outcome.path ||
          (outcome.branch !== null && agent.branch === outcome.branch),
      );
      if (owner === undefined || LIVE_STATUSES.includes(owner.status)) continue;
      this.db.upsertAgent({
        ...owner,
        worktreePath: null,
        branch: null,
      });
    }
    const noteworthy =
      report.worktrees.some((outcome) => outcome.rule !== "live-agent") ||
      report.preservedRefs.removed.length > 0 ||
      report.preservedRefs.kept.length > 0;
    if (!noteworthy) return report;

    const worktrees = report.worktrees.map((outcome) => {
      const subject = outcome.branch ?? outcome.path;
      switch (outcome.rule) {
        case "live-agent":
          return `${subject}: kept (live agent row owns it)`;
        case "preserved-agent":
          return `${subject}: kept (closed agent row carries an explicit preservation reason)`;
        case "stranded-work":
          return `${subject}: kept (${outcome.unmergedCommits} unmerged commit(s), ${outcome.dirtyFiles.length} real uncommitted path(s))`;
        case "foreign-instance":
          return `${subject}: kept (branch is owned by another Hive instance)`;
        case "unregistered-path":
          return `${subject}: kept (disk path is not registered as a git worktree; manual inspection required)`;
        case "assessment-failed":
          return `${subject}: kept (stranded-work assessment failed: ${outcome.note ?? "unknown error"})`;
        case "cleanup-failed":
          return `${subject}: kept (clean-orphan removal failed: ${outcome.note ?? "unknown error"})`;
        case "clean-orphan":
          return `${subject}: removed (no owning row, no unmerged commits, no real uncommitted paths)`;
        default:
          return unknownVendor(outcome.rule, "worktree reconciliation rule");
      }
    });
    const removedRefs = report.preservedRefs.removed.map(
      (ref) => `${ref.branch} (fully merged)`,
    );
    const keptRefs = report.preservedRefs.kept.map(
      (ref) => `${ref.branch} (${ref.unmergedCommits} unmerged)`,
    );
    const body = [
      "Hive worktree reconciliation:",
      ...worktrees.map((line) => `- ${line}`),
      `Preserved refs removed: ${removedRefs.length}${
        removedRefs.length === 0 ? "" : ` — ${removedRefs.join(", ")}`
      }.`,
      `Preserved refs kept: ${keptRefs.length}${
        keptRefs.length === 0 ? "" : ` — ${keptRefs.join(", ")}`
      }. Nothing with unmerged commits or real uncommitted paths was deleted.`,
    ].join("\n");
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
    await this.delivery
      .send("hive-lifecycle", ORCHESTRATOR_NAME, body, {
        idempotencyKey: `worktree-reconciliation:${this.bootId}:${digest}`,
      })
      .catch(logAlertDeliveryFailure);
    return report;
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
    const targetBranch = await resolveLandingTargetBranch(this.repoRoot);
    const branches = await this.listUnmergedBranches(
      this.repoRoot,
      targetBranch,
    );
    if (branches.length === 0) return;
    const agents = this.db.listAgents();
    const liveInstances = await this.liveInstanceIds().catch(
      () => new Set<string>(),
    );
    const ownInstanceId = hiveInstanceSuffix();

    for (const {
      branch,
      tip,
      unmergedCommits,
      preserved,
      ownerInstanceId,
    } of branches) {
      if (preserved) continue;
      if (
        ownerInstanceId !== undefined &&
        ownerInstanceId !== ownInstanceId &&
        liveInstances.has(ownerInstanceId)
      )
        continue;
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
      const detail =
        closed === undefined
          ? // The case that stranded david: a branch with unlanded commits and no
            // agent row at all. Nothing in the agents table can ever surface this.
            `no agent row owns it (its row predates this database or was lost), so nothing in the agent table can account for it`
          : `its agent ${closed.name} is ${closed.status} and left it behind`;
      await this.delivery
        .send(
          "hive-lifecycle",
          ORCHESTRATOR_NAME,
          `Stranded work: ${branch} holds ${unmergedCommits} commit(s) not on ${targetBranch} and ${detail}. Nothing was deleted. Assess it with an integrator agent and land or discard it explicitly.`,
          { idempotencyKey: `stranded-branch:${alertKey}:${this.bootId}` },
        )
        .catch(logAlertDeliveryFailure);
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
    // Name one failure per refusal because stale epochs and revoked authority
    // require opposite actions: re-read the former and stop for the latter.
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
    const operation = await this.machineMutations?.beginOperation("landing");
    try {
      const landed = await this.land(this.repoRoot, agent.branch);
      // The graph tracks main, and this is the one choke point every landing
      // passes through. Fire-and-forget: the merge result is already decided
      // and a graph rebuild must never appear in landing latency.
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

  /**
   * Deliver an approval decision to a vendor session that is parked on its own
   * TUI prompt, and report whether it actually landed.
   *
   * Codex is sitting on its terminal approval popup, and the only thing that
   * advances it is the keystroke that popup advertises. Delivering through any
   * other queue leaves an approved request blocked.
   *
   * Never claims delivery it did not make: a host with no key channel, or a
   * declined injection, returns false and says why on the daemon's stderr.
   */
  private async answerVendorPrompt(
    approval: Approval,
    approved: boolean,
  ): Promise<
    | { outcome: "answered" | "not-applicable" | "stale" }
    | { outcome: "delivery-failed"; reason: string }
  > {
    // Only the vendor's own tool prompt is answerable this way; cost-consent
    // and land-rearm are Hive's own approvals, with nothing waiting at a pane.
    if (approval.kind !== "tool-permission")
      return { outcome: "not-applicable" };
    const agent = this.db.getAgentByName(approval.agentName);
    if (agent === null || agent.tool !== "codex")
      return { outcome: "not-applicable" };
    if (this.db.getApproval(approval.id)?.status !== "pending") {
      return { outcome: "stale" };
    }
    // A human can answer the popup at the pane, and the following tool
    // boundary is what proves it: that observation moves the agent out of
    // awaiting-approval. Pressing a key after it would type into a composer
    // the model is using.
    if (agent.status !== "awaiting-approval") return { outcome: "stale" };
    if (agent.sessionLocator?.hostKind !== "sessiond") {
      return { outcome: "not-applicable" };
    }
    const keys = approved
      ? CODEX_TUI_APPROVAL_KEYS.approve
      : CODEX_TUI_APPROVAL_KEYS.deny;
    if (this.sessiondInput.injectKeys === undefined) {
      const reason = "this session host cannot send keys";
      console.error(
        `Hive could not deliver approval ${approval.id}: this session host ` +
          `cannot send keys, so ${agent.name}'s approval remains pending`,
      );
      return { outcome: "delivery-failed", reason };
    }
    const activeRun = this.db.getActiveProviderRunForAgent(agent.id);
    if (activeRun === null) return { outcome: "stale" };
    try {
      const result = await this.sessiondInput.injectKeys(agent, keys, {
        transactionId: `approval:${approval.id}`,
        isPromptPending: () =>
          this.db.getApproval(approval.id)?.status === "pending" &&
          this.db.getAgentByName(agent.name)?.status === "awaiting-approval",
        expectedForeground: {
          pid: activeRun.pid,
          startToken: activeRun.startToken,
          processGroupId: activeRun.foregroundProcessGroupId,
        },
      });
      if (result.outcome === "declined") {
        if (
          this.db.getApproval(approval.id)?.status !== "pending" ||
          this.db.getAgentByName(agent.name)?.status !== "awaiting-approval"
        ) {
          return { outcome: "stale" };
        }
        console.error(
          `Hive could not answer ${agent.name}'s vendor approval prompt: ${result.reason}`,
        );
        return { outcome: "delivery-failed", reason: result.reason };
      }
      return { outcome: "answered" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(
        `Hive failed to answer ${agent.name}'s vendor approval prompt: ${reason}`,
      );
      return { outcome: "delivery-failed", reason };
    }
  }

  async queueCodexApproval(
    agentName: string,
    description: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.stalePendingToolApprovals(agentName, createdAt);
      this.db.insertApproval({
        id,
        agentName,
        // The description is the command Codex wants to run. Never trimmed.
        kind: "tool-permission",
        description,
        status: "pending",
        createdAt,
        resolvedAt: null,
      });
      const agent = this.db.getAgentByName(agentName);
      if (
        agent !== null &&
        agent.status !== "dead" &&
        agent.status !== "done" &&
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
        database =
          result.length === 1 && result[0] === "ok"
            ? { status: "ok" }
            : { status: "degraded", errors: result };
      } catch (error) {
        database = {
          status: "unreadable",
          error: error instanceof Error ? error.message : "unknown error",
        };
      }
      const ok =
        database.status === "ok" && this.maintenanceHealth.status !== "error";
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
      // The sessiond broker authenticates by fetching this over a raw socket
      // and reading to EOF (`Connection: close`); Bun keep-alive would leave
      // that read hanging until its timeout and fail broker auth closed.
      return json(await this.handshake(), { headers: { connection: "close" } });
    }
    // Everything below mutates state or reads another tenant's data, so every
    // one of them authenticates first.
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
    if (
      url.pathname === "/orchestrator-session" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return this.orchestratorSessionEndpoint(url, request);
    }
    if (url.pathname === "/orchestrator-status" && request.method === "GET") {
      return this.orchestratorStatusEndpoint(request);
    }
    if (url.pathname === "/workspace-visibility" && request.method === "POST") {
      return this.workspaceVisibilityEndpoint(request);
    }
    if (url.pathname === "/workspace-owner" && request.method === "POST") {
      return this.workspaceOwnerEndpoint(request);
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
      const sessionId = tokenSession[1];
      const action = tokenSession[2];
      if (sessionId === undefined || action === undefined) {
        return json(
          { error: "invalid token usage session path" },
          { status: 400 },
        );
      }
      return action === "orchestrators"
        ? this.startTokenUsageOrchestrator(sessionId, request)
        : this.endTokenUsageSession(sessionId, request);
    }
    const tokenSubject = url.pathname.match(
      /^\/token-usage\/subjects\/([^/]+)\/end$/,
    );
    if (tokenSubject !== null && request.method === "POST") {
      const subjectId = tokenSubject[1];
      if (subjectId === undefined) {
        return json(
          { error: "invalid token usage subject path" },
          { status: 400 },
        );
      }
      return this.endTokenUsageSubject(subjectId, request);
    }
    if (url.pathname === "/recover" && request.method === "POST") {
      return this.recoverEndpoint(request);
    }
    if (url.pathname === "/stop" && request.method === "POST") {
      return this.stopEndpoint(request);
    }
    if (url.pathname === "/codex-root-token" && request.method === "POST") {
      return this.mintCodexRootToken(request);
    }
    if (
      url.pathname.startsWith("/agents/") &&
      url.pathname.endsWith("/kill") &&
      request.method === "POST"
    ) {
      return this.killEndpoint(url.pathname, request);
    }
    if (
      url.pathname.startsWith("/agents/") &&
      url.pathname.endsWith("/attach-grant") &&
      request.method === "POST"
    ) {
      return this.attachGrantEndpoint(url.pathname, request);
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
    const { token } = this.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
      {
        epoch: 0,
        ttlMs,
      },
    );
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
        agent.name,
        parsed.data.contextUsedPct,
        parsed.data.contextWindow,
      );
    }
    // Bind this observation to the model the agent is *running*, not the one it
    // was spawned with. `agent.model` is a spawn-time intention that a `/model`
    // inside the session silently invalidates, and quota charged to a model
    // nobody is running is quota charged to nobody.
    const model = await this.reconcileModel(agent);
    const observation =
      (await this.quota?.observeStatusline(
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
        },
      )) ?? null;
    this.followReservationRekey(agent.name);
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
    const current = this.db.getAgentByName(agent.name);
    if (
      current === null ||
      (current.tool !== "claude" && current.tool !== "grok")
    )
      return;
    const identity = current.executionIdentity;
    if (identity === undefined) {
      if (current.tool === "grok") {
        console.error(
          `Cannot reconcile Grok effort for ${current.name}: execution identity is absent`,
        );
        return;
      }
      if (current.model === "default") return;
      this.db.upsertAgent({
        ...current,
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
      this.db.upsertAgent({
        ...current,
        executionIdentity: { ...identity, effort: observedEffort },
      });
      return;
    }
    if (identity.effort === observedEffort) return;

    const description =
      `Execution effort drifted from immutable launch value ${identity.effort} ` +
      `to observed current value ${observedEffort}`;
    const alreadyRecorded = this.db
      .listEvents(current.name)
      .some(
        (event) =>
          event.kind === "effort-drift" && event.description === description,
      );
    if (alreadyRecorded) return;
    const timestamp = new Date().toISOString();
    this.db.insertEvent({
      kind: "effort-drift",
      agentName: current.name,
      timestamp,
      description,
    });
    await this.delivery
      .send(
        "hive-effort",
        ORCHESTRATOR_NAME,
        `Effort drift observed for ${current.name}: ${description}. ` +
          "ExecutionIdentity was not changed.",
        {
          idempotencyKey: `effort-drift:${current.id}:${identity.effort}:${observedEffort}`,
        },
      )
      .catch(() => undefined);
  }

  /**
   * Land Claude Code's own occupancy figure and its measured context window
   * onto the agent row.
   *
   * Re-reads before writing for the same reason `followReservationRekey`
   * does: the sweep and this handler both land on this row, and a stale
   * `agent` captured earlier in the request would clobber a concurrent
   * update instead of merging with it.
   */
  private reconcileContext(
    name: string,
    contextUsedPct: number | undefined,
    contextWindow: number | undefined,
  ): void {
    const current = this.db.getAgentByName(name);
    if (current === null) return;
    const updates: Partial<AgentRecord> = {};
    if (contextUsedPct !== undefined && current.contextPct !== contextUsedPct) {
      updates.contextPct = contextUsedPct;
    }
    if (
      contextWindow !== undefined &&
      current.contextWindow !== contextWindow
    ) {
      updates.contextWindow = contextWindow;
    }
    if (Object.keys(updates).length > 0) {
      this.db.upsertAgent({ ...current, ...updates });
    }
  }

  private followReservationRekey(name: string): void {
    const held = this.quota?.ledger.getActiveReservationForAgent(name);
    if (held === undefined || held === null) return;
    const agent = this.db.getAgentByName(name);
    if (agent === null) return;
    if (held.purpose === "control") {
      if (agent.controlQuotaReservationId === held.id) return;
      this.db.upsertAgent({ ...agent, controlQuotaReservationId: held.id });
      return;
    }
    if (agent.quotaReservationId === held.id) return;
    this.db.upsertAgent({ ...agent, quotaReservationId: held.id });
  }

  /**
   * The model `agent` is actually running, observed and persisted onto its row.
   *
   * The observation is written to `liveModel`, never over `model`. They are
   * different facts and the difference is load-bearing: `model` is the
   * immutable execution identity, and `restartForControl` refuses to restart an
   * agent whose recorded identity and row disagree — so overwriting `model`
   * would leave an agent that changed models permanently unrestartable after a
   * critical control. Do not conflate launch intention with live observation.
   *
   * No observation — a Codex rollout, which records no model name, or a Claude
   * session that has not answered yet — leaves `liveModel` untouched, and the
   * launch model stands. An unknown model is unknown, never a guess.
   */
  private async reconcileModel(agent: AgentRecord): Promise<string> {
    const known = agent.liveModel ?? agent.model;
    if (agent.worktreePath === null) return known;

    let live: string | null;
    switch (agent.tool) {
      case "claude":
        live = await this.readLiveModel(
          agent.worktreePath,
          agent.toolSessionId,
        ).catch(() => null);
        break;
      case "grok":
        live = await this.readGrokLiveModel(
          agent.worktreePath,
          agent.toolSessionId,
        ).catch(() => null);
        break;
      case "codex":
        return known;
      case "kimi":
        // Kimi's session state.json records no model name, so there is no
        // live observation to reconcile against — the launch model stands.
        return known;
      case "opencode":
        // opencode's session database has no live-model reader wired.
        return known;
      default:
        return unknownVendor(agent.tool, "live model reconciliation");
    }
    if (live === null) return known;
    if (live !== agent.liveModel) {
      // Re-read before writing: the sweep and this handler both land here, and a
      // hook event may have advanced the row under us.
      const current = this.db.getAgentById(agent.id);
      if (current !== null) {
        this.db.upsertAgent({ ...current, liveModel: live });
      }
    }
    return live;
  }

  /** Starts or observes the exact sessiond root generation owned by the
   * Workspace supervisor. POST returns a locator only after terminal creation
   * and its durable binding complete. */
  private async orchestratorSessionEndpoint(
    url: URL,
    request: Request,
  ): Promise<Response> {
    const route = "/orchestrator-session";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      route,
      request.method === "POST" ? "agent:spawn" : "status:read",
      undefined,
      request.method === "POST",
    );
    if (!decision.ok) return this.denied(decision);
    if (this.orchestratorSessiond === null) {
      return json(
        { error: "the sessiond queen host is unavailable" },
        { status: 503 },
      );
    }
    if (request.method === "GET") {
      const snapshot = this.orchestratorSessiond.snapshot();
      const requestId = url.searchParams.get("requestId");
      if (
        snapshot === null ||
        (requestId !== null && snapshot.requestId !== requestId)
      ) {
        return json(
          { error: "queen session generation not found" },
          { status: 404 },
        );
      }
      return json(snapshot);
    }
    const parsed = OrchestratorSessiondLaunchSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return json({ error: parsed.error.message }, { status: 400 });
    try {
      const snapshot = await this.orchestratorSessiond.start(parsed.data);
      return json(snapshot);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : "queen launch failed",
        },
        { status: 409 },
      );
    }
  }

  /**
   * `GET /orchestrator-status` — what the root is doing, for the Workspace dot.
   *
   * The root has no agents-table row, so derive this surface from its own
   * turn-boundary events. Return `{"status": null}` whenever they cannot be
   * trusted; an absent status is unknown, never a flattering guess.
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
    const host = this.orchestratorSessiond?.snapshot() ?? null;
    return json({
      status: deriveOrchestratorStatus(
        this.db.recentOrchestratorSignals(ORCHESTRATOR_NAME),
      ),
      host: "sessiond",
      hostState: host?.state ?? null,
      hostDiagnostic: host?.diagnostic ?? null,
      sessionLocator: host?.locator ?? null,
    });
  }

  private async workspaceVisibilityEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/workspace-visibility";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      route,
      "workspace-visibility:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    if (this.workspaceVisibility === null) {
      return json(
        { error: "workspace visibility authority is unavailable" },
        { status: 503 },
      );
    }
    const body = WorkspaceVisibilitySnapshotSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    const result = this.workspaceVisibility.publish(body.data);
    if (result.state !== "accepted") return json(result, { status: 409 });
    // A publish records which panes the Workspace is showing. It decides
    // nothing about which terminals exist: a terminal is alive because its
    // process is alive, and it observes that for itself.
    //
    // Do not make terminal lifetime depend on publish latency. Per-terminal
    // round trips can exceed the Workspace timeout during a launch burst even
    // while the daemon remains responsive.
    return json(result, { status: 200 });
  }

  private async workspaceOwnerEndpoint(request: Request): Promise<Response> {
    const route = "/workspace-owner";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      route,
      "workspace-visibility:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    if (this.workspaceVisibility === null) {
      return json(
        { error: "workspace ownership authority is unavailable" },
        { status: 503 },
      );
    }
    const body = WorkspaceOwnerSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    const result = this.workspaceVisibility.register(body.data);
    if (result.state !== "accepted") return json(result, { status: 409 });
    if (this.ownerRegistrationTimer !== null) {
      clearTimeout(this.ownerRegistrationTimer);
      this.ownerRegistrationTimer = null;
    }
    return json({ state: "accepted" });
  }

  /** The Workspace's own liveness is policy the daemon owns: a Hive with no
   * Workspace has nobody to serve, so it shuts down. Nothing a terminal needs
   * rides on this check — terminals observe their own supervisor and outlive
   * any number of missed ticks. Do not renew terminal lifetime here: agent
   * survival must not depend on a liveness message arriving on time. */
  checkWorkspaceOwnerAlive(): void {
    const workspaceVisibility = this.workspaceVisibility;
    if (workspaceVisibility == null) return;
    if (workspaceVisibility.sourceVerified()) return;
    if (!workspaceVisibility.ownerRegistered()) return;
    if (this.stopInProgress) return;
    this.stopInProgress = true;
    this.initiateShutdown();
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
      return json(
        await this.tokenUsage.snapshot(
          url.searchParams.get("repoRoot") ?? undefined,
        ),
      );
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
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    return json({
      sessionId: await this.tokenUsage.startSession(body.data.repoRoot),
    });
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
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
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
   * updated document. Operator-only in both directions: an enabled model here
   * is consent to spend, and an agent
   * granting itself consent would be self-authorization.
   */
  private async routingPolicyEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/routing/policy");
    if (!authenticated.ok) return this.denied(authenticated);
    if (this.routingPolicy === null) {
      this.routingPolicy = new RoutingPolicyStore(this.db);
    }
    const store = this.routingPolicy;
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
      const policy = store.apply(
        mutation.data,
        authenticated.capability.subject,
      );
      if (mutation.data.op === "set-selection") {
        try {
          await this.selectionPreferences?.apply(
            mutation.data,
            policy.selection,
          );
        } catch (error) {
          return json(
            {
              error:
                "selection was saved in this Workspace but could not be saved " +
                `for future ordinary Workspace sessions: ${
                  error instanceof Error ? error.message : String(error)
                }`,
            },
            { status: 500 },
          );
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

  /**
   * POST /agents/<name>/kill — the pane's X button.
   *
   * The Workspace needs a kill it can call without an MCP client, and it must
   * be the SAME kill: a second teardown path is how one of them quietly stops
   * reaping something. So this checks the pane's exact Hive locator, then is a
   * thin authorization shell over killAgentTeardown.
   *
   * Idempotent while a residual process tree might still need reaping. Once
   * the exact terminal generation is positively absent, a repeat click is a
   * typed refusal rather than a fabricated successful kill.
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
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(
        {
          state: "rejected",
          reason: "invalid-session-locator",
          error: "Kill requires the pane's exact sessionLocator",
        },
        { status: 400 },
      );
    }
    const parsed = z
      .strictObject({
        sessionLocator: SessionLocatorSchema,
        // Who asked for this kill: CLI subcommand, argv, and parent pid, written
        // onto the allow-decision audit row. Free-form and truncated rather than
        // validated: a kill must never be refused because its provenance string
        // is long.
        origin: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      return json(
        {
          state: "rejected",
          reason: "invalid-session-locator",
          error: "Kill requires the pane's exact sessionLocator",
        },
        { status: 400 },
      );
    }
    const decision = this.authorize(
      authenticated.capability,
      "/agents/kill",
      "agent:kill",
      name,
      true,
      parsed.data.origin?.slice(0, 1_024) ?? null,
    );
    if (!decision.ok) return this.denied(decision);
    const agent = this.db.getAgentByName(name);
    if (agent === null) {
      return json({ error: `Hive agent not found: ${name}` }, { status: 404 });
    }
    if (
      agent.sessionLocator === undefined ||
      !sameSessionLocator(agent.sessionLocator, parsed.data.sessionLocator)
    ) {
      return json(
        {
          state: "rejected",
          reason: "session-locator-mismatch",
          error: `Hive refused to kill ${name}: its session generation changed`,
        },
        { status: 409 },
      );
    }
    if (
      isTerminalAgentStatus(agent.status) &&
      (await this.agentTreeAbsent(agent))
    ) {
      return json(
        {
          state: "rejected",
          reason: "session-generation-gone",
          error: `Hive refused to kill ${name}: its session generation is gone`,
        },
        { status: 409 },
      );
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

  /**
   * POST /stop — fleet shutdown as one atomic-or-abortive daemon request.
   *
   * Evaluate every gate before anything dies so a mid-flight failure or dead
   * requesting client cannot leave a partially killed fleet under a live daemon:
   *
   *   1. operator authorization (the same agent:kill the pane X needs);
   *   2. the invoker must not be an agent worktree shell — client-reported and
   *      therefore accident prevention, not a security boundary (a same-UID
   *      process can read the operator credential);
   *   3. unlanded work refuses the stop unless explicitly confirmed, naming
   *      the agents and their unlanded state.
   *
   * Past the commit latch, the daemon drives every kill and then its own exit
   * to completion whether or not the requesting client survives — the handler
   * is not cancelled by a vanished request. A teardown failure reports
   * stop-failed and leaves the daemon up: exiting over survivors would strand
   * them with nothing left to supervise or reap them.
   */
  private async stopEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/stop");
    if (!authenticated.ok) return this.denied(authenticated);
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const parsed = z
      .object({
        origin: z.string().optional(),
        confirmUnlanded: z.boolean().optional(),
        invoker: z
          .object({
            cwd: z.string(),
            agentWorktree: z.boolean(),
          })
          .optional(),
      })
      .safeParse(rawBody);
    if (!parsed.success) {
      return json(
        { error: "Invalid stop request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const origin = parsed.data.origin?.slice(0, 1_024) ?? null;
    const capability = authenticated.capability;
    const fleet = this.authorize(
      capability,
      "/stop",
      "agent:kill",
      undefined,
      false,
    );
    if (!fleet.ok) return this.denied(fleet);
    const deny = (reason: string): void =>
      this.capabilities.audit({
        route: "/stop",
        action: "agent:kill",
        callerSubject: capability.subject,
        callerRole: capability.role,
        capabilityId: capability.id,
        requestedSubject: null,
        epoch: capability.epoch,
        decision: "deny",
        reason: origin === null ? reason : `${reason}; ${origin}`,
      });
    const live = this.db
      .listAgents()
      .filter((agent) => LIVE_STATUSES.includes(agent.status));
    const invoker = parsed.data.invoker;
    const worktreeRoot = join(this.repoRoot, ".hive", "worktrees");
    const cwd = invoker?.cwd;
    const insideAgentWorktree =
      invoker?.agentWorktree === true ||
      (cwd !== undefined &&
        (cwd === worktreeRoot ||
          cwd.startsWith(`${worktreeRoot}/`) ||
          live.some(
            (agent) =>
              agent.worktreePath !== null &&
              (cwd === agent.worktreePath ||
                cwd.startsWith(`${agent.worktreePath}/`)),
          )));
    if (insideAgentWorktree) {
      deny("invoker inside an agent worktree");
      return json(
        {
          state: "refused-invoker",
          error:
            "Hive refused shutdown: `hive stop` was invoked from inside an agent " +
            "worktree, and agent shells hold no fleet-kill authority. " +
            "No agent was killed.",
        },
        { status: 403 },
      );
    }
    const unlanded: Array<{
      name: string;
      branch: string | null;
      dirtyFiles: number;
      unmergedCommits: number;
    }> = [];
    const stopTargetBranch = await resolveLandingTargetBranch(this.repoRoot);
    for (const agent of live) {
      if (agent.worktreePath === null && agent.branch === null) continue;
      try {
        const work = await this.assessStranded(
          this.repoRoot,
          agent.worktreePath,
          agent.branch,
          stopTargetBranch,
        );
        if (work.dirtyFiles.length > 0 || work.unmergedCommits > 0) {
          unlanded.push({
            name: agent.name,
            branch: agent.branch,
            dirtyFiles: work.dirtyFiles.length,
            unmergedCommits: work.unmergedCommits,
          });
        }
      } catch {
        // Unassessable is not "clean": a worktree whose state cannot be read
        // must gate the stop exactly as unlanded work would.
        unlanded.push({
          name: agent.name,
          branch: agent.branch,
          dirtyFiles: 0,
          unmergedCommits: 0,
        });
      }
    }
    if (unlanded.length > 0 && parsed.data.confirmUnlanded !== true) {
      deny(
        `unlanded work without confirmation: ${unlanded
          .map((agent) => agent.name)
          .join(", ")}`,
      );
      return json(
        {
          state: "refused-unlanded",
          unlanded,
          error:
            "Hive refused shutdown: agent(s) hold unlanded work. " +
            "No agent was killed.",
        },
        { status: 409 },
      );
    }
    if (this.stopInProgress) {
      return json({ state: "already-stopping" }, { status: 409 });
    }
    // COMMIT. From here the stop proceeds to completion regardless of the
    // requesting client's fate; nothing above this line killed anything.
    this.stopInProgress = true;
    const failures: string[] = [];
    for (const agent of live) {
      const kill = this.authorize(
        capability,
        "/stop",
        "agent:kill",
        agent.name,
        true,
        origin,
      );
      if (!kill.ok) {
        failures.push(`${agent.name}: ${kill.message}`);
        continue;
      }
      try {
        await this.killAgentTeardown(agent);
      } catch (error) {
        failures.push(
          `${agent.name}: ${
            error instanceof Error ? error.message : "kill failed"
          }`,
        );
      }
    }
    if (failures.length > 0) {
      this.stopInProgress = false;
      return json({ state: "stop-failed", failures }, { status: 500 });
    }
    this.initiateShutdown();
    return json({
      state: "stopping",
      killed: live.map((agent) => agent.name),
    });
  }

  /** POST /agents/<name>/attach-grant — terminal-stack-transition.html#visibility
   * one-use viewer attach for the
   * Workspace renderer, fenced by the pane's EXACT sessionLocator: a stale or
   * superseded generation is refused before the broker is ever contacted. */
  private async attachGrantEndpoint(
    pathname: string,
    request: Request,
  ): Promise<Response> {
    return attachGrantRoute(
      {
        db: this.db,
        orchestratorSessiond: this.orchestratorSessiond,
        terminalHost: this.terminalHost,
        authenticate: (req, route) => this.authenticate(req, route),
        authorize: (capability, route, action, subject, audit, reason) =>
          this.authorize(capability, route, action, subject, audit, reason),
        denied: (decision) => this.denied(decision),
      },
      pathname,
      request,
    );
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
    const parsed = z
      .object({ agent: z.string().min(1).optional() })
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
    return processHookEvent(
      {
        db: this.db,
        delivery: this.delivery,
        drainHandler: this.drainHandler,
        orchestratorSessiond: this.orchestratorSessiond,
        quota: this.quota,
        repoRoot: this.repoRoot,
        status: this.status,
        tokenUsage: this.tokenUsage,
        killAgentTeardown: (agent, options) =>
          this.killAgentTeardown(agent, options ?? {}),
      },
      event,
    );
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

    registerStatusTools(server, capability, {
      db: this.db,
      repoRoot: this.repoRoot,
      delivery: this.delivery,
      status: this.status,
      terminalHost: this.terminalHost,
      graphify: this.graphify,
      graphifyCalls: this.graphifyCalls,
      sessionHost: this.sessionHost,
      statusIncarnationGenerationSource: this.statusIncarnationGenerationSource,
      resolveSessionLocator: this.resolveSessionLocator,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      hasCompletedSessiondBinding: (agent) =>
        this.hasCompletedSessiondBinding(agent),
      memoryEmbeddingsStatusSection: () => this.memoryEmbeddingsStatusSection(),
      statusLiveness: (agent, sessions) => this.statusLiveness(agent, sessions),
    });

    registerQuotaTools(server, capability, {
      quota: this.quota,
      tokenUsage: this.tokenUsage,
      modelInventory: this.modelInventory,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    registerAgentControlTools(server, capability, {
      db: this.db,
      terminalHost: this.terminalHost,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      recoverCrashedAgents: (name) => this.recoverCrashedAgents(name),
      hasNeverBoundSessiondGeneration: (agent) =>
        this.hasNeverBoundSessiondGeneration(agent),
      killAgentTeardown: (agent, options) =>
        this.killAgentTeardown(agent, options ?? {}),
    });

    registerMessagingTools(server, capability, {
      db: this.db,
      delivery: this.delivery,
      spawner: this.spawner,
      status: this.status,
      machineMutations: this.machineMutations,
      memoryPressure: () => this.memoryPressure,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      acknowledgeControlMessage: (name, id, epoch, applied) =>
        this.acknowledgeControlMessage(name, id, epoch, applied),
    });

    const spawnAgent = async (request: SpawnRequest): Promise<AgentRecord> => {
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
        const persisted =
          current !== null && current.lastEventAt >= agent.lastEventAt
            ? current
            : this.db.upsertAgent(agent);
        if (persisted.status === "stuck") {
          throw new Error(
            `Hive agent ${persisted.name} could not verify cleanup after spawn: ${
              persisted.failureReason ?? "unknown launch failure"
            }`,
          );
        }
        this.status.openAssignment(persisted.id, persisted.createdAt);
        await this.delivery.flushQueued(persisted.name);
        return persisted;
      } finally {
        operation?.release();
      }
    };
    registerSpawnApprovalTools(server, capability, {
      db: this.db,
      delivery: this.delivery,
      capabilities: this.capabilities,
      resolvingApprovals: this.resolvingApprovals,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      answerVendorPrompt: (approval, approved) =>
        this.answerVendorPrompt(approval, approved),
      spawnAgent,
    });

    registerLandTool(server, capability, {
      db: this.db,
      capabilities: this.capabilities,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      landAgent: (name, epoch) => this.landAgent(name, epoch),
      decideSpentLandGrant: (cap, branch, mayAutoRearm) =>
        this.decideSpentLandGrant(cap, branch, mayAutoRearm),
      fileLandRearmApproval: (subject) => this.fileLandRearmApproval(subject),
    });

    registerMemoryTools(server, capability, {
      db: this.db,
      repoRoot: this.repoRoot,
      memory: this.memory,
      embeddingIndex: this.embeddingIndex,
      episodic: this.episodic,
      status: this.status,
      tokenUsage: this.tokenUsage,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      writeMemoryFact: (input) => this.writeMemoryFact(input),
      deleteMemoryFact: (scope, id) => this.deleteMemoryFact(scope, id),
      rebuildMemoryIndex: () => this.rebuildMemoryIndex(),
      semanticRecall: () => this.semanticRecall(),
      semanticRecallState: () => this.semanticRecallState(),
    });

    registerGraphTool(server, capability, {
      repoRoot: this.repoRoot,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    return server;
  }

  private async handleMcp(request: Request): Promise<Response> {
    // Authentication gates the whole transport, so an anonymous caller cannot
    // even enumerate the tools it is not allowed to call.
    const authenticated = this.authenticate(request, "/mcp");
    if (!authenticated.ok) {
      return json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: authenticated.message },
          id: null,
        },
        { status: authenticated.status },
      );
    }
    // An authenticated request is the truthful proof that this
    // subject's vendor MCP client reached the right port with a working
    // credential. The launch path waits on this marker rather than trusting
    // a redrawing pane; a stale token or dead port simply never lands here.
    this.mcpClientsSeen.set(
      authenticated.capability.subject,
      new Date().toISOString(),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = this.createMcpServer(authenticated.capability);
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch (error) {
      return json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
          id: null,
        },
        { status: 500 },
      );
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
    statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
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
