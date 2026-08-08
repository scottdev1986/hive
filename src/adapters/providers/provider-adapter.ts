import type { CapabilityProvider } from "../../schemas/capability";
import type { ProviderCommunicationCapabilities } from "../../schemas/provider-communication";

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
  boardTools?: boolean;
  excludeMcpServers?: readonly string[];
  providerRunId?: string;
}

export interface PreparedProviderRuntime {
  argv: string[];
}

/** The one provider boundary used by normal agent creation. Each implementation owns its provider's worktree preparation, config, command construction, and launch wrapping. */
export interface AgentAdapter {
  readonly id: CapabilityProvider;
  readonly communication: ProviderCommunicationCapabilities;
  prepareWorktree?(worktreePath: string): Promise<void>;
  prepareRuntime(context: AgentSpawnContext): Promise<PreparedProviderRuntime>;
}
