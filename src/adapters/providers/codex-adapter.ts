import {
  buildCodexSpawnCommand,
  type CodexSpawnOptions,
  writeCodexAgentConfig,
} from "./codex-cli";
import { definedFields } from "../../shared/defined-fields";
import type { AgentAdapter } from "./provider-adapter";

export const codexAgentAdapter: AgentAdapter = {
  id: "codex",
  communication: {
    provider: "codex",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: true,
    turnBoundaryEvents: true,
    transcriptReader: true,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareRuntime(context) {
    await writeCodexAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      ...definedFields({
        hiveCommand: context.hiveCommand,
        graphifyUrl: context.graphifyUrl,
      }),
    });
    const options: CodexSpawnOptions = {
      daemonPort: context.daemonPort,
      effort: context.effort ?? "medium",
      model: context.model,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      worktreePath: context.worktreePath,
      excludeMcpServers: context.excludeMcpServers ?? [],
      withCapabilityToken: context.withCapability === true,
      ...definedFields({
        executable: context.executable,
        graphifyUrl: context.graphifyUrl,
      }),
    };
    const argv = buildCodexSpawnCommand(options);
    return { argv };
  },
};
