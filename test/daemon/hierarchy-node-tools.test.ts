import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { registerHierarchyNodeTools } from "../../src/daemon/hierarchy-service/node-tools";
import { HierarchyStore } from "../../src/daemon/hierarchy-store";
import type { HierarchyNode } from "../../src/schemas/hierarchy-node";
import {
  captureTools,
  realCaller,
  seedBoundAgent,
  type ToolHandler,
  toolService,
} from "./hierarchy-tool-fixture";
import { bumpCapabilityEpoch } from "./fence-state";

const runId = "run_018f4f5e-0000-7000-8000-000000000101";
const rootNodeId = "node_018f4f5e-0000-7000-8000-000000000101";
const leadNodeId = "node_018f4f5e-0000-7000-8000-000000000102";
const leafNodeId = "node_018f4f5e-0000-7000-8000-000000000103";
const outsiderNodeId = "node_018f4f5e-0000-7000-8000-000000000104";
const createdNodeId = "node_018f4f5e-0000-7000-8000-000000000109";
const selfOwnedNodeId = "node_018f4f5e-0000-7000-8000-00000000010a";
const missingOwnerNodeId = "node_018f4f5e-0000-7000-8000-00000000010b";
const crossRunNodeId = "node_018f4f5e-0000-7000-8000-00000000010c";
const foreignRunId = "run_018f4f5e-0000-7000-8000-000000000102";
const foreignRootNodeId = "node_018f4f5e-0000-7000-8000-00000000010d";
const digest = `sha256:${"a".repeat(64)}`;
const stamp = "2026-07-30T12:00:00.000Z";

let db: HiveDatabase;
let store: HierarchyStore;

function node(
  nodeId: string,
  parentNodeId: string | null,
  role: HierarchyNode["organizationalRole"] = "worker",
): HierarchyNode {
  return {
    nodeId,
    runId,
    parentNodeId,
    ownerNodeId: parentNodeId,
    organizationalRole: role,
    assignmentKind: "author",
    taskScope: [],
    capacityCharge: 1,
    lifecycle: "active",
    revision: "1",
  };
}

/**
 * The tool with its own checks isolated: a real capability, but the capability
 * layer stubbed out, so what refuses is the door's in-transaction read rather
 * than the gate in front of it.
 */
function handlerWithoutOuterGate(name: string, epoch = 1): ToolHandler {
  const { server, handlers } = captureTools();
  const caller = realCaller(db, name, "writer", epoch);
  registerHierarchyNodeTools(
    server,
    caller.capability,
    toolService(db, { authorizeTool: () => {} }),
  );
  const handler = handlers.get("hive_node_create");
  if (handler === undefined) throw new Error("hive_node_create not registered");
  return handler;
}

function handlerFor(
  name: string,
  epoch = 1,
  role: "writer" | "reader" = "writer",
): ToolHandler {
  const { server, handlers } = captureTools();
  const caller = realCaller(db, name, role, epoch);
  registerHierarchyNodeTools(
    server,
    caller.capability,
    toolService(db, { authorizeTool: caller.authorizeTool }),
  );
  const handler = handlers.get("hive_node_create");
  if (handler === undefined) throw new Error("hive_node_create not registered");
  return handler;
}

beforeEach(() => {
  db = new HiveDatabase(":memory:");
  store = new HierarchyStore(db);
  store.putRun(
    {
      runId,
      revision: "1",
      repo: "hive",
      instanceId: "instance-1",
      spec: { revision: "1", digest },
      currentPlan: { revision: "1", digest },
      topology: { revision: "1", digest },
      phase: "P2",
      g2: { state: "pending" },
      baseSha: "c".repeat(40),
      budget: { revision: "1", digest },
      runEpoch: 0,
      lifecycle: "active",
    },
    null,
  );
  // root -> lead -> leaf, plus an outsider directly under the root.
  store.putNode(node(rootNodeId, null, "lead-worker"), null);
  seedBoundAgent(db, store, {
    name: "queen-root",
    agentId: "agent-01",
    nodeId: rootNodeId,
    runId,
  });
  store.putNode(node(leadNodeId, rootNodeId, "lead-worker"), null, undefined, {
    binding: { nodeId: rootNodeId, agentId: "agent-01", generation: 1 },
    expectedCapabilityEpoch: 1,
  });
  store.putNode(node(leafNodeId, leadNodeId), null);
  store.putNode(node(outsiderNodeId, rootNodeId), null);
  seedBoundAgent(db, store, {
    name: "lead",
    agentId: "agent-02",
    nodeId: leadNodeId,
    runId,
  });
  seedBoundAgent(db, store, {
    name: "outsider",
    agentId: "agent-04",
    nodeId: outsiderNodeId,
    runId,
  });
});

