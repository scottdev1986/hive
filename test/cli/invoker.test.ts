import { describe, expect, test } from "bun:test";
import {
  captureInvokerIdentity,
  formatInvokerOrigin,
  isAgentCaller,
  isAgentCapabilityEnv,
  isAgentWorktreePath,
  isTestRunnerEnv,
} from "../../src/cli/invoker";

describe("invoker identity (#70)", () => {
  test("walks the parent chain with process names and stops at an unresolvable pid", () => {
    const parents = new Map<number, { ppid: number; command: string }>([
      [500, { ppid: 900, command: "zsh" }],
      [900, { ppid: 800, command: "zsh" }],
      // 800 is gone: the chain ends honestly.
    ]);
    // The walk starts at a pid this test owns. Keyed on the real parent instead,
    // the case below would decide the outcome: a runner whose parent has exited
    // walks from pid 1 and gets nothing, so the fixture would never be reached.
    const identity = captureInvokerIdentity(
      (pid) => parents.get(pid) ?? null,
      500,
    );

    expect(identity.pid).toBe(process.pid);
    expect(identity.ppid).toBe(process.ppid);
    expect(identity.chain).toEqual(["500:zsh", "900:zsh"]);
    expect(identity.argv).toEqual(process.argv.slice(2));
    expect(identity.cwd).toBe(process.cwd());
  });

  test("an orphaned invoker reports no chain at all", () => {
    // Positive control on the reader: it answers for pid 1, so an empty chain is
    // the walk refusing to start at init, not a lookup that came back missing.
    const identity = captureInvokerIdentity(
      () => ({ ppid: 0, command: "launchd" }),
      1,
    );

    expect(identity.chain).toEqual([]);
  });

  test("flags an agent worktree cwd; positive control on the flat repo path", () => {
    expect(isAgentWorktreePath("/repo/.hive/worktrees/maya")).toBe(true);
    expect(isAgentWorktreePath("/repo/.hive/worktrees/maya/src")).toBe(true);
    expect(isAgentWorktreePath("/repo/.hive/worktrees")).toBe(true);
    // Positive control: ordinary paths are not worktrees.
    expect(isAgentWorktreePath("/repo")).toBe(false);
    expect(isAgentWorktreePath("/repo/.hive/memory")).toBe(false);
  });

  test("a capability token is an agent even outside a worktree", () => {
    expect(isAgentCapabilityEnv({})).toBe(false);
    expect(isAgentCapabilityEnv({ HIVE_CAPABILITY_TOKEN: "" })).toBe(false);
    expect(isAgentCapabilityEnv({ HIVE_CAPABILITY_TOKEN: "tok" })).toBe(true);
    expect(isAgentCaller("/repo", { HIVE_CAPABILITY_TOKEN: "tok" })).toBe(true);
    expect(isAgentCaller("/repo", {})).toBe(false);
    expect(isAgentCaller("/repo/.hive/worktrees/elton", {})).toBe(true);
  });

  test("formats a compact, attributable origin string", () => {
    const origin = formatInvokerOrigin("stop", {
      pid: 1,
      ppid: 2,
      argv: [],
      cwd: "/repo/.hive/worktrees/maya",
      chain: ["2:bash", "3:bun"],
      agentWorktree: true,
    });
    expect(origin).toBe(
      "hive stop pid=1 ppid=2 argv=[] cwd=/repo/.hive/worktrees/maya " +
        "agentWorktree=yes chain=[2:bash,3:bun]",
    );
  });

  test("this very process is recognized as a test runner", () => {
    // bun test stamps NODE_ENV=test; the ambient-kill guard keys on it.
    expect(isTestRunnerEnv()).toBe(true);
  });
});
