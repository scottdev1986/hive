import { type CapabilityProvider, unknownVendor } from "../../schemas";
import { claudeAgentAdapter } from "./claude-adapter";
import { codexAgentAdapter } from "./codex-adapter";
import { grokAgentAdapter } from "./grok-adapter";
import { kimiAgentAdapter } from "./kimi-adapter";
import { opencodeAgentAdapter } from "./opencode-adapter";
import type { AgentAdapter } from "./provider-adapter";

const AGENT_ADAPTERS: Record<CapabilityProvider, AgentAdapter> = {
  claude: claudeAgentAdapter,
  codex: codexAgentAdapter,
  grok: grokAgentAdapter,
  kimi: kimiAgentAdapter,
  opencode: opencodeAgentAdapter,
};

/** Return the one launch adapter for a provider. */
export function getAgentAdapter(provider: CapabilityProvider): AgentAdapter {
  const adapter: AgentAdapter | undefined = AGENT_ADAPTERS[provider];
  if (adapter === undefined) {
    return unknownVendor(provider as never, "agent adapter registry");
  }
  return adapter;
}