afterEach(() => {
  db.close();
});

describe("hive_node_create derives the acting identity", () => {
  test("the created node records no actor, and the caller is read from the capability", async () => {
    const created = (await handlerFor("lead")(
      node(createdNodeId, leadNodeId) as never,
    )) as { structuredContent: { node: HierarchyNode } };

    expect(created.structuredContent.node.nodeId).toBe(createdNodeId);
    expect(store.getNode(createdNodeId)?.parentNodeId).toBe(leadNodeId);
  });

  test("a caller with no live agent is refused at the gate", async () => {
    await expect(
      handlerFor("ghost")(node(createdNodeId, leadNodeId) as never),
    ).rejects.toThrow(/No live authority record exists for ghost/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("the door refuses a caller with no live agent on its own", async () => {
    await expect(
      handlerWithoutOuterGate("ghost")(
        node(createdNodeId, leadNodeId) as never,
      ),
    ).rejects.toThrow(/no live agent holds the name ghost/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("a caller whose binding is unbound is refused", async () => {
    const live = store.getAgentBinding({
      nodeId: leadNodeId,
      agentId: "agent-02",
      generation: 1,
    });
    if (live === null) throw new Error("lead binding fixture disappeared");
    store.putAgentBinding({ ...live, unboundAt: stamp }, runId);

    await expect(
      handlerFor("lead")(node(createdNodeId, leadNodeId) as never),
    ).rejects.toThrow(/holds no live hierarchy binding/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("a caller presenting a stale capability epoch is refused at the gate", async () => {
    await expect(
      handlerFor("lead", 2)(node(createdNodeId, leadNodeId) as never),
    ).rejects.toThrow(/Capability epoch 2 is stale/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("the door refuses a stale capability epoch on its own, inside the write", async () => {
    await expect(
      handlerWithoutOuterGate(
        "lead",
        2,
      )(node(createdNodeId, leadNodeId) as never),
    ).rejects.toThrow(/does not hold the live capability epoch/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("a flat capability epoch rotation locks the caller out until the capability is re-minted", async () => {
    // One counter: rotating the flat AgentRecord epoch without a matching
    // capability refuses — outer gate names stale epoch; the write door names
    // the live-capability-epoch hold.
    bumpCapabilityEpoch(db, {
      nodeId: leadNodeId,
      agentId: "agent-02",
      generation: 1,
    });

    await expect(
      handlerFor("lead")(
        node(createdNodeId, leafNodeId, "lead-worker") as never,
      ),
    ).rejects.toThrow(/stale|does not hold the live capability epoch/);
    expect(store.getNode(createdNodeId)).toBeNull();

    await expect(
      handlerWithoutOuterGate(
        "lead",
        1,
      )(node(createdNodeId, leafNodeId, "lead-worker") as never),
    ).rejects.toThrow(/does not hold the live capability epoch/);

    // Re-minting at the live epoch is the recovery path.
    const created = (await handlerFor(
      "lead",
      2,
    )(node(createdNodeId, leafNodeId, "lead-worker") as never)) as {
      structuredContent: { node: HierarchyNode };
    };

    expect(created.structuredContent.node.organizationalRole).toBe(
      "lead-worker",
    );
  });
});

describe("the agent-keyed binding reader", () => {
  test("one agent generation cannot occupy two hierarchy nodes", () => {
    const live = store.findBindingByAgent("agent-02", 1);
    if (live === null) throw new Error("lead binding fixture disappeared");

    expect(() =>
      store.putAgentBinding({ ...live, nodeId: outsiderNodeId }, runId),
    ).toThrow(/agent agent-02 generation 1 is already bound to node/);
    expect(
      store.getAgentBinding({ ...live, nodeId: outsiderNodeId }),
    ).toBeNull();
  });

  test("two generations of one agent are two different bindings", async () => {
    // The same agentId rebound onto a different node at a later generation.
    // Keying on the agent alone would make these one row and hand the caller
    // whichever the scan reached first.
    seedBoundAgent(db, store, {
      name: "lead-next",
      agentId: "agent-02",
      nodeId: outsiderNodeId,
      runId,
      generation: 2,
    });

    expect(store.findBindingByAgent("agent-02", 1)?.nodeId).toBe(leadNodeId);
    expect(store.findBindingByAgent("agent-02", 2)?.nodeId).toBe(
      outsiderNodeId,
    );
    expect(store.findBindingByAgent("agent-02", 3)).toBeNull();
  });
});

describe("the door is reachable by the caller production actually mints", () => {
  // Agents are minted writer or reader (spawner-impl issueCredential). If the
  // tool asked for an action neither role carries, every real caller would be
  // denied while a stubbed suite stayed green.
  test("a writer reaches the door and creates", async () => {
    const created = (await handlerFor(
      "lead",
      1,
      "writer",
    )(node(createdNodeId, leafNodeId) as never)) as {
      structuredContent: { node: HierarchyNode };
    };

    expect(created.structuredContent.node.parentNodeId).toBe(leafNodeId);
  });

  test("a reader is refused: creating a node is not a read-only act", async () => {
    await expect(
      handlerFor("lead", 1, "reader")(node(createdNodeId, leafNodeId) as never),
    ).rejects.toThrow(/may not node:create/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("a writer whose write authority is revoked cannot create a node", async () => {
    const live = db.getAgentByName("lead");
    if (live === null) throw new Error("lead fixture disappeared");
    db.upsertAgent({ ...live, writeRevoked: true });

    await expect(
      handlerFor("lead")(node(createdNodeId, leafNodeId) as never),
    ).rejects.toThrow(/Write and landing authority is revoked for lead/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });
});

describe("hive_node_create enforces creation authority", () => {
  test("a caller that is neither the run root nor an ancestor of the parent is refused", async () => {
    // The outsider sits under the root, so it is inside the run but holds
    // nothing above leadNodeId.
    await expect(
      handlerFor("outsider")(node(createdNodeId, leadNodeId) as never),
    ).rejects.toThrow(/does not hold parent/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("the run root may create anywhere in its run", async () => {
    const created = (await handlerFor("queen-root")(
      node(createdNodeId, leafNodeId) as never,
    )) as { structuredContent: { node: HierarchyNode } };

    expect(created.structuredContent.node.parentNodeId).toBe(leafNodeId);
  });

  test("a lead may create under a descendant of its own node", async () => {
    const created = (await handlerFor("lead")(
      node(createdNodeId, leafNodeId) as never,
    )) as { structuredContent: { node: HierarchyNode } };

    expect(created.structuredContent.node.parentNodeId).toBe(leafNodeId);
  });

  test("creating a second run root through this tool is refused", async () => {
    await expect(
      handlerFor("queen-root")(node(createdNodeId, null) as never),
    ).rejects.toThrow(/a run root is not created through this tool/);
    expect(store.getNode(createdNodeId)).toBeNull();
  });
});

describe("hive_node_create validates the owner edge at the write", () => {
  test("owner=parent and owner=self are both admitted inside a held subtree", async () => {
    await handlerFor("lead")(node(createdNodeId, leadNodeId) as never);
    await handlerFor("lead")({
      ...node(selfOwnedNodeId, leafNodeId),
      ownerNodeId: selfOwnedNodeId,
    } as never);

    expect(store.getNode(createdNodeId)?.ownerNodeId).toBe(leadNodeId);
    expect(store.getNode(selfOwnedNodeId)?.ownerNodeId).toBe(selfOwnedNodeId);
  });

  test("a missing owner node is refused without creating the node", async () => {
    expect(store.getNode(missingOwnerNodeId)).toBeNull();

    await expect(
      handlerFor("lead")({
        ...node(createdNodeId, leafNodeId),
        ownerNodeId: missingOwnerNodeId,
      } as never),
    ).rejects.toThrow(
      `owner node ${missingOwnerNodeId} must exist before creating node ${createdNodeId}`,
    );
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("an owner node from another run is refused independently", async () => {
    const activeRun = store.getRun(runId);
    if (activeRun === null) throw new Error("active run fixture disappeared");
    store.putRun(
      {
        ...activeRun,
        runId: foreignRunId,
        revision: "1",
        instanceId: "instance-foreign",
      },
      null,
    );
    store.putNode(
      {
        ...node(foreignRootNodeId, null),
        runId: foreignRunId,
        ownerNodeId: null,
      },
      null,
    );

    await expect(
      handlerFor("lead")({
        ...node(crossRunNodeId, leafNodeId),
        ownerNodeId: foreignRootNodeId,
      } as never),
    ).rejects.toThrow(
      `owner node ${foreignRootNodeId} belongs to run ${foreignRunId}, not ${runId}`,
    );
    expect(store.getNode(crossRunNodeId)).toBeNull();
  });

  test("an owner outside the creator's held subtree is refused", async () => {
    expect(store.getNode(outsiderNodeId)?.runId).toBe(runId);

    await expect(
      handlerFor("lead")({
        ...node(createdNodeId, leafNodeId),
        ownerNodeId: outsiderNodeId,
      } as never),
    ).rejects.toThrow(
      `owner node ${outsiderNodeId} is outside creator ${leadNodeId}'s held subtree`,
    );
    expect(store.getNode(createdNodeId)).toBeNull();
  });
});

describe("hive_node_create requires an active stored run", () => {
  test("a missing run is refused at the final store door", async () => {
    expect(store.getRun(runId)?.lifecycle).toBe("active");
    db.database
      .query("DELETE FROM hierarchy_records WHERE kind = 'run' AND id = ?")
      .run(runId);
    expect(store.getRun(runId)).toBeNull();

    await expect(
      handlerFor("lead")(node(createdNodeId, leafNodeId) as never),
    ).rejects.toThrow(`run ${runId} must exist and be active`);
    expect(store.getNode(createdNodeId)).toBeNull();
  });

  test("a closed run is refused at the final store door", async () => {
    const activeRun = store.getRun(runId);
    if (activeRun === null) throw new Error("active run fixture disappeared");
    store.putRun({ ...activeRun, revision: "2", lifecycle: "completed" }, "1");

    await expect(
      handlerFor("lead")(node(createdNodeId, leafNodeId) as never),
    ).rejects.toThrow(`run ${runId} must exist and be active`);
    expect(store.getRun(runId)?.lifecycle).toBe("completed");
    expect(store.getNode(createdNodeId)).toBeNull();
  });
});

describe("hive_node_create composes with the landed conferral guard", () => {
  test("a lead confers lead-worker inside its subtree; a plain worker cannot", async () => {
    const conferred = (await handlerFor("lead")(
      node(createdNodeId, leafNodeId, "lead-worker") as never,
    )) as { structuredContent: { node: HierarchyNode } };
    expect(conferred.structuredContent.node.organizationalRole).toBe(
      "lead-worker",
    );

    // The outsider is a plain worker: it fails creation authority before the
    // conferral guard is ever consulted, which is the stricter of the two.
    await expect(
      handlerFor("outsider")(
        node(
          "node_018f4f5e-0000-7000-8000-00000000010a",
          outsiderNodeId,
          "lead-worker",
        ) as never,
      ),
    ).rejects.toThrow(/is not lead-worker/);
  });
});
