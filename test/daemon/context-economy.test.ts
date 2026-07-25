import { describe, expect, test } from "bun:test";
import { buildAgentPrompt } from "../../src/daemon/spawner-impl";

const worktree = {
  path: "/repo/.hive/worktrees/reviewer",
  branch: "hive/reviewer-context-economy",
};

describe("C3 context economy", () => {
  test("bootstrap keeps judgment rules and drops daemon-enforced repetition", () => {
    const task = "Review the context projection.";
    const prompt = buildAgentPrompt("reviewer", task, worktree, "", {
      tool: "codex",
      category: "code_review",
    });

    expect(prompt).toContain(`Your task: ${task}`);
    expect(prompt).toContain("An absent field is unknown");
    expect(prompt).toContain("Measure, do not infer");
    expect(prompt).not.toContain("Urgent is a turn kill");
    expect(prompt).not.toContain("After 3 failed attempts");
    expect(prompt).not.toContain("(src/, not the repo root)");
    expect(prompt).not.toContain("merge-base with main");
    expect(prompt).toContain("primary checkout's current branch");

    const hiveBytes =
      Buffer.byteLength(prompt, "utf8") - Buffer.byteLength(task, "utf8");
    expect(hiveBytes).toBeLessThan(6_000);
  });
});
