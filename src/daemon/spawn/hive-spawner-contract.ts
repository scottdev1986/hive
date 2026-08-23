import type { probeGrokCliVersion } from "../../adapters/providers/grok-cli";
import type {
  CreatedWorktree,
  unavailableAgentNames,
} from "../../adapters/worktrees";
import type { EpisodicStore } from "../../memory-service/episodic";
import type { buildMemoryIndex } from "../../memory-service/memory-store";
import type { AgentRecord } from "../../schemas/agent";
import type {
  CapabilityDiscoveryResult,
  CapabilityProvider,
} from "../../schemas/capability";
import type { HiveConfig } from "../../schemas/config-schema";
import type {
  ModelEnablementDecision,
  RoutingPolicy,
} from "../../schemas/routing-policy";
import type { FlatAssignment } from "../../schemas/status-envelope";
import type { AccountBilling } from "../../usage-service/usage-credits/usage-credit-types";
import type { QuotaService } from "../../usage-service/usage-quota";
import type { HiveDatabase } from "../database/hive-database";
import type { CommandOutput } from "../resource-management/resources";
import type { StopAgentSession } from "../resource-management/teardown";
import type { HiveTerminalHostAdapter } from "../session-host/hive-terminal-host";
import type {
  WorkspaceVisibilityAdmission,
  WorkspaceVisibilityLease,
} from "../session-host/workspace-visibility";
import type { SpawnAdmission } from "./admission";

type AgentStore = Pick<
  HiveDatabase,
  | "database"
  | "discardSpawn"
  | "getAgentById"
  | "getActiveProviderRunByTerminal"
  | "getHandoff"
  | "getRunOutcome"
  | "getLiveAgentByName"
  | "insertAgent"
  | "insertProviderRun"
  | "recordRunOutcome"
  | "listAgents"
  | "releaseAgentName"
  | "reserveAgentName"
>;

export type WorktreeCreator = (
  repoRoot: string,
  agentName: string,
  taskSlug: string,
) => Promise<CreatedWorktree>;
export interface SpawnWorktreeSettlement {
  open(
    agent: AgentRecord,
    worktree: CreatedWorktree,
    baseOid: string | null,
  ): Promise<void>;
  settleFailed(
    agent: AgentRecord,
    worktree: CreatedWorktree | null,
    keepOnFailure: boolean,
  ): Promise<{
    preserved: string | null;
    removed: boolean;
    cleanupErrors: string[];
  }>;
}
/** Carries ownership that crosses the synchronous admission/background-launch
 * boundary. The name remains reserved until launch reaches a terminal outcome,
 * so recovery cannot mistake a still-starting agent for abandoned work. */
export type StrandedIdentity = {
  release: (() => void) | null;
  launchOwnsName: boolean;
};
export type Sleep = (milliseconds: number) => Promise<void>;
export type WorktreeHeadReader = (worktreePath: string) => Promise<string>;
type CapabilityDiscoverer = (
  provider: CapabilityProvider,
) => Promise<CapabilityDiscoveryResult>;

/** Mints one agent's capability, writes it to its 0600 credential file, and returns the token. Absent (tests, tooling) the agent is launched with no credential and its daemon calls fail closed rather than fail open. */
export type CredentialIssuer = (
  name: string,
  role: "writer" | "reader",
  epoch: number,
) => string;

export interface SessiondSpawnAdmission {
  terminalHost: Pick<
    HiveTerminalHostAdapter,
    "create" | "inspect" | "terminate"
  >;
  prepareAgentCreation(): Promise<WorkspaceVisibilityLease | null>;
  admit(
    candidate: Readonly<{
      agentId: string;
      agentName: string;
    }>,
  ): Promise<WorkspaceVisibilityAdmission | null>;
}

