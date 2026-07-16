import { describe, expect, test } from "bun:test";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  GrokCapabilityProbe,
  grokModelsProvedLive,
  recordsFromClaudeInitialize,
  recordsFromCodexModelList,
  recordsFromGrokModels,
  claudeEffectiveDefault,
  codexEffectiveDefault,
} from "./capability-discovery";
import {
  CapabilityRecordSchema,
  type CapabilityRecord,
  capabilityFreshness,
  capabilityKey,
  fingerprintAccount,
  known,
  splitVariant,
  unknown,
  valueOr,
} from "../schemas/capability";

const GROK_PAYLOAD = {
  stdout: [
    "Available models:",
    "  - fixture-reasoning-model",
    "  * fixture-fast-model (default)",
  ].join("\n"),
  cliVersion: "fixture-version",
  cache: {
    fetched_at: "2026-07-12T12:00:00.000Z",
    etag: "fixture-etag",
    grok_version: "fixture-version",
    auth_method: "oauth",
    origin: "subscription",
    models: {
      "fixture-reasoning-model": {
        info: {
          id: "fixture-reasoning-model",
          name: "Fixture Reasoning",
          hidden: false,
          supports_reasoning_effort: true,
          reasoning_efforts: [
            { value: "low", default: false },
            { value: "high", default: true },
          ],
        },
      },
      "fixture-fast-model": {
        info: {
          id: "fixture-fast-model",
          name: "Fixture Fast",
          hidden: false,
          supports_reasoning_effort: false,
        },
      },
    },
  },
};

/**
 * The fixtures below are the payloads the real binaries returned on 2026-07-11
 * (claude 2.1.207, codex-cli 0.144.1), captured by driving them with the exact
 * frames `capability-discovery.ts` sends. Only the account identifiers are
 * replaced. They are verbatim otherwise — including the shapes that surprised
 * the design: Haiku carries no effort fields at all, and Codex's efforts arrive
 * as objects rather than strings.
 */

const OBSERVED_AT = "2026-07-11T12:00:00.000Z";
const CLAUDE_CLI = "2.1.207";
const CODEX_CLI = "0.144.1";

const CLAUDE_INITIALIZE = {
  account: {
    email: "someone@example.com",
    organization: "Example Org",
    subscriptionType: "max",
    apiProvider: "anthropic",
  },
  models: [
    {
      value: "default",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Default (recommended)",
      description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-4-8[1m]",
      displayName: "Opus",
      description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
      description: "Fable 5 · Most capable for your hardest and longest-running tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    // Verbatim: the live Haiku entry carries NO effort fields whatsoever.
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers",
    },
  ],
};

const effortObjects = (...levels: string[]) =>
  levels.map((level) => ({
    reasoningEffort: level,
    description: `${level} reasoning`,
  }));

const CODEX_MODEL_LIST = {
  nextCursor: null,
  data: [
    {
      id: "gpt-5.5",
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: effortObjects("low", "medium", "high", "xhigh"),
      inputModalities: ["text", "image"],
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      // `max` and `ultra` are advertised by the live CLI and are unknown to
      // Hive's shipped effort enums. They must survive ingestion verbatim.
      supportedReasoningEfforts: effortObjects(
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ),
      inputModalities: ["text", "image"],
    },
    {
      id: "gpt-5.3-codex-spark",
      model: "gpt-5.3-codex-spark",
      displayName: "GPT-5.3-Codex-Spark",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: effortObjects("low", "medium", "high", "xhigh"),
      inputModalities: ["text"],
    },
    {
      id: "codex-auto-review",
      model: "codex-auto-review",
      displayName: "Codex Auto Review",
      hidden: true,
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: effortObjects("low", "medium", "high", "xhigh"),
      inputModalities: ["text", "image"],
    },
  ],
};

const CODEX_ACCOUNT = {
  account: { type: "chatgpt", email: "someone@example.com", planType: "prolite" },
  requiresOpenaiAuth: false,
};

const claudeRecords = () =>
  recordsFromClaudeInitialize(CLAUDE_INITIALIZE, CLAUDE_CLI, OBSERVED_AT);
const codexRecords = () =>
  recordsFromCodexModelList(
    CODEX_MODEL_LIST,
    CODEX_ACCOUNT,
    CODEX_CLI,
    OBSERVED_AT,
  );

