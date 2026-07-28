import {
  OpencodeCapabilityProbe,
  OpencodeCliCapabilityTransport,
} from "../../daemon/capability-discovery";
import { shellJoin } from "../../daemon/session-host/shell-session";
import {
  buildOpencodeResumeCommand,
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  type OpencodeSpawnOptions,
  resolveWorkingOpencodeExecutable,
  writeOpencodeAgentConfig,
} from "./opencode-cli";
import type { AgentAdapter } from "./provider-adapter";
import { wrapSpawnWithCapabilityEnv } from "./shared/capability-env";

export const opencodeAgentAdapter: AgentAdapter = {
  id: "opencode",
  // TODO(C2): enable the Hive plugin descriptor only after the disabled
  // OpenCode provider can be launched and its callbacks verified.
  communication: {
    provider: "opencode",
    eventSource: "none",
    nativeDelivery: false,
    toolBoundaryEvents: false,
    turnBoundaryEvents: false,
    transcriptReader: false,
    nativeCancel: false,
    conversationResume: true,
  },
  async prepareSpawn(context) {
    await writeOpencodeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      readOnly: context.readOnly,
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
      ...(context.instructionPath === undefined
        ? {}
        : { instructionPath: context.instructionPath }),
    });
    const options: OpencodeSpawnOptions = {
      model: context.model,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
      ...(context.instructionPath === undefined
        ? {}
        : { agent: OPENCODE_HIVE_AGENT }),
    };
    const argv =
      context.resumeSessionId === undefined
        ? buildOpencodeSpawnCommand(options)
        : buildOpencodeResumeCommand(options, context.resumeSessionId);
    const command = shellJoin(
      context.kickoff === undefined
        ? argv
        : [...argv, "--prompt", context.kickoff],
    );
    return {
      argv,
      command:
        context.withCapability === true
          ? wrapSpawnWithCapabilityEnv(command, context.name)
          : command,
    };
  },
  discover: (
    executable = resolveWorkingOpencodeExecutable()?.path ?? "opencode",
  ) =>
    new OpencodeCapabilityProbe(
      new OpencodeCliCapabilityTransport(executable),
    ).read(),
};
