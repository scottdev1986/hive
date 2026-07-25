import {
  GrokCapabilityProbe,
  GrokCliCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { wrapGrokWithRulesFile } from "../../../daemon/launch-prompt";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import { wrapSpawnWithCapabilityEnv } from "../capability-env";
import {
  buildGrokResumeCommand,
  buildGrokSpawnCommand,
  type GrokSpawnOptions,
  resolveWorkingGrokExecutable,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
} from "../grok";
import type { AgentAdapter } from "./agent-adapter";

export const grokAgentAdapter: AgentAdapter = {
  id: "grok",
  // TODO(C2): project-hook firing stays unclaimed until a live Grok turn can
  // be verified after the quota reset at 2026-07-26T17:18Z.
  communication: {
    provider: "grok",
    eventSource: "transcript",
    nativeDelivery: false,
    toolBoundaryEvents: false,
    turnBoundaryEvents: true,
    transcriptReader: true,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareSpawn(context) {
    await writeGrokAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    const options: GrokSpawnOptions = {
      model: context.model,
      ...(context.effort === undefined ? {} : { effort: context.effort }),
      worktreePath: context.worktreePath,
      readOnly: context.readOnly,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
    };
    const argv =
      context.resumeSessionId !== undefined
        ? buildGrokResumeCommand(options, context.resumeSessionId)
        : buildGrokSpawnCommand({
            ...options,
            ...(context.newVendorSessionId === undefined
              ? {}
              : { sessionId: context.newVendorSessionId }),
          });
    let command = shellJoin(argv);
    if (context.instructionPath !== undefined) {
      command = wrapGrokWithRulesFile(
        command,
        context.instructionPath,
        context.kickoff,
      );
    }
    command = wrapGrokSpawnWithCompatibilityEnv(command);
    if (context.withCapability === true) {
      command = wrapSpawnWithCapabilityEnv(command, context.name);
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingGrokExecutable()?.path ?? "grok") =>
    new GrokCapabilityProbe(new GrokCliCapabilityTransport(executable)).read(),
};
