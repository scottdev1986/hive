import { join } from "node:path";
import { isString } from "../shared/is-record";
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { Server } from "bun";
import { z } from "zod";
import {
  assessStrandedWork,
  listSettlementBranches,
  reconcileOrphanedWorktrees as reconcileWorktrees,
  type SettlementBranch,
  type StrandedWork,
  type WorktreeReconciliationReport,
} from "../adapters/worktrees";
import type { AutonomyControl } from "../config/autonomy";
import {
  getHiveHome,
  hiveInstanceSuffix,
  sessiondRuntimeRoot,
} from "../hive-home/home";
import {
  type MailRecipientState,
  MailService,
  type MailServiceConfig,
} from "../mail-service/service";
import { MailStore } from "../mail-service/store";
import { MailWakeAclError, MailWakeLedger } from "../mail-service/wake-ledger";
import { MailWakeStore } from "../mail-service/wake-store";
import { countConsolidationCandidates } from "../memory-service/consolidate";
import {
  embeddingsRuntimeDir,
  type MemoryEmbedderLoad,
  type MemoryEmbeddingConfig,
  MemoryEmbeddingIndex,
  MemoryEmbeddingService,
} from "../memory-service/embeddings";
import type { EpisodicStore } from "../memory-service/episodic";
import { MemoryIndex } from "../memory-service/fts-index";
import {
  harvestPitfalls,
  harvestVerification,
  isHarvestBoundaryEvent,
  VERIFICATION_ARTICLE_ID,
  verificationCommandFromTitle,
} from "../memory-service/harvest";
import {
  type MemoryJobDeps,
  MemoryJobStore,
  type StartedMemoryJob,
  startMemoryJob,
} from "../memory-service/jobs";
import {
  applyMemoryMutation,
  buildMemoryListPage,
} from "../memory-service/library";
import {
  casWriteMemoryConfig,
  readMemoryConfig,
} from "../memory-service/memory-config";
import { listMemoryFacts } from "../memory-service/memory-store";
import { registerMemoryTools } from "../memory-service/memory-tools";
import {
  buildMemoryMaintenance,
  buildMemoryOverview,
  type MemoryProjectionDeps,
} from "../memory-service/projections";
import { buildMemoryRecallPreview } from "../memory-service/recall-preview";
import type { RetentionSweepReport } from "../memory-service/retention";
import { MemoryWriteService } from "../memory-service/write-service";
import {
  type AgentRecord,
  canonicalOrchestratorName,
  isLiveAgent,
  isOrchestratorName,
  isTerminalAgentStatus,
  ORCHESTRATOR_NAME,
} from "../schemas/agent";
import {
  type CapabilityProvider,
  MeasuredProviderCapabilitiesSchema,
} from "../schemas/capability";
import {
  type ArtifactsConfig,
  ArtifactsConfigSchema,
  AutonomyEnvelopeSchema,
  type MemoryRetentionConfig,
  type ResourceLimits,
} from "../schemas/config-schema";
import { type HookEvent, HookEventSchema } from "../schemas/event";
import {
  FrontendWakeReportSchema,
  MailReadyAckSchema,
  MailReadyResponseSchema,
  type MailStatusState,
} from "../schemas/mail-wake";
import type { MemoryScope, MemoryWriteInput } from "../schemas/memory";
import {
  MemoryConfigPatchSchema,
  type MemoryConfigProjection,
  type MemoryJobKind,
  MemoryJobKindSchema,
  MemoryListRequestSchema,
  MemoryMutationRequestSchema,
  MemoryRecallPreviewRequestSchema,
} from "../schemas/memory-projections";
import {
  type ProviderRun,
  ProviderRuntimeReportSchema,
} from "../schemas/provider-run";
import { QuotaStatusSchema } from "../schemas/quota";
import { RunControlIntentSchema } from "../schemas/run-control";
import {
  SessionLocatorSchema,
  type TerminalGeometry,
} from "../schemas/session-protocol";
import {
  type WorkspaceEventV2,
  WorkspaceSnapshotV2Schema,
} from "../schemas/status-envelope";
import {
  ProtocolSessionFactsReportSchema,
  TokenUsageEventIngestSchema,
  type TokenUsageSessionCreated,
  type TokenUsageSubjectCreated,
} from "../schemas/token-usage-schema";
import { systemClock } from "../shared/clock";
import { definedFields } from "../shared/defined-fields";
import { type JsonValue, requireJsonValue } from "../shared/json";
import { errorMessage } from "../shared/error-message";
import { HIVE_MCP_CATALOG_CACHE_TTL_MS } from "../shared/mcp-protocol";
import { HIVE_VERSION } from "../shared/version";
import { registerKnowledgeTool } from "../skills/knowledge-tool";
import {
  QuotaObservationRequestSchema,
  registerQuotaTools,
} from "../usage-service/quota-tools";
import { TokenUsageStore } from "../usage-service/token-usage";
import type {
  QuotaRefreshReport,
  QuotaService,
} from "../usage-service/usage-quota";
import { ApprovalService } from "./approval-service/approval-service";
import {
  artifactReadRoots,
  artifactsRoot,
  sweepArtifacts,
} from "./artifact-store/artifact-store";
import { registerArtifactTools } from "./artifact-store/artifact-store-tool";
import type { MainHealthMonitorHandle } from "./landing/main-health-monitor";
import {
  type ProjectGate,
  runLearnedProjectGate,
  verificationCommandDeclared,
} from "./landing/project-gate";
import { repoMemoryCitesItem } from "./messaging/ruling-record";
import { registerAgentControlTools } from "./recovery/agent-control-tools";
import type { ModelControlSnapshot } from "./routing-service/model-control-snapshot";
import { promoteVerificationToStandards } from "./spawn/agent-standards";
import { WakePayloadService } from "./wake-payload-service";

export type { Approval } from "./approval-service/approval-service";
export {
  AUTO_REARM_BUDGET,
  AUTO_REARM_REASON,
} from "./approval-service/approval-service";

import {
  type Action,
  AuthorizationRefusedError,
  bearerToken,
  type Capability,
  CapabilityStore,
  type Decision,
  type Denial,
  type Role,
  type RouteAuthorization,
} from "./authorization/authorization-service";
import {
  removeCredential,
  USER_SUBJECT,
  writeCredential,
} from "./authorization/credentials";
import { HiveToolRegistrar } from "./authorization/mcp-tool-policy";
import { HiveDatabase } from "./database/hive-database";
import type { GraphifyService } from "./graphify-service/graphify-service";
import { registerGraphTool } from "./graphify-service/graphify-service-tool";
import { RunNotFoundError } from "./hierarchy-service/hierarchy-run-control";
import { HierarchyService } from "./hierarchy-service/hierarchy-service";
import { registerHierarchyNodeTools } from "./hierarchy-service/node-tools";
import { registerRunBootstrapTool } from "./hierarchy-service/run-bootstrap";
import { registerHierarchyWriteTools } from "./hierarchy-service/write-tools";
import {
  DetachedCheckoutError,
  type LandBranch,
  landAgent,
  landBranch,
  type ReadLandReadiness,
  readLandReadiness,
  resolveLandingTargetBranch,
} from "./landing/landing-service";
import { registerLandTool } from "./landing/landing-tool";
import {
  cleanupLifecycleFiles,
  expectedDaemonHandshake,
  readConfiguredPort,
  writeLifecycleFiles,
} from "./lifecycle/daemon-lifecycle";
import {
  DaemonMaintenance,
  type MaintenanceTask,
} from "./lifecycle/maintenance";
import { liveRunControlEndpoint } from "./live-run-control/live-run-control-endpoint";
import { ManifestJournal } from "./manifest-journal";
import { MemoryRetentionService } from "./memory-retention-service/memory-retention-service";
import { registerMailTools, registerMessagingTools } from "./messaging/tools";
import { MachineMutationCoordinator } from "./mutation-lease";
import { DaemonLog, logAlertDeliveryFailure } from "./observability/daemon-log";
import { ObservabilityService } from "./observability/observability-service";
import type { OrchestratorHostStatus } from "./orchestrator-host/orchestrator-host-contract";
import {
  HeadlessOrchestratorSessiondLaunchSchema,
  OrchestratorSessiondController,
  OrchestratorSessiondLaunchSchema,
} from "./orchestrator-host/sessiond-controller";
import { projectRootOrCwd } from "./project-identity-core/project-root";
import type { ModelInventory } from "./provider-capabilities/model-inventory";
import { processEvent as processHookEvent } from "./provider-events/process-event";
import {
  buildHandoffBundle,
  measureHandoffWorktree,
} from "./queen-provider-service/handoff";
import { vendorAvailabilityReader } from "./queen-provider-service/projection";
import { QueenProviderService } from "./queen-provider-service/queen-provider-service";
import {
  CrashRecovery,
  type RecoveryOutcome,
} from "./recovery/recovery-service";
import {
  type CommandOutput,
  runPs,
  runVmStat,
} from "./resource-management/resources";
import { RoutingService } from "./routing-service/routing-service";
import { attachGrantEndpoint as attachGrantRoute } from "./session-host/attach-grant-endpoint";
import {
  HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  requireSessiondRootLocator,
  sessiondAgentProviderRunIsDead,
  sessiondTeardownSucceeded,
  sessiondTerminalIsDead,
} from "./session-host/hive-terminal-host";
import {
  countSocketRootNodes,
  SOCKET_ROOT_SWEEP_THRESHOLD,
} from "./session-host/host-operations";
import {
  mintSessionRequestId,
  sameSessionLocator,
} from "./session-host/locators";
import type {
  SessionHost,
  SessionLocator,
} from "./session-host/session-host-contract";
import {
  type LandedTerminalHost,
  SessiondHost,
} from "./session-host/sessiond-host";
import type { SessiondOutputObservation } from "./session-host/sessiond-output-observer";
import {
  type WorkspaceVisibilityAdmission,
  type WorkspaceVisibilityAuthority,
  type WorkspaceVisibilityCandidate,
  type WorkspaceVisibilityLease,
  WorkspaceVisibilitySnapshotSchema,
} from "./session-host/workspace-visibility";
import {
  DrainHandler,
  type DrainHandlerDependencies,
  type ReplacementDrain,
} from "./spawn/drain-handler";
import { WorkspaceOwnerService } from "./workspace-owner-service/workspace-owner-service";

export {
  WORKSPACE_OWNER_REGISTRATION_TIMEOUT_MS,
  WORKSPACE_OWNER_WATCH_MS,
} from "./workspace-owner-service/workspace-owner-service";

import type { GraphifyCallCursor } from "./observability/tool-telemetry";
import { refreshToolTelemetry as refreshToolTelemetrySweep } from "./observability/tool-telemetry-refresh";
import type { SuccessionService } from "./queen-provider-service/succession";
import { registerSuccessionTools } from "./queen-provider-service/succession-tools";
import { sweepResources as sweepResourcesCycle } from "./resource-management/sweep-resources";
import {
  defaultReapDependencies,
  type ReapDependencies,
  type ReapOutcome,
  stopSessiondAgentSession,
} from "./resource-management/teardown";
import { GatedSpawner } from "./spawn/gates";
import type { Spawner, SpawnRequest } from "./spawn/spawn-service";
import { registerSpawnTools } from "./spawn/spawn-tools";
import { StatusDerivedProjectionService } from "./status-service/status-derived-projection-service";
import {
  AgentStatusBindingError,
  AgentStatusConflictError,
  ProviderStatusReportSchema,
  type StatusIncarnationGenerationSource,
  StatusService,
  unavailableStatusIncarnationGenerationSource,
} from "./status-service/status-service";
import {
  type McpCredentialObservation,
  type MemoryEmbeddingsStatusSection,
  registerStatusTools,
} from "./status-service/status-tools";
import {
  describeWorktreeKill,
  type TeardownStrandedWork,
  type WorktreeKillResult,
  WorktreeLifecycleService,
} from "./worktree-lifecycle-service/worktree-lifecycle-service";

export { HIVE_VERSION };

const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DAEMON_MAINTENANCE_INTERVAL_MS = 30_000;
const EXPENSIVE_MAINTENANCE_INTERVAL_MS = 5 * 60_000;

const TokenUsageSessionRequestSchema = z.object({
  repoRoot: z.string().min(1),
});

const TokenUsageOrchestratorRequestSchema = z.object({
  provider: z.string().min(1),
  cwd: z.string().min(1),
});

const TokenUsageEventsRequestSchema = z.object({
  events: z.array(TokenUsageEventIngestSchema).min(1),
});

const ProviderCapabilitiesRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subject: z.string().min(1),
  vendorSessionId: z.string().min(1),
  capabilities: MeasuredProviderCapabilitiesSchema,
});

export type { LandBranch };

export interface HiveDaemonOptions {
  spawner: Spawner;
  db?: HiveDatabase;
  statusService?: StatusService;
  episodicStore?: EpisodicStore;
  sessionHost?: Pick<SessionHost, "capture">;
  observeTerminalOutput?: (
    locator: SessionLocator,
    geometry: TerminalGeometry,
  ) => Promise<SessiondOutputObservation | null>;
  terminalHost?: LandedTerminalHost;
  workspaceVisibility?: WorkspaceVisibilityAuthority;
  resolveSessionLocator?: (
    sessionId: string,
    generation: number,
  ) => Promise<SessionLocator | null>;
  statusIncarnationGenerationSource: StatusIncarnationGenerationSource;
  autonomy?: AutonomyControl;
  queenVendorAvailability?: () => Record<
    CapabilityProvider,
    { available: boolean }
  >;
  queenRootObservation?: () => CapabilityProvider | null;
  /** Graphify lifecycle work never blocks callers. */
  graphify?: GraphifyService;
  repoRoot?: string;
  assessStrandedWork?: (
    repoRoot: string,
    worktreePath: string | null,
    branch: string | null,
    mainBranch?: string,
  ) => Promise<StrandedWork>;
  manifestJournal?: ManifestJournal;
  listSettlementBranches?: (
    repoRoot: string,
    mainBranch?: string,
  ) => Promise<SettlementBranch[]>;
  reconcileOrphanedWorktrees?: typeof reconcileWorktrees;
  landBranch?: LandBranch;
  projectGate?: ProjectGate;
  mainHealthMonitor?: MainHealthMonitorHandle | null;
  readLandReadiness?: ReadLandReadiness;
  port?: number;
  hostname?: string;
  manageLifecycle?: boolean;
  initiateShutdown?: () => void;
  machineMutations?: Pick<MachineMutationCoordinator, "beginOperation">;
  quota?: QuotaService;
  tokenUsage?: TokenUsageStore;
  modelInventory?: () => Promise<ModelInventory>;
  /** Workspace reads never fall back to live provider discovery. */
  modelControlSnapshot?: () => Promise<ModelControlSnapshot>;
  /** Maintenance owns vendor refreshes; request handlers never invoke them. */
  refreshModelControl?: () => Promise<void>;
  /** Override the bound stop() waits for an in-flight sweep to unwind. */
  maintenanceDrainTimeoutMs?: number;
  mail?: MailServiceConfig;
  resources?: ResourceLimits;
  retention?: MemoryRetentionConfig;
  artifacts?: ArtifactsConfig;
  wakeBudgetTokens?: number;
  /** Embedding failure degrades recall to FTS rather than crashing the daemon. */
  memoryEmbeddings?: MemoryEmbeddingConfig;
  memoryEmbeddingLoad?: MemoryEmbedderLoad;
  daemonLog?: (line: string) => void;
  resourceRunners?: {
    ps?: CommandOutput;
    vmStat?: CommandOutput;
    kill?: (pid: number) => void;
    reap?: ReapDependencies;
  };
}

