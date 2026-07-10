import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const requestPath = process.env.AGENTHOST_APPROVAL_REQUEST;
const decisionPath = process.env.AGENTHOST_APPROVAL_DECISION;
if (requestPath === undefined || decisionPath === undefined) {
  throw new Error("approval relay paths are required");
}

const server = new McpServer({ name: "agenthost", version: "0.1.0" });
server.registerTool("permission_prompt", {
  description: "Prototype-only Claude permission relay sentinel",
  inputSchema: z.object({}).passthrough(),
}, async (input) => {
  const approvalId = randomUUID();
  writeFileSync(requestPath, `${JSON.stringify({ approvalId, input })}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 3_000 && !existsSync(decisionPath); attempt += 1) {
    await Bun.sleep(10);
  }
  if (!existsSync(decisionPath)) throw new Error("AgentHost approval decision timed out");
  const decision = JSON.parse(readFileSync(decisionPath, "utf8")) as { behavior: "allow" | "deny" };
  return {
    content: [{ type: "text", text: JSON.stringify({
      behavior: decision.behavior,
      message: decision.behavior === "deny" ? "DENIED_BY_AGENTHOST_PROTOTYPE" : undefined,
    }) }],
  };
});
await server.connect(new StdioServerTransport());
