import type { CapabilityDiscoveryResult } from "../../../daemon/capability-discovery";
import type { CapabilityProvider } from "../../../schemas/capability";

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
  capabilityToken?: string;
  graphifyUrl?: string;
  instructionPath?: string;
  sessionId?: string;
  kickoff?: string;
  resumeSessionId?: string;
  boardTools?: boolean;
  excludeMcpServers?: readonly string[];
  newVendorSessionId?: string;
}

/** The command prepared for the terminal host. */
export interface PreparedAgentSpawn {
  argv: string[];
  command: string;
}

/**
 * The one provider boundary used by normal agent creation.
 *
 * Each implementation owns its provider's worktree preparation, config,
 * command construction, launch wrapping, and model discovery.
 */
export interface AgentAdapter {
  readonly id: CapabilityProvider;
  prepareWorktree?(worktreePath: string): Promise<void>;
  writeInstructionCopy?(sessionId: string, prompt: string): Promise<void>;
  prepareSpawn(context: AgentSpawnContext): Promise<PreparedAgentSpawn>;
  discover(executable?: string): Promise<CapabilityDiscoveryResult>;
}