export interface HiveSpawnerDependencies {
  db: AgentStore;
  repoRoot: string;
  /** Per-project episodic store for wake-pack mistakes. Absent means the pack floor loads without ledger history. */
  episodic?: EpisodicStore;
  newestAgentEventSeq?: (agentId: string) => string | null;
  /** Present only for hierarchy-run requests. Flat spawns never read it. */
  /** Read late, never held: the daemon owns spawn admission and is constructed after the spawner. Returning undefined means this composition has no hierarchy at all, and hierarchy spawns are refused. */
  hierarchyAdmission?: () => SpawnAdmission | undefined;
  /**
   * Board task lookup for spawn prompt linkage. When a spawn carries taskId,
   * the spawner refuses unknown ids before launch and injects the story-of-record
   * instruction. Absent (tests without a hierarchy) means taskId is not validated
   * here — hierarchy admission, if any, still runs its own checks.
   */
  getBoardTask?: (taskId: string) => { taskId: string } | null;
  /** Daemon-owned board transition after an agent row exists. This is system bookkeeping, not an agent board write. */
  startBoardTask?: (taskId: string, agentId: string, agentName: string) => void;
  port: number | (() => number);
  issueCredential?: CredentialIssuer;
  assignments?: Readonly<{
    open(agentId: string, openedAt: string): FlatAssignment;
    close(agentId: string, closedAt: string): FlatAssignment | null;
  }>;
  config: {
    autonomy?: HiveConfig["autonomy"];
    memory?: { wake_pack_enabled?: boolean };
  };
  /** The user's routing policy — the ONLY route source. A spawn names a task category; the policy's ordered chain for that category decides what runs. Absent (unwired embedders) or throwing (corrupt store) REFUSES the spawn: not-configured is never a route. */
  readRoutingPolicy?: () => RoutingPolicy;
  sessiond: SessiondSpawnAdmission;
  /** Kimi's persistent TUI has no launch-time user-turn argument. Production supplies the same exact-foreground terminal injector used for later messages; other providers never read this dependency. */
  stopSession: StopAgentSession;
  createWorktree?: WorktreeCreator;
  measureWorktreeHead?: WorktreeHeadReader;
  unavailableAgentNames?: typeof unavailableAgentNames;
  keepWorktreeOnFailure?: boolean;
  settlement?: SpawnWorktreeSettlement;
  sleep?: Sleep;
  /** Whether a subject's credential has authenticated against the daemon's /mcp at or after a launch baseline. Wired in production; when the seam is absent the reachability check does not run. */
  mcpClientSeen?: (subject: string, since: string) => boolean;
  quotaReady?: () => Promise<void>;
  /** A model-layer failure the vendor says is a rate limit goes to the drain handler, never the launch-failure quarantine. */
  drainError?: (agent: AgentRecord, failure: string) => Promise<void>;
  /** Test seam to collapse the reachability wait's deadline. */
  mcpReportingTimeoutMs?: number;
  /** Live account capability records used only after the final model is chosen. */
  discoverCapabilities?: CapabilityDiscoverer;
  grokIdentity?: typeof probeGrokCliVersion;
  /** The account's live pool readings. The release valve is derived from these — from the pools the provider actually meters — rather than from a model name. */
  readBilling?: (
    provider: CapabilityProvider,
  ) => Promise<AccountBilling | null>;
  isModelEnabled?: (
    provider: CapabilityProvider,
    model: string,
  ) => Promise<ModelEnablementDecision>;
  /** The per-repo graphify MCP server's URL, or null when there is nothing healthy to attach. Read synchronously at spawn time and never awaited: a broken graph means the agent spawns without graph tools, noted, never a slower or failed spawn. Absent (tests, unwired embedders), spawning is bit-identical. */
  graphifyUrl?: () => string | null;
  /** The layer-1 graph digest for a task, or null for repos that never opted in. Hard-bounded inside (query token budget + time-box), so awaiting it adds at most the time-box to a spawn; a throw degrades to no digest, never a failed spawn. */
  graphifyBrief?: (task: string) => Promise<string | null>;
  /** Allows transport-focused tests and embedders to isolate durable-memory I/O. Production uses the canonical memory index builder. */
  buildMemoryIndex?: typeof buildMemoryIndex;
  claudeExecutable?: string;
  codexExecutable?: string;
  grokExecutable?: string;
  kimiExecutable?: string;
  opencodeExecutable?: string;
  ps?: CommandOutput;
  listCodexMcpServers?: () => Promise<string[]>;
  quota?: QuotaService;
  readCodexActivity?: (
    worktreePath: string,
    toolSessionId: string,
  ) => Promise<string | null>;
}
