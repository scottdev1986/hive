// Resolves the hierarchy identity held by one authenticated MCP session. Flat AgentRecord.capabilityEpoch is the one credential-rotation counter: it authenticates the capability and fences hierarchy authority. There is no second copy on AgentBinding.

import { isOrchestratorName } from "../../schemas/agent";
import type {
  AgentBinding,
  AgentBindingRef,
} from "../../schemas/hierarchy-node";
import {
  AuthorizationRefusedError,
  type Capability,
} from "../authorization/authorization-service";
import type { HiveDatabase } from "../database/hive-database";
import type { HierarchyStore } from "../hierarchy-store";

export type HierarchyToolAuthorityDeps = {
  db: HiveDatabase;
  store: HierarchyStore;
};

export type HierarchyActingBinding =
  | (AgentBinding & { authorityKind: "agent" })
  | (AgentBindingRef & { authorityKind: "root" });

export function isRootActingBinding(
  binding: HierarchyActingBinding,
): binding is AgentBindingRef & { authorityKind: "root" } {
  return binding.authorityKind === "root";
}

export function requireActingBinding(
  capability: Capability,
  deps: HierarchyToolAuthorityDeps,
  runId?: string,
): HierarchyActingBinding {
  if (isOrchestratorName(capability.subject)) {
    if (capability.role !== "orchestrator" || runId === undefined) {
      throw new AuthorizationRefusedError(
        "root hierarchy authority requires an orchestrator run",
      );
    }
    const run = deps.store.getRun(runId);
    if (run === null) {
      throw new AuthorizationRefusedError(
        `root hierarchy authority has no run ${runId}`,
      );
    }
    const providerRun = deps.db.getActiveRootProviderRun(run.instanceId);
    if (providerRun === null) {
      throw new AuthorizationRefusedError(
        `root hierarchy authority has no active provider run for ${run.instanceId}`,
      );
    }
    if (capability.epoch !== providerRun.capabilityEpoch) {
      throw new AuthorizationRefusedError(
        "root capability does not hold the live provider epoch",
      );
    }
    const binding = deps.store.getRootBinding(runId);
    const node = binding === null ? null : deps.store.getNode(binding.nodeId);
    if (
      binding === null ||
      node === null ||
      node.runId !== runId ||
      node.parentNodeId !== null ||
      node.lifecycle !== "active"
    ) {
      throw new AuthorizationRefusedError(
        `run ${runId} has no live root hierarchy binding`,
      );
    }
    return { ...binding, authorityKind: "root" };
  }
  const live = deps.db.getLiveAgentByName(capability.subject);
  if (live === null) {
    throw new AuthorizationRefusedError(
      `no live agent holds the name ${capability.subject}`,
    );
  }
  const locator = live.sessionLocator;
  if (
    locator === undefined ||
    locator.subject.kind !== "agent" ||
    locator.subject.agentId !== live.id
  ) {
    throw new AuthorizationRefusedError(
      `agent ${capability.subject} has no live session identity`,
    );
  }
  if (capability.epoch !== live.capabilityEpoch) {
    throw new AuthorizationRefusedError(
      `caller ${capability.subject} does not hold the live capability epoch`,
    );
  }
  const binding = deps.store.findBindingByAgent(live.id, locator.generation);
  if (binding === null || binding.unboundAt !== null) {
    throw new AuthorizationRefusedError(
      `agent ${capability.subject} holds no live hierarchy binding`,
    );
  }
  return { ...binding, authorityKind: "agent" };
}

export function bindingRef(binding: AgentBindingRef): AgentBindingRef {
  return {
    nodeId: binding.nodeId,
    agentId: binding.agentId,
    generation: binding.generation,
  };
}
