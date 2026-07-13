import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_SUBJECT, writeCredential } from "../daemon/credentials";
import {
  parseChainEntryArg,
  parseEffortTargetArg,
  setProviderPolicy,
} from "./routing-policy";

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

describe("Model Control Center daemon pinning", () => {
  test("an explicit port wins over another daemon's global pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-routing-port-"));
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "daemon.port"), "4317\n");
    writeCredential(OPERATOR_SUBJECT, "operator-test-token");

    const policy = {
      schemaVersion: 1,
      revision: 9,
      updatedAt: "2026-07-13T12:00:00.000Z",
      provisional: false,
      providers: { claude: "enabled" },
      models: [{
        provider: "claude",
        model: "claude-test",
        state: "enabled",
        effort: { mode: "provider-controlled" },
      }],
      chains: {
        default: [{
          provider: "claude",
          model: "claude-test",
          effort: { mode: "provider-controlled" },
        }],
      },
      selection: { global: "spread", categories: {} },
    };
    let requestedUrl = "";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((
      async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(policy), {
          headers: { "content-type": "application/json" },
        });
      }
    ) as typeof fetch);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await setProviderPolicy("claude", "enabled", "8", 4483);
      expect(requestedUrl).toEqual("http://127.0.0.1:4483/routing/policy");
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
