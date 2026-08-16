import { describe, expect, test } from "bun:test";
import {
  CapabilityStore,
  type Capability,
} from "../../src/daemon/authorization/authorization-service";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { registerAgentControlTools } from "../../src/daemon/recovery/agent-control-tools";
import type { SettlementDecision } from "../../src/daemon/worktree-lifecycle-service/settlement-decision-store";
import { required } from "../required";

const input = {
  caseId: "a".repeat(32),
  revision: 1,
  evidenceDigest: "b".repeat(64),
  reason: "the residue was reviewed",
  expiresAt: "2026-08-13T23:00:00.000Z",
};

const decision: SettlementDecision = {
  version: 1,
  decisionId: "c".repeat(32),
  instanceId: "test",
  caseId: input.caseId,
  caseRevision: input.revision,
  evidenceDigest: input.evidenceDigest,
  worktreePath: null,
  branch: "hive/maya-work",
  branchOid: "d".repeat(40),
  refs: [],
  residue: ["notes.txt"],
  outcome: "discard",
  reason: input.reason,
  decisionOwner: "user",
  mintedAt: "2026-08-13T22:00:00.000Z",
  expiresAt: input.expiresAt,
  executedAt: null,
  executedBy: null,
  removedPaths: [],
  removedRefs: [],
};

async function mintAs(capability: Capability): Promise<{
  readonly inputs: Array<typeof input & { decisionOwner: string }>;
  readonly executions: Array<{ decisionId: string; executedBy: string }>;
  readonly mint: () => Promise<unknown>;
  readonly execute: () => Promise<unknown>;
}> {
  const tools = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  const inputs: Array<typeof input & { decisionOwner: string }> = [];
  const executions: Array<{ decisionId: string; executedBy: string }> = [];
  const db = new HiveDatabase(":memory:");
  const capabilities = new CapabilityStore(db, () => null);
  registerAgentControlTools(
    {
      registerTool: (
        name: string,
        _meta: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) => {
        tools.set(name, handler);
      },
    } as never,
    capability,
    {
      db,
      terminalHost: {} as never,
      authorizeTool: (caller, tool, action) => {
        const authorization = capabilities.authorize(caller, {
          action,
          route: tool,
        });
        if (!authorization.ok) throw new Error(authorization.message);
      },
      recoverCrashedAgents: async () => [],
      hasNeverBoundSessiondGeneration: () => true,
      killAgentTeardown: async () => Promise.reject(new Error("unused")),
      listSalvageableRefs: async () => [],
      releaseSalvageableRef: async () => Promise.reject(new Error("unused")),
      keepSalvageableRef: async () => Promise.reject(new Error("unused")),
      mintDestructiveDecision: async (next) => {
        inputs.push(next);
        return { ...decision, decisionOwner: next.decisionOwner };
      },
      executeDestructiveDecision: async (decisionId, executedBy) => {
        executions.push({ decisionId, executedBy });
        return { ...decision, executedBy };
      },
      listSettlementCases: async () => [],
      sweepSettlement: async () => ({}),
    },
  );
  return {
    inputs,
    executions,
    mint: () => required(tools.get("hive_settlement_decide"))(input),
    execute: () =>
      required(tools.get("hive_settlement_execute"))({
        decisionId: decision.decisionId,
      }),
  };
}

describe("settlement decision authorization", () => {
  test("only the user can mint with its audit owner", async () => {
    const mint = await mintAs({
      role: "user",
      subject: "user",
    } as Capability);
    await mint.mint();
    expect(mint.inputs).toEqual([{ ...input, decisionOwner: "user" }]);
  });

  test("the queen can mint, and the decision carries the queen as audit owner", async () => {
    const mint = await mintAs({
      role: "orchestrator",
      subject: "queen",
    } as Capability);
    const minted = (await mint.mint()) as {
      structuredContent: { decision: { decisionOwner: string } };
    };
    expect(mint.inputs).toEqual([{ ...input, decisionOwner: "queen" }]);
    expect(minted.structuredContent.decision.decisionOwner).toBe("queen");
  });

  test("the queen can execute a user-minted settlement decision", async () => {
    const execute = await mintAs({
      role: "orchestrator",
      subject: "queen",
    } as Capability);
    await execute.execute();
    expect(execute.executions).toEqual([
      { decisionId: decision.decisionId, executedBy: "queen" },
    ]);
  });

  test("a writer cannot mint a settlement decision", async () => {
    const mint = await mintAs({
      role: "writer",
      subject: "maya",
    } as Capability);
    await expect(mint.mint()).rejects.toThrow("may not settlement:decide");
    expect(mint.inputs).toEqual([]);
  });
});
