import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadAgentStandards } from "../../src/daemon/spawn/agent-standards";
import { buildAgentPrompt } from "../../src/daemon/spawn/spawner-impl";

const worktree = {
  path: "/repo/.hive/worktrees/maya",
  branch: "hive/maya-graph",
};

const standards = await loadAgentStandards(join(import.meta.dir, "../.."));

const prompt = (tool: "claude" | "grok" | "codex") =>
  buildAgentPrompt("maya", "Find the spawner.", worktree, "", standards, {
    tool,
    graphifyTools: true,
  });

const ACTIVATION =
  "select:mcp__hive__graph_locate,mcp__graphify__get_neighbors," +
  "mcp__graphify__query_graph,mcp__graphify__shortest_path";

describe("graphify spawn directive", () => {
  // Claude agents made 0 graph calls in 60 graph-visible sessions while making
  // 607 successful Hive MCP calls, and transcripts show them loading the graph
  // tools and then calling Read. Naming the tools was never the gap; the
  // deferral step between naming one and calling it was.
  test("gives Claude the two-step activation for its deferred graph tools", () => {
    const claude = prompt("claude");
    expect(claude).toContain("call ToolSearch with");
    expect(claude).toContain(ACTIVATION);
    expect(claude).toContain("then invoke the tool reference it returns");
  });

  test("leaves harnesses without deferred tools unchanged", () => {
    for (const tool of ["grok", "codex"] as const) {
      expect(prompt(tool)).toContain("call the hive tool graph_locate");
      expect(prompt(tool)).not.toContain("ToolSearch");
    }
  });

  test("says nothing about the graph tools when graphify is off", () => {
    const off = buildAgentPrompt(
      "maya",
      "Find the spawner.",
      worktree,
      "",
      standards,
      { tool: "claude" },
    );
    expect(off).not.toContain("ToolSearch");
    expect(off).not.toContain("graph_locate");
  });
});
