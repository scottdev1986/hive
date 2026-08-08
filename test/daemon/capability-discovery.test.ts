import { describe, expect, test } from "bun:test";
import {
  claudeEffectiveDefault,
  codexEffectiveDefault,
  recordsFromClaudeInitialize,
  recordsFromCodexModelList,
} from "../../src/daemon/provider-capabilities/discovery";
import { CapabilityRecordSchema } from "../../src/schemas/capability";

const AT = "2026-08-02T20:00:00.000Z";

const CLAUDE_INITIALIZE = {
  account: { email: "someone@example.com", organization: "Example" },
  models: [
    {
      value: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5",
      displayName: "Haiku",
    },
  ],
};

const CODEX_MODELS = {
  data: [
    {
      id: "gpt-visible",
      displayName: "Visible",
      hidden: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "high" },
      ],
    },
    {
      id: "gpt-hidden",
      displayName: "Hidden",
      hidden: true,
      supportedReasoningEfforts: [],
    },
  ],
};

describe("Claude protocol catalog", () => {
  test("collapses aliases without putting the context variant in the launch token", () => {
    const records = recordsFromClaudeInitialize(
      CLAUDE_INITIALIZE,
      "2.1.220",
      AT,
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      canonicalId: "claude-opus-5",
      variant: "1m",
      launchToken: "claude-opus-5",
      aliases: ["default", "opus"],
    });
    expect(claudeEffectiveDefault(records, AT).model).toMatchObject({
      state: "known",
      value: "claude-opus-5",
    });
  });

  test("an omitted effort field is unknown, never false", () => {
    const records = recordsFromClaudeInitialize(
      CLAUDE_INITIALIZE,
      "2.1.220",
      AT,
    );
    expect(records[1]?.supportsEffort).toMatchObject({
      state: "unknown",
      reason: "field-absent",
    });
    for (const record of records) {
      expect(CapabilityRecordSchema.parse(record)).toBeDefined();
    }
  });
});

describe("Codex protocol catalog", () => {
  test("preserves hidden entries and raw effort values", () => {
    const records = recordsFromCodexModelList(
      CODEX_MODELS,
      { account: { email: "someone@example.com" } },
      "0.146.0",
      AT,
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.supportedEffortLevels).toMatchObject({
      state: "known",
      value: ["low", "high"],
    });
    expect(records[1]?.hidden).toMatchObject({ state: "known", value: true });
    expect(records[0]?.supportsEffort).toMatchObject({
      state: "unknown",
      reason: "surface-silent",
    });
  });

  test("reads the effective default from config/read, not the model catalog", () => {
    const value = codexEffectiveDefault(
      {
        config: {
          model: "gpt-visible",
          model_reasoning_effort: "high",
        },
      },
      AT,
    );
    expect(value.model).toMatchObject({
      state: "known",
      value: "gpt-visible",
      surface: "codex.config/read",
    });
    expect(value.effort).toMatchObject({ state: "known", value: "high" });
  });

  test("a malformed config is unknown rather than a guessed default", () => {
    expect(codexEffectiveDefault("bad", AT)).toMatchObject({
      model: { state: "unknown", reason: "malformed" },
      effort: { state: "unknown", reason: "malformed" },
    });
  });
});
