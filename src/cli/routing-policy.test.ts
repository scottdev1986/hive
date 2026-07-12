import { describe, expect, test } from "bun:test";
import { parseChainEntryArg, parseEffortTargetArg } from "./routing-policy";

describe("chain entry syntax — the CLI half of the Control Center contract", () => {
  test("provider/model parses as an exact target with provider-controlled effort", () => {
    expect(parseChainEntryArg("claude/claude-fable-5")).toEqual({
      mode: "exact",
      provider: "claude",
      model: "claude-fable-5",
      effort: { mode: "provider-controlled" },
    });
  });

  test("@LEVEL pins an exact effort; @none states the no-effort axis", () => {
    expect(parseChainEntryArg("codex/gpt-5.6-sol@high")).toEqual({
      mode: "exact",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
    });
    expect(parseChainEntryArg("grok/grok-composer-2.5-fast@none")).toEqual({
      mode: "exact",
      provider: "grok",
      model: "grok-composer-2.5-fast",
      effort: { mode: "none" },
    });
  });

  test("vendor-default:provider is the labeled volatile form", () => {
    expect(parseChainEntryArg("vendor-default:grok")).toEqual({
      mode: "vendor-default",
      provider: "grok",
      effort: { mode: "provider-controlled" },
    });
    expect(parseChainEntryArg("vendor-default:claude@high")).toEqual({
      mode: "vendor-default",
      provider: "claude",
      effort: { mode: "exact", value: "high" },
    });
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
