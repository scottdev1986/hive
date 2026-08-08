import {
  type CapabilityProvider,
  unknownVendor,
} from "../../schemas/capability";
import { claudeAgentAdapter } from "./claude-adapter";
import { ClaudeStreamJsonAdapter } from "./protocol/claude-runtime-adapter";
import { GrokAcpAdapter } from "./protocol/grok-acp-adapter";
import { KimiAcpAdapter } from "./protocol/kimi-acp-adapter";
import { OpenCodeAcpAdapter } from "./protocol/opencode-acp-adapter";
import type { ProviderRuntimeAdapter } from "./protocol/types";
import { codexAgentAdapter } from "./codex-adapter";
import { codexAppServerAdapter } from "./codex-app-server/runtime-adapter";
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

const RUNTIME_ADAPTERS: Record<CapabilityProvider, ProviderRuntimeAdapter> = {
  claude: new ClaudeStreamJsonAdapter(),
  codex: codexAppServerAdapter,
  grok: new GrokAcpAdapter(),
  kimi: new KimiAcpAdapter(),
  opencode: new OpenCodeAcpAdapter(),
};

export function getAgentAdapter(provider: CapabilityProvider): AgentAdapter {
  const adapter: AgentAdapter | undefined = AGENT_ADAPTERS[provider];
  if (adapter === undefined) {
    return unknownVendor(provider as never, "agent adapter registry");
  }
  return adapter;
}

export function getProviderRuntimeAdapter(
  provider: CapabilityProvider,
): ProviderRuntimeAdapter {
  const adapter = RUNTIME_ADAPTERS[provider];
  if (adapter === undefined) {
    return unknownVendor(
      provider as never,
      "provider runtime adapter registry",
    );
  }
  return adapter;
}
