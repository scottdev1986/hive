import { describe, expect, test } from "bun:test";
import type { Capability } from "../../src/daemon/authorization/authorization-service";
import type { HiveToolServer } from "../../src/daemon/authorization/mcp-tool-policy";
import {
  type LandToolDeps,
  registerLandTool,
} from "../../src/daemon/landing/landing-tool";
import {
  type HierarchyLanding,
  NothingToLandError,
} from "../../src/daemon/landing/landing-service";
import type { AgentRecord } from "../../src/schemas/agent";
import { isRecord } from "../../src/shared/is-record";
import type { JsonValue } from "../../src/shared/json";

type ToolInput = {
  agent: string;
  capabilityEpoch: number;
};

type ToolHandler = (args: ToolInput) => Promise<object>;

type InputSchema = {
  safeParse(input: JsonValue): { success: boolean };
};

type CapturedTool = {
  handler: ToolHandler;
  inputSchema: InputSchema;
};

type TestDeps = LandToolDeps & {
  landAgentCalls: Array<{ name: string; epoch: number }>;
};

const STAMP = "2026-07-09T12:00:00.000Z";

function writerCapability(): Capability {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    subject: "writer",
    role: "writer",
    epoch: 0,
    issuedAt: STAMP,
    expiresAt: "2026-07-10T12:00:00.000Z",
    revokedAt: null,
  };
}

function writerAgent(): AgentRecord {
  return {
    id: "agent-writer",
    name: "writer",
    tool: "codex",
    model: "gpt-5",
    category: "simple_coding",
    status: "working",
    taskDescription: "land",
    worktreePath: "/tmp/hive-writer",
    branch: "hive/writer",
    contextPct: null,
    createdAt: STAMP,
    lastEventAt: STAMP,
    capabilityEpoch: 1,
    readOnly: false,
    writeRevoked: false,
  };
}

function captureTool(deps: LandToolDeps): CapturedTool {
  let captured: CapturedTool | null = null;
  const server: HiveToolServer = {
    registerTool: (_name, config, handler) => {
      captured = {
        handler: async (input) => {
          // SAFETY: The test owns this value and its fields.
          const result = await handler(input, {
            mcpReq: { signal: new AbortController().signal },
          } as Parameters<typeof handler>[1]);
          if (!isRecord(result) && !Array.isArray(result)) {
            throw new Error("hive_land returned a non-object tool result");
          }
          return result;
        },
        inputSchema: config.inputSchema,
      };
    },
  };
  registerLandTool(server, writerCapability(), deps);
  if (captured === null) throw new Error("handler not registered");
  return captured;
}

function captureHandler(deps: LandToolDeps): ToolHandler {
  return captureTool(deps).handler;
}

/**
 * A resolved hierarchy landing that records each call. `landCalls` holds one
 * entry per land, each the argument list the tool passed: every entry must be
 * empty, because the authority is already bound inside `land` and the tool has
 * nothing left to supply.
 */
function hierarchyLanding(landCalls: unknown[][] = []): HierarchyLanding {
  return {
    land: async (...args: unknown[]) => {
      landCalls.push(args);
      return { commit: "hier".padEnd(40, "1") };
    },
  };
}

function baseDeps(overrides: Partial<LandToolDeps> = {}): TestDeps {
  const landAgentCalls: Array<{ name: string; epoch: number }> = [];
  return {
    db: {
      getAgentByName: () => writerAgent(),
    },
    capabilities: {
      consumeOneShot: () => true,
      releaseOneShot: () => {},
      audit: () => {},
    },
    authorizeTool: () => {},
    projectGate: async () => {},
    readNothingToLandEvidence: async () => ({
      sourceOid: null,
      baseOid: null,
    }),
    landAgent: async (name, capabilityEpoch) => {
      landAgentCalls.push({ name, epoch: capabilityEpoch });
      return {
        commit: "flat".padEnd(40, "0"),
        landedCommits: ["flat".padEnd(40, "0")],
      };
    },
    decideSpentLandGrant: async () =>
      ({
        kind: "ask",
        reason: "readiness-unreadable",
        readiness: null,
      }) as const,
    fileLandRearmApproval: () => {},
    landAgentCalls,
    ...overrides,
  };
}

