import {
  GrokCapabilityProbe,
  GrokCliCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { wrapGrokWithRulesFile } from "../../../daemon/launch-prompt";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import {
  buildGrokResumeCommand,
  buildGrokSpawnCommand,
  resolveWorkingGrokExecutable,
  wrapGrokSpawnWithCompatibilityEnv,
  writeGrokAgentConfig,
  type GrokSpawnOptions,
} from "../grok";
import type { AgentAdapter } from "./agent-adapter";

export const grokAgentAdapter: AgentAdapter = {
  id: "grok",
  async prepareSpawn(context) {
    await writeGrokAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      ...(context.capabilityToken === undefined
        ? {}
        : { capabilityToken: context.capabilityToken }),
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
    const argv = context.resumeSessionId !== undefined
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
    return { argv, command: wrapGrokSpawnWithCompatibilityEnv(command) };
  },
  discover: (executable = resolveWorkingGrokExecutable()?.path ?? "grok") =>
    new GrokCapabilityProbe(new GrokCliCapabilityTransport(executable)).read(),
};
