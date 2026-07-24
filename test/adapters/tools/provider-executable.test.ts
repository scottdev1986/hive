import { describe, expect, test } from "bun:test";
import { resolveProviderExecutable } from "../../../src/adapters/tools/provider-executable";

describe("provider executable resolution", () => {
  test("skips a broken earlier shim and accepts a later working installation", () => {
    expect(resolveProviderExecutable(
      "claude",
      [],
      (candidate) => candidate === "/broken/claude" ? null : "Claude Code current",
      () => ["/broken/claude", "/working/claude"],
    )).toEqual({
      path: "/working/claude",
      version: null,
    });
  });

  test("records a version when available without gating on it", () => {
    expect(resolveProviderExecutable(
      "codex",
      [],
      () => "codex-cli 999.42.7",
      () => ["/working/codex"],
    )).toEqual({
      path: "/working/codex",
      version: "999.42.7",
    });
  });
});
