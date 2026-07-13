import { describe, expect, test } from "bun:test";
import { parseChainEntryArg, parseEffortTargetArg } from "./routing-policy";

describe("chain entry syntax — the CLI half of the Control Center contract", () => {
  test("provider/model parses as a specific target with provider-controlled effort", () => {
    expect(parseChainEntryArg("claude/claude-fable-5")).toEqual({
      provider: "claude",
      model: "claude-fable-5",
      effort: { mode: "provider-controlled" },
    });
  });

  test("@LEVEL pins an exact effort; @none states the no-effort axis", () => {
    expect(parseChainEntryArg("codex/gpt-5.6-sol@high")).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
    });
    expect(parseChainEntryArg("grok/grok-composer-2.5-fast@none")).toEqual({
      provider: "grok",
      model: "grok-composer-2.5-fast",
      effort: { mode: "none" },
    });
  });

  test("there is NO vendor-default form — the user is specific on the models he chooses", () => {
    // "vendor-default:grok" has no slash, so it fails the only legal shape.
    expect(() => parseChainEntryArg("vendor-default:grok")).toThrow(/provider\/model/);
  });

  test("an unknown provider, a missing model, and a bare word all refuse with the syntax named", () => {
    expect(() => parseChainEntryArg("acme/some-model")).toThrow(/unknown provider/);
    expect(() => parseChainEntryArg("claude/")).toThrow(/provider\/model/);
    expect(() => parseChainEntryArg("claude")).toThrow(/provider\/model/);
  });

  test("effort targets parse exactly and reject the rest", () => {
    expect(parseEffortTargetArg("exact:xhigh")).toEqual({ mode: "exact", value: "xhigh" });
    expect(parseEffortTargetArg("none")).toEqual({ mode: "none" });
    expect(parseEffortTargetArg("provider-controlled"))
      .toEqual({ mode: "provider-controlled" });
    expect(() => parseEffortTargetArg("exact:")).toThrow(/effort must be/);
    expect(() => parseEffortTargetArg("high")).toThrow(/effort must be/);
  });
});
