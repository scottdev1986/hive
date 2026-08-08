import { describe, expect, test } from "bun:test";
import {
  discoveryFromAcp,
  modelIdsFromAcpCatalog,
} from "../src/adapters/providers/protocol/capability-catalog";

const AT = "2026-08-02T20:00:00.000Z";

function configOptions(model: string, efforts?: string[]) {
  return {
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: model,
        options: [
          { value: "kimi-code/k3", name: "K3" },
          { value: "kimi-code/k3-256k", name: "K3-256k" },
        ],
      },
      ...(efforts === undefined
        ? []
        : [
            {
              id: "thinking",
              category: "thought_level",
              currentValue: "high",
              options: efforts.map((value) => ({ value, name: value })),
            },
          ]),
    ],
  };
}

describe("ACP capability catalogs", () => {
  test("Grok exposes the models returned by session/new to the live picker", () => {
    expect(
      modelIdsFromAcpCatalog({
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5" },
            { modelId: "grok-4-fast", name: "Grok 4 Fast" },
          ],
        },
      }),
    ).toEqual(["grok-4.5", "grok-4-fast"]);
  });

  test("Grok reads its model and effort catalog from the protocol handshake", () => {
    const result = discoveryFromAcp(
      "grok",
      {
        handshake: {
          _meta: {
            modelState: {
              currentModelId: "grok-4.5",
              availableModels: [
                {
                  modelId: "grok-4.5",
                  name: "Grok 4.5",
                  _meta: {
                    supportsReasoningEffort: true,
                    reasoningEffort: "low",
                    reasoningEfforts: [
                      { value: "high", default: true },
                      { value: "medium" },
                      { value: "low" },
                    ],
                  },
                },
              ],
            },
          },
        },
        sessionNew: null,
      },
      "0.2.118",
      AT,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.records[0]?.supportedEffortLevels).toMatchObject({
      state: "known",
      value: ["high", "medium", "low"],
      surface: "grok.acp",
    });
    expect(result.effectiveDefault.model).toMatchObject({
      state: "known",
      value: "grok-4.5",
    });
  });

  test("Kimi keeps effort readings per model instead of inventing a cross-product", () => {
    const result = discoveryFromAcp(
      "kimi",
      {
        handshake: {},
        sessionNew: configOptions("kimi-code/k3", ["low", "high", "max"]),
        modelConfigurations: new Map([
          [
            "kimi-code/k3",
            configOptions("kimi-code/k3", ["low", "high", "max"]),
          ],
          [
            "kimi-code/k3-256k",
            configOptions("kimi-code/k3-256k", ["low", "high", "max"]),
          ],
        ]),
      },
      "0.31.1",
      AT,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(
      result.records.map((record) => [
        record.canonicalId,
        record.supportedEffortLevels,
      ]),
    ).toMatchObject([
      ["kimi-code/k3", { state: "known", value: ["low", "high", "max"] }],
      ["kimi-code/k3-256k", { state: "known", value: ["low", "high", "max"] }],
    ]);
  });

  test("OpenCode model presence is known while its silent effort field stays unknown", () => {
    const result = discoveryFromAcp(
      "opencode",
      {
        handshake: {},
        sessionNew: {
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "opencode/big-pickle",
              options: [{ value: "opencode/big-pickle", name: "Big Pickle" }],
            },
          ],
        },
      },
      "1.18.11",
      AT,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.records[0]?.entitled).toMatchObject({
      state: "known",
      value: true,
    });
    expect(result.records[0]?.supportedEffortLevels).toMatchObject({
      state: "unknown",
      reason: "field-absent",
      surface: "opencode.acp",
    });
  });
});
