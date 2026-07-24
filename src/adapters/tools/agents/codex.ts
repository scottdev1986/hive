import {
  CodexCapabilityProbe,
  CodexStdioCapabilityTransport,
} from "../../../daemon/capability-discovery";
import {
  codexInstructionProfileName,
  wrapCodexWithInstructionProfile,
  writeCodexInstructionProfile,
} from "../../../daemon/launch-prompt";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import {
  buildCodexResumeCommand,
  buildCodexSpawnCommand,
  type CodexSpawnOptions,
  resolveWorkingCodexExecutable,
  wrapCodexSpawnWithCapabilityEnv,
  writeCodexAgentConfig,
} from "../codex";
import type { AgentAdapter } from "./agent-adapter";

export const codexAgentAdapter: AgentAdapter = {
  id: "codex",
  writeInstructionCopy: async (sessionId, prompt) => {
    await writeCodexInstructionProfile(sessionId, prompt);
  },
  async prepareSpawn(context) {
    await writeCodexAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      ...(context.hiveCommand === undefined
        ? {}
        : { hiveCommand: context.hiveCommand }),
      ...(context.capabilityToken === undefined
        ? {}
        : { capabilityToken: context.capabilityToken }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    });
    const sessionId = context.sessionId;
    const withInstructions =
      context.instructionPath !== undefined && sessionId !== undefined;
    const options: CodexSpawnOptions = {
      daemonPort: context.daemonPort,
      effort: context.effort ?? "medium",
      model: context.model,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      worktreePath: context.worktreePath,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
      excludeMcpServers: context.excludeMcpServers ?? [],
      withCapabilityToken: context.capabilityToken !== undefined,
      ...(withInstructions
        ? { profile: codexInstructionProfileName(sessionId) }
        : {}),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
    };
    const argv =
      context.resumeSessionId === undefined
        ? buildCodexSpawnCommand(options)
        : buildCodexResumeCommand(options, context.resumeSessionId);
    let command = shellJoin(
      context.kickoff === undefined ? argv : [...argv, context.kickoff],
    );
    if (context.capabilityToken !== undefined) {
      command = wrapCodexSpawnWithCapabilityEnv(command, context.worktreePath);
    }
    if (withInstructions) {
      command = wrapCodexWithInstructionProfile(command, sessionId);
    }
    return { argv, command };
  },
  discover: (executable = resolveWorkingCodexExecutable()?.path ?? "codex") =>
    new CodexCapabilityProbe(
      new CodexStdioCapabilityTransport(
        [executable, "app-server", "--stdio"],
        [executable],
      ),
    ).read(),
};
