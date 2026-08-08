// MCP tool for hierarchy node creation. The tool input names the node to create; it never names who is creating it. The acting hierarchy identity is resolved from the calling capability inside the same transaction as the write, which HierarchyService owns.

import type { HiveToolRegistrar } from "../authorization/mcp-tool-policy";
import { HierarchyNodeSchema } from "../../schemas/hierarchy-node";
import type { Capability } from "../authorization/authorization-service";
import type { HierarchyService } from "./hierarchy-service";
import { toolResult } from "../../shared/mcp-tool-result";

export function registerHierarchyNodeTools(
  server: HiveToolRegistrar,
  capability: Capability,
  hierarchy: HierarchyService,
): void {
  server.registerTool(
    "hive_node_create",
    {
      title: "Create hierarchy node",
      description:
        "Create one hierarchy node under a parent you hold. The daemon reads who you are from your capability — the node you describe is the one being created, not the one creating it.",
      inputSchema: HierarchyNodeSchema,
    },
    async (node) => toolResult(hierarchy.createNode(capability, node), "node"),
  );
}
