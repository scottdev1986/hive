import type { HiveDaemon } from "../src/daemon/server";
import type { WorktreeKillResult } from "../src/daemon/worktree-lifecycle-service/worktree-lifecycle-service";
import type { AgentRecord } from "../src/schemas/agent";

export type KillTeardownResult = {
  agent: AgentRecord;
  cleaned: { sessionId: string };
  worktree: WorktreeKillResult;
  reaped: unknown;
  preserved: { branch: string; ref: string } | null;
  stranded: unknown;
};

export async function killAgentTeardown(
  daemon: HiveDaemon,
  agent: AgentRecord,
  options: {
    removeWorktree?: boolean;
  } = {},
): Promise<KillTeardownResult> {
  return (
    // SAFETY: The test owns this value and its fields.
    (
      daemon as {
        killAgentTeardown: (
          agent: AgentRecord,
          options: {
            removeWorktree?: boolean;
          },
        ) => Promise<KillTeardownResult>;
      }
    ).killAgentTeardown(agent, options)
  );
}
