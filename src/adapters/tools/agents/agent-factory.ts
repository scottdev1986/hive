import {
  unknownVendor,
  type CapabilityProvider,
} from "../../../schemas/capability";
import type { AgentAdapter } from "./agent-adapter";
import { claudeAgentAdapter } from "./claude";
import { codexAgentAdapter } from "./codex";
import { grokAgentAdapter } from "./grok";
import { kimiAgentAdapter } from "./kimi";
import { opencodeAgentAdapter } from "./opencode";

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
