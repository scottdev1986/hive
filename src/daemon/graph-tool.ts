import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { graphLocate } from "../adapters/graphify";
import type { Action, Capability } from "./capabilities";
import { toolResult } from "./tool-result";

/**
 * The graph-locate tool, with its dependencies named.
 *
 * Last of the tool-group extractions out of `createMcpServer` (audit §11), and
 * the smallest: two dependencies. It is separate from the memory group on
 * purpose — locating code in the repo graph is not recalling a memory article,
 * and the two surfaces share no state.
 */
export interface GraphToolDeps {
  repoRoot: string;
  authorizeTool: (
    capability: Capability,
    tool: string,
    action: Action,
    subject?: string,
    auditAllow?: boolean,
  ) => void;
}

export function registerGraphTool(
  server: McpServer,
  capability: Capability,
  deps: GraphToolDeps,
): void {
  // The mid-task half of the graph-first mandate: the same locate the spawn
  // brief runs (Hive-side seeding + expansion over graph.json), callable
  // with a natural-language question. Lives on Hive's server, not
  // graphify's — that surface is pre-1.0 and not ours — and never blocks:
  // every failure is an honest "use grep" answer, not an error.
  server.registerTool(
    "graph_locate",
    {
      title: "Locate files for a question via the code knowledge graph",
      description:
        "Find where something lives or happens in this repo: returns the files, symbols (with file:line citations), and import edges (with EXTRACTED/INFERRED provenance tags) that best match a natural-language question, using the repo's local knowledge graph. Use it for locate- and structure-questions before grep; it matches names and structure, not file contents, so exact-string hunts and vocabulary the code does not use still belong to grep/rg. Answers are leads to verify, never authority.",
      inputSchema: z.object({
        question: z
          .string()
          .min(3)
          .describe(
            'What you are trying to find, in plain words — e.g. "where does the daemon attach the MCP server to a spawning agent"',
          ),
      }),
    },
    async ({ question }) => {
      deps.authorizeTool(
        capability,
        "graph_locate",
        "status:read",
        undefined,
        false,
      );
      return toolResult(await graphLocate(deps.repoRoot, question), "locate");
    },
  );
}
