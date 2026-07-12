import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGraphifyHook } from "./graphify-hook";

let root: string;
let server: ReturnType<typeof Bun.serve>;
let path: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hive-graphify-hook-"));
  path = join(root, "hook.sh");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(
      { jsonrpc: "2.0", error: { message: "Bad Request: Missing session ID" } },
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

// Adoption baseline, 2026-07-12: neutral capability-tracing agent Arash used
// a healthy attached server but finished with graphifyCalls=0 (positive
// controls: April=2, Anton=1). That is why this is a harness hook, not another
// prompt-only instruction.
describe("graphify PreToolUse hook", () => {
  test("nudges both harnesses through hookSpecificOutput without blocking", async () => {
    // One shape on purpose: Codex 0.144.1 parses {"systemMessage": …} and then
    // silently drops it (measured — the text never reached a model request),
    // while additionalContext is injected as a developer message on both CLIs.
    for (const kind of ["claude-search", "codex"]) {
      const result = await run(kind, '{"tool_input":{"command":"rg auth src"}}');
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      expect(output).toMatchObject({ hookEventName: "PreToolUse" });
      expect(output.additionalContext).toContain("token_budget: 16000");
    }
  });

  test("irrelevant or graph-output reads are silent", async () => {
    // Codex normalizes its shell tool to "Bash" in hook input, so the same
    // search filter applies: a non-search command must not spend a nudge.
    expect((await run("claude-search", '{"tool_input":{"command":"git status"}}')).stdout.length)
      .toBe(0);
    expect((await run("codex", '{"tool_input":{"command":"git status"}}')).stdout.length)
      .toBe(0);
    expect((await run("claude-read", '{"tool_input":{"file_path":"graphify-out/graph.json"}}')).stdout.length)
      .toBe(0);
  });

  test("a dead server is a fast, successful no-op", async () => {
    server.stop(true);
    const started = performance.now();
    const result = await run("codex", '{"tool_input":{"command":"rg auth src"}}');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("disable removes the worktree-local hook", async () => {
    expect((await readFile(path, "utf8")).startsWith("#!/bin/sh\n")).toBe(true);
    await writeGraphifyHook(path, undefined);
    expect(stat(path)).rejects.toThrow();
  });
});
