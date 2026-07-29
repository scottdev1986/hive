import {
  OpencodeCapabilityProbe,
  OpencodeCliCapabilityTransport,
} from "../../daemon/capability-discovery";
import { hiveInstanceSuffix } from "../../daemon/instance-identity";
import { shellJoin } from "../../daemon/session-host/shell-session";
import {
  buildOpencodeResumeCommand,
  buildOpencodeSpawnCommand,
  OPENCODE_HIVE_AGENT,
  type OpencodeSpawnOptions,
  resolveWorkingOpencodeExecutable,
  writeOpencodeAgentConfig,
  writeOpencodeTurnPlugin,
} from "./opencode-cli";
import type { AgentAdapter } from "./provider-adapter";
import { wrapSpawnWithCapabilityEnv } from "./shared/capability-env";

export const opencodeAgentAdapter: AgentAdapter = {
  id: "opencode",
  communication: {
    provider: "opencode",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: false,
    turnBoundaryEvents: true,
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
    if (context.providerRunId !== undefined) {
      await writeOpencodeTurnPlugin(context.worktreePath, {
        name: context.name,
        daemonPort: context.daemonPort,
        instanceId: hiveInstanceSuffix(),
        providerRunId: context.providerRunId,
        hiveCommand: context.hiveCommand,
      });
    }
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