const byId = (records: CapabilityRecord[], id: string): CapabilityRecord => {
  const found = records.find((record) => record.canonicalId === id);
  if (found === undefined) throw new Error(`no record for ${id}`);
  return found;
};

describe("claude initialize → capability records", () => {
  test("collapses the menu's aliases into one record per model+variant", () => {
    const records = claudeRecords();
    // Five menu entries, four models: `default` and `opus[1m]` are one model.
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.canonicalId).sort()).toEqual([
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-5",
    ]);
    expect(byId(records, "claude-opus-4-8").aliases.sort()).toEqual([
      "default",
      "opus[1m]",
    ]);
  });

  test("keeps the name's three facts apart, and never launches the variant", () => {
    const opus = byId(claudeRecords(), "claude-opus-4-8");
    expect(opus.canonicalId).toBe("claude-opus-4-8");
    expect(opus.variant).toBe("1m");
    expect(opus.launchToken).toBe("claude-opus-4-8");
    expect(opus.launchToken).not.toContain("[");
  });

  test("reads the variant off whichever name carries it", () => {
    const records = claudeRecords();
    // Fable is the asymmetric case: `claude-fable-5[1m]` resolves to a bare
    // `claude-fable-5`, so the variant is only on the menu value.
    const fable = byId(records, "claude-fable-5");
    expect(fable.variant).toBe("1m");
    expect(fable.launchToken).toBe("claude-fable-5");
    // Sonnet and Haiku carry no variant on either name.
    expect(byId(records, "claude-sonnet-5").variant).toBeNull();
    expect(byId(records, "claude-haiku-4-5-20251001").variant).toBeNull();
  });

  test("an omitted effort field is unknown, NOT false", () => {
    const haiku = byId(claudeRecords(), "claude-haiku-4-5-20251001");
    expect(haiku.supportsEffort).toEqual({
      state: "unknown",
      reason: "field-absent",
      surface: "claude.initialize",
      observedAt: OBSERVED_AT,
    });
    expect(haiku.supportedEffortLevels.state).toBe("unknown");
    // The distinction this whole record exists to protect: absent ≠ false. The
    // record holds no value at all, so a caller wanting a boolean must supply
    // the fallback itself, in the open — whichever it picks is what it gets.
    expect(valueOr(haiku.supportsEffort, false)).toBe(false);
    expect(valueOr(haiku.supportsEffort, true)).toBe(true);
  });

  test("records the effort fields the vendor did send, unmerged", () => {
    const sonnet = byId(claudeRecords(), "claude-sonnet-5");
    expect(sonnet.supportsEffort).toMatchObject({ state: "known", value: true });
    expect(sonnet.supportedEffortLevels).toMatchObject({
      state: "known",
      value: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  test("fields Claude's protocol never carries are surface-silent, not false", () => {
    for (const record of claudeRecords()) {
      // Claude has no hidden flag and no per-model default effort for ANY model.
      // Defaulting either to `false`/`medium` would invent a vendor claim.
      expect(record.hidden).toMatchObject({
        state: "unknown",
        reason: "surface-silent",
      });
      expect(record.defaultEffort).toMatchObject({
        state: "unknown",
        reason: "surface-silent",
      });
    }
  });

  test("presence in the account menu is positive entitlement evidence", () => {
    for (const record of claudeRecords()) {
      expect(record.entitled).toMatchObject({ state: "known", value: true });
    }
  });
});

describe("Grok models catalog", () => {
  test("joins the free stdout default to fresh structured cache records", async () => {
    const records = recordsFromGrokModels(GROK_PAYLOAD, OBSERVED_AT);
    expect(records.map((record) => record.canonicalId)).toEqual([
      "fixture-reasoning-model",
      "fixture-fast-model",
    ]);
    expect(records[0]?.supportedEffortLevels).toMatchObject({
      state: "known",
      value: ["low", "high"],
    });
    expect(records[1]?.supportsEffort).toMatchObject({
      state: "known",
      value: false,
    });

    const probe = new GrokCapabilityProbe(
      { readCatalog: async () => GROK_PAYLOAD },
      () => new Date(OBSERVED_AT),
    );
    const result = await probe.read();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.effectiveDefault.model).toMatchObject({
        state: "known",
        value: "fixture-fast-model",
      });
    }
  });

  test("accepts an unchanged cache after a live command and preserves its age", async () => {
    const stale = {
      ...GROK_PAYLOAD,
      cache: { ...GROK_PAYLOAD.cache, fetched_at: "2026-07-12T11:00:00.000Z" },
    };
    const records = recordsFromGrokModels(stale, OBSERVED_AT);
    expect(records).toHaveLength(2);
    expect(records[0]?.observedAt).toBe("2026-07-12T11:00:00.000Z");
    const result = await new GrokCapabilityProbe({ readCatalog: async () => stale })
      .read();
    expect(result).toMatchObject({ status: "ok" });
  });

  test("requires positive live-fetch evidence instead of trusting exit zero", () => {
    expect(grokModelsProvedLive(
      "Fetched remote settings from cli-chat-proxy\n",
    )).toBe(true);
    expect(grokModelsProvedLive(
      "Fetched 2 models from https://cli-chat-proxy.grok.com/v1/models\n",
    )).toBe(true);
    expect(grokModelsProvedLive(
      "Settings fetch failed after 3 attempts\n",
    )).toBe(false);
    expect(grokModelsProvedLive("")).toBe(false);
  });

  test("admits a newer CLI by behavior when its live catalog contract is unchanged", async () => {
    const future = {
      ...GROK_PAYLOAD,
      cliVersion: "99.0.0",
      cache: { ...GROK_PAYLOAD.cache, grok_version: "99.0.0" },
    };

    expect(recordsFromGrokModels(future, OBSERVED_AT)).toHaveLength(2);
    expect(await new GrokCapabilityProbe({ readCatalog: async () => future }).read())
      .toMatchObject({ status: "ok" });
  });

  test("fails closed on a changed or incoherent runtime catalog", async () => {
    const wrongVersion = {
      ...GROK_PAYLOAD,
      cliVersion: "99.0.0",
    };
    const wrongId = {
      ...GROK_PAYLOAD,
      cache: {
        ...GROK_PAYLOAD.cache,
        models: {
          ...GROK_PAYLOAD.cache.models,
          "fixture-fast-model": {
            info: {
              ...GROK_PAYLOAD.cache.models["fixture-fast-model"].info,
              id: "different-model",
            },
          },
        },
      },
    };
    const wrongEffort = {
      ...GROK_PAYLOAD,
      cache: {
        ...GROK_PAYLOAD.cache,
        models: {
          ...GROK_PAYLOAD.cache.models,
          "fixture-fast-model": {
            info: {
              ...GROK_PAYLOAD.cache.models["fixture-fast-model"].info,
              reasoning_efforts: [{ value: "high", default: true }],
            },
          },
        },
      },
    };

    for (const payload of [wrongVersion, wrongId, wrongEffort]) {
      expect(recordsFromGrokModels(payload, OBSERVED_AT)).toEqual([]);
      expect(await new GrokCapabilityProbe({ readCatalog: async () => payload }).read())
        .toMatchObject({ status: "unavailable" });
    }
  });
});