function json<T>(value: T, init?: ResponseInit): Response {
  return Response.json(value, init);
}

const ORCHESTRATOR_SESSION_LONG_POLL_TIMEOUT_MS = 30_000;

/** An ACL refusal on the wake ledger is the caller's 403; anything else is
 * the daemon's 500. */
function mailWakeError<T>(error: T): Response {
  return json(
    { error: errorMessage(error) },
    { status: error instanceof MailWakeAclError ? 403 : 500 },
  );
}

/** Agent runtime reports use its record for id and capability-epoch fencing. */
type ProviderRuntimeSubject =
  | { readonly kind: "root" }
  | { readonly kind: "agent"; readonly agent: AgentRecord };

export class HiveDaemon {
  static readonly statusGenerationUnavailable =
    unavailableStatusIncarnationGenerationSource;

  readonly db: HiveDatabase;
  readonly mail: MailStore;
  readonly mailWake: MailWakeLedger;
  readonly mailService: MailService;
  readonly spawner: Spawner;
  private readonly gatedSpawner: GatedSpawner;
  readonly memory: MemoryIndex;
  readonly capabilities: CapabilityStore;
  readonly status: StatusService;
  private readonly statusEventProjector: StatusDerivedProjectionService | null;
  readonly observability: ObservabilityService;
  readonly episodic: EpisodicStore | null;
  private readonly memoryWrites: MemoryWriteService;
  private readonly memoryJobs = new Set<StartedMemoryJob["done"]>();
  private readonly ownsDatabase: boolean;
  private readonly port: number;
  private readonly hostname: string;
  private readonly manageLifecycle: boolean;
  private readonly initiateShutdown: () => void;
  private stopInProgress = false;
  private gracefulShutdownCheckpointed = false;
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
  /** Resolved on first use and kept: project identity costs a git call plus a registry read, and it cannot change while the daemon runs. */
  private artifactsRootPath: string | null = null;
  private artifactReadRootsCache: readonly string[] | null = null;
  /** Computed once. The handshake hashes the source tree in a checkout, and walking that tree on every /handshake probe is what made workspace-feed miss its 1s budget whenever a kill-time sweep occupied the event loop. The document cannot change while this process runs. */
  private handshakeDocument: Awaited<
    ReturnType<typeof expectedDaemonHandshake>
  > | null = null;
  private readonly assessStranded: NonNullable<
    HiveDaemonOptions["assessStrandedWork"]
  >;
  private readonly manifestJournal: ManifestJournal;
  private readonly worktrees: WorktreeLifecycleService;
  private readonly quota: QuotaService | undefined;
  private readonly tokenUsage: TokenUsageStore;
  private readonly modelInventory: HiveDaemonOptions["modelInventory"];
  private readonly modelControlSnapshot: () => Promise<ModelControlSnapshot>;
  private readonly refreshModelControl: (() => Promise<void>) | undefined;
  private readonly routingService: RoutingService;
  private readonly queenProviderService: QueenProviderService;
  readonly hierarchy: HierarchyService;
  private readonly queenVendorAvailability: () => Record<
    CapabilityProvider,
    { available: boolean }
  >;
  private readonly queenRootObservation:
    (() => CapabilityProvider | null) | null;
  private readonly approvalService: ApprovalService;
  private readonly workspaceOwnerService: WorkspaceOwnerService;
  private readonly memoryRetentionService: MemoryRetentionService;
  private readonly autonomy: AutonomyControl | undefined;
  private readonly graphify: GraphifyService | undefined;
  /** Restart recounts durable transcripts rather than trusting stale call counts. */
  private readonly graphifyCalls = new Map<string, GraphifyCallCursor>();
  private readonly mcpClientsSeen = new Map<string, string>();
  /** When this daemon started keeping `mcpClientsSeen`. The map is process-local, so it can only answer for credentials used after this instant: an absent entry from before it is unknown, never a negative. */
  private readonly mcpClientsSeenSince = new Date().toISOString();
  /** Authority is bound to validated SDK auth, never client request metadata. */
  private readonly mcpCapabilities = new WeakMap<AuthInfo, Capability>();
  private readonly mcpHandler: McpHttpHandler;
  private readonly mcpAllowedHostnames: string[];
  private readonly land: LandBranch;
  private bunServer: Server<undefined> | null = null;
  private readonly drainHandler: DrainHandler;
  private readonly maintenance: DaemonMaintenance;
  private readonly resources: ResourceLimits | null;
  private readonly wakeBudgetTokens: number | null;
  private readonly embeddingService: MemoryEmbeddingService | null;
  private readonly wakePayloadService: WakePayloadService;
  readonly embeddingIndex: MemoryEmbeddingIndex | null;
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
  private readonly projectGate: ProjectGate;
  private readonly mainHealthMonitor: MainHealthMonitorHandle | null;
  private memoryPressure = false;

  constructor(options: HiveDaemonOptions) {
    this.ownsDatabase = options.db === undefined;
    this.db = options.db ?? new HiveDatabase();
    this.mail = new MailStore(this.db);
    this.mailWake = new MailWakeLedger(
      new MailWakeStore(this.db),
      (recipient, state, at) => this.publishMailStatus(recipient, state, at),
      (exhausted) => this.mailService.reportUndeliveredWake(exhausted),
      (itemId) => this.mailService.stillOffers(itemId),
    );
    this.mailService = new MailService(
      {
        store: this.mail,
        recipients: (named: string) => this.mailRecipient(named),
        notifyReady: (ready) => this.mailWake.publishReady(ready),
        beforeClaim: (itemId, recipient) =>
          this.mailWake.requirePresented(itemId, recipient),
        beforeComplete: (itemId, recipient) =>
          this.mailWake.requireClaimed(itemId, recipient),
        safePointAt: (recipient) => this.db.latestSafePointAt(recipient),
        liveGeneration: (subject) => this.liveMailGeneration(subject),
      },
      options.mail,
    );
    this.status =
      options.statusService ??
      StatusService.create(this.db, hiveInstanceSuffix());
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
      options.daemonLog ?? ((line) => daemonLogFile.report(line));
    this.maintenance = new DaemonMaintenance(
      DAEMON_MAINTENANCE_INTERVAL_MS,
      (failure) => {
        this.observability.record({
          source: "daemon",
          operation: failure.component,
          reason: failure.error,
        });
      },
      options.maintenanceDrainTimeoutMs,
    );
    this.observability = new ObservabilityService(this.db, {
      log: (line) => this.writeDaemonLog(line),
      correlateSubject: (subject) => {
        const run = isOrchestratorName(subject)
          ? this.db.getActiveRootProviderRun(hiveInstanceSuffix())
          : (() => {
              const agent = this.db.getAgentByName(subject);
              return agent === null
                ? null
                : this.db.getActiveProviderRunForAgent(agent.id);
            })();
        const agent = isOrchestratorName(subject)
          ? null
          : this.db.getAgentByName(subject);
        return {
          agentId: agent?.id ?? run?.agentId ?? null,
          provider: run?.provider ?? null,
          providerRunId: run?.runId ?? null,
          vendorSessionId: run?.conversationId ?? null,
        };
      },
    });
    this.embeddingService =
      this.episodic !== null && options.memoryEmbeddings !== undefined
        ? new MemoryEmbeddingService(options.memoryEmbeddings, {
            ...definedFields({ load: options.memoryEmbeddingLoad }),
            log: (message) => this.writeDaemonLog(message),
          })
        : null;
    this.embeddingIndex =
      this.embeddingService !== null && this.episodic !== null
        ? new MemoryEmbeddingIndex({
            store: this.episodic,
            service: this.embeddingService,
            log: (message) => this.writeDaemonLog(message),
          })
        : null;
    this.statusEventProjector =
      this.episodic === null
        ? null
        : new StatusDerivedProjectionService({
            project: (event) => this.ingestEpisodicEvent(event),
            onDrop: (dropped) => {
              if (dropped === 1 || dropped % 100 === 0) {
                this.writeDaemonLog(
                  `Hive episodic status projection dropped ${dropped} derived event(s) after its queue filled.`,
                );
              }
            },
          });
    if (this.statusEventProjector !== null) {
      this.status.onEvent((event) => this.statusEventProjector?.enqueue(event));
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
    const configuredMcpHostname =
      this.hostname === "::1" ? "[::1]" : this.hostname;
    this.mcpAllowedHostnames = Array.from(
      new Set([
        ...localhostAllowedHostnames(),
        ...localhostAllowedOrigins(),
        configuredMcpHostname,
      ]),
    );
    this.mcpHandler = createMcpHandler(
      (context) => this.createMcpServer(this.mcpCapability(context)),
      {
        legacy: "stateless",
        responseMode: "auto",
        keepAliveMs: 15_000,
        maxSubscriptions: 128,
        onerror: (error) => {
          this.observability.record({
            source: "mcp-transport",
            operation: "mcp-request",
            reason: error.message,
          });
        },
      },
    );
    this.manageLifecycle = options.manageLifecycle ?? false;
    this.initiateShutdown =
      options.initiateShutdown ??
      (() => {
        // The short delay lets the /stop response flush before stop() force-closes the listener; the signal handlers own the rest of the teardown.
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
    this.gatedSpawner = new GatedSpawner(this.spawner, {
      isStopping: () => this.stopInProgress,
      admitRootWork: () => this.successionService().admitNewWork(),
      memoryPressure: () => this.memoryPressure,
      machineMutations: this.machineMutations,
    });
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
    this.refreshModelControl = options.refreshModelControl;
    this.modelControlSnapshot =
      options.modelControlSnapshot ??
      (() =>
        Promise.reject(
          new Error("the daemon has no model-control projection configured"),
        ));
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
    this.queenVendorAvailability =
      options.queenVendorAvailability ?? vendorAvailabilityReader();
    this.queenRootObservation = options.queenRootObservation ?? null;
    this.graphify = options.graphify;
    this.quota?.setAlertSink(async (body, standing) => {
      await this.mailService.publishSystem(
        "hive-quota",
        ORCHESTRATOR_NAME,
        body,
        standing,
      );
    });
    this.quota?.setConditionClearer(async (conditionId) => {
      this.mailService.clearStandingCondition(
        "hive-quota",
        ORCHESTRATOR_NAME,
        conditionId,
      );
    });
    this.land = options.landBranch ?? landBranch;
    this.resources = options.resources ?? null;
    this.wakeBudgetTokens = options.wakeBudgetTokens ?? null;
    this.wakePayloadService = new WakePayloadService({
      mailStore: this.mail,
      repoRoot: () => this.repoRoot,
      wakeBudgetTokens: this.wakeBudgetTokens ?? 300,
    });
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
          readProviderRun: (record) =>
            this.db.getActiveProviderRunForAgent(record.id),
        },
        beforeKill,
      );
    this.repoRoot = options.repoRoot ?? projectRootOrCwd();
    this.projectGate =
      options.projectGate ??
      ((worktree) => runLearnedProjectGate(this.repoRoot, worktree));
    // Verification is learned from the repo, never compiled in. A stranger's
    // checkout is not this source tree; even this source tree is learned the
    // same way. Tests may inject a monitor.
    this.mainHealthMonitor = options.mainHealthMonitor ?? null;
    this.approvalService = new ApprovalService({
      db: this.db,
      capabilities: this.capabilities,
      repoRoot: this.repoRoot,
      readLandReadiness: options.readLandReadiness ?? readLandReadiness,
      clock: systemClock,
      publish: (from, to, body, publishOptions) =>
        this.mailService.publishSystem(from, to, body, publishOptions),
      authorizeRoute: (request, route, action, authorizeOptions) =>
        this.authorizeRoute(request, route, action, authorizeOptions),
      authorizeTool: (capability, tool, action, subject, auditAllow) =>
        this.authorizeTool(capability, tool, action, subject, auditAllow),
    });
    this.routingService = new RoutingService({
      db: this.db,
      quota: this.quota,
      modelControlSnapshot: () => this.modelControlSnapshot(),
      forceQuotaRefresh:
        this.quota === undefined
          ? undefined
          : () => this.refreshQuota({ force: true, trigger: "operator" }),
      authenticate: (request, route) => this.authenticate(request, route),
      denied: (decision) => this.denied(decision),
      authorize: (
        capability,
        route,
        action,
        subject,
        auditAllow,
        allowReason,
      ) =>
        this.authorize(
          capability,
          route,
          action,
          subject,
          auditAllow,
          allowReason,
        ),
      authorizeRoute: (request, route, action, authorizeOptions) =>
        this.authorizeRoute(request, route, action, authorizeOptions),
    });
    this.workspaceOwnerService = new WorkspaceOwnerService({
      manageLifecycle: this.manageLifecycle,
      workspaceVisibility: this.workspaceVisibility,
      isServerRunning: () => this.bunServer !== null,
      isStopping: () => this.stopInProgress,
      requestShutdown: () => {
        this.stopInProgress = true;
        this.initiateShutdown();
      },
      authorizeRoute: (request, route, action, authorizeOptions) =>
        this.authorizeRoute(request, route, action, authorizeOptions),
    });
    this.memoryWrites = new MemoryWriteService({
      repoRoot: this.repoRoot,
      index: this.memory,
      embeddingIndex: this.embeddingIndex,
    });
    const artifacts = options.artifacts ?? ArtifactsConfigSchema.parse({});
    this.memoryRetentionService = new MemoryRetentionService({
      repoRoot: this.repoRoot,
      config: options.retention ?? null,
      episodic: this.episodic,
      serializeMemory: (operation) => this.memoryWrites.serialize(operation),
      rebuildMemoryIndex: () => this.rebuildMemoryIndex(),
      runSweep: (reason) => this.runMemoryRetentionSweep(reason),
      sweepArtifacts: () =>
        sweepArtifacts(
          this.artifactsRoot(),
          artifacts.retention_days,
          new Date(),
        ),
      artifactRetentionDays: artifacts.retention_days,
      log: (line) => this.writeDaemonLog(line),
    });
    this.assessStranded = options.assessStrandedWork ?? assessStrandedWork;
    this.manifestJournal =
      options.manifestJournal ?? new ManifestJournal(this.db);
    this.queenProviderService = new QueenProviderService({
      db: this.db,
      mail: this.mail,
      queenBootMailbox: () =>
        this.mailService.queenBootMailboxFor(ORCHESTRATOR_NAME),
      hierarchySnapshot: () => this.status.fetchSnapshot(),
      journal: this.manifestJournal,
      orchestratorSessiond: this.orchestratorSessiond,
      terminalHost: this.terminalHost,
      vendorAvailability: this.queenVendorAvailability,
      rootObservation: this.queenRootObservation,
      rootProviderStatus: (providerRunId) =>
        this.status.orchestratorProviderStatus(ORCHESTRATOR_NAME, providerRunId)
          ?.status ?? null,
      authenticate: (request, route) => this.authenticate(request, route),
      denied: (decision) => this.denied(decision),
      authorize: (
        capability,
        route,
        action,
        subject,
        auditAllow,
        allowReason,
      ) =>
        this.authorize(
          capability,
          route,
          action,
          subject,
          auditAllow,
          allowReason,
        ),
      authorizeRoute: (request, route, action, authorizeOptions) =>
        this.authorizeRoute(request, route, action, authorizeOptions),
      parseJsonBody: (request, schema) => this.parseJsonBody(request, schema),
    });
    this.worktrees = new WorktreeLifecycleService({
      db: this.db,
      repoRoot: this.repoRoot,
      clock: systemClock,
      publish: (from, to, body, publishOptions) =>
        this.mailService.publishSystem(from, to, body, publishOptions),
      assessStrandedWork: this.assessStranded,
      listSettlementBranches:
        options.listSettlementBranches ?? listSettlementBranches,
      reconcileOrphanedWorktrees:
        options.reconcileOrphanedWorktrees ?? reconcileWorktrees,
      processLiveness: (agent) => this.agentTreeLiveness(agent),
      onAlertDeliveryFailure: (error) => {
        this.observability.record({
          source: "daemon",
          operation: "hive-lifecycle alert delivery",
          reason: errorMessage(error),
        });
      },
    });
    this.hierarchy = new HierarchyService({
      db: this.db,
      repoRoot: this.repoRoot,
      authorizeTool: (capability, tool, action, subject, auditAllow) =>
        this.authorizeTool(capability, tool, action, subject, auditAllow),
      writeBoundaryCheckpoint: (event, run) =>
        this.successionService().writeBoundaryCheckpoint(event, run),
      machineMutations: options.machineMutations,
      onLanded: (agent, commit) => this.worktrees.onLanded(agent, commit),
    });
    const episodic = this.episodic;
    const drainDependencies: DrainHandlerDependencies = {
      db: this.db,
      quota: this.quota,
      publish: (from, to, body, options) =>
        this.mailService.publishSystem(from, to, body, options),
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
    };
    this.drainHandler =
      episodic === null
        ? new DrainHandler(drainDependencies)
        : new DrainHandler({
            ...drainDependencies,
            remember: (event) => {
              episodic.appendEvent(event);
            },
          });
    this.recovery = new CrashRecovery({
      db: this.db,
      terminalHost: this.terminalHost,
      publish: (from, to, body, options) =>
        this.mailService.publishSystem(from, to, body, options),
      mail: this.mail,
    });
    // Embedded daemons mint in memory and never overwrite a live token.
    if (this.manageLifecycle) {
      this.issueCredential(USER_SUBJECT, "user", 0, USER_TTL_MS);
      this.issueCredential(ORCHESTRATOR_NAME, "orchestrator", 0, USER_TTL_MS);
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

    // Fence the source epoch before asking the terminal to pause. This is the durable write boundary; process control then targets the exact old run.
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
      mail: this.mailService.unsettledFor(fenced.name),
      providerEvents: this.db.listProviderEvents(run.runId),
      statusEvents: this.status.listEventsForAgent(agent.id),
      output,
      memory: await listMemoryFacts(this.repoRoot).catch(() => []),
      createdAt: new Date().toISOString(),
    });
    this.db.insertHandoff(bundle);

    // Persistence is the boundary: failure from here onward cannot erase the task, worktree measurements, or evidence needed by another provider.
    if (paused) await this.terminalHost.stopProvider(locator, run);
    // Route the replacement now that the handoff is durable, excluding the proven-drained pool so the work cannot land back on the route that just demonstrated it cannot continue. A refused route (no candidate) falls back to the durable orchestrator notice — quota lifecycle and the user decide wait versus preserve; nothing busy-retries here.
    try {
      const replacement = await this.gatedSpawner.spawnDrainReplacement({
        task: fenced.taskDescription,
        category: fenced.category,
        handoffId: bundle.handoffId,
        ...definedFields({
          excludedPoolIds: drain.pool === null ? undefined : [drain.pool],
        }),
      });
      await this.mailService.publishSystem(
        "hive-handoff",
        ORCHESTRATOR_NAME,
        `${agent.name} drained its quota; handoff ${bundle.handoffId} is durable and ` +
          `${replacement.name} (${replacement.tool}/${replacement.model}) was launched to pick it up. ` +
          "The source terminal and worktree remain retained.",
        {
          idempotencyKey: `handoff-replacement:${bundle.handoffId}`,
        },
      );
    } catch (error) {
      await this.mailService.publishSystem(
        "hive-handoff",
        ORCHESTRATOR_NAME,
        `${agent.name}'s quota handoff ${bundle.handoffId} is durable; the source terminal and worktree remain retained. ` +
          `No replacement could be routed away from the proven drained ${
            drain.pool === null
              ? `${drain.provider} route`
              : `${drain.provider}/${drain.pool} pool`
          }${drain.resetsAt === null ? "" : ` until ${drain.resetsAt}`}: ${errorMessage(
            error,
          )}`,
        {
          idempotencyKey: `handoff-awaiting-route:${bundle.handoffId}`,
        },
      );
    }
  }

