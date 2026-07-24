import { describe, expect, test } from "bun:test";
import {
  captureInvokerIdentity,
  formatInvokerOrigin,
  isAgentWorktreePath,
  isTestRunnerEnv,
} from "../../src/cli/invoker";

describe("invoker identity (#70)", () => {
  test("walks the parent chain with process names and stops at an unresolvable pid", () => {
    const parents = new Map<number, { ppid: number; command: string }>([
      [process.ppid, { ppid: 900, command: "zsh" }],
      [900, { ppid: 800, command: "zsh" }],
      // 800 is gone: the chain ends honestly.
    ]);
    const identity = captureInvokerIdentity((pid) => parents.get(pid) ?? null);

    expect(identity.pid).toBe(process.pid);
    expect(identity.ppid).toBe(process.ppid);
    expect(identity.chain).toEqual([
      `${process.ppid}:zsh`,
      "900:zsh",
    ]);
    expect(identity.argv).toEqual(process.argv.slice(2));
    expect(identity.cwd).toBe(process.cwd());
  });

  test("flags an agent worktree cwd; positive control on the flat repo path", () => {
    expect(isAgentWorktreePath("/repo/.hive/worktrees/maya")).toBe(true);
    expect(isAgentWorktreePath("/repo/.hive/worktrees/maya/src")).toBe(true);
    expect(isAgentWorktreePath("/repo/.hive/worktrees")).toBe(true);
    // Positive control: the detector must not flag everything.
    expect(isAgentWorktreePath("/repo")).toBe(false);
    expect(isAgentWorktreePath("/repo/.hive/memory")).toBe(false);
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
    // bun test stamps NODE_ENV=test; the #70 ambient-kill guard keys on it.
    expect(isTestRunnerEnv()).toBe(true);
  });
});
