import type { HiveToolServer } from "../authorization/mcp-tool-policy";
import { HierarchyNodeSchema } from "../../schemas/hierarchy-node";
import type { Capability } from "../authorization/authorization-service";
import type { HierarchyService } from "./hierarchy-service";
import { toolResult } from "../../shared/mcp-tool-result";

export function registerHierarchyNodeTools(
  server: HiveToolServer,
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