describe("codex model/list → capability records", () => {
  test("one record per catalog entry, hidden entries included", () => {
    const records = codexRecords();
    expect(records).toHaveLength(4);
    // The hidden entry is kept, flagged — not dropped. Dropping it at ingestion
    // would make an explicit pin unresolvable and leave a stale manifest's claim
    // about it unchallenged.
    expect(byId(records, "codex-auto-review").hidden).toMatchObject({
      state: "known",
      value: true,
    });
    expect(byId(records, "gpt-5.5").hidden).toMatchObject({
      state: "known",
      value: false,
    });
  });

  test("effort levels survive as raw strings, including ones Hive does not know", () => {
    const sol = byId(codexRecords(), "gpt-5.6-sol");
    expect(sol.supportedEffortLevels).toMatchObject({
      state: "known",
      value: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
  });

  test("the vendor's recommended effort is recorded per model", () => {
    const records = codexRecords();
    expect(byId(records, "gpt-5.5").defaultEffort).toMatchObject({
      state: "known",
      value: "medium",
    });
    expect(byId(records, "gpt-5.3-codex-spark").defaultEffort).toMatchObject({
      state: "known",
      value: "high",
    });
  });

  test("supportsEffort is surface-silent: Codex sends no such boolean", () => {
    for (const record of codexRecords()) {
      // Inferring `true` from a non-empty effort list would fabricate a claim the
      // vendor never made — exactly the merge the design forbids.
      expect(record.supportsEffort).toMatchObject({
        state: "unknown",
        reason: "surface-silent",
      });
    }
  });

  test("codex has no aliases and no context-window variant", () => {
    for (const record of codexRecords()) {
      expect(record.aliases).toEqual([]);
      expect(record.variant).toBeNull();
      expect(record.launchToken).toBe(record.canonicalId);
    }
  });

  test("an unreadable effort list is malformed, not an empty capability", () => {
    const records = recordsFromCodexModelList(
      {
        data: [{
          id: "gpt-weird",
          displayName: "Weird",
          supportedReasoningEfforts: [{ notTheField: "low" }],
        }],
      },
      CODEX_ACCOUNT,
      CODEX_CLI,
      OBSERVED_AT,
    );
    expect(records[0]!.supportedEffortLevels).toMatchObject({
      state: "unknown",
      reason: "malformed",
    });
    // A field the entry simply omitted is a different unknown.
    expect(records[0]!.defaultEffort).toMatchObject({
      state: "unknown",
      reason: "field-absent",
    });
  });
});

describe("provenance and identity", () => {
  test("every record validates, and every fact names its own surface", () => {
    for (const record of [...claudeRecords(), ...codexRecords()]) {
      expect(() => CapabilityRecordSchema.parse(record)).not.toThrow();
      const expected = record.provider === "claude"
        ? "claude.initialize"
        : "codex.model/list";
      for (
        const fact of [
          record.entitled,
          record.hidden,
          record.supportsEffort,
          record.supportedEffortLevels,
          record.defaultEffort,
        ]
      ) {
        expect(fact.surface).toBe(expected);
        expect(fact.observedAt).toBe(OBSERVED_AT);
      }
    }
  });

  test("the account fingerprint carries no PII", () => {
    const serialized = JSON.stringify([...claudeRecords(), ...codexRecords()]);
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain("Example Org");
    expect(serialized).not.toContain("@");
  });

  test("the fingerprint is stable, and distinct across providers", () => {
    expect(fingerprintAccount("claude", ["a@b.com", "Org"]))
      .toBe(fingerprintAccount("claude", ["a@b.com", "Org"]));
    expect(fingerprintAccount("claude", ["a@b.com"]))
      .not.toBe(fingerprintAccount("codex", ["a@b.com"]));
    // An unreadable account still keys, rather than throwing or colliding.
    expect(fingerprintAccount("codex", [null, undefined])).toBe(
      "codex:unidentified",
    );
  });

  test("the key separates variants, CLI builds, and accounts", () => {
    const opus = byId(claudeRecords(), "claude-opus-4-8");
    const base = capabilityKey(opus);
    expect(base).toContain("claude-opus-4-8[1m]");
    // A 200k Opus is not the same routable thing as a 1M Opus.
    expect(capabilityKey({ ...opus, variant: null })).not.toBe(base);
    // A catalog read from 2.1.207 is not a claim about 2.2's.
    expect(capabilityKey({ ...opus, cliVersion: "2.2.0" })).not.toBe(base);
    expect(capabilityKey({ ...opus, accountFingerprint: "other" })).not.toBe(base);
  });

  test("splitVariant leaves an unbracketed name alone", () => {
    expect(splitVariant("claude-opus-4-8[1m]")).toEqual({
      base: "claude-opus-4-8",
      variant: "1m",
    });
    expect(splitVariant("gpt-5.5")).toEqual({ base: "gpt-5.5", variant: null });
  });
});

describe("freshness", () => {
  const at = (iso: string) => new Date(iso);

  test("a record inside the TTL is fresh; past it, stale", () => {
    const record = { observedAt: OBSERVED_AT };
    expect(capabilityFreshness(record, 30, at("2026-07-11T12:29:00.000Z")))
      .toBe("fresh");
    expect(capabilityFreshness(record, 30, at("2026-07-11T12:31:00.000Z")))
      .toBe("stale");
  });

  test("an unparseable timestamp is stale, never fresh", () => {
    expect(capabilityFreshness({ observedAt: "not-a-date" }, 30, at(OBSERVED_AT)))
      .toBe("stale");
  });
});

describe("probes degrade to unknown, never to a guess", () => {
  test("a transport failure is unavailable with its reason", async () => {
    const probe = new ClaudeCapabilityProbe({
      readCatalog: () => Promise.reject(new Error("claude is not signed in")),
    });
    expect(await probe.read()).toEqual({
      status: "unavailable",
      reason: "claude is not signed in",
    });
  });

  test("an empty menu is unavailable, not an account with no models", async () => {
    const probe = new CodexCapabilityProbe({
      readCatalog: () =>
        Promise.resolve({
          modelList: { data: [] },
          account: null,
          config: null,
          cliVersion: "0.144.1",
        }),
    });
    const result = await probe.read();
    expect(result.status).toBe("unavailable");
  });

  test("a good catalog produces records stamped with the probe's clock", async () => {
    const probe = new ClaudeCapabilityProbe(
      {
        readCatalog: () =>
          Promise.resolve({
            handshake: CLAUDE_INITIALIZE,
            cliVersion: CLAUDE_CLI,
          }),
      },
      () => at2026(),
    );
    const result = await probe.read();
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.records).toHaveLength(4);
    expect(result.records[0]!.cliVersion).toBe(CLAUDE_CLI);
    expect(result.records[0]!.observedAt).toBe("2026-07-11T12:00:00.000Z");
  });

  const at2026 = () => new Date("2026-07-11T12:00:00.000Z");
});

describe("the effective default: what an unflagged launch actually runs", () => {
  const AT = "2026-07-11T12:00:00.000Z";

  test("codex reads config/read, whose keys came off the live wire", () => {
    // codex-cli 0.144.1's real payload shape, snake_case and all.
    const effective = codexEffectiveDefault({
      config: { model: "gpt-5.6-sol", model_reasoning_effort: "xhigh" },
    }, AT);
    expect(effective.model).toEqual(known("gpt-5.6-sol", "codex.config/read", AT));
    expect(effective.effort).toEqual(known("xhigh", "codex.config/read", AT));
  });

  test("the catalog's isDefault is NOT the effective default", () => {
    // The catalog flags gpt-5.5; this machine's unflagged launch runs gpt-5.6-sol.
    // A router that reads the flag and calls it "the default" is describing a
    // different machine than the one it is about to spawn on.
    const records = recordsFromCodexModelList(
      { data: [{ id: "gpt-5.5", isDefault: true }] },
      null,
      "0.144.1",
      AT,
    );
    const effective = codexEffectiveDefault({
      config: { model: "gpt-5.6-sol", model_reasoning_effort: "xhigh" },
    }, AT);
    expect(records[0]!.canonicalId).toBe("gpt-5.5");
    expect(effective.model.state === "known" && effective.model.value)
      .toBe("gpt-5.6-sol");
  });

  test("a config that pins no model is unknown, never a guessed one", () => {
    const effective = codexEffectiveDefault({
      config: { model: null, model_reasoning_effort: null },
    }, AT);
    expect(effective.model.state).toBe("unknown");
    expect(effective.effort.state).toBe("unknown");
  });

  test("an unreadable config is malformed, which is not 'the vendor said none'", () => {
    const effective = codexEffectiveDefault("not a config at all", AT);
    expect(effective.model).toEqual(unknown("malformed", "codex.config/read", AT));
  });

  test("claude's default is the menu entry, and its effort stays unknown", () => {
    const records = recordsFromClaudeInitialize({
      models: [
        { value: "default", resolvedModel: "claude-opus-4-8[1m]" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5" },
      ],
    }, "2.1.207", AT);
    const effective = claudeEffectiveDefault(records, AT);
    expect(effective.model).toEqual(known("claude-opus-4-8", "claude.initialize", AT));
    // Claude publishes no per-model effort anywhere. Discovery cannot name an
    // unflagged launch's effort before the live statusLine observes it, and a
    // shipped `medium` here would be a Hive guess wearing vendor authority.
    expect(effective.effort).toEqual(
      unknown("surface-silent", "claude.initialize", AT),
    );
  });

  test("a menu with no default entry is unknown, not the first model listed", () => {
    const records = recordsFromClaudeInitialize({
      models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5" }],
    }, "2.1.207", AT);
    expect(claudeEffectiveDefault(records, AT).model.state).toBe("unknown");
  });
});
