import {
  OpencodeCapabilityProbe,
  OpencodeCliCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import { wrapSpawnWithCapabilityEnv } from "../capability-env";
import {
  buildOpencodeResumeCommand,
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  type OpencodeSpawnOptions,
  resolveWorkingOpencodeExecutable,
  writeOpencodeAgentConfig,
} from "../opencode";
import type { AgentAdapter } from "./agent-adapter";

export const opencodeAgentAdapter: AgentAdapter = {
  id: "opencode",
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
        context.capabilityToken === undefined
          ? command
          : wrapSpawnWithCapabilityEnv(command, context.name),
    };
  },
  discover: (
    executable = resolveWorkingOpencodeExecutable()?.path ?? "opencode",
  ) =>
    new OpencodeCapabilityProbe(
      new OpencodeCliCapabilityTransport(executable),
    ).read(),
};