  /** Only the daemon mints credentials; each subject has one current token. */
  issueCredential(
    subject: string,
    role: Role,
    epoch: number,
    ttlMs?: number,
  ): string {
    this.capabilities.revokeSubject(subject);
    // Startup/generic mint stays unconstrained. Root visible-text self-observe is granted only by the launcher mint (POST /codex-root-token) so the pre-launch queen.cap is not widened beyond what Q needs.
    const { token } = this.capabilities.mint(subject, role, {
      epoch,
      ...definedFields({ ttlMs }),
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
      { route, action, ...definedFields({ subject }) },
      auditAllow,
      allowReason,
    );
  }

  /** The authenticate + authorize prelude shared by the route handlers.
   * `withSubject` audits against the authenticated capability's own subject
   * (an agent acting on its own inbox); `auditAllow` stays true except on
   * poll surfaces, which pass false. Returns the denial to send back, or the
   * authenticated capability. */
  private authorizeRoute(
    request: Request,
    route: string,
    action: Action,
    options: Readonly<{ withSubject?: boolean; auditAllow?: boolean }> = {},
  ): RouteAuthorization {
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok)
      return { ok: false, response: this.denied(authenticated) };
    const decision = this.authorize(
      authenticated.capability,
      route,
      action,
      options.withSubject === true
        ? authenticated.capability.subject
        : undefined,
      options.auditAllow ?? true,
    );
    if (!decision.ok) return { ok: false, response: this.denied(decision) };
    return { ok: true, capability: authenticated.capability };
  }

