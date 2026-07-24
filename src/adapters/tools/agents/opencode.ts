import {
  OpencodeCapabilityProbe,
  OpencodeCliCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import {
  buildOpencodeResumeCommand,
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  resolveWorkingOpencodeExecutable,
  writeOpencodeAgentConfig,
  type OpencodeSpawnOptions,
} from "../opencode";
import type { AgentAdapter } from "./agent-adapter";

export const opencodeAgentAdapter: AgentAdapter = {
  id: "opencode",
  async prepareSpawn(context) {
    await writeOpencodeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      readOnly: context.readOnly,
      ...(context.capabilityToken === undefined
        ? {}
        : { capabilityToken: context.capabilityToken }),
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
    const argv = context.resumeSessionId === undefined
      ? buildOpencodeSpawnCommand(options)
      : buildOpencodeResumeCommand(options, context.resumeSessionId);
    return {
      argv,
      command: shellJoin(
        context.kickoff === undefined
          ? argv
          : [...argv, "--prompt", context.kickoff],
      ),
    };
  },
  discover: (
    executable = resolveWorkingOpencodeExecutable()?.path ?? "opencode"
  ) =>
    new OpencodeCapabilityProbe(
      new OpencodeCliCapabilityTransport(executable),
    ).read(),
};
