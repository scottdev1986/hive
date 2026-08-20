import {
  writeOpencodeAgentConfig,
  writeOpencodeTurnPlugin,
} from "./opencode-cli";
import { definedFields } from "../../shared/defined-fields";
import type { AgentAdapter } from "./provider-adapter";

export const opencodeAgentAdapter: AgentAdapter = {
  id: "opencode",
  communication: {
    provider: "opencode",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: false,
    // Opencode has no turn-start surface (session.idle maps to turn-end only, and sparsely). Claiming a turn stream makes every busy opencode agent read as deaf ("no turn events at all") and makes paste confirmation wait on a turn-start that never comes; judging it by lastEventAt is the honest surface.
    turnBoundaryEvents: false,
    transcriptReader: false,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareRuntime(context) {
    await writeOpencodeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...definedFields({
        graphifyUrl: context.graphifyUrl,
        instructionPath: context.instructionPath,
      }),
    });
    if (context.providerRunId !== undefined) {
      await writeOpencodeTurnPlugin(context.worktreePath, {
        name: context.name,
        daemonPort: context.daemonPort,
        instanceId: hiveInstanceSuffix(),
        providerRunId: context.providerRunId,
        hiveCommand: context.hiveCommand,
      });
    }
    return { argv: [] };
  },
};

import { hiveInstanceSuffix } from "../../hive-home/home";
