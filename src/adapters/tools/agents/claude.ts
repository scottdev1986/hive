import { join } from "node:path";
import {
  ClaudeCapabilityProbe,
  ClaudeStdioCapabilityTransport,
} from "../../../daemon/capability-discovery";
import { shellJoin } from "../../../daemon/session-host/shell-session";
import {
  buildClaudeResumeCommand,
  buildClaudeSpawnCommand,
  type ClaudeSpawnOptions,
  resolveWorkingClaudeExecutable,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
} from "../claude";
import type { AgentAdapter } from "./agent-adapter";

export const claudeAgentAdapter: AgentAdapter = {
  id: "claude",
  // Hooks source four normalized kinds — run-started (SessionStart),
  // turn-started (UserPromptSubmit), turn-idle (Stop, and Notification's
  // idle_prompt) and tool-finished (PostToolUse) — plus approval-waiting from
  // Notification's permission_prompt. Every registered name is checked against
  // the event list claude 2.1.220 itself dispatches (claude.test.ts).
  // NOT sourced from hooks, and the gap is deliberate rather than an omission:
  // run-ended, because measured process exit is the stronger evidence;
  // tool-started, turn-failed, compacted and interrupted, because the vendor
  // events exist (PreToolUse, StopFailure, PreCompact, PostToolBatch) but no
  // reader consumes them. Registering one is a single line if a consumer
  // appears.
  communication: {
    provider: "claude",
    eventSource: "hooks",
    nativeDelivery: false,
    toolBoundaryEvents: true,
    turnBoundaryEvents: true,
    transcriptReader: true,
    nativeCancel: false,
    conversationResume: true,
  },
  prepareWorktree: seedClaudeWorktreeTrust,
  async prepareSpawn(context) {
    await writeClaudeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...(context.providerRunId === undefined
        ? {}
        : { providerRunId: context.providerRunId }),
      ...(context.boardTools === undefined
        ? {}
        : { boardTools: context.boardTools }),
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
    const argv =
      context.resumeSessionId === undefined
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
