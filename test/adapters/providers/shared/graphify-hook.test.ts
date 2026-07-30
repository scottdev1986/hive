import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGraphifyHook } from "../../../../src/adapters/providers/shared/graphify-hook";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let path: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hive-graphify-hook-"));
  path = join(root, "hook.sh");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        {
          jsonrpc: "2.0",
          error: { message: "Bad Request: Missing session ID" },
        },
        { status: 400, headers: { Connection: "close" } },
      ),
  });
  await writeGraphifyHook(path, `http://127.0.0.1:${server.port}/mcp`);
});

afterAll(async () => {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const run = async (kind: string, input: string) => {
  const child = Bun.spawn([path, kind], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: root,
  });
  child.stdin.write(input);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

/** The one decline is spent on the first structural search of a session. Tests
 * that are about the advisory nudge spend it up front; gate tests clear it. */
const spendGate = () => writeFile(`${path}.gate`, "");
const armGate = () => rm(`${path}.gate`, { force: true });

describe("graphify PreToolUse hook", () => {
  test("nudges both harnesses through hookSpecificOutput without blocking", async () => {
    await spendGate();
    for (const kind of ["claude-search", "codex"]) {
      const result = await run(
        kind,
        '{"tool_input":{"command":"rg auth src"}}',
      );
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      expect(output).toMatchObject({ hookEventName: "PreToolUse" });
      expect(output.additionalContext).toContain("token_budget: 16000");
    }
  });

  test("irrelevant or graph-output reads are silent", async () => {
    // Codex normalizes its shell tool to "Bash" in hook input, so the same
    // search filter applies: a non-search command must not spend a nudge.
    expect(
      (await run("claude-search", '{"tool_input":{"command":"git status"}}'))
        .stdout.length,
    ).toBe(0);
    expect(
      (await run("codex", '{"tool_input":{"command":"git status"}}')).stdout
        .length,
    ).toBe(0);
    expect(
      (
        await run(
          "claude-read",
          '{"tool_input":{"file_path":"graphify-out/graph.json"}}',
        )
      ).stdout.length,
    ).toBe(0);
  });

  test("a native Grep call is nudged; a Grep of graph output is not", async () => {
    await spendGate();
    const grep = await run(
      "claude-read",
      '{"tool_name":"Grep","tool_input":{"pattern":"reserveQuota","path":"src"}}',
    );
    expect(grep.exitCode).toBe(0);
    expect(
      JSON.parse(grep.stdout).hookSpecificOutput.additionalContext,
    ).toContain("graph_locate");

    expect(
      (
        await run(
          "claude-read",
          '{"tool_name":"Grep","tool_input":{"pattern":"x","path":"graphify-out/graph.json"}}',
        )
      ).stdout.length,
    ).toBe(0);
  });

  test("declines the first structural search of a session, exactly once", async () => {
    for (const [kind, input] of [
      ["claude-read", '{"tool_name":"Grep","tool_input":{"pattern":"x"}}'],
      ["claude-search", '{"tool_input":{"command":"rg auth src"}}'],
      ["grok", '{"tool_name":"read_file","tool_input":{"path":"src/x.ts"}}'],
    ] as const) {
      await armGate();
      const declined = JSON.parse(
        (await run(kind, input)).stdout,
      ).hookSpecificOutput;
      expect(declined.permissionDecision).toBe("deny");
      expect(declined.permissionDecisionReason).toContain(
        "select:mcp__hive__graph_locate,mcp__graphify__get_neighbors",
      );
      // The escape hatch has to be in the message the agent is shown, or a
      // question the graph cannot answer becomes a dead end.
      expect(declined.permissionDecisionReason).toContain(
        "repeat this exact call",
      );

      // Retrying the identical call is the recovery path: it must run.
      const retry = JSON.parse(
        (await run(kind, input)).stdout,
      ).hookSpecificOutput;
      expect(retry.permissionDecision).toBeUndefined();
      expect(retry.additionalContext).toContain("graph_locate");
    }
  });

  test("codex is never gated", async () => {
    await armGate();
    const result = JSON.parse(
      (await run("codex", '{"tool_input":{"command":"rg auth src"}}')).stdout,
    ).hookSpecificOutput;
    expect(result.permissionDecision).toBeUndefined();
    expect(result.additionalContext).toContain("graph_locate");
  });

  test("a graph call spends the gate, so graph-first work is never declined", async () => {
    await armGate();
    // Claude's hook matcher carries the graph tools for exactly this reason.
    expect(
      (
        await run(
          "claude-read",
          '{"tool_name":"mcp__hive__graph_locate","tool_input":{"question":"where"}}',
        )
      ).stdout.length,
    ).toBe(0);
    const after = JSON.parse(
      (
        await run(
          "claude-read",
          '{"tool_name":"Read","tool_input":{"file_path":"src/x.ts"}}',
        )
      ).stdout,
    ).hookSpecificOutput;
    expect(after.permissionDecision).toBeUndefined();
    expect(after.additionalContext).toContain("graph_locate");
  });

  test("kimi and opencode gate on tool_name, and each vendor's graph naming spends the gate", async () => {
    for (const [kind, structural, graphCall] of [
      [
        "kimi",
        '{"tool_name":"Grep","tool_input":{"pattern":"reserveQuota"}}',
        // Kimi names MCP tools mcp__<server>__<tool>, like Claude.
        '{"tool_name":"mcp__graphify__query_graph","tool_input":{"question":"where"}}',
      ],
      [
        "opencode",
        '{"tool_name":"grep","tool_input":{"pattern":"reserveQuota"}}',
        // opencode names MCP tools <server>_<tool> — a single underscore the
        // double-underscore spend pattern would miss.
        '{"tool_name":"graphify_query_graph","tool_input":{"question":"where"}}',
      ],
    ] as const) {
      await armGate();
      const declined = JSON.parse(
        (await run(kind, structural)).stdout,
      ).hookSpecificOutput;
      expect(declined.permissionDecision).toBe("deny");
      // Retrying the identical call is the recovery path: it must run.
      const retry = JSON.parse(
        (await run(kind, structural)).stdout,
      ).hookSpecificOutput;
      expect(retry.permissionDecision).toBeUndefined();

      // A graph call in this vendor's own naming spends the gate silently, so
      // graph-first work is never declined.
      await armGate();
      expect((await run(kind, graphCall)).stdout.length).toBe(0);
      const after = JSON.parse(
        (await run(kind, structural)).stdout,
      ).hookSpecificOutput;
      expect(after.permissionDecision).toBeUndefined();
    }
  });

  test("kimi and opencode non-structural calls are silent", async () => {
    await armGate();
    for (const [kind, input] of [
      ["kimi", '{"tool_name":"Edit","tool_input":{"path":"src/x.ts"}}'],
      [
        "kimi",
        '{"tool_name":"mcp__hive__hive_send","tool_input":{"to":"queen"}}',
      ],
      [
        "opencode",
        '{"tool_name":"bash","tool_input":{"command":"git status"}}',
      ],
      [
        "opencode",
        '{"tool_name":"hive_hive_send","tool_input":{"to":"queen"}}',
      ],
    ] as const) {
      expect((await run(kind, input)).stdout.length).toBe(0);
    }
    // Nothing structural was seen, so the session's decline is still unspent.
    expect(stat(`${path}.gate`)).rejects.toThrow();
  });

  test("a dead server is a fast, successful no-op", async () => {
    // Armed on purpose: a broken graphify must not gate anything.
    await armGate();
    server.stop(true);
    const started = performance.now();
    for (const kind of ["codex", "claude-search"]) {
      const result = await run(
        kind,
        '{"tool_input":{"command":"rg auth src"}}',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBe(0);
    }
    expect(performance.now() - started).toBeLessThan(200);
    // Nothing was declined, so the session's one decline is still unspent.
    expect(stat(`${path}.gate`)).rejects.toThrow();
  });

  test("disable removes the worktree-local hook and its gate marker", async () => {
    expect((await readFile(path, "utf8")).startsWith("#!/bin/sh\n")).toBe(true);
    await spendGate();
    await writeGraphifyHook(path, undefined);
    expect(stat(path)).rejects.toThrow();
    expect(stat(`${path}.gate`)).rejects.toThrow();
  });
});
