import { describe, expect, test } from "bun:test";
import { SpawnRequestSchema } from "../../src/daemon/spawner";

describe("hive_spawn schema after the router cutover", () => {
  test("accepts category routing with the long-context requirement modifier", () => {
    expect(SpawnRequestSchema.parse({
      task: "Review the authentication flow",
      category: "code_review",
      reviewOfTool: "codex",
      minContextTokens: 1_000_000,
      readOnly: true,
    })).toEqual({
      task: "Review the authentication flow",
      category: "code_review",
      reviewOfTool: "codex",
      minContextTokens: 1_000_000,
      readOnly: true,
    });
  });

  test("tiers are gone and long_context is not a category", () => {
    expect(SpawnRequestSchema.safeParse({
      task: "Build it",
      category: "complex_coding",
      tier: "deep",
    }).success).toBeFalse();
    expect(SpawnRequestSchema.safeParse({
      task: "Read a large document",
      category: "long_context",
    }).success).toBeFalse();
  });
});
