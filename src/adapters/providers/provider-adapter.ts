import type { CapabilityDiscoveryResult } from "../../daemon/capability-discovery";
import type { CapabilityProvider } from "../../schemas";
import type { ProviderCommunicationCapabilities } from "../../schemas";

/** Everything a launch needs that is not provider-specific. */
export interface AgentSpawnContext {
  name: string;
  model: string;
  effort?: string;
  worktreePath: string;
  daemonPort: number;
  readOnly: boolean;
  dangerous: boolean;
  executable?: string;
  hiveCommand?: readonly string[];
  withCapability?: boolean;
  graphifyUrl?: string;
  instructionPath?: string;
  sessionId?: string;
  kickoff?: string;
  resumeSessionId?: string;
  boardTools?: boolean;
  excludeMcpServers?: readonly string[];
  newVendorSessionId?: string;
  providerRunId?: string;
}

/** The command prepared for the terminal host. */
export interface PreparedAgentSpawn {
  argv: string[];
  command: string;
}

/**
 * A way to write to one agent's terminal, and nothing else. The spawner hands
 * this to an adapter that must start its first turn after launch instead of
 * from argv; what those bytes mean — bracketed paste, Enter, a vendor's own
 * submit key — is the adapter's business, not the spawn spine's.
 */
export interface AgentTurnInput {
  write(bytes: Uint8Array, idempotencyKey: string): Promise<void>;
}

/**
 * The one provider boundary used by normal agent creation.
 *
 * Each implementation owns its provider's worktree preparation, config,
 * command construction, launch wrapping, and model discovery.
 */
export interface AgentAdapter {
  readonly id: CapabilityProvider;
  readonly communication: ProviderCommunicationCapabilities;
  prepareWorktree?(worktreePath: string): Promise<void>;
  writeInstructionCopy?(sessionId: string, prompt: string): Promise<void>;
  prepareSpawn(context: AgentSpawnContext): Promise<PreparedAgentSpawn>;
  /** Only for providers whose TUI cannot take its first turn from argv. The
   * spawner calls this once the launch is otherwise ready and never inspects
   * what is sent. */
  startInitialTurn?(input: AgentTurnInput, kickoff: string): Promise<void>;
  discover(executable?: string): Promise<CapabilityDiscoveryResult>;
}
