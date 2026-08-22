import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEffortTargetArg,
  parseRouteCandidateArg,
  setProviderPolicy,
  setRoute,
} from "../../src/cli/routing-policy-command";
import {
  USER_SUBJECT,
  writeCredential,
} from "../../src/daemon/authorization/credentials";
import { HiveDatabase } from "../../src/daemon/database/hive-database";
import { machineModelControlDatabase } from "../../src/daemon/routing-service/instance-settings";
import { RoutingPolicyStore } from "../../src/daemon/routing-policy-store";
import { HiveDaemon } from "../../src/daemon/server";

describe("route candidate syntax — the CLI half of the Control Center contract", () => {
  test("provider/model parses as a specific target with provider-controlled effort and weight 1", () => {
    expect(parseRouteCandidateArg("claude/claude-fable-5")).toEqual({
      provider: "claude",
      model: "claude-fable-5",
      effort: { mode: "provider-controlled" },
      weight: 1,
    });
  });

  test("@LEVEL pins an exact effort; @none states the no-effort axis; @hive-decides delegates the pick", () => {
    expect(parseRouteCandidateArg("codex/gpt-5.6-sol@high")).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
      weight: 1,
    });
    expect(parseRouteCandidateArg("grok/grok-composer-2.5-fast@none")).toEqual({
      provider: "grok",
      model: "grok-composer-2.5-fast",
      effort: { mode: "none" },
      weight: 1,
    });
    expect(
      parseRouteCandidateArg("claude/claude-fable-5@hive-decides"),
    ).toEqual({
      provider: "claude",
      model: "claude-fable-5",
      effort: { mode: "hive-decides" },
      weight: 1,
    });
  });

  test("=WEIGHT sets an integer rating 1–100 and refuses the rest", () => {
    expect(parseRouteCandidateArg("codex/gpt-5.6-sol@high=60")).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: { mode: "exact", value: "high" },
      weight: 60,
    });
    expect(() => parseRouteCandidateArg("codex/gpt-5.6-sol=0")).toThrow(
      /integer 1–100/,
    );
    expect(() => parseRouteCandidateArg("codex/gpt-5.6-sol=101")).toThrow(
      /integer 1–100/,
    );
    expect(() => parseRouteCandidateArg("codex/gpt-5.6-sol=fast")).toThrow(
      /integer 1–100/,
    );
  });

  test("there is NO vendor-default form — the user is specific on the models he chooses", () => {
    // "vendor-default:grok" has no slash, so it fails the only legal shape.
    expect(() => parseRouteCandidateArg("vendor-default:grok")).toThrow(
      /provider\/model/,
    );
  });

  test("an unknown provider, a missing model, and a bare word all refuse with the syntax named", () => {
    expect(() => parseRouteCandidateArg("acme/some-model")).toThrow(
      /unknown provider/,
    );
    expect(() => parseRouteCandidateArg("claude/")).toThrow(/provider\/model/);
    expect(() => parseRouteCandidateArg("claude")).toThrow(/provider\/model/);
  });

  test("effort targets parse exactly and reject the rest", () => {
    expect(parseEffortTargetArg("exact:xhigh")).toEqual({
      mode: "exact",
      value: "xhigh",
    });
    expect(parseEffortTargetArg("none")).toEqual({ mode: "none" });
    expect(parseEffortTargetArg("provider-controlled")).toEqual({
      mode: "provider-controlled",
    });
    expect(() => parseEffortTargetArg("exact:")).toThrow(/effort must be/);
    expect(() => parseEffortTargetArg("high")).toThrow(/effort must be/);
  });
});

const EMPTY_POLICY = {
  schemaVersion: 3,
  revision: 1,
  updatedAt: "2026-07-13T12:00:00.000Z",
  provisional: false,
  providers: {},
  models: [],
  global: null,
  categories: {},
};

describe("Model Control Center daemon pinning", () => {
  test("an explicit port wins over another daemon's global pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-routing-port-"));
    const previousHome = process.env.HIVE_HOME;
    process.env.HIVE_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "daemon.port"), "4317\n");
    writeCredential(USER_SUBJECT, "user-test-token");

    const policy = {
      ...EMPTY_POLICY,
      revision: 9,
      providers: { claude: "enabled" },
      models: [
        {
          provider: "claude",
          model: "claude-test",
          state: "enabled",
          effort: { mode: "provider-controlled" },
        },
      ],
      global: {
        mode: "hive-equal",
        candidates: [
          {
            provider: "claude",
            model: "claude-test",
            effort: { mode: "provider-controlled" },
            weight: 1,
          },
        ],
      },
    };
    let requestedUrl = "";
    // SAFETY: The test owns this value and its fields.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input,
    ) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(policy), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);
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

  test("set-route applies and clears CAS revisions in the daemon-owned store", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-routing-set-route-"));
    const machineHome = mkdtempSync(
      join(tmpdir(), "hive-routing-set-route-machine-"),
    );
    const previousHome = process.env.HIVE_HOME;
    const previousDefaultHome = process.env.HIVE_DEFAULT_HOME;
    process.env.HIVE_HOME = home;
    process.env.HIVE_DEFAULT_HOME = machineHome;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "daemon.port"), "4483\n");
    const db = new HiveDatabase(":memory:");
    const daemon = new HiveDaemon({
      statusIncarnationGenerationSource: HiveDaemon.statusGenerationUnavailable,
      db,
      spawner: {
        spawn: async () => {
          throw new Error("no spawn");
        },
      },
      repoRoot: "/tmp/hive-routing-set-route",
    });
    const userToken = daemon.capabilities.mint(USER_SUBJECT, "user").token;
    writeCredential(USER_SUBJECT, userToken);
    const policyDatabase = machineModelControlDatabase(db).database;
    const store = new RoutingPolicyStore(policyDatabase);
    // SAFETY: The test owns this value and its fields.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input,
      init,
    ) => daemon.fetch(new Request(input, init))) as typeof fetch);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await setRoute(
        "complex_coding",
        "user-weighted",
        ["claude/claude-fable-5@xhigh=3", "codex/gpt-5.6-sol"],
        "0",
        4483,
      );
      expect(store.read()).toMatchObject({
        revision: 1,
        categories: {
          complex_coding: {
            mode: "user-weighted",
            candidates: [
              {
                provider: "claude",
                model: "claude-fable-5",
                effort: { mode: "exact", value: "xhigh" },
                weight: 3,
              },
              {
                provider: "codex",
                model: "gpt-5.6-sol",
                effort: { mode: "provider-controlled" },
                weight: 1,
              },
            ],
          },
        },
      });
      await setRoute("complex_coding", "user-weighted", [], "1", 4483);
      expect(store.read()).toMatchObject({ revision: 2, categories: {} });
      // Bad scope and bad mode refuse locally rather than reach the daemon.
      await expect(
        setRoute(
          "profiling",
          "hive-equal",
          ["claude/claude-fable-5"],
          "2",
          4483,
        ),
      ).rejects.toThrow(/unknown route scope/);
      await expect(
        setRoute("global", "ordered", ["claude/claude-fable-5"], "2", 4483),
      ).rejects.toThrow(/route mode must be/);
      expect(store.read().revision).toBe(2);
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
      await daemon.stop();
      policyDatabase.close();
      db.close();
      if (previousHome === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = previousHome;
      if (previousDefaultHome === undefined)
        delete process.env.HIVE_DEFAULT_HOME;
      else process.env.HIVE_DEFAULT_HOME = previousDefaultHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(machineHome, { recursive: true, force: true });
    }
  });
});
