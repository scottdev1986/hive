import { join } from "node:path";
import {
  buildClaudeSpawnCommand,
  type ClaudeSpawnOptions,
  seedClaudeWorktreeTrust,
  writeClaudeAgentConfig,
} from "./claude-cli";
import { definedFields } from "../../shared/defined-fields";
import type { AgentAdapter } from "./provider-adapter";

export const claudeAgentAdapter: AgentAdapter = {
  id: "claude",
  // Hooks source four normalized kinds — run-started (SessionStart), turn-started (UserPromptSubmit), turn-idle (Stop, and Notification's idle_prompt) and tool-finished (PostToolUse) — plus approval-waiting from Notification's permission_prompt. Every registered name is checked against the event list claude 2.1.220 itself dispatches (claude.test.ts). NOT sourced from hooks, and the gap is deliberate rather than an omission: run-ended, because measured process exit is the stronger evidence; tool-started, turn-failed, compacted and interrupted, because the vendor events exist (PreToolUse, StopFailure, PreCompact, PostToolBatch) but no reader consumes them. Registering one is a single line if a consumer appears.
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
  async prepareRuntime(context) {
    await writeClaudeAgentConfig(context.worktreePath, {
      daemonPort: context.daemonPort,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      ...definedFields({
        providerRunId: context.providerRunId,
        boardTools: context.boardTools,
        graphifyUrl: context.graphifyUrl,
        hiveCommand: context.hiveCommand,
      }),
    });
    const options: ClaudeSpawnOptions = {
      daemonPort: context.daemonPort,
      model: context.model,
      name: context.name,
      readOnly: context.readOnly,
      dangerous: context.dangerous,
      worktreePath: context.worktreePath,
      scopedMcpConfigPath: join(context.worktreePath, ".mcp.json"),
      ...definedFields({
        effort: context.effort,
        executable: context.executable,
        appendSystemPromptFile: context.instructionPath,
      }),
    };
    const argv = buildClaudeSpawnCommand(options);
    return { argv };
  },
};
