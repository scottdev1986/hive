import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import { z } from "zod";
import type { StewardshipRef } from "../../adapters/worktrees";
import type { SettlementDecision } from "../worktree-lifecycle-service/settlement-decision-store";
import type { AgentRecord } from "../../schemas/agent";
import type {
  Action,
  Capability,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import type { RecoveryOutcome } from "./recovery-service";
import {
  type HiveTerminalHostAdapter,
  requireSessiondAgentLocator,
  sessiondAgentProviderRunIsDead,
} from "../session-host/hive-terminal-host";
import { toolResult } from "../../shared/mcp-tool-result";

export const MarkDeadRequestSchema = z.strictObject({
  agent: z.string().min(1),
  /** Same as hive_kill: optional, default absent — current mark-dead behavior unchanged when omitted. */
  removeWorktree: z.boolean().optional(),
});

export const KillRequestSchema = z.strictObject({
  name: z.string().min(1),
  removeWorktree: z.boolean().optional(),
});

export const SalvageRequestSchema = z.object({
  action: z.enum(["list", "release", "keep"]),
  /** Full ref under refs/hive-preserved/* or refs/hive-salvage/*; required for release and keep. */
  ref: z.string().min(1).optional(),
});

export const SettlementDecisionRequestSchema = z.strictObject({
  caseId: z.string().regex(/^[0-9a-f]{32}$/),
  revision: z.number().int().min(1),
  evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const SettlementExecuteRequestSchema = z.strictObject({
  decisionId: z.string().regex(/^[0-9a-f]{32}$/),
});

export const SettlementListRequestSchema = z.strictObject({});

/** The agent-control tool surface, with its dependencies named. The teardown result is typed to the one field this surface reads (`agent`) rather than the caller's full outcome shape: these tools report which agent was torn down, and importing the reap/preserve/strand detail would couple the tool layer to a result it never inspects. */
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
      at?: string;
    },
  ) => Promise<{ agent: AgentRecord }>;
  /** Stewardship decisions live in WorktreeLifecycleService; this layer only authenticates and forwards. */
  listSalvageableRefs: () => Promise<StewardshipRef[]>;
  releaseSalvageableRef: (ref: string) => Promise<{ released: string }>;
  keepSalvageableRef: (ref: string) => Promise<{ kept: string; tip: string }>;
  mintDestructiveDecision: (input: {
    caseId: string;
    revision: number;
    evidenceDigest: string;
    reason: string;
    expiresAt: string;
    decisionOwner: string;
  }) => Promise<SettlementDecision>;
  executeDestructiveDecision: (
    decisionId: string,
    executedBy: string,
  ) => Promise<SettlementDecision>;
  sweepSettlement: () => Promise<unknown>;
  listSettlementCases: () => Promise<unknown[]>;
}

