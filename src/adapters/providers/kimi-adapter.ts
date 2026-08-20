import {
  kimiReadOnlyContainmentGap,
  writeKimiAgentConfig,
  writeKimiInstructionFile,
  writeKimiTurnHook,
} from "./kimi-cli";
import { definedFields } from "../../shared/defined-fields";
import type { AgentAdapter } from "./provider-adapter";

export const kimiAgentAdapter: AgentAdapter = {
  id: "kimi",
  communication: {
    provider: "kimi",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: false,
    // Kimi reads hook config only from user-level files Hive does not write: no turn-start ever arrives and turn-end is sporadic at best. Claiming a turn stream makes every busy kimi agent read as deaf ("no turn events at all") and makes paste confirmation wait on a turn-start that never comes; judging it by lastEventAt is the honest surface.
    turnBoundaryEvents: false,
    transcriptReader: false,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareRuntime(context) {
    await writeKimiAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...definedFields({ graphifyUrl: context.graphifyUrl }),
    });
    if (context.instructionPath !== undefined) {
      await writeKimiInstructionFile(
        context.worktreePath,
        context.instructionPath,
      );
    }
    if (context.providerRunId !== undefined) {
      await writeKimiTurnHook([
        "bun",
        "/Users/scottkellar/Projects/hive/src/cli.ts",
      ]);
    }
    // Read-only is a label Hive cannot enforce on this vendor. Say so at the moment it stops being true, rather than letting the posture read as contained on a launch that is not.
    if (context.readOnly && !context.dangerous) {
      const gap = kimiReadOnlyContainmentGap();
      if (gap !== null) console.error(`Hive ${context.name}: ${gap}`);
    }
    return { argv: [] };
  },
};
