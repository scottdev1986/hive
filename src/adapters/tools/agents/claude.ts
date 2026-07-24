import { join } from "node:path";
import {
  ClaudeCapabilityProbe,
  ClaudeStdioCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import {
  buildClaudeResumeCommand,
  buildClaudeSpawnCommand,
  resolveWorkingClaudeExecutable,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
  type ClaudeSpawnOptions,
} from "../claude";
import type { AgentAdapter } from "./agent-adapter";

export const claudeAgentAdapter: AgentAdapter = {
  id: "claude",
  prepareWorktree: seedClaudeWorktreeTrust,
  async prepareSpawn(context) {
    await writeClaudeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.boardTools === undefined ? {} : { boardTools: context.boardTools }),
      ...(context.graphifyUrl === undefined
        ? {}
        : { graphifyUrl: context.graphifyUrl }),
      ...(context.hiveCommand === undefined
        ? {}
        : { hiveCommand: context.hiveCommand }),
    });
    const options: ClaudeSpawnOptions = {
      daemonPort: context.daemonPort,
      model: context.model,
      ...(context.effort === undefined ? {} : { effort: context.effort }),
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      worktreePath: context.worktreePath,
      ...(context.executable === undefined
        ? {}
        : { executable: context.executable }),
      scopedMcpConfigPath: join(context.worktreePath, ".mcp.json"),
      ...(context.instructionPath === undefined
        ? {}
        : { appendSystemPromptFile: context.instructionPath }),
    };
    const argv = context.resumeSessionId === undefined
      ? buildClaudeSpawnCommand(options)
      : buildClaudeResumeCommand(options, context.resumeSessionId);
    return {
      argv,
      command: shellJoin(
        context.kickoff === undefined ? argv : [...argv, context.kickoff],
      ),
    };
  },
  discover: (executable = resolveWorkingClaudeExecutable().path) =>
    new ClaudeCapabilityProbe(
      new ClaudeStdioCapabilityTransport(
        [
          executable,
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        [executable],
      ),
    ).read(),
};