export function registerAgentControlTools(
  server: HiveToolRegistrar,
  capability: Capability,
  deps: AgentControlToolDeps,
): void {
  server.registerTool(
    "hive_recover",
    {
      title: "Recover crashed Hive agents",
      description:
        "Report which crashed agents' terminal sessions are confirmed dead, with evidence — report-only, it never relaunches the conversation, resumes a provider session, or changes the agent's row. Omit agent to sweep all recoverable agents; name one — including an agent already marked dead — for a manual retry.",
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
        "Mark an agent dead only after its exact provider run is confirmed stopped, then ask the settlement service to release only a provably safe worktree. A live shell without a provider does not block this; use hive_kill to stop a live provider and terminate its terminal.",
      inputSchema: MarkDeadRequestSchema,
    },
    async ({ agent: agentName, removeWorktree: shouldRemoveWorktree }) => {
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
      const teardownOptions =
        shouldRemoveWorktree === undefined
          ? undefined
          : { removeWorktree: shouldRemoveWorktree };
      if (deps.hasNeverBoundSessiondGeneration(agent)) {
        return toolResult(
          (await deps.killAgentTeardown(agent, teardownOptions)).agent,
          "agent",
        );
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
      return toolResult(
        (await deps.killAgentTeardown(agent, teardownOptions)).agent,
        "agent",
      );
    },
  );

  server.registerTool(
    "hive_kill",
    {
      title: "Kill Hive agent",
      description:
        "Kill a named Hive agent's terminal session and mark it dead. The settlement service releases its worktree only when a self-validating proof accounts for every path and commit; unprovable work stays owned and due.",
      inputSchema: KillRequestSchema,
    },
    async ({ name, removeWorktree: shouldRemoveWorktree }) => {
      deps.authorizeTool(capability, "hive_kill", "agent:kill", name);
      const agent = deps.db.getAgentByName(name);
      if (agent === null) {
        throw new Error(`Hive agent not found: ${name}`);
      }
      return toolResult(
        await deps.killAgentTeardown(agent, {
          removeWorktree: shouldRemoveWorktree,
        }),
        "result",
      );
    },
  );

  server.registerTool(
    "hive_salvage",
    {
      title: "Steward preserved and salvage refs",
      description:
        "List, keep, or proof-release Hive preserved/salvage refs (refs/hive-preserved/* and refs/hive-salvage/*). Listing works without an agent row. Keep parks the bundle with a review time; release succeeds only when the settlement service can reproduce exact accounting.",
      inputSchema: SalvageRequestSchema,
    },
    async ({ action, ref }) => {
      deps.authorizeTool(capability, "hive_salvage", "agent:kill");
      if (action === "list") {
        return toolResult(
          { action: "list", refs: await deps.listSalvageableRefs() },
          "result",
        );
      }
      if (ref === undefined || ref.trim() === "") {
        throw new Error(`hive_salvage action=${action} requires ref`);
      }
      if (action === "release") {
        return toolResult(
          {
            action: "release",
            ...(await deps.releaseSalvageableRef(ref)),
          },
          "result",
        );
      }
      return toolResult(
        {
          action: "keep",
          ...(await deps.keepSalvageableRef(ref)),
        },
        "result",
      );
    },
  );

  server.registerTool(
    "hive_settlement_list",
    {
      title: "List worktree settlement cases",
      description:
        "Read the current Git-backed settlement cases in actionable order, including each exact revision, owner, due trigger, and evidence digest.",
      inputSchema: SettlementListRequestSchema,
    },
    async () => {
      deps.authorizeTool(capability, "hive_settlement_list", "status:read");
      return toolResult(await deps.listSettlementCases(), "cases");
    },
  );

  server.registerTool(
    "hive_settlement_decide",
    {
      title: "Mint an exact destructive settlement decision",
      description:
        "Authorize discarding one measured settlement case at its exact revision and evidence digest. This mints a separate expiring decision; it does not weaken or waive the automatic-release proof. Refuses a case with no measured evidence digest.",
      inputSchema: SettlementDecisionRequestSchema,
    },
    async (input) => {
      deps.authorizeTool(
        capability,
        "hive_settlement_decide",
        "settlement:decide",
      );
      return toolResult(
        await deps.mintDestructiveDecision({
          ...input,
          decisionOwner: capability.subject,
        }),
        "decision",
      );
    },
  );

  server.registerTool(
    "hive_settlement_execute",
    {
      title: "Execute an owner-minted settlement decision",
      description:
        "Execute one unexpired owner-minted decision. Any case, evidence, worktree, branch, or ref drift invalidates it before mutation.",
      inputSchema: SettlementExecuteRequestSchema,
    },
    async ({ decisionId }) => {
      deps.authorizeTool(
        capability,
        "hive_settlement_execute",
        "settlement:execute",
      );
      return toolResult(
        await deps.executeDestructiveDecision(decisionId, capability.subject),
        "decision",
      );
    },
  );

  server.registerTool(
    "hive_settlement_sweep",
    {
      title: "Settle repository work bundles",
      description:
        "Run the deterministic settlement pass. Exact-safe cases release; every unprovable case remains protected with an owner and due trigger.",
      inputSchema: z.strictObject({}),
    },
    async () => {
      deps.authorizeTool(
        capability,
        "hive_settlement_sweep",
        "settlement:execute",
      );
      return toolResult(await deps.sweepSettlement(), "settlement");
    },
  );
}