describe("land-tool hierarchy routing", () => {
  test("land input rejects caller-supplied hierarchy context", () => {
    const schema = captureTool(baseDeps()).inputSchema;

    expect(
      schema.safeParse({ agent: "writer", capabilityEpoch: 0 }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        agent: "writer",
        capabilityEpoch: 0,
        binding: {
          nodeId: "node_018f4f5e-0000-7000-8000-000000000001",
          agentId: "agent-worker",
          generation: 1,
        },
      }).success,
    ).toBe(false);
  });

  test("direct handler refuses forged promotion authority fields", async () => {
    const handler = captureHandler(baseDeps());
    const forgeries = {
      promotion: { targetRef: "refs/heads/forged" },
      grant: { grantId: "grant_forged" },
      review: { reviewId: "review_forged" },
      actor: { agentId: "agent-forged" },
    };

    for (const [field, value] of Object.entries(forgeries)) {
      await expect(
        // SAFETY: The test owns this value and its fields.
        handler({
          agent: "writer",
          capabilityEpoch: 0,
          [field]: value,
        } as ToolInput),
      ).rejects.toThrow("Unrecognized key");
    }
  });

  test("legacy flat path is used when hierarchy routing is absent", async () => {
    const deps = baseDeps();
    const result = await captureHandler(deps)({
      agent: "writer",
      capabilityEpoch: 0,
    });

    expect(deps.landAgentCalls).toEqual([{ name: "writer", epoch: 0 }]);
    expect(JSON.stringify(result)).toContain("flat");
  });

  test("legacy flat path is used when the resolver returns null", async () => {
    const landCalls: unknown[][] = [];
    const deps = baseDeps({ resolveHierarchyLand: () => null });

    await captureHandler(deps)({ agent: "writer", capabilityEpoch: 3 });

    expect(deps.landAgentCalls).toEqual([{ name: "writer", epoch: 3 }]);
    expect(landCalls).toEqual([]);
  });

  test("a fresh flat grant says a branch at its spawn base never held work", async () => {
    let releases = 0;
    const deps = baseDeps({
      capabilities: {
        consumeOneShot: () => true,
        releaseOneShot: () => {
          releases += 1;
        },
        audit: () => {},
      },
      readNothingToLandEvidence: async (_agent, sourceOid) => ({
        sourceOid,
        baseOid: sourceOid,
      }),
      landAgent: async () => {
        throw new NothingToLandError("hive/writer", "unknown", "a".repeat(40));
      },
    });

    const message = await captureHandler(deps)({
      agent: "writer",
      capabilityEpoch: 0,
    }).then(
      () => "",
      (error: JsonValue) => (error instanceof Error ? error.message : ""),
    );

    expect(message).toContain("Nothing to land for writer");
    expect(message).toContain("still at its recorded spawn base");
    expect(message).toContain("never held a commit to merge");
    expect(message).toContain("commit your work on hive/writer");
    expect(message).toContain("No re-arm approval was filed");
    expect(releases).toBe(1);
  });

  test("hierarchy land carries no caller-supplied authority", async () => {
    const order: string[] = [];
    const landCalls: unknown[][] = [];
    const resolved = hierarchyLanding(landCalls);
    const deps = baseDeps({
      authorizeTool: () => {
        order.push("authorize");
      },
      resolveHierarchyLand: (name) => {
        order.push(`resolve:${name}`);
        return name === "worker" ? resolved : null;
      },
      capabilities: {
        consumeOneShot: () => {
          order.push("consume");
          return true;
        },
        releaseOneShot: () => {},
        audit: () => {},
      },
    });

    const result = await captureHandler(deps)({
      agent: "worker",
      capabilityEpoch: 999,
    });

    expect(order).toEqual(["authorize", "resolve:worker", "consume"]);
    // One land, and the request's flat epoch 999 reached none of it: the tool
    // had no argument to pass it through.
    expect(landCalls).toEqual([[]]);
    expect(deps.landAgentCalls).toEqual([]);
    expect(JSON.stringify(result)).toContain("hier");
  });

  test("flat agent still uses landAgent when hierarchy routing is wired", async () => {
    const landCalls: unknown[][] = [];
    const deps = baseDeps({
      resolveHierarchyLand: (name) =>
        name === "hierarchy-worker" ? hierarchyLanding(landCalls) : null,
    });

    await captureHandler(deps)({
      agent: "flat-writer",
      capabilityEpoch: 1,
    });

    expect(deps.landAgentCalls).toEqual([{ name: "flat-writer", epoch: 1 }]);
    expect(landCalls).toEqual([]);
  });

  test("project gate refusal blocks both landing paths", async () => {
    for (const hierarchy of [false, true]) {
      const landCalls: unknown[][] = [];
      const deps = baseDeps({
        projectGate: async () => {
          throw new Error("Project typecheck blocked landing");
        },
        resolveHierarchyLand: hierarchy
          ? () => hierarchyLanding(landCalls)
          : () => null,
      });

      await expect(
        captureHandler(deps)({ agent: "writer", capabilityEpoch: 0 }),
      ).rejects.toThrow("Project typecheck blocked landing");
      expect(deps.landAgentCalls).toEqual([]);
      expect(landCalls).toEqual([]);
    }
  });

  test("project gate runs before either landing path", async () => {
    for (const hierarchy of [false, true]) {
      const order: string[] = [];
      const deps = baseDeps({
        projectGate: async () => {
          order.push("gate");
        },
        landAgent: async () => {
          order.push("flat");
          return {
            commit: "flat".padEnd(40, "0"),
            landedCommits: ["flat".padEnd(40, "0")],
          };
        },
        resolveHierarchyLand: hierarchy
          ? () => ({
              land: async () => {
                order.push("hierarchy");
                return { commit: "hier".padEnd(40, "1") };
              },
            })
          : () => null,
      });

      await captureHandler(deps)({ agent: "writer", capabilityEpoch: 0 });
      expect(order).toEqual(["gate", hierarchy ? "hierarchy" : "flat"]);
    }
  });

  test("spent hierarchy request never uses the flat readiness decision", async () => {
    let resolverCalls = 0;
    let readinessCalls = 0;
    let approvalCalls = 0;
    const deps = baseDeps({
      authorizeTool: () => {
        throw new Error(
          "The one-shot branch:land grant for writer is already spent",
        );
      },
      resolveHierarchyLand: () => {
        resolverCalls += 1;
        return hierarchyLanding();
      },
      decideSpentLandGrant: async () => {
        readinessCalls += 1;
        return { kind: "nothing-to-land" } as const;
      },
      fileLandRearmApproval: () => {
        approvalCalls += 1;
      },
    });

    await expect(
      captureHandler(deps)({ agent: "writer", capabilityEpoch: 0 }),
    ).rejects.toThrow("already spent");

    expect(resolverCalls).toBe(1);
    expect(readinessCalls).toBe(0);
    expect(approvalCalls).toBe(1);
  });

  test("spent flat request still uses the flat readiness decision", async () => {
    let readinessCalls = 0;
    const deps = baseDeps({
      authorizeTool: () => {
        throw new Error(
          "The one-shot branch:land grant for writer is already spent",
        );
      },
      decideSpentLandGrant: async () => {
        readinessCalls += 1;
        return { kind: "nothing-to-land" } as const;
      },
      readNothingToLandEvidence: async () => ({
        sourceOid: "b".repeat(40),
        baseOid: "a".repeat(40),
      }),
    });

    const message = await captureHandler(deps)({
      agent: "writer",
      capabilityEpoch: 0,
    }).then(
      () => "",
      (error: JsonValue) => (error instanceof Error ? error.message : ""),
    );
    expect(message).toContain("Nothing to land for writer");
    expect(message).toContain("commits beyond its recorded spawn base");
    expect(message).toContain("work is already landed; you are done");
    expect(readinessCalls).toBe(1);
  });

  test("lost hierarchy reservation never uses the flat readiness decision", async () => {
    let readinessCalls = 0;
    let approvalCalls = 0;
    const deps = baseDeps({
      resolveHierarchyLand: () => hierarchyLanding(),
      capabilities: {
        consumeOneShot: () => false,
        releaseOneShot: () => {},
        audit: () => {},
      },
      decideSpentLandGrant: async () => {
        readinessCalls += 1;
        return { kind: "nothing-to-land" } as const;
      },
      fileLandRearmApproval: () => {
        approvalCalls += 1;
      },
    });

    await expect(
      captureHandler(deps)({ agent: "writer", capabilityEpoch: 0 }),
    ).rejects.toThrow("already in flight");
    expect(readinessCalls).toBe(0);
    expect(approvalCalls).toBe(1);
  });

  test("a spent grant with a moved target names both blockers", async () => {
    const deps = baseDeps({
      authorizeTool: () => {
        throw new Error(
          "The one-shot branch:land grant for writer is already spent",
        );
      },
      decideSpentLandGrant: async () =>
        ({
          kind: "ask",
          reason: "target-moved",
          readiness: {
            pending: 2,
            rebased: false,
            targetBranch: "main",
            targetHead: "f".repeat(40),
            baseSha: "e".repeat(40),
          },
        }) as const,
    });

    const refusal = await captureHandler(deps)({
      agent: "writer",
      capabilityEpoch: 0,
    }).catch((error) => error);

    // Both true conditions are named: the grant is spent AND the target moved,
    // with both SHAs, and the agent's own next step (rebase) comes first.
    expect(String(refusal)).toContain("already spent");
    expect(String(refusal)).toContain("has also moved");
    expect(String(refusal)).toContain("f".repeat(40));
    expect(String(refusal)).toContain("e".repeat(40));
    expect(String(refusal)).toContain("rebase");
    expect(String(refusal)).toContain(
      "Hive has already filed the re-arm approval",
    );
  });

  test("hierarchy failure releases the one-shot reservation", async () => {
    let releaseCalls = 0;
    const deps = baseDeps({
      resolveHierarchyLand: () => ({
        land: async () => {
          throw new Error("promotion refused");
        },
      }),
      capabilities: {
        consumeOneShot: () => true,
        releaseOneShot: () => {
          releaseCalls += 1;
        },
        audit: () => {},
      },
    });

    await expect(
      captureHandler(deps)({ agent: "writer", capabilityEpoch: 0 }),
    ).rejects.toThrow("promotion refused");
    expect(releaseCalls).toBe(1);
  });
});
