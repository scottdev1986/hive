import {
  KimiCapabilityProbe,
  KimiCliCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import { wrapSpawnWithCapabilityEnv } from "../capability-env";
import {
  buildKimiResumeCommand,
  buildKimiSpawnCommand,
  type KimiSpawnOptions,
  resolveWorkingKimiExecutable,
  wrapKimiSpawnWithEffort,
  wrapKimiWithInstructionFile,
  writeKimiAgentConfig,
} from "../kimi";
import type { AgentAdapter } from "./agent-adapter";

export const kimiAgentAdapter: AgentAdapter = {
  id: "kimi",
  communication: {
    provider: "kimi",
    eventSource: "transcript",
    nativeDelivery: false,
    toolBoundaryEvents: true,
    turnBoundaryEvents: true,
    transcriptReader: true,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareSpawn(context) {
    await writeKimiAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    const options: KimiSpawnOptions = {
      model: context.model,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
    };
    const argv =
      context.resumeSessionId === undefined
        ? buildKimiSpawnCommand(options)
        : buildKimiResumeCommand(options, context.resumeSessionId);
    let command = shellJoin(argv);
    if (context.effort !== undefined) {
      command = wrapKimiSpawnWithEffort(command, context.effort);
    }
    if (context.capabilityToken !== undefined) {
      command = wrapSpawnWithCapabilityEnv(command, context.name);
    }
    // After the env prefixes, never before: the instruction wrapper leads with
    // its own `mkdir && install`, and an assignment placed in front of that
    // would reach those commands instead of kimi.
    if (context.instructionPath !== undefined) {
      command = wrapKimiWithInstructionFile(
        command,
        context.instructionPath,
        context.kickoff,
      );
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingKimiExecutable()?.path ?? "kimi") =>
    new KimiCapabilityProbe(new KimiCliCapabilityTransport(executable)).read(),
};
