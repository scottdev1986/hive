import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Action, Capability } from "./capabilities";
import type { HiveDatabase } from "./db";
import type { RecoveryOutcome } from "./recovery";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  sessiondAgentProviderRunIsDead,
} from "./session-host/hive-terminal-host";
import { toolResult } from "./tool-result";
import type { AgentRecord } from "../schemas";

export const MarkDeadRequestSchema = z.object({
  agent: z.string().min(1),
});

export const KillRequestSchema = z.object({
  name: z.string().min(1),
  removeWorktree: z.boolean().optional(),
  discardWork: z.boolean().optional(),
});

/**
 * The agent-control tool surface, with its dependencies named.
 *
 * The teardown result is typed to the one field this surface reads (`agent`)
 * rather than the caller's full outcome shape: these tools report which agent
 * was torn down, and importing the reap/preserve/strand detail would couple
 * the tool layer to a result it never inspects.
 */
export interface AgentControlToolDeps {
  db: HiveDatabase;
  terminalHost: HiveTerminalHostAdapter;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
  recoverCrashedAgents: (name?: string) => Promise<RecoveryOutcome[]>;
  hasNeverBoundSessiondGeneration: (agent: AgentRecord) => boolean;
  killAgentTeardown: (
    agent: AgentRecord,
    options?: {
      removeWorktree?: boolean;
      discardWork?: boolean;
      failureReason?: string;
      at?: string;
    },
  ) => Promise<{ agent: AgentRecord }>;
}

export function registerAgentControlTools(
  server: McpServer,
  capability: Capability,
  deps: AgentControlToolDeps,
): void {
  server.registerTool(
    "hive_recover",
    {
      title: "Recover crashed Hive agents",
      description:
        "Resume crashed agent sessions with their conversation context restored (native tool resume in the same worktree). Omit agent to sweep all recoverable agents; name one — including an agent already marked dead — for a manual retry.",
      inputSchema: z.object({ agent: z.string().min(1).optional() }),
    },
    async ({ agent }) => {
      deps.authorizeTool(capability, "hive_recover", "agent:recover", agent);
      return toolResult(await deps.recoverCrashedAgents(agent), "outcomes");
    },
  );

  server.registerTool(
    "hive_mark_dead",
    {
      title: "Mark Hive agent dead",
      description:
        "Mark an agent dead only after its exact provider run is confirmed stopped, then clean residual resources. A live shell without a provider does not block this; use hive_kill to stop a live provider and terminate its terminal.",
      inputSchema: MarkDeadRequestSchema,
    },
    async ({ agent: agentName }) => {
      deps.authorizeTool(
        capability,
        "hive_mark_dead",
        "agent:mark-dead",
        agentName,
      );
      const agent = deps.db.getAgentByName(agentName);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${agentName}`);
      }
      if (deps.hasNeverBoundSessiondGeneration(agent)) {
        return toolResult((await deps.killAgentTeardown(agent)).agent, "agent");
      }
      const inspection = await deps.terminalHost.inspect(
        requireSessiondAgentLocator(agent),
      );
      const activeRun = deps.terminalHost.reconcileProviderRun(
        requireSessiondAgentLocator(agent),
      );
      const presence = inspection.presence;
      if (presence === "unknown") {
        throw new Error(
          `Cannot mark ${agentName} dead: session presence is unknown; inspect the host and retry.`,
        );
      }
      if (
        presence === "present" &&
        !sessiondAgentProviderRunIsDead(inspection, activeRun)
      ) {
        throw new Error(
          `Cannot mark ${agentName} dead: its exact provider run is still active. Use hive_kill to stop the provider and terminate its terminal.`,
        );
      }
      return toolResult((await deps.killAgentTeardown(agent)).agent, "agent");
    },
  );

  server.registerTool(
    "hive_kill",
    {
      title: "Kill Hive agent",
      description:
        "Kill a named Hive agent's terminal session, mark it dead, and optionally remove its worktree and branch. Removal refuses to delete unmerged commits or dirty files and reports them as stranded work instead; pass discardWork to delete them anyway.",
      inputSchema: KillRequestSchema,
    },
    async ({ name, removeWorktree: shouldRemoveWorktree, discardWork }) => {
      deps.authorizeTool(capability, "hive_kill", "agent:kill", name);
      const agent = deps.db.getAgentByName(name);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }
      return toolResult(
        await deps.killAgentTeardown(agent, {
          removeWorktree: shouldRemoveWorktree,
          discardWork,
        }),
        "result",
      );
    },
  );
}
