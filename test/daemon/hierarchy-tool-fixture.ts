// The four-part world an authenticated hierarchy tool needs before it can
// authorize anyone: a flat AgentRecord row, that agent live under its name, a
// session locator whose subject and generation match the binding, and a stored
// binding for that identity. The flat AgentRecord capability epoch is the one
// credential fence. Every tool-layer suite needs all four, and a partial world
// refuses for the wrong reason.

import type {
  Action,
  Capability,
  Role,
} from "../../src/daemon/authorization/authorization-service";
import { CapabilityStore } from "../../src/daemon/authorization/authorization-service";
import type { HiveDatabase } from "../../src/daemon/database/hive-database";
import {
  HierarchyService,
  type HierarchyServiceOptions,
} from "../../src/daemon/hierarchy-service/hierarchy-service";
import type { HierarchyStore } from "../../src/daemon/hierarchy-store";
import type { HiveToolRegistrar } from "../../src/daemon/authorization/mcp-tool-policy";
import type { AgentRecord } from "../../src/schemas/agent";
import type { AgentBinding } from "../../src/schemas/hierarchy-node";

export type ToolHandler = (input: never) => Promise<unknown>;

const stamp = "2026-07-30T12:00:00.000Z";

/** Captures the handlers a register* function installs. */
export function captureTools(): {
  server: HiveToolRegistrar;
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as HiveToolRegistrar;
  return { server, handlers };
}

/**
 * A real capability and the real authorization that goes with it.
 *
 * Minted through CapabilityStore against the same agents table production
 * reads, and authorized through CapabilityStore.authorize, so a tool that asks
 * for an action the role does not hold is refused here exactly as it would be
 * on the wire. A fabricated capability would let a test world be more
 * permissive than the real one, which is how an unreachable door passes its
 * own suite.
 */
export function realCaller(
  db: HiveDatabase,
  name: string,
  role: Role = "writer",
  epoch = 1,
): {
  capability: Capability;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
} {
  const capabilities = new CapabilityStore(db, (subject) => {
    const record = db.getAgentByName(subject);
    return record === null
      ? null
      : {
          capabilityEpoch: record.capabilityEpoch,
          writeRevoked: record.writeRevoked,
        };
  });
  const { capability } = capabilities.mint(name, role, { epoch });
  return {
    capability,
    authorizeTool: (cap, tool, action, subject) => {
      const decision = capabilities.authorize(cap, {
        action,
        subject,
        route: tool,
      });
      if (!decision.ok) throw new Error(decision.message);
    },
  };
}

/**
 * The real service every hierarchy tool is registered against, over the test
 * database. Suites exercise the same object the daemon wires, so an authority
 * rule cannot pass here and refuse on the wire.
 *
 */
export function toolService(
  db: HiveDatabase,
  options: {
    authorizeTool: HierarchyServiceOptions["authorizeTool"];
    now?: () => Date;
  },
): HierarchyService {
  return new HierarchyService({
    db,
    repoRoot: "/repo",
    authorizeTool: options.authorizeTool,
    now: options.now,
  });
}

/**
 * Seed one agent that holds its name, its session, and a hierarchy binding on
 * nodeId. The flat AgentRecord carries capabilityEpoch; the binding does not.
 * The node itself must already exist: putAgentBinding refuses a binding on a
 * node that does not.
 */
export function seedBoundAgent(
  db: HiveDatabase,
  store: HierarchyStore,
  options: {
    name: string;
    agentId: string;
    nodeId: string;
    runId: string;
    generation?: number;
    capabilityEpoch?: number;
  },
): AgentBinding {
  const generation = options.generation ?? 1;
  const capabilityEpoch = options.capabilityEpoch ?? 1;
  const sessionLocator = {
    schemaVersion: 1,
    instanceId: "instance-tool-test",
    subject: { kind: "agent", agentId: options.agentId },
    generation,
    sessionId: `ses_018f4f5e-0000-7000-8000-0000000000${options.agentId.slice(-2)}`,
    hostKind: "sessiond",
    engineBuildId: "test-build",
  } as const;
  const agent: AgentRecord = {
    id: options.agentId,
    name: options.name,
    tool: "codex",
    model: "gpt-5",
    category: "simple_coding",
    status: "working",
    taskDescription: "Exercise an authenticated hierarchy tool",
    worktreePath: `/worktrees/${options.name}`,
    branch: `hive/${options.name}`,
    sessionLocator,
    contextPct: null,
    createdAt: stamp,
    lastEventAt: stamp,
    capabilityEpoch,
    readOnly: false,
    writeRevoked: false,
  };
  db.insertAgent(agent);
  return store.putAgentBinding(
    {
      nodeId: options.nodeId,
      agentId: options.agentId,
      generation,
      provider: "codex",
      model: "gpt-5",
      sessionLocator,
      worktree: `/worktrees/${options.name}`,
      branch: `hive/${options.name}`,
      baseSha: "b".repeat(40),
      credentialId: `cred-${options.name}`,
      boundAt: stamp,
      unboundAt: null,
    },
    options.runId,
  );
}