  /** Parse a JSON request body against a schema, or the 400 to send back. */
  private async parseJsonBody<T>(
    request: Request,
    schema: z.ZodType<T>,
  ): Promise<
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly response: Response }
  > {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return {
        ok: false,
        response: json({ error: parsed.error.message }, { status: 400 }),
      };
    }
    return { ok: true, data: parsed.data };
  }

  /** MCP denial names the refused rule, never the token. */
  private authorizeTool(
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow = true,
  ): void {
    // The root's own calls pass the succession gate first: while a succession awaits attestation her authority is limited to the recovery tools, and her re-read of status/inbox is measured here as it happens, bound to the exact credential making the call.
    if (capability.subject === ORCHESTRATOR_NAME) {
      this.successionService().gateRootToolCall(capability, tool);
    }
    const decision = this.authorize(
      capability,
      `/mcp:${tool}`,
      action,
      subject,
      auditAllow,
    );
    if (!decision.ok) throw new AuthorizationRefusedError(decision.message);
  }

  private mailRecipient(named: string): MailRecipientState {
    const canonical = canonicalOrchestratorName(named);
    if (canonical === ORCHESTRATOR_NAME) return { kind: "live", canonical };
    const recipient = this.db.getAgentByName(canonical);
    if (recipient === null) {
      return this.db.isAgentNameReserved(canonical)
        ? { kind: "live", canonical }
        : { kind: "absent" };
    }
    if (["dead", "done"].includes(recipient.status)) {
      return { kind: "terminal", status: recipient.status };
    }
    if (
      this.spawner.hierarchyRecipientBindingState?.(recipient) === "unbound"
    ) {
      return { kind: "unbound" };
    }
    return { kind: "live", canonical: recipient.name };
  }

  /** Mail fences session generation, not capability epoch; no live session is never zero. */
  private liveMailGeneration(subject: string): number | null {
    if (canonicalOrchestratorName(subject) !== ORCHESTRATOR_NAME) {
      return (
        this.db.getAgentByName(subject)?.sessionLocator?.generation ?? null
      );
    }
    const running = this.orchestratorSessiond?.snapshot()?.locator.generation;
    if (running !== undefined) return running;
    // The controller holds the running root in memory, and a daemon that has restarted under a live root has not taken that snapshot yet. Its generation is durable regardless: it is the highest root session this instance has bound, which is the same fact the snapshot is minted from.
    const bound = this.db
      .listTerminalHostBindings(hiveInstanceSuffix())
      .reduce(
        (highest, binding) =>
          binding.locator.subject.kind === "root"
            ? Math.max(highest, binding.locator.generation)
            : highest,
        0,
      );
    return bound === 0 ? null : bound;
  }

  private waitingRootInstructions(): Map<string, string[]> {
    const waiting = new Map<string, string[]>();
    for (const agent of this.db.listAgents()) {
      const bodies = this.mailService
        .unsettledFor(agent.name)
        .filter((item) => isOrchestratorName(item.sender))
        .map((item) => item.body);
      if (bodies.length > 0) waiting.set(agent.name, bodies);
    }
    return waiting;
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

  /** Receiving-side record of this credential's authenticated MCP requests: when it was last seen, and the start of the window this daemon can answer for. */
  mcpCredentialObservation(subject: string): McpCredentialObservation {
    return {
      lastAuthenticatedAt: this.mcpClientsSeen.get(subject) ?? null,
      observingSince: this.mcpClientsSeenSince,
    };
  }

  /** Receiving-side proof that this credential authenticated after `since`. */
  mcpClientSeen(subject: string, since: string): boolean {
    const { lastAuthenticatedAt } = this.mcpCredentialObservation(subject);
    return lastAuthenticatedAt !== null && lastAuthenticatedAt >= since;
  }

  prepareSessiondSpawn(): Promise<Readonly<{ engineBuildId: string }> | null> {
    return this.workspaceVisibility?.prepare() ?? Promise.resolve(null);
  }

  prepareAgentSessiondSpawn(): Promise<WorkspaceVisibilityLease | null> {
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
      // Fleet shutdown verifies each captured process tree in sequence. The default 10-second request timeout can sever a healthy /stop before that verification finishes, even though teardown continues server-side.
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
    this.db.clearAgentNameReservations();
    this.maintenance.start(() => this.runMaintenance());
    this.workspaceOwnerService.start();
    this.memoryRetentionService.start();
    this.mainHealthMonitor?.start();
    if (this.embeddingService !== null) {
      const status = this.embeddingService.status();
      const line =
        status.state === "unavailable"
          ? `Hive memory embeddings: UNAVAILABLE — ${status.detail}`
          : `Hive memory embeddings: provider=${this.embeddingService.provider} ` +
            `model=${this.embeddingService.model} (loads lazily on first use; ` +
            "[memory] embedding_provider / embedding_model)";
      this.writeDaemonLog(line);
    }
    // The socket tree is counted once here so the sweep threshold is checked
    // against a reported number instead of passing unnoticed. Counting only:
    // no probe, no unlink — a live node and a stale one both count.
    try {
      const hiveHome = getHiveHome();
      this.writeDaemonLog(
        `Hive sessiond socket root: ${countSocketRootNodes(hiveHome)} node(s) under ${sessiondRuntimeRoot(hiveHome)} (sweep threshold ${SOCKET_ROOT_SWEEP_THRESHOLD})`,
      );
    } catch (error) {
      // A failed observation says so; it never reads as a quiet zero and
      // never breaks the start it rides on.
      this.writeDaemonLog(
        `Hive sessiond socket root: node count failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    void this.runMaintenance()
      .catch((error) => {
        console.error(
          `Hive startup recovery failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      })
      .finally(() =>
        this.workspaceOwnerService.armRegistrationTimeoutAfterRecovery(),
      );
    this.quotaBootRefresh = this.refreshQuota({ force: true }).catch(
      (error) => {
        console.error(
          `Hive quota discovery failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
    );
    if (this.episodic !== null) {
      void this.startTrackedMemoryJob("reindex", "daemon-startup").done;
    }
    void this.graphify?.start().catch((error) => {
      console.error(
        `Hive graphify start failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
    return this.bunServer;
  }

  private serializeMemory<T>(operation: () => Promise<T>): Promise<T> {
    return this.memoryWrites.serialize(operation);
  }

  /** An unwired semantic leg yields byte-identical FTS-only recall. */
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

  private semanticRecallState(): (() => string) | undefined {
    const service = this.embeddingService;
    if (service === null) return undefined;
    return () => service.stateLabel();
  }

  private memoryEmbeddingsStatusSection(): MemoryEmbeddingsStatusSection {
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
      ...definedFields({
        detail: status.state === "unavailable" ? status.detail : undefined,
      }),
      runtimeDir: embeddingsRuntimeDir(),
      vectors: {
        articles: counts.articles,
        facts: counts.facts,
        total: counts.articles + counts.facts,
      },
    };
  }

  async writeMemoryFact(input: MemoryWriteInput) {
    return this.memoryWrites.write(input);
  }

  async deleteMemoryFact(scope: MemoryScope, id: string): Promise<boolean> {
    return this.memoryWrites.delete(scope, id);
  }

  async rebuildMemoryIndex(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.serializeMemory(async () => {
      signal?.throwIfAborted();
      const result = await this.memory.rebuild(this.repoRoot, signal);
      signal?.throwIfAborted();
      if (
        this.embeddingIndex !== null &&
        this.embeddingService !== null &&
        this.episodic !== null
      ) {
        const articles = await listMemoryFacts(this.repoRoot);
        signal?.throwIfAborted();
        this.embeddingIndex.prune(
          new Set(articles.map((article) => `${article.scope}:${article.id}`)),
        );
        const sources = articles.map((article) => ({
          kind: "article" as const,
          scope: article.scope,
          id: article.id,
          text: MemoryEmbeddingIndex.articleText(article),
        }));
        const identity = (kind: string, scope: string, id: string): string =>
          `${kind}:${scope}:${id}`;
        const embeddingModel = this.embeddingService.model;
        const indexedBefore = new Set(
          this.episodic
            .memoryEmbeddings()
            .filter((row) => row.model === embeddingModel)
            .map((row) => identity(row.kind, row.scope, row.sourceId)),
        );
        const missing = sources.filter(
          (source) =>
            !indexedBefore.has(identity(source.kind, source.scope, source.id)),
        );
        if (
          missing.length > 0 &&
          this.embeddingService.status().state !== "unavailable" &&
          (await this.embeddingService.embedder()) !== null
        ) {
          signal?.throwIfAborted();
          for (const source of missing) {
            signal?.throwIfAborted();
            const outcome = await this.embeddingIndex.upsertArticle(
              source.scope,
              source.id,
              source.text,
            );
            signal?.throwIfAborted();
            if (outcome !== "indexed") break;
          }
        }
        const indexedAfter = new Set(
          this.episodic
            .memoryEmbeddings()
            .filter((row) => row.model === embeddingModel)
            .map((row) => identity(row.kind, row.scope, row.sourceId)),
        );
        const indexed = sources.filter((source) =>
          indexedAfter.has(identity(source.kind, source.scope, source.id)),
        ).length;
        this.writeDaemonLog(
          `Hive memory vector coverage after reindex: expected=${sources.length} ` +
            `indexed=${indexed} missing=${sources.length - indexed}`,
        );
      }
      signal?.throwIfAborted();
      return result;
    });
  }

  /** Fresh limits tighten reservations; missing readings never loosen them. */
  async refreshQuota(
    options: {
      force?: boolean;
      providers?: readonly CapabilityProvider[];
      trigger?: "operator";
    } = {},
  ): Promise<QuotaRefreshReport[]> {
    if (this.quota === undefined) return [];
    return this.quota.refreshFromProviders(undefined, options);
  }

  async quotaReady(): Promise<void> {
    await this.quotaBootRefresh;
  }

  /** Rate limits drain instead of entering launch-failure quarantine. */
  async onVendorDrainError(agent: AgentRecord, failure: string): Promise<void> {
    await this.drainHandler.onVendorError(agent, failure);
  }

  private quotaBootRefresh: Promise<unknown> = Promise.resolve();

  private hasCompletedSessiondBinding(agent: AgentRecord): boolean {
    return (
      this.db.getTerminalHostBindingByLocator(
        requireSessiondAgentLocator(agent),
      )?.createEvidence !== undefined
    );
  }

  private publishMailStatus(
    recipient: string,
    state: MailStatusState,
    at: string,
  ): void {
    const agent = this.db.getLiveAgentByName(recipient);
    if (agent === undefined || agent === null) return;
    this.status.appendSourceEvent({
      entity: { kind: "agent", id: agent.id },
      occurredAt: at,
      kind: "status.mail",
      source: {
        kind: "sessiond",
        id: `mail:${agent.id}`,
        observedAt: at,
        confidence: "authoritative",
      },
      data: { agentId: agent.id, value: state },
    });
  }

  private statusLiveness(
    stored: AgentRecord,
    sessions: Awaited<ReturnType<HiveTerminalHostAdapter["list"]>> | null,
  ): AgentRecord {
    const agent = stored;
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
      status: "unknown",
    };
  }

  async runMaintenance(): Promise<void> {
    const tasks: MaintenanceTask[] = [
      ...(this.quota?.needsRefresh() === true
        ? [
            {
              component: "quota refresh",
              run: async () => {
                await this.refreshQuota();
              },
            },
          ]
        : []),
      ...(this.refreshModelControl === undefined
        ? []
        : [
            {
              component: "model-control refresh",
              run: async () => {
                await this.refreshModelControl?.();
              },
            },
          ]),
      {
        component: "quota reservation recovery",
        run: async () => {
          await this.recoverQuotaReservations();
        },
      },
      {
        component: "quota drain sweep",
        run: async () => {
          await this.drainHandler.sweep();
        },
      },
      {
        component: "agent reconciliation",
        run: async () => {
          await this.reconcileAgents();
        },
      },
      {
        component: "tool telemetry sweep",
        run: async () => {
          await this.refreshToolTelemetry();
        },
      },
      {
        component: "token-usage sweep",
        run: async () => {
          await this.tokenUsage.refreshCurrent(this.repoRoot);
        },
      },
      {
        component: "mail deadline sweep",
        run: async () => {
          await this.mailService.sweep(new Date());
        },
      },
      {
        component: "resource sweep",
        run: async () => {
          await this.sweepResources();
        },
      },
      {
        component: "worktree reconciliation",
        run: async () => {
          await this.reconcileOrphanedWorktrees().catch((error) => {
            this.worktrees.recordSettlementMeasurementFailure(error);
          });
        },
        minimumIntervalMs: EXPENSIVE_MAINTENANCE_INTERVAL_MS,
      },
    ];
    await this.maintenance.sweep(tasks, () => {
      this.db.pruneHistory(new Date().toISOString());
    });
  }

  async refreshToolTelemetry(): Promise<void> {
    return refreshToolTelemetrySweep({
      db: this.db,
      graphify: this.graphify,
      graphifyCalls: this.graphifyCalls,
    });
  }

  async sweepResources(): Promise<void> {
    return sweepResourcesCycle({
      db: this.db,
      publish: (from, to, body, options) =>
        this.mailService.publishSystem(from, to, body, options),
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
          const teardown = await this.killAgentTeardown(agent);
          const processOutcome =
            teardown.reaped.survivors.length === 0
              ? "all captured processes were stopped"
              : `${teardown.reaped.survivors.length} captured process(es) survived SIGKILL and remain running`;
          await this.mailService
            .publishSystem(
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

  private async settleReservationsOfDeadAgents(): Promise<void> {
    if (this.quota === undefined) return;
    for (const reservation of this.quota.ledger.activeReservations()) {
      const agent = this.db.getAgentByName(reservation.agentName);
      if (agent === null) continue;
      const dead = agent.status === "dead" || agent.status === "done";
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

  /** All kill doors preserve unlanded work before optional worktree removal. */
  /** Can this agent's process tree be positively read as gone? Fail closed: an unreachable host or broker proves nothing. */
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

  private async agentTreeLiveness(
    agent: AgentRecord,
  ): Promise<"live" | "dead" | "unknown"> {
    try {
      const inspection = await this.terminalHost.inspect(
        requireSessiondAgentLocator(agent),
      );
      return sessiondTerminalIsDead(inspection) ? "dead" : "live";
    } catch {
      return this.hasNeverBoundSessiondGeneration(agent) ? "dead" : "unknown";
    }
  }

  /** A sessiond host binding is written before the host is created. Its absence therefore proves this generation never acquired a process tree; unlike an unreachable bound host, it is safe to clean the failed spawn row. */
  private hasNeverBoundSessiondGeneration(agent: AgentRecord): boolean {
    const locator = requireSessiondAgentLocator(agent);
    return this.db.getTerminalHostBindingByLocator(locator) === null;
  }

  /** Git rechecks stranded work but never authorizes its deletion or release. */
  async killAgentTeardown(
    agent: AgentRecord,
    options: {
      removeWorktree?: boolean;
      at?: string;
    } = {},
  ): Promise<{
    agent: AgentRecord;
    cleaned: {
      sessionId: string;
    };
    worktree: WorktreeKillResult;
    reaped: ReapOutcome;
    preserved: {
      branch: string;
      ref: string;
      salvageRef?: string;
    } | null;
    stranded: TeardownStrandedWork | null;
  }> {
    // Register deliberate-kill intent BEFORE the first destructive step. While the process is dead but markAgentDead has not landed, the row matches the recovery sweep's crash predicate. The marker is cleared only after dead status is durable; a teardown that fails in between leaves it set, because a deliberately killed agent must never be resurrected by the sweep.
    this.recovery.noteDeliberateKill(agent.id);
    // Stop the agent's processes BEFORE capturing the worktree (invariant I7: decide on a quiesced worktree). A live agent mid-write leaves dirty tracked files that an explicit removeWorktree would silently downgrade to keep; measuring after the process is gone is the only way a clean post-stop worktree can be released.
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
        // If teardown throws after the processes are gone, the agent is dead; record that and finish the teardown. A tree whose absence cannot be proved keeps the failure: unreachable is not dead.
        if (!(await this.agentTreeAbsent(agent))) throw error;
        revoke();
        reaped = { killed: [], survivors: [] };
      }
    }
    // Capture the final known work state on the now-quiesced worktree and journal it BEFORE the ladder may destroy the worktree and branch. A journal written after them could describe work that no longer exists. A failed append must not wedge the kill: it is reported, and teardown proceeds, exactly like a failed preservation.
    const capture = await this.worktrees.captureFinalWorkManifest(agent);
    try {
      this.manifestJournal.append(capture.manifest);
    } catch (error) {
      console.error(
        `Hive manifest journal append for ${agent.name} failed: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    const timestamp = options.at ?? new Date().toISOString();
    const killed = this.db.markAgentDead(agent.id, timestamp);
    if (killed === null) {
      throw new Error(`Hive agent not found: ${agent.name}`);
    }
    this.recovery.clearDeliberateKill(agent.id);
    const closedAssignment = this.status.closeAssignment(agent.id, timestamp);
    await this.settleAgentQuota(killed, timestamp);
    void this.refreshQuota({ force: true, providers: [agent.tool] }).catch(
      (error) => {
        console.error(
          `Hive quota refresh after ${agent.name} closed failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
    );
    const settled = await this.worktrees.settleTeardownWorktree({
      agent,
      updated: killed,
      capture,
      at: timestamp,
      removeWorktree: options.removeWorktree ?? false,
    });
    const { agent: updated, preserved, stranded } = settled;
    // Session identity only — worktree fate lives on the structured worktree field so cleaned:{worktreePath:null} can no longer mean three different things.
    const cleaned = {
      sessionId: requireSessiondAgentLocator(agent).sessionId,
    };
    const worktree = describeWorktreeKill(agent, settled);

    await this.reportKill(agent, reaped);

    // A session end is a harvest activity boundary: failure clusters become unverified pitfall candidates citing their source events. Failure-isolated — a harvest failure must never add failure modes to a kill.
    this.harvestSessionPitfalls(
      agent.id,
      closedAssignment?.assignmentId ?? null,
      "agent session end",
    );

    // A session end is a retention lifecycle boundary (S3.7 DoD 5): the sweep rides it. Fire-and-forget — retention is maintenance and must never add failure modes to a kill.
    this.triggerMemoryRetentionSweep("agent session end");

    return { agent: updated, cleaned, worktree, reaped, preserved, stranded };
  }

  /** Report surviving processes; settlement state is reported by its aggregate. */
  private async reportKill(
    agent: AgentRecord,
    reaped: ReapOutcome,
  ): Promise<void> {
    if (reaped.survivors.length > 0) {
      await this.mailService
        .publishSystem(
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

  /** Continue closing agents after a failure so shutdown cannot orphan others. */
  private async killAllAgents(): Promise<void> {
    const failures: string[] = [];
    for (const agent of this.db.listAgents()) {
      if (!isLiveAgent(agent)) continue;
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

  private checkpointGracefulShutdown(): void {
    if (this.gracefulShutdownCheckpointed) return;
    this.successionService().writeBoundaryCheckpoint("graceful-shutdown");
    this.gracefulShutdownCheckpointed = true;
  }

  /** Episodic projection failure never breaks its primary status write. */
  private ingestEpisodicEvent(event: WorkspaceEventV2): void {
    if (this.episodic === null) return;
    try {
      const summary = isString(event.data.summary)
        ? event.data.summary
        : event.kind;
      const agentId =
        event.entity.kind === "agent"
          ? event.entity.id
          : isString(event.data.agentId)
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
          data: event.data,
        },
      });
      // A landing/completion event is a harvest activity boundary. Failure-isolated separately so a harvest failure is never reported as an ingest failure.
      if (agentId !== null && isHarvestBoundaryEvent(event.kind, event.data)) {
        const sessionId =
          this.status.currentAssignment(agentId)?.assignmentId ?? null;
        this.harvestSessionPitfalls(
          agentId,
          sessionId,
          `landing/completion event ${event.kind}`,
        );
      }
    } catch (error) {
      console.error(
        `Hive episodic ingest failed for ${event.kind} (${event.eventId}): ${errorMessage(
          error,
        )}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.manageLifecycle) {
      this.stopInProgress = true;
      try {
        this.checkpointGracefulShutdown();
      } catch (error) {
        this.stopInProgress = false;
        throw new Error(
          `Hive refused shutdown because the graceful-shutdown checkpoint failed: ${errorMessage(
            error,
          )}`,
        );
      }
    }
    // Once the checkpoint is verified, a teardown refusal is a report to the caller, not a reason to stay half-alive. Release daemon resources either way, then rethrow so teardown failure is still a failed quit.
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
          if (!sessiondTeardownSucceeded(terminated)) {
            throw new Error(
              `Hive refused shutdown because the queen termination is ${terminated.state} with ${terminated.survivors.length} survivor(s)`,
            );
          }
        }
      } catch (error) {
        refusal = error;
      }
    }
    try {
      await this.maintenance.stop();
    } catch (error) {
      refusal =
        refusal === undefined
          ? error
          : new Error(
              `Hive refused shutdown for more than one reason: ${errorMessage(refusal)}; ${errorMessage(error)}`,
            );
    }
    await this.mainHealthMonitor?.stop();
    await this.worktrees.stop();
    this.workspaceOwnerService.close();
    this.memoryRetentionService.close();
    await this.mcpHandler.close();
    this.bunServer?.stop(true);
    this.bunServer = null;
    await this.statusEventProjector?.stop();
    await Promise.allSettled(this.memoryJobs);
    await this.graphify?.stop();
    if (this.manageLifecycle) {
      cleanupLifecycleFiles();
    }
    if (this.ownsDatabase) {
      this.db.close();
    }
    this.episodic?.close();
    this.ownedMachineMutations?.close();
    this.routingService.close();
    if (refusal !== undefined) throw refusal;
  }

  // Crash detection and recovery: any agent whose status claims a process but whose terminal session is gone gets reported to the orchestrator with evidence. The sweep never relaunches a conversation, marks the agent dead, or touches its worktree — closing it (hive_mark_dead/hive_kill) or reviving it with a fresh spawn is the orchestrator's call.
  async reconcileAgents(): Promise<RecoveryOutcome[]> {
    return this.recovery.sweep();
  }

  /** Retention needs config and episodic memory. */
  async runMemoryRetentionSweep(
    reason = "manual",
  ): Promise<RetentionSweepReport | null> {
    return this.memoryRetentionService.runMemoryRetentionSweep(reason);
  }

  private async handshakeDocumentOnce(): Promise<
    Awaited<ReturnType<typeof expectedDaemonHandshake>>
  > {
    this.handshakeDocument ??= await expectedDaemonHandshake(this.repoRoot);
    return this.handshakeDocument;
  }

  private artifactsRoot(): string {
    this.artifactsRootPath ??= artifactsRoot(this.repoRoot);
    return this.artifactsRootPath;
  }

  private artifactReadRoots(): readonly string[] {
    this.artifactReadRootsCache ??= artifactReadRoots(this.repoRoot);
    return this.artifactReadRootsCache;
  }

  /** Retention failure is logged maintenance noise, never a daemon failure. */
  private triggerMemoryRetentionSweep(reason: string): void {
    this.memoryRetentionService.triggerMemoryRetentionSweep(reason);
  }

  /** Harvest follows digest compilation and shares the serialized memory write path. */
  private harvestSessionPitfalls(
    agentId: string,
    sessionId: string | null,
    reason: string,
  ): void {
    const episodic = this.episodic;
    if (episodic === null) return;
    const harvestDeps = {
      store: episodic,
      repoRoot: this.repoRoot,
      agent: agentId,
      sessionId,
      write: (input: Parameters<typeof this.writeMemoryFact>[0]) =>
        this.writeMemoryFact(input),
      search: (query: string) => this.memory.search(query, { limit: 5 }),
    };
    void harvestPitfalls(harvestDeps).catch((error) => {
      const line = `Hive pitfall harvest (${reason}) failed for ${agentId}: ${errorMessage(
        error,
      )}`;
      this.writeDaemonLog(line);
    });
    void harvestVerification(harvestDeps).catch((error) => {
      const line = `Hive verification harvest (${reason}) failed for ${agentId}: ${errorMessage(
        error,
      )}`;
      this.writeDaemonLog(line);
    });
  }

  async openWorktreeSettlementCase(
    agent: AgentRecord,
    worktree: { path: string; branch: string },
    baseOid: string | null,
  ): Promise<void> {
    return this.worktrees.openSettlementCase(agent, worktree, baseOid);
  }

  async settleFailedSpawnWorktree(
    agent: AgentRecord,
    worktree: { path: string; branch: string } | null,
    keepOnFailure: boolean,
  ) {
    return this.worktrees.settleFailedSpawn(agent, worktree, keepOnFailure);
  }

  async reconcileOrphanedWorktrees(): Promise<WorktreeReconciliationReport> {
    return this.worktrees.reconcileOrphanedWorktrees();
  }

  async recoverCrashedAgents(name?: string): Promise<RecoveryOutcome[]> {
    if (name !== undefined) {
      return [await this.recovery.recoverAgent(name)];
    }
    return this.recovery.sweep();
  }

  queueProviderApproval(
    agentName: string,
    requestId: string,
    description: string,
  ): string {
    return this.approvalService.queueProviderApproval(
      agentName,
      requestId,
      description,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
      const maintenance = this.maintenance.health();
      const ok = database.status === "ok" && maintenance.status === "ok";
      return json(
        {
          ok,
          version: HIVE_VERSION,
          database,
          maintenance,
        },
        { status: ok ? 200 : 503 },
      );
    }
    if (url.pathname === "/handshake" && request.method === "GET") {
      // The sessiond broker authenticates by fetching this over a raw socket and reading to EOF (`Connection: close`); Bun keep-alive would leave that read hanging until its timeout and fail broker auth closed.
      return json(await this.handshakeDocumentOnce(), {
        headers: { connection: "close" },
      });
    }
    if (url.pathname === "/event" && request.method === "POST") {
      return this.receiveEvent(request);
    }
    if (url.pathname === "/agent-status" && request.method === "POST") {
      return this.receiveAgentStatus(request);
    }
    if (url.pathname === "/observability/events" && request.method === "POST") {
      return this.observabilityReportEndpoint(request);
    }
    if (url.pathname === "/observability/errors" && request.method === "GET") {
      return this.observabilityQueryEndpoint(url, request);
    }
    if (
      url.pathname === "/provider-permission/prompt" &&
      request.method === "POST"
    ) {
      return this.approvalService.providerPermissionPromptEndpoint(request);
    }
    if (
      url.pathname === "/provider-permission/decisions" &&
      request.method === "GET"
    ) {
      return this.approvalService.providerPermissionDecisionsEndpoint(request);
    }
    if (
      url.pathname === "/provider-permission/settled" &&
      request.method === "POST"
    ) {
      return this.approvalService.providerPermissionSettledEndpoint(request);
    }
    if (
      url.pathname === "/provider-permission/ack" &&
      request.method === "POST"
    ) {
      return this.approvalService.providerPermissionAckEndpoint(request);
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
      return this.routingService.routingPolicyEndpoint(request);
    }
    if (url.pathname === "/routing/inspect" && request.method === "GET") {
      return this.routingService.routingInspectEndpoint(url, request);
    }
    if (url.pathname === "/routing/escalations" && request.method === "GET") {
      return this.routingService.routingEscalationsEndpoint(request);
    }
    if (
      url.pathname === "/model-control/snapshot" &&
      request.method === "GET"
    ) {
      return this.routingService.modelControlSnapshotEndpoint(request);
    }
    if (
      url.pathname === "/model-control/probe-refresh" &&
      request.method === "POST"
    ) {
      return this.routingService.modelControlProbeRefreshEndpoint(request);
    }
    if (url.pathname === "/workspace-snapshot" && request.method === "GET") {
      return this.workspaceSnapshotEndpoint(request);
    }
    if (
      url.pathname === "/live-run-control" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return liveRunControlEndpoint(
        {
          db: this.db,
          terminalHost: this.terminalHost,
          terminateAgent: async (agent) => {
            await this.killAgentTeardown(agent);
          },
          now: () => new Date(),
          authenticate: (req, route) => this.authenticate(req, route),
          authorize: (capability, route, action, subject, audit, reason) =>
            this.authorize(capability, route, action, subject, audit, reason),
          denied: (decision) => this.denied(decision),
        },
        request,
      );
    }
    if (url.pathname === "/agent-ui/quota" && request.method === "GET") {
      return this.agentUiQuotaEndpoint(request);
    }
    if (url.pathname === "/mail-ready" && request.method === "GET") {
      return this.mailReadyEndpoint(request, url);
    }
    if (url.pathname === "/mail-ready/ack" && request.method === "POST") {
      return this.mailReadyAckEndpoint(request);
    }
    if (url.pathname === "/mail/lease-heartbeat" && request.method === "POST") {
      return this.mailLeaseHeartbeatEndpoint(request);
    }
    if (url.pathname === "/mail-wake/report" && request.method === "POST") {
      return this.mailWakeReportEndpoint(request);
    }
    if (url.pathname === "/wake-payload" && request.method === "POST") {
      return this.wakePayloadEndpoint(request);
    }
    if (
      url.pathname === "/provider-capabilities" &&
      request.method === "POST"
    ) {
      return this.providerCapabilitiesEndpoint(request);
    }
    if (url.pathname === "/provider-runtime" && request.method === "POST") {
      return this.providerRuntimeEndpoint(request);
    }
    if (url.pathname === "/run-control" && request.method === "POST") {
      return this.runControlEndpoint(request);
    }
    if (
      url.pathname === "/orchestrator-session" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return this.orchestratorSessionEndpoint(url, request);
    }
    if (
      url.pathname === "/orchestrator-session/headless" &&
      request.method === "POST"
    ) {
      return this.orchestratorSessionHeadlessEndpoint(request);
    }
    if (
      url.pathname === "/queen-provider" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return this.queenProviderService.queenProviderEndpoint(request);
    }
    if (url.pathname === "/queen/compact-reload" && request.method === "GET") {
      return this.queenProviderService.queenCompactReloadEndpoint(request);
    }
    if (
      url.pathname === "/queen-succession/steer" &&
      request.method === "GET"
    ) {
      return this.queenProviderService.queenSuccessionSteerEndpoint(request);
    }
    if (
      url.pathname === "/queen-succession/prepare-launch" &&
      request.method === "POST"
    ) {
      return this.queenProviderService.queenSuccessionPrepareLaunchEndpoint(
        request,
      );
    }
    if (
      url.pathname === "/queen-succession/replies" &&
      request.method === "POST"
    ) {
      return this.queenProviderService.queenSuccessionRepliesEndpoint(request);
    }
    if (
      url.pathname === "/queen-succession/projection" &&
      request.method === "GET"
    ) {
      return this.queenProviderService.queenSuccessionProjectionEndpoint(
        request,
      );
    }
    if (
      url.pathname === "/queen-succession/launch-failure" &&
      request.method === "POST"
    ) {
      return this.queenProviderService.queenSuccessionLaunchFailureEndpoint(
        request,
      );
    }
    if (url.pathname === "/orchestrator-status" && request.method === "GET") {
      return this.orchestratorStatusEndpoint(request);
    }
    if (url.pathname.startsWith("/memory/")) {
      return this.memoryEndpoint(url, request);
    }
    if (url.pathname === "/workspace-visibility" && request.method === "POST") {
      return this.workspaceVisibilityEndpoint(request);
    }
    if (url.pathname === "/workspace-owner" && request.method === "POST") {
      return this.workspaceOwnerService.workspaceOwnerEndpoint(request);
    }
    if (url.pathname === "/token-usage" && request.method === "GET") {
      return this.tokenUsageEndpoint(url, request);
    }
    if (
      url.pathname === "/token-usage/protocol-session-facts" &&
      request.method === "POST"
    ) {
      return this.receiveProtocolSessionFacts(request);
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
      /^\/token-usage\/subjects\/([^/]+)\/(end|events)$/,
    );
    if (tokenSubject !== null && request.method === "POST") {
      const subjectId = tokenSubject[1];
      const action = tokenSubject[2];
      if (subjectId === undefined || action === undefined) {
        return json(
          { error: "invalid token usage subject path" },
          { status: 400 },
        );
      }
      return action === "events"
        ? this.recordTokenUsageEvents(subjectId, request)
        : this.endTokenUsageSubject(subjectId, request);
    }
    if (url.pathname === "/recover" && request.method === "POST") {
      return this.recoverEndpoint(request);
    }
    if (url.pathname === "/quota/observe" && request.method === "POST") {
      return this.quotaObserveEndpoint(request);
    }
    if (url.pathname === "/settlement/sweep" && request.method === "POST") {
      return this.settlementSweepEndpoint(request);
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

  /** POST /codex-root-token — the root-token mint every vendor's launcher calls before relaunching the queen (the codex launcher was the first). Each call mints a FRESH orchestrator credential and revokes every prior one, so a predecessor root's token dies at the successor's launch; the fresh token is persisted for the vendors whose config reads it from the store (claude's headersHelper, and the env indirection the others use). The stateless MCP transport authenticates every request, so this remains valid for the same bounded session window as the other orchestrator capability instead of expiring after launch. This is the one sanctioned issuance outside the daemon's own spawn path (the `root-token:mint` carve-out in capabilities.ts). */
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
    const ttlMs = USER_TTL_MS;
    this.capabilities.revokeSubject(ORCHESTRATOR_NAME);
    const { token } = this.capabilities.mint(
      ORCHESTRATOR_NAME,
      "orchestrator",
      {
        epoch: 0,
        ttlMs,
        // Launcher-only: every vendor launch replaces queen.cap here. Root self-observe maps queen→ROOT_VISIBILITY_ID and requires content:true (capabilities.ts self path; status-mcp root fixture). Startup issueCredential deliberately does not grant this.
        constraints: { content: true },
      },
    );
    writeCredential(ORCHESTRATOR_NAME, token);
    return json({
      token,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
  }

  /** Land facts measured on a connected protocol session. Replaces the deleted statusline scrape: live model, context window/occupancy, effort, and optional attributed usage. Null window/percent means proven absence and is not written as zero. */
  private async receiveProtocolSessionFacts(
    request: Request,
  ): Promise<Response> {
    const route = "/token-usage/protocol-session-facts";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid protocol session facts" }, { status: 400 });
    }
    const parsed = ProtocolSessionFactsReportSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        {
          error: "Invalid protocol session facts",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }
    const decision = this.authorize(
      authenticated.capability,
      route,
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
    const report = parsed.data;
    if (
      report.effort !== undefined &&
      report.effort !== null &&
      (agent.tool === "claude" || agent.tool === "grok")
    ) {
      await this.reconcileClaudeEffort(agent, report.effort);
    }
    if (
      (report.contextPercent !== undefined && report.contextPercent !== null) ||
      (report.contextWindow !== undefined && report.contextWindow !== null)
    ) {
      this.reconcileContext(
        agent.name,
        report.contextPercent === null || report.contextPercent === undefined
          ? undefined
          : report.contextPercent,
        report.contextWindow === null || report.contextWindow === undefined
          ? undefined
          : report.contextWindow,
      );
    }
    let model = agent.liveModel ?? agent.model;
    if (report.model !== undefined && report.model !== null) {
      model = await this.applyLiveModel(agent, report.model);
      if (this.quota !== undefined) {
        await this.quota.reconcileAgentModel(
          agent.name,
          model,
          report.observedAt ?? new Date().toISOString(),
        );
        this.followReservationRekey(agent.name);
      }
    }
    if (report.usage !== undefined) {
      this.tokenUsage.recordProtocolUsageForAgent(
        agent.id,
        [
          {
            key: report.usage.usageKey,
            counts: {
              inputTokens: report.usage.inputTokens,
              cachedInputTokens: report.usage.cachedInputTokens ?? null,
              cacheCreationInputTokens:
                report.usage.cacheCreationInputTokens ?? null,
              outputTokens: report.usage.outputTokens,
              reasoningTokens: report.usage.reasoningTokens ?? null,
            },
            observedAt: report.observedAt ?? new Date().toISOString(),
            source: report.usage.source ?? "protocol",
            ...definedFields({
              cumulative: report.usage.cumulative === true ? true : undefined,
            }),
          },
        ],
        model,
      );
    }
    return json({ ok: true, model });
  }

  /** Freeze Claude's first measured effort into launch identity. Later status line values are current mutable state (`/effort` changes them), so a disagreement is durable drift, never permission to rewrite the identity. */
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
    await this.mailService
      .publishSystem(
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

  /** Land Claude Code's own occupancy figure and its measured context window onto the agent row. Re-reads before writing for the same reason `followReservationRekey` does: the sweep and this handler both land on this row, and a stale `agent` captured earlier in the request would clobber a concurrent update instead of merging with it. */
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

  /** Persist a protocol-observed live model onto `liveModel`, never over `model`. Launch intention and live observation are different facts. */
  private async applyLiveModel(
    agent: AgentRecord,
    live: string,
  ): Promise<string> {
    if (live === agent.liveModel) return live;
    const current = this.db.getAgentById(agent.id);
    if (current !== null) {
      this.db.upsertAgent({ ...current, liveModel: live });
    }
    return live;
  }

  /** Starts or observes the exact sessiond root generation owned by the Workspace supervisor. POST returns a locator only after terminal creation and its durable binding complete. GET with a request id waits for that generation to finish or for the bounded reconnect check to expire. */
  private async orchestratorSessionEndpoint(
    url: URL,
    request: Request,
  ): Promise<Response> {
    const route = "/orchestrator-session";
    const authorized = this.authorizeRoute(
      request,
      route,
      request.method === "POST" ? "agent:spawn" : "status:read",
      { auditAllow: request.method === "POST" },
    );
    if (!authorized.ok) return authorized.response;
    if (this.orchestratorSessiond === null) {
      return json(
        { error: "the sessiond queen host is unavailable" },
        { status: 503 },
      );
    }
    if (request.method === "GET") {
      const requestId = url.searchParams.get("requestId");
      const snapshot =
        requestId === null
          ? this.orchestratorSessiond.snapshot()
          : await this.orchestratorSessiond.waitForTerminal(
              requestId,
              ORCHESTRATOR_SESSION_LONG_POLL_TIMEOUT_MS,
              request.signal,
            );
      if (snapshot === null) {
        return json(
          { error: "queen session generation not found" },
          { status: 404 },
        );
      }
      return json(snapshot);
    }
    const parsed = await this.parseJsonBody(
      request,
      OrchestratorSessiondLaunchSchema,
    );
    if (!parsed.ok) return parsed.response;
    try {
      const snapshot = await this.orchestratorSessiond.start(parsed.data);
      // A provider change accepted while this launch was already in flight could not terminate anything (there was no running root yet). Ending the wrong-vendor root here lets the supervisor's relaunch converge on the requested vendor instead of leaving the change pending forever.
      const control = this.queenProviderService.controlStore().read();
      if (
        control.state === "pending" &&
        control.desired !== null &&
        control.desired !== parsed.data.provider
      ) {
        this.queenProviderService.replaceQueenForProviderChange(
          control.desired,
        );
      }
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

  /** `POST /orchestrator-session/headless` — opens a root with no vendor process attached: a real sessiond-backed shell, verified live and idle, with an agentId=null provider run bound to it. Same authority gate as a vendor launch (`agent:spawn`) and the same one-generation discipline (orchestratorSessiond enforces both) — this only changes what runs inside the terminal, never who may open one or how many may be open. */
  private async orchestratorSessionHeadlessEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/orchestrator-session/headless";
    const authorized = this.authorizeRoute(request, route, "agent:spawn", {
      auditAllow: true,
    });
    if (!authorized.ok) return authorized.response;
    if (this.orchestratorSessiond === null) {
      return json(
        { error: "the sessiond queen host is unavailable" },
        { status: 503 },
      );
    }
    const parsed = await this.parseJsonBody(
      request,
      HeadlessOrchestratorSessiondLaunchSchema,
    );
    if (!parsed.ok) return parsed.response;
    try {
      // Deliberately no pending-provider-change reconciliation here, unlike the sibling vendor POST: a headless root satisfies no vendor desire, so a pending change must survive to be honoured when a vendor root next opens, and with no provider on this launch to compare, the vendor path's condition would fire unconditionally and tear down the root just opened.
      const snapshot = await this.orchestratorSessiond.startHeadless(
        parsed.data,
      );
      return json(snapshot);
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : "headless queen launch failed",
        },
        { status: 409 },
      );
    }
  }

  /** `GET /orchestrator-status` — the root identity Workspace cannot read from an agents-table row. The exact provider turn projection wins; conservative boundaries support older sources, and host lifecycle keeps the status concrete between those observations. */
  private orchestratorStatusEndpoint(request: Request): Response {
    // A poll surface (the feed asks every second): don't audit allows.
    const authorized = this.authorizeRoute(
      request,
      "/orchestrator-status",
      "status:read",
      { auditAllow: false },
    );
    if (!authorized.ok) return authorized.response;
    const host = this.orchestratorSessiond?.snapshot() ?? null;
    const providerRun = this.rootProviderRun();
    const providerStatus =
      providerRun === null
        ? null
        : this.status.orchestratorProviderStatus(
            ORCHESTRATOR_NAME,
            providerRun.runId,
          );
    const boundaryStatus = this.status.orchestratorStatus(
      this.db.recentOrchestratorSignals(ORCHESTRATOR_NAME),
    );
    const status: OrchestratorHostStatus["status"] =
      host?.state === "failed"
        ? "failed"
        : host?.state === "exited"
          ? "exited"
          : host?.state === "awaiting-visibility"
            ? "spawning"
            : (providerStatus?.status ??
              boundaryStatus ??
              (providerRun !== null
                ? "connecting"
                : host?.state === "running"
                  ? "ready"
                  : "disconnected"));
    const body: OrchestratorHostStatus = {
      name: ORCHESTRATOR_NAME,
      status,
      statusObservedAt:
        status === providerStatus?.status ? providerStatus.observedAt : null,
      tool: providerRun?.provider ?? null,
      model: providerRun?.model ?? null,
      host: "sessiond",
      hostState: host?.state ?? null,
      hostDiagnostic: host?.diagnostic ?? null,
      sessionLocator: host?.locator ?? null,
    };
    return json(body);
  }

  private successionService(): SuccessionService {
    return this.queenProviderService.succession();
  }

  private memoryProjectionDeps(
    config: MemoryConfigProjection,
  ): MemoryProjectionDeps {
    return {
      repoRoot: this.repoRoot,
      index: this.memory,
      episodic: this.episodic,
      embeddings: this.embeddingIndex,
      embeddingState: () => this.embeddingService?.stateLabel() ?? "disabled",
      config,
    };
  }

  private memoryJobDeps(): MemoryJobDeps {
    return {
      repoRoot: this.repoRoot,
      index: this.memory,
      episodic: this.episodic,
      embeddingService: this.embeddingService,
      writeMemoryFact: (input) => this.writeMemoryFact(input),
      // The daemon's own sweep: serialized against every other memory write, and followed by the FTS reprojection that makes a demotion visible. It runs with the retention policy this daemon STARTED with, which is what its own timer uses; a configuration write lands in the file and the daemon adopts it at next start.
      runRetentionSweep: () => this.runMemoryRetentionSweep(),
      // Serialized against every other memory write, so a rebuild cannot drop an article whose write landed while it was listing files.
      rebuildMemoryIndex: () => this.rebuildMemoryIndex(),
      now: systemClock,
    };
  }

  private startTrackedMemoryJob(
    kind: MemoryJobKind,
    requestedBy: string,
  ): StartedMemoryJob {
    if (this.episodic === null) {
      throw new Error("this daemon has no episodic store");
    }
    const started = startMemoryJob(
      new MemoryJobStore(this.episodic),
      this.memoryJobDeps(),
      kind,
      requestedBy,
    );
    this.memoryJobs.add(started.done);
    void started.done.then(
      () => this.memoryJobs.delete(started.done),
      () => this.memoryJobs.delete(started.done),
    );
    return started;
  }

  private async memoryEndpoint(url: URL, request: Request): Promise<Response> {
    const route = url.pathname;
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const capability = authenticated.capability;
    const allow = (action: Action, audit = true): Response | null => {
      const decision = this.authorize(
        capability,
        route,
        action,
        undefined,
        audit,
      );
      return decision.ok ? null : this.denied(decision);
    };
    const body = async (): Promise<JsonValue> =>
      requireJsonValue(await request.json().catch(() => null), route);
    const config = await readMemoryConfig();

    if (route === "/memory/overview" && request.method === "GET") {
      // A poll surface, like the orchestrator status feed: don't audit allows.
      const denied = allow("memory:read", false);
      if (denied !== null) return denied;
      const jobs =
        this.episodic === null
          ? []
          : new MemoryJobStore(this.episodic).latestPerKind();
      return json(
        await buildMemoryOverview(this.memoryProjectionDeps(config), jobs),
      );
    }

    if (route === "/memory/library" && request.method === "GET") {
      const denied = allow("memory:read", false);
      if (denied !== null) return denied;
      const parsed = MemoryListRequestSchema.safeParse({
        cursor: url.searchParams.get("cursor"),
        ...definedFields({
          limit: url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
        }),
        kinds: url.searchParams.getAll("kind"),
        scopes: url.searchParams.getAll("scope"),
        statuses: url.searchParams.getAll("status"),
      });
      if (!parsed.success) {
        return json({ error: parsed.error.message }, { status: 400 });
      }
      const filters = parsed.data;
      return json(
        await buildMemoryListPage(
          { repoRoot: this.repoRoot, episodic: this.episodic },
          {
            cursor: filters.cursor,
            limit: filters.limit,
            kinds: filters.kinds?.length ? filters.kinds : null,
            scopes: filters.scopes?.length ? filters.scopes : null,
            statuses: filters.statuses?.length ? filters.statuses : null,
          },
        ),
      );
    }

    if (route === "/memory/library/mutate" && request.method === "POST") {
      const parsed = MemoryMutationRequestSchema.safeParse(await body());
      if (!parsed.success) {
        return json({ error: parsed.error.message }, { status: 400 });
      }
      const writes =
        parsed.data.action === "create" || parsed.data.action === "update";
      const denied = allow(writes ? "memory:write" : "memory:delete");
      if (denied !== null) return denied;
      // The adapter takes the critical section itself and runs the fence and the write inside it, so these primitives are the unlocked bodies.
      const result = await applyMemoryMutation(
        {
          repoRoot: this.repoRoot,
          serialize: (operation) => this.memoryWrites.serialize(operation),
          writeMemoryFact: (input) => this.memoryWrites.writeLocked(input),
          deleteMemoryFact: (scope, id) =>
            this.memoryWrites.deleteLocked(scope, id),
        },
        parsed.data,
      );
      // A stale read and a reference guard are answers, not server errors, so they come back 409 with the state the client needs to recover.
      return json(result, { status: result.state === "applied" ? 200 : 409 });
    }

    if (route === "/memory/recall-preview" && request.method === "POST") {
      const denied = allow("memory:read", false);
      if (denied !== null) return denied;
      const parsed = MemoryRecallPreviewRequestSchema.safeParse(await body());
      if (!parsed.success) {
        return json({ error: parsed.error.message }, { status: 400 });
      }
      return json(
        await buildMemoryRecallPreview(
          {
            repoRoot: this.repoRoot,
            index: this.memory,
            semanticRecall: () => this.semanticRecall(),
            semanticRecallState: () => this.semanticRecallState(),
            wakeBudgetTokens: this.wakeBudgetTokens ?? config.wakeBudgetTokens,
          },
          {
            query: parsed.data.query,
            purpose: parsed.data.purpose,
            ...definedFields({
              budget:
                parsed.data.budget == null ? undefined : parsed.data.budget,
            }),
          },
        ),
      );
    }

    if (route === "/memory/maintenance" && request.method === "GET") {
      const denied = allow("memory:read", false);
      if (denied !== null) return denied;
      const store =
        this.episodic === null ? null : new MemoryJobStore(this.episodic);
      return json(
        buildMemoryMaintenance(
          this.memoryProjectionDeps(config),
          {
            state: store === null ? "absent" : "ok",
            recent: store?.recent() ?? [],
          },
          this.episodic === null
            ? null
            : countConsolidationCandidates(this.episodic),
        ),
      );
    }

    if (route === "/memory/jobs" && request.method === "POST") {
      const denied = allow("memory:write");
      if (denied !== null) return denied;
      const parsed = MemoryJobKindSchema.safeParse(
        // SAFETY: The surrounding code already established this contract.
        ((await body()) as { kind?: unknown } | null)?.kind,
      );
      if (!parsed.success) {
        return json({ error: parsed.error.message }, { status: 400 });
      }
      if (this.episodic === null) {
        return json(
          {
            error:
              "this daemon has no episodic store open, so a job receipt " +
              "could not be persisted and the job was not started",
          },
          { status: 503 },
        );
      }
      const started = this.startTrackedMemoryJob(
        parsed.data,
        capability.subject,
      );
      return json(started.receipt, { status: 202 });
    }

    if (route === "/memory/config" && request.method === "POST") {
      const denied = allow("memory:write");
      if (denied !== null) return denied;
      const parsed = z
        .strictObject({
          expectedRevision: z.string().min(1),
          patch: MemoryConfigPatchSchema,
        })
        .safeParse(await body());
      if (!parsed.success) {
        return json({ error: parsed.error.message }, { status: 400 });
      }
      const result = await casWriteMemoryConfig(parsed.data);
      return json(result, { status: result.state === "applied" ? 200 : 409 });
    }

    return json({ error: `no such memory route: ${route}` }, { status: 404 });
  }

  private async workspaceVisibilityEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/workspace-visibility";
    const authorized = this.authorizeRoute(
      request,
      route,
      "workspace-visibility:write",
    );
    if (!authorized.ok) return authorized.response;
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
    // A publish records which panes the Workspace is showing. It decides nothing about which terminals exist: a terminal is alive because its process is alive, and it observes that for itself. Do not make terminal lifetime depend on publish latency. Per-terminal round trips can exceed the Workspace timeout during a launch burst even while the daemon remains responsive.
    return json(result, { status: 200 });
  }

  /** The Workspace's own liveness is policy the daemon owns: a Hive with no Workspace has nobody to serve, so it shuts down. Nothing a terminal needs rides on this check — terminals observe their own supervisor and outlive any number of missed ticks. Do not renew terminal lifetime here: agent survival must not depend on a liveness message arriving on time. */
  checkWorkspaceOwnerAlive(): void {
    this.workspaceOwnerService.checkWorkspaceOwnerAlive();
  }

  private async tokenUsageEndpoint(
    url: URL,
    request: Request,
  ): Promise<Response> {
    const authorized = this.authorizeRoute(
      request,
      "/token-usage",
      "token-usage:read",
      { auditAllow: false },
    );
    if (!authorized.ok) return authorized.response;
    try {
      return json(
        await this.tokenUsage.snapshot(
          url.searchParams.get("repoRoot") ?? undefined,
        ),
      );
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  private async startTokenUsageSession(request: Request): Promise<Response> {
    const authorized = this.authorizeRoute(
      request,
      "/token-usage/sessions",
      "token-usage:write",
    );
    if (!authorized.ok) return authorized.response;
    const body = TokenUsageSessionRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    const created: TokenUsageSessionCreated = {
      sessionId: await this.tokenUsage.startSession(body.data.repoRoot),
    };
    return json(created);
  }

  private async startTokenUsageOrchestrator(
    sessionId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/sessions/${sessionId}/orchestrators`;
    const authorized = this.authorizeRoute(request, route, "token-usage:write");
    if (!authorized.ok) return authorized.response;
    const body = TokenUsageOrchestratorRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    try {
      const created: TokenUsageSubjectCreated = {
        subjectId: this.tokenUsage.startOrchestrator(
          sessionId,
          body.data.provider,
          body.data.cwd,
        ),
      };
      return json(created);
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  private async endTokenUsageSubject(
    subjectId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/subjects/${subjectId}/end`;
    const authorized = this.authorizeRoute(request, route, "token-usage:write");
    if (!authorized.ok) return authorized.response;
    await this.tokenUsage.endSubject(subjectId);
    return json({ ok: true });
  }

  /** Attribute protocol usage readings. The only write path after the artifact scanners were deleted. */
  private async recordTokenUsageEvents(
    subjectId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/subjects/${subjectId}/events`;
    const authorized = this.authorizeRoute(request, route, "token-usage:write");
    if (!authorized.ok) return authorized.response;
    const body = TokenUsageEventsRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!body.success)
      return json({ error: body.error.message }, { status: 400 });
    this.tokenUsage.recordProtocolUsage(subjectId, body.data.events);
    return json({ ok: true, attributed: body.data.events.length });
  }

  private async endTokenUsageSession(
    sessionId: string,
    request: Request,
  ): Promise<Response> {
    const route = `/token-usage/sessions/${sessionId}/end`;
    const authorized = this.authorizeRoute(request, route, "token-usage:write");
    if (!authorized.ok) return authorized.response;
    await this.tokenUsage.endSession(sessionId);
    return json({ ok: true });
  }

  /** `/autonomy` — the agent-autonomy dial. GET reads the live value: the one the next spawn or resume will actually use, which is what the Workspace menu checkmark and `hive autonomy` display. POST sets it, user-only: the Workspace and the user's CLI hold the user credential, agents never do, so no agent can raise its own autonomy. The control persists to `~/.hive/config.toml` before the live value changes — a set that could not be made durable is refused whole, never applied for this daemon's lifetime only. */
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
    const requested = AutonomyEnvelopeSchema.safeParse(body);
    if (!requested.success) {
      return json(
        { error: 'autonomy must be "sandboxed" or "dangerous"' },
        { status: 400 },
      );
    }
    try {
      await this.autonomy.set(requested.data.autonomy);
    } catch (error) {
      return json(
        {
          error: `could not persist autonomy: ${errorMessage(error)}`,
        },
        { status: 500 },
      );
    }
    return json({ autonomy: this.autonomy.get() });
  }

  private async workspaceSnapshotEndpoint(request: Request): Promise<Response> {
    const route = "/workspace-snapshot";
    const authorized = this.authorizeRoute(request, route, "status:read", {
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    try {
      return json(
        WorkspaceSnapshotV2Schema.parse(await this.status.fetchSnapshot()),
      );
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  /** The pane is infrastructure observing its own vendor, not the model asking
   * for authority. Keep this on the pane's agent credential while bypassing
   * the root MCP succession gate that applies only to model tool calls. */
  private agentUiQuotaEndpoint(request: Request): Response {
    const route = "/agent-ui/quota";
    const authorized = this.authorizeRoute(request, route, "quota:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    return json({
      quotas: z.array(QuotaStatusSchema).parse(this.quota?.statuses() ?? []),
    });
  }

  /** Replays the mail-ready notifications a frontend missed. The mailbox this answers for is the authenticated subject's, never a name in the query — so a frontend can only watch the inbox it could already read, and the ACL is the mailbox's own rather than a second one that could drift from it. A query that names someone else is refused rather than quietly answered with the caller's own mail. */
  private mailReadyEndpoint(request: Request, url: URL): Response {
    const route = "/mail-ready";
    const authorized = this.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const named = url.searchParams.get("recipient");
    const raw = url.searchParams.get("sinceCursor");
    const sinceCursor = raw === null ? null : Number(raw);
    if (
      sinceCursor !== null &&
      (!Number.isSafeInteger(sinceCursor) || sinceCursor < 0)
    ) {
      return json(
        { error: "sinceCursor must be a whole number" },
        { status: 400 },
      );
    }
    // A caller that names an unknown resume point is refused rather than quietly handed a resume it did not ask for: the mailbox sequence used to be accepted here, and silently ignoring it would look like it still works.
    if (url.searchParams.has("sinceBrokerSeq")) {
      return json(
        {
          error:
            "sinceBrokerSeq is not a resume point; resume from the event's cursor",
        },
        { status: 400 },
      );
    }
    try {
      const events = this.mailWake
        .subscribe(subject, {
          kind: "mail-subscribe",
          schemaVersion: 1,
          recipient: named ?? subject,
          // Absent replays nothing, which is "from now" rather than an accidental full history for a caller that forgot to say.
          sinceCursor,
        })
        .filter((event) => this.mailService.stillOffers(event.oldestItemId));
      return json(
        MailReadyResponseSchema.parse({ recipient: subject, events }),
      );
    } catch (error) {
      return mailWakeError(error);
    }
  }

  /** Records the exact notification a live frontend received. This is the only writer of `frontend_notified`, and its absence is what the no-live-frontend breach measures — so an unacknowledged notification stays visibly unobserved rather than being assumed delivered. */
  private async mailReadyAckEndpoint(request: Request): Promise<Response> {
    const route = "/mail-ready/ack";
    const authorized = this.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const parsed = MailReadyAckSchema.omit({ at: true }).safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        { error: parsed.error.issues[0]?.message ?? "bad ack" },
        {
          status: 400,
        },
      );
    }
    try {
      const written = this.mailWake.acknowledge(subject, {
        recipient: parsed.data.recipient,
        cursor: parsed.data.cursor,
        brokerSeq: parsed.data.brokerSeq,
        at: new Date().toISOString(),
      });
      return json({ notified: written.map((row) => row.itemId) });
    } catch (error) {
      return mailWakeError(error);
    }
  }

  /** The pane, not the model, renews a claimed item while a provider turn is
   * alive. This endpoint can only renew the authenticated subject's existing
   * lease; it cannot claim an item or revive expired ownership. */
  private mailLeaseHeartbeatEndpoint(request: Request): Response {
    const route = "/mail/lease-heartbeat";
    const authorized = this.authorizeRoute(request, route, "message:ack", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const generation = this.liveMailGeneration(subject);
    if (generation === null) {
      return json(
        { error: `No live mailbox generation for ${subject}` },
        { status: 409 },
      );
    }
    return json({
      leases: this.mailService.renewLiveLeases(
        { subject, agentGeneration: generation },
        new Date(),
      ),
    });
  }

  private async mailWakeReportEndpoint(request: Request): Promise<Response> {
    const route = "/mail-wake/report";
    const authorized = this.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const parsed = FrontendWakeReportSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        { error: parsed.error.issues[0]?.message ?? "bad wake report" },
        { status: 400 },
      );
    }
    try {
      return json({
        delivery: this.mailWake.acceptWakeReport(subject, parsed.data),
      });
    } catch (error) {
      return mailWakeError(error);
    }
  }

  private async wakePayloadEndpoint(request: Request): Promise<Response> {
    const route = "/wake-payload";
    const authorized = this.authorizeRoute(request, route, "inbox:read", {
      withSubject: true,
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const { WakePayloadRequestSchema } =
      await import("../schemas/wake-payload");
    const parsed = WakePayloadRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        {
          error: parsed.error.issues[0]?.message ?? "bad wake payload request",
        },
        { status: 400 },
      );
    }
    if (
      canonicalOrchestratorName(subject) !==
      canonicalOrchestratorName(parsed.data.recipient)
    ) {
      return json(
        {
          error: `${subject} may not fetch wake payload for ${parsed.data.recipient}`,
        },
        { status: 403 },
      );
    }
    try {
      const payload = await this.wakePayloadService.build(parsed.data);
      return json(payload);
    } catch (error) {
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  private async providerCapabilitiesEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/provider-capabilities";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const report = ProviderCapabilitiesRequestSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!report.success) {
      return json(
        { error: report.error.issues[0]?.message ?? "bad capability report" },
        { status: 400 },
      );
    }
    const decision = this.authorize(
      authenticated.capability,
      route,
      "event:report",
      report.data.subject,
      false,
    );
    if (!decision.ok) return this.denied(decision);
    this.status.replaceProviderCapabilities(report.data.subject, {
      vendorSessionId: report.data.vendorSessionId,
      capabilities: report.data.capabilities,
      observedAt: new Date().toISOString(),
    });
    return json({
      subject: report.data.subject,
      vendorSessionId: report.data.vendorSessionId,
    });
  }

  private providerRuntimeSubject(
    subject: string,
  ): ProviderRuntimeSubject | null {
    if (isOrchestratorName(subject)) return { kind: "root" };
    const agent = this.db.getAgentByName(subject);
    return agent === null || isTerminalAgentStatus(agent.status)
      ? null
      : { kind: "agent", agent };
  }

  /** The running provider run for the root's own terminal. The root's run cannot be found by agent id, because it has none. It is keyed on the terminal it was launched into, and the binding that created that terminal is durable, so this still answers after a daemon restart — unlike the controller's snapshot, which only lives in memory. A run that carries an agentId belongs to that agent, not to the root, even when it sits on a terminal that matched. */
  private rootProviderRun(): ProviderRun | null {
    return this.db.getActiveRootProviderRun(hiveInstanceSuffix());
  }

  private async providerRuntimeEndpoint(request: Request): Promise<Response> {
    const route = "/provider-runtime";
    const authorized = this.authorizeRoute(request, route, "event:report", {
      withSubject: true,
    });
    if (!authorized.ok) return authorized.response;
    const subject = authorized.capability.subject;
    const report = ProviderRuntimeReportSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!report.success) {
      return json(
        { error: report.error.issues[0]?.message ?? "bad runtime report" },
        { status: 400 },
      );
    }
    const reporter = this.providerRuntimeSubject(subject);
    if (reporter === null) {
      return json(
        { error: "provider runtime has no live agent" },
        { status: 409 },
      );
    }
    const active =
      reporter.kind === "root"
        ? this.rootProviderRun()
        : this.db.getActiveProviderRunForAgent(reporter.agent.id);
    if (active === null || active.runId !== report.data.providerRunId) {
      return json(
        { error: "provider runtime report is stale" },
        { status: 409 },
      );
    }
    if (reporter.kind === "agent") {
      // The root has no agent row to advance. For an agent, the report itself is proof of life whether or not the store then accepts it: an authenticated pane process on that agent's current run just spoke. It matters most for the submission outcomes no turn ever follows — a vendor that refused the submission, or an acknowledgement lost in transport. Those are exactly when an agent is stuck rather than working, and a liveness timestamp that freezes there is what gets a working agent called dead.
      this.db.upsertAgent({
        ...reporter.agent,
        lastEventAt: new Date().toISOString(),
      });
    }
    // The root has no agent row to fence the write against, so the run's own epoch stands in. What makes the claim specific is already established: the run was found through the root's terminal and carries no agentId.
    const agentId = reporter.kind === "root" ? null : reporter.agent.id;
    const capabilityEpoch =
      reporter.kind === "root"
        ? active.capabilityEpoch
        : reporter.agent.capabilityEpoch;
    if (report.data.kind === "adapter-child") {
      if (!this.terminalHost.verifyAdapterChildIdentity(report.data.identity)) {
        return json(
          { error: "adapter child identity is not live" },
          { status: 409 },
        );
      }
      const bound = this.db.bindProviderRunAdapterChild(
        active.runId,
        agentId,
        capabilityEpoch,
        report.data.identity,
      );
      return bound === null
        ? json({ error: "adapter child identity changed" }, { status: 409 })
        : json({ run: bound });
    }
    const receipt = this.db.recordProviderRunProtocolReceipt(
      active.runId,
      agentId,
      capabilityEpoch,
      { ...report.data.receipt, reportedAt: new Date().toISOString() },
    );
    return receipt === null
      ? json({ error: "protocol receipt was refused" }, { status: 409 })
      : json({ run: receipt });
  }

  /** `POST /run-control` — create, delegate, pause, resume, and abort, as one typed intent in and one typed result out. User-only, like autonomy and routing policy. A refused intent is a 200 carrying a rejected outcome and the state that stayed in force — the caller needs that state either way, and a transport error would hide it. */
  private async runControlEndpoint(request: Request): Promise<Response> {
    const authorized = this.authorizeRoute(
      request,
      "/run-control",
      "run-control:write",
    );
    if (!authorized.ok) return authorized.response;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid run control request" }, { status: 400 });
    }
    const intent = RunControlIntentSchema.safeParse(body);
    if (!intent.success) {
      return json({ error: intent.error.message }, { status: 400 });
    }
    try {
      // The decider is the authenticated subject, never a body field: a gate recorded under a name the caller chose would name the wrong engineer.
      return json(
        this.hierarchy.applyRunControl(
          intent.data,
          authorized.capability.subject,
        ),
      );
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        return json({ error: error.message }, { status: 404 });
      }
      return json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  /** POST /agents/<name>/kill — the pane's X button. The Workspace needs a kill it can call without an MCP client, and it must be the SAME kill: a second teardown path is how one of them quietly stops reaping something. So this checks the pane's exact Hive locator, then is a thin authorization shell over killAgentTeardown. Idempotent while a residual process tree might still need reaping. Once the exact terminal generation is positively absent, a repeat click is a typed refusal rather than a fabricated successful kill. */
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
        // Who asked for this kill: CLI subcommand, argv, and parent pid, written onto the allow-decision audit row. Free-form and truncated rather than validated: a kill must never be refused because its provenance string is long.
        origin: z.string().optional(),
        // The user ended this agent himself, from the Workspace sidebar's Close Agent item, rather than the orchestrator ending it. Nothing else about the kill changes; this only decides whether the orchestrator is told a closure she did not order has happened. It is a request field because this endpoint is the one place the two callers are distinguishable: `hive kill` (src/cli/control.ts killAgentCli) sends sessionLocator and origin and never this. Reading it off `origin` instead would make the notification depend on parsing a free-form audit string.
        userClosed: z.boolean().optional(),
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
      const teardown = await this.killAgentTeardown(agent);
      if (parsed.data.userClosed === true) {
        await this.reportUserClosed(agent);
      }
      return json(teardown);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Kill failed" },
        { status: 500 },
      );
    }
  }

  /** Tell the orchestrator that the USER ended this agent. A kill she ordered needs no telling — she already knows — so this fires only for the Workspace's Close Agent, and it fires after the teardown so it can never announce a closure that did not happen. It rides the control lane because she has to act on it: the agent is gone and whatever board story it held needs a new owner. The work lane would be wrong here for a measured reason, not a stylistic one — work items from one sender on one topic coalesce while unread (src/mail-service/store.ts coalesceInTx), so closing two agents before she polls would leave her holding only the second agent's name. The idempotency key is the agent id, so a double-click cannot deliver twice. A failed publish must not fail the kill: the agent is already dead, and reporting the kill as failed would be the larger lie. */
  private async reportUserClosed(agent: AgentRecord): Promise<void> {
    await this.mailService
      .publishSystem(
        "hive-control",
        ORCHESTRATOR_NAME,
        `The user closed ${agent.name} from the Workspace sidebar. ` +
          "You did not order this kill. " +
          `${agent.name} is gone; anything you had in flight with it needs a new owner.`,
        { idempotencyKey: `user-closed:${agent.id}` },
      )
      .catch(() => undefined);
  }

  /** POST /stop — fleet shutdown as one atomic-or-abortive daemon request. Evaluate every gate before anything dies so a mid-flight failure or dead requesting client cannot leave a partially killed fleet under a live daemon: 1. user authorization (the same agent:kill the pane X needs); 2. the invoker must not be an agent worktree shell — client-reported and therefore accident prevention, not a security boundary (a same-UID process can read the user credential); 3. unlanded work refuses the stop unless explicitly confirmed, naming the agents and their unlanded state; 4. the daemon writes and verifies the graceful-shutdown checkpoint. A checkpoint failure clears the stop latch and reports stop-failed before any kill. Past that latch, the daemon drives every kill and then its own exit to completion whether or not the requesting client survives — the handler is not cancelled by a vanished request. A teardown failure reports stop-failed and leaves the daemon up: exiting over survivors would strand them with nothing left to supervise or reap them. */
  private async stopEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/stop");
    if (!authenticated.ok) return this.denied(authenticated);
    let rawBody;
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
    const live = this.db.listAgents().filter(isLiveAgent);
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
    let stopTargetBranch: string;
    try {
      stopTargetBranch = await resolveLandingTargetBranch(this.repoRoot);
    } catch (error) {
      if (!(error instanceof DetachedCheckoutError)) throw error;
      // There is no safe fallback target to measure unlanded work against: a detached position can contain agent work, and assessing against it would read that work as landed. Refuse the stop rather than risk the undercount.
      deny("landing target unreadable: primary checkout is detached");
      return json(
        {
          state: "refused-detached",
          error:
            "Hive refused shutdown: the primary checkout is detached" +
            (error.head === null ? "" : ` at ${error.head}`) +
            ", so which work is landed cannot be measured. No agent was" +
            " killed. Restore the primary checkout to its branch, then stop again.",
        },
        { status: 409 },
      );
    }
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
        // Unassessable is not "clean": a worktree whose state cannot be read must gate the stop exactly as unlanded work would.
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
    this.stopInProgress = true;
    try {
      this.checkpointGracefulShutdown();
    } catch (error) {
      this.stopInProgress = false;
      return json(
        {
          state: "stop-failed",
          error: `Hive refused shutdown because the graceful-shutdown checkpoint failed: ${errorMessage(
            error,
          )}`,
        },
        { status: 500 },
      );
    }
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
      this.gracefulShutdownCheckpointed = false;
      return json({ state: "stop-failed", failures }, { status: 500 });
    }
    this.initiateShutdown();
    return json({
      state: "stopping",
      killed: live.map((agent) => agent.name),
    });
  }

  /** POST /agents/<name>/attach-grant — terminal-stack-transition.html#visibility one-use viewer attach for the Workspace renderer, fenced by the pane's EXACT sessionLocator: a stale or superseded generation is refused before the broker is ever contacted. */
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
    let body;
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

  private async quotaObserveEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/quota/observe");
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      "/quota/observe",
      "quota:write",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    if (this.quota === undefined) {
      return json({ error: "Quota tracking is unavailable" }, { status: 503 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid quota observation" }, { status: 400 });
    }
    const parsed = QuotaObservationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: "Invalid quota observation", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    try {
      const observation = await this.quota.observe({
        ...parsed.data,
        observedAt: parsed.data.observedAt ?? new Date().toISOString(),
      });
      return json({ observation });
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Quota observation failed",
        },
        { status: 500 },
      );
    }
  }

  private async settlementSweepEndpoint(request: Request): Promise<Response> {
    const authenticated = this.authenticate(request, "/settlement/sweep");
    if (!authenticated.ok) return this.denied(authenticated);
    const decision = this.authorize(
      authenticated.capability,
      "/settlement/sweep",
      "settlement:execute",
      undefined,
    );
    if (!decision.ok) return this.denied(decision);
    try {
      return json({
        settlement: await this.worktrees.reconcileOrphanedWorktrees(),
      });
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Settlement sweep failed",
        },
        { status: 500 },
      );
    }
  }

  async processEvent(event: HookEvent): Promise<void> {
    return processHookEvent(
      {
        db: this.db,
        publish: (from, to, body, options) =>
          this.mailService.publishSystem(from, to, body, options),
        drainHandler: this.drainHandler,
        orchestratorSessiond: this.orchestratorSessiond,
        quota: this.quota,
        repoRoot: this.repoRoot,
        status: this.status,
        tokenUsage: this.tokenUsage,
        killAgentTeardown: async (agent, options) => {
          await this.killAgentTeardown(agent, options ?? {});
        },
      },
      event,
    );
  }

  private async observabilityReportEndpoint(
    request: Request,
  ): Promise<Response> {
    const route = "/observability/events";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    return await this.observability.reportEndpoint(request, (subject) => {
      const decision = this.authorize(
        authenticated.capability,
        route,
        "event:report",
        subject,
        false,
      );
      return decision.ok
        ? { ok: true }
        : { ok: false, response: this.denied(decision) };
    });
  }

  private observabilityQueryEndpoint(url: URL, request: Request): Response {
    const route = "/observability/errors";
    const authorized = this.authorizeRoute(request, route, "status:read", {
      auditAllow: false,
    });
    if (!authorized.ok) return authorized.response;
    const scope =
      authorized.capability.role === "user" ||
      authorized.capability.role === "orchestrator"
        ? null
        : { subject: authorized.capability.subject };
    return this.observability.queryEndpoint(url, scope);
  }

  private async receiveAgentStatus(request: Request): Promise<Response> {
    const route = "/agent-status";
    const authenticated = this.authenticate(request, route);
    if (!authenticated.ok) return this.denied(authenticated);
    const parsed = ProviderStatusReportSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return json(
        {
          error: "Invalid provider status report",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }
    const decision = this.authorize(
      authenticated.capability,
      route,
      "event:report",
      parsed.data.agent,
      false,
    );
    if (!decision.ok) return this.denied(decision);
    try {
      const status = this.status.observeProvider(parsed.data);
      return json({
        status,
        dimensions: status === null ? null : this.status.dimensionsFrom(status),
      });
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Status report failed",
        },
        {
          status:
            error instanceof AgentStatusBindingError ||
            error instanceof AgentStatusConflictError
              ? 409
              : 500,
        },
      );
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
    const normalized = {
      ...event.data,
      agentName: canonicalOrchestratorName(event.data.agentName),
    };
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
    const mcpServer = new McpServer(
      {
        name: "hive-daemon",
        version: HIVE_VERSION,
      },
      {
        // Hive's MCP surface is fixed for the lifetime of a daemon process. Do not advertise list-change notifications that can never occur.
        capabilities: { tools: { listChanged: false } },
        cacheHints: {
          "server/discover": {
            ttlMs: HIVE_MCP_CATALOG_CACHE_TTL_MS,
            cacheScope: "private",
          },
          "tools/list": {
            ttlMs: HIVE_MCP_CATALOG_CACHE_TTL_MS,
            cacheScope: "private",
          },
        },
      },
    );
    const server = new HiveToolRegistrar(
      mcpServer,
      capability,
      this.observability,
    );

    registerStatusTools(server, capability, {
      db: this.db,
      repoRoot: this.repoRoot,
      status: this.status,
      terminalHost: this.terminalHost,
      graphify: this.graphify,
      graphifyCalls: this.graphifyCalls,
      sessionHost: this.sessionHost,
      statusIncarnationGenerationSource: this.statusIncarnationGenerationSource,
      resolveSessionLocator: this.resolveSessionLocator,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      getTask: (taskId) => this.hierarchy.getTask(taskId),
      listTasks: () => this.hierarchy.listTasks(),
      hasCompletedSessiondBinding: (agent) =>
        this.hasCompletedSessiondBinding(agent),
      memoryEmbeddingsStatusSection: () => this.memoryEmbeddingsStatusSection(),
      waitingInstructions: () => this.waitingRootInstructions(),
      mailBacklog: (recipient) => this.mail.unsettledMailCount(recipient),
      mcpCredential: (subject) => this.mcpCredentialObservation(subject),
      settlementDebt: () => this.worktrees.settlementDebt(),
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
      hasNeverBoundSessiondGeneration: (agent) =>
        this.hasNeverBoundSessiondGeneration(agent),
      killAgentTeardown: (agent, options) =>
        this.killAgentTeardown(agent, options ?? {}),
      listSalvageableRefs: () => this.worktrees.listSalvageableRefs(),
      releaseSalvageableRef: (ref) => this.worktrees.releaseSalvageableRef(ref),
      keepSalvageableRef: (ref) => this.worktrees.keepSalvageableRef(ref),
      mintDestructiveDecision: (input) =>
        this.worktrees.mintDestructiveDecision(input),
      executeDestructiveDecision: (decisionId, executedBy) =>
        this.worktrees.executeDestructiveDecision(decisionId, executedBy),
      listSettlementCases: () => this.worktrees.listSettlementCases(),
    });

    registerMessagingTools(server, capability, {
      db: this.db,
      status: this.status,
      machineMutations: this.machineMutations,
      memoryPressure: () => this.memoryPressure,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      publish: (from, to, body, options) =>
        this.mailService.publishSystem(from, to, body, options),
    });

    registerMailTools(server, capability, {
      service: this.mailService,
      wake: this.mailWake,
      recipients: (named) => this.mailRecipient(named),
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      liveGeneration: (subject) => this.liveMailGeneration(subject),
      requireRulingRecord: (itemId) =>
        repoMemoryCitesItem(this.repoRoot, itemId),
    });

    registerHierarchyNodeTools(server, capability, this.hierarchy);
    registerHierarchyWriteTools(server, capability, this.hierarchy);

    const spawnAgent = async (request: SpawnRequest): Promise<AgentRecord> => {
      const agent = await this.gatedSpawner.spawn(request, capability.subject);
      const persisted =
        this.db.getAgentById(agent.id) ?? this.db.upsertAgent(agent);
      if (persisted.status === "stuck") {
        throw new Error(
          `Hive agent ${persisted.name} could not verify cleanup after spawn`,
        );
      }
      this.status.openAssignment(persisted.id, persisted.createdAt);
      return persisted;
    };
    registerSpawnTools(server, capability, {
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      spawnAgent,
    });
    this.approvalService.registerTools(server, capability);

    registerLandTool(server, capability, {
      db: this.db,
      capabilities: this.capabilities,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      projectGate: (worktreePath) => this.projectGate(worktreePath),
      readNothingToLandEvidence: (agent, sourceOid) =>
        this.worktrees.landingEvidence(agent, sourceOid),
      landAgent: (name, epoch) =>
        landAgent(
          {
            db: this.db,
            machineMutations: this.machineMutations,
            repoRoot: this.repoRoot,
            land: this.land,
            capabilities: this.capabilities,
            worktrees: this.worktrees,
            mainHealthMonitor: this.mainHealthMonitor,
            graphify: this.graphify,
            succession: () => this.successionService(),
          },
          name,
          epoch,
        ),
      resolveHierarchyLand: (name) =>
        this.hierarchy.resolveLand(capability, name),
      decideSpentLandGrant: (cap, branch, mayAutoRearm) =>
        this.approvalService.decideSpentLandGrant(cap, branch, mayAutoRearm),
      fileLandRearmApproval: (subject) =>
        this.approvalService.fileLandRearmApproval(subject),
    });

    registerMemoryTools(server, capability, {
      repoRoot: this.repoRoot,
      memory: this.memory,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
      writeMemoryFact: (input) => this.writeMemoryFact(input),
      verifyMemoryFact: async (scope, id, verifier) => {
        const verified = await this.memoryWrites.verify(scope, id, {
          verifier,
        });
        if (scope === "repo" && id === VERIFICATION_ARTICLE_ID) {
          const command = verificationCommandFromTitle(verified.title);
          if (
            command !== null &&
            verificationCommandDeclared(this.repoRoot, command)
          ) {
            await promoteVerificationToStandards(this.repoRoot, command);
          }
        }
        return verified;
      },
      deleteMemoryFact: (scope, id) => this.deleteMemoryFact(scope, id),
      rebuildMemoryIndex: (signal) => this.rebuildMemoryIndex(signal),
    });

    registerGraphTool(server, capability, {
      repoRoot: this.repoRoot,
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    registerKnowledgeTool(server, capability, {
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    registerArtifactTools(server, capability, {
      artifactsRoot: () => this.artifactsRoot(),
      artifactReadRoots: () => this.artifactReadRoots(),
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    registerRunBootstrapTool(server, capability, {
      db: this.db,
      hierarchy: this.hierarchy,
      repoRoot: this.repoRoot,
      instanceId: hiveInstanceSuffix(),
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    registerSuccessionTools(server, capability, {
      succession: this.successionService(),
      authorizeTool: (cap, tool, action, subject, auditAllow) =>
        this.authorizeTool(cap, tool, action, subject, auditAllow),
    });

    server.installRoleScopedCatalog();
    return mcpServer;
  }

  private mcpCapability(context: McpRequestContext): Capability {
    const capability =
      context.authInfo === undefined
        ? undefined
        : this.mcpCapabilities.get(context.authInfo);
    if (capability === undefined) {
      throw new Error("MCP request is missing validated Hive authority");
    }
    return capability;
  }

  private mcpAuthInfo(request: Request, capability: Capability): AuthInfo {
    const token = bearerToken(request);
    if (token === null) {
      throw new Error("Authenticated MCP request is missing its bearer token");
    }
    const authInfo: AuthInfo = {
      token,
      clientId: capability.id,
      scopes: [capability.role],
      expiresAt: Math.floor(Date.parse(capability.expiresAt) / 1_000),
      extra: {
        hiveSubject: capability.subject,
        hiveCapabilityId: capability.id,
      },
    };
    this.mcpCapabilities.set(authInfo, capability);
    return authInfo;
  }

  private async handleMcp(request: Request): Promise<Response> {
    const invalidRequest =
      hostHeaderValidationResponse(request, this.mcpAllowedHostnames) ??
      originValidationResponse(request, this.mcpAllowedHostnames);
    if (invalidRequest !== undefined) return invalidRequest;
    // Authentication gates the whole transport, so an anonymous caller cannot even enumerate the tools it is not allowed to call.
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
    try {
      const response = await this.mcpHandler.fetch(request, {
        authInfo: this.mcpAuthInfo(request, authenticated.capability),
      });
      // Authentication alone only proves that something reached this route. A successful SDK dispatch proves a real MCP request also negotiated and parsed, which is the readiness signal the launch path needs.
      if (response.ok) {
        this.mcpClientsSeen.set(
          authenticated.capability.subject,
          new Date().toISOString(),
        );
      }
      return response;
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
    try {
      await daemon.stop();
      process.exit(0);
    } catch (error) {
      console.error(`[hive] graceful shutdown aborted: ${errorMessage(error)}`);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
