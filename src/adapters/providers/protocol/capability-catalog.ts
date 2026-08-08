import {
  type CapabilityDiscoveryResult,
  type CapabilityRecord,
  type CapabilitySurface,
  fingerprintAccount,
  known,
  unknown,
  unknownVendor,
} from "../../../schemas/capability";
import type { ProviderModel } from "./types";

export interface AcpCatalogPayload {
  readonly handshake: unknown;
  readonly sessionNew: unknown;
  readonly modelConfigurations?: ReadonlyMap<string, unknown>;
}

interface ModelEntry {
  readonly id: string;
  readonly name: string | null;
  readonly supportsEffort: boolean | null;
  readonly efforts: string[] | null;
  readonly defaultEffort: string | null;
}

export function discoveryFromAcp(
  provider: "grok" | "kimi" | "opencode",
  payload: AcpCatalogPayload,
  cliVersion: string,
  observedAt: string,
): CapabilityDiscoveryResult {
  const surface = acpSurface(provider);
  const models =
    provider === "grok"
      ? grokModels(payload.handshake, payload.sessionNew)
      : configModels(payload.sessionNew, payload.modelConfigurations);
  if (models.length === 0) {
    return {
      status: "unavailable",
      reason: `${provider} ACP returned no usable model catalog`,
    };
  }
  const accountFingerprint = fingerprintAccount(
    provider,
    models.map((model) => model.id),
  );
  const records: CapabilityRecord[] = models.map((model) => ({
    provider,
    accountFingerprint,
    cliVersion,
    canonicalId: model.id,
    variant: null,
    launchToken: model.id,
    displayName: model.name,
    aliases: [],
    entitled: known(true, surface, observedAt),
    hidden: unknown("surface-silent", surface, observedAt),
    supportsEffort:
      model.supportsEffort === null
        ? unknown("field-absent", surface, observedAt)
        : known(model.supportsEffort, surface, observedAt),
    supportedEffortLevels:
      model.efforts === null
        ? unknown("field-absent", surface, observedAt)
        : known(model.efforts, surface, observedAt),
    defaultEffort:
      model.defaultEffort === null
        ? unknown("field-absent", surface, observedAt)
        : known(model.defaultEffort, surface, observedAt),
    observedAt,
  }));
  const defaults = acpDefaults(provider, payload.handshake, payload.sessionNew);
  return {
    status: "ok",
    records,
    effectiveDefault: {
      provider,
      model:
        defaults.model === null
          ? unknown("field-absent", surface, observedAt)
          : known(defaults.model, surface, observedAt),
      effort:
        defaults.effort === null
          ? unknown("field-absent", surface, observedAt)
          : known(defaults.effort, surface, observedAt),
    },
  };
}

export function modelIdsFromAcpCatalog(sessionNew: unknown): string[] {
  const model = configOption(sessionNew, "model");
  if (model !== null) return optionValues(model);
  const modelState = object(object(sessionNew)?.models);
  if (!Array.isArray(modelState?.availableModels)) return [];
  return modelState.availableModels.flatMap((raw): string[] => {
    const id = string(object(raw)?.modelId);
    return id === null ? [] : [id];
  });
}

export function modelsFromAcpCatalog(
  provider: "grok" | "kimi" | "opencode",
  handshake: unknown,
  sessionNew: unknown,
  modelConfigurations?: ReadonlyMap<string, unknown>,
): readonly ProviderModel[] {
  const models =
    provider === "grok"
      ? grokModels(handshake, sessionNew)
      : configModels(sessionNew, modelConfigurations);
  const defaults = acpDefaults(provider, handshake, sessionNew);
  return models.map((model) => ({
    id: model.id,
    displayName: model.name ?? model.id,
    description: null,
    isDefault: model.id === defaults.model,
    supportedReasoningEfforts: (model.efforts ?? []).map((id) => ({
      id,
      description: null,
    })),
    defaultReasoningEffort: model.defaultEffort,
  }));
}

function acpSurface(provider: "grok" | "kimi" | "opencode"): CapabilitySurface {
  switch (provider) {
    case "grok":
      return "grok.acp";
    case "kimi":
      return "kimi.acp";
    case "opencode":
      return "opencode.acp";
    default:
      return unknownVendor(provider, "ACP capability surface");
  }
}

function grokModels(handshake: unknown, sessionNew: unknown): ModelEntry[] {
  const handshakeRoot = object(handshake);
  const handshakeMeta = object(handshakeRoot?._meta);
  const sessionRoot = object(sessionNew);
  const sessionModels = object(sessionRoot?.models);
  const modelState =
    sessionModels ?? object(object(handshakeMeta?.modelState)) ?? null;
  if (modelState === null || !Array.isArray(modelState.availableModels)) {
    return [];
  }
  return modelState.availableModels.flatMap((raw): ModelEntry[] => {
    const entry = object(raw);
    const id = string(entry?.modelId);
    if (id === null) return [];
    const meta = object(entry?._meta);
    const rawEfforts = Array.isArray(meta?.reasoningEfforts)
      ? meta.reasoningEfforts
      : null;
    const efforts =
      rawEfforts === null
        ? null
        : rawEfforts.flatMap((rawEffort): string[] => {
            const effort = object(rawEffort);
            const value = string(effort?.value) ?? string(effort?.id);
            return value === null ? [] : [value];
          });
    const advertisedDefault =
      rawEfforts?.map(object).find((effort) => effort?.default === true) ??
      null;
    return [
      {
        id,
        name: string(entry?.name),
        supportsEffort:
          typeof meta?.supportsReasoningEffort === "boolean"
            ? meta.supportsReasoningEffort
            : null,
        efforts,
        defaultEffort:
          string(meta?.reasoningEffort) ??
          string(advertisedDefault?.value) ??
          string(advertisedDefault?.id),
      },
    ];
  });
}

function configModels(
  sessionNew: unknown,
  modelConfigurations: ReadonlyMap<string, unknown> | undefined,
): ModelEntry[] {
  const modelOption = configOption(sessionNew, "model");
  if (modelOption === null) return [];
  const currentModel = string(modelOption.currentValue);
  return optionEntries(modelOption).map((model) => {
    const configuration =
      modelConfigurations?.get(model.value) ??
      (currentModel === model.value ? sessionNew : null);
    const effortOption = configOption(configuration, "effort");
    const efforts = effortOption === null ? null : optionValues(effortOption);
    return {
      id: model.value,
      name: model.name,
      supportsEffort: efforts === null ? null : efforts.length > 0,
      efforts,
      defaultEffort:
        effortOption === null ? null : string(effortOption.currentValue),
    };
  });
}

function acpDefaults(
  provider: "grok" | "kimi" | "opencode",
  handshake: unknown,
  sessionNew: unknown,
): { model: string | null; effort: string | null } {
  if (provider === "grok") {
    const handshakeRoot = object(handshake);
    const modelState = object(object(handshakeRoot?._meta)?.modelState);
    const sessionModels = object(object(sessionNew)?.models);
    const active = sessionModels ?? modelState;
    const model = string(active?.currentModelId);
    const entry = Array.isArray(active?.availableModels)
      ? active.availableModels
          .map(object)
          .find((candidate) => string(candidate?.modelId) === model)
      : null;
    return {
      model,
      effort: string(object(entry?._meta)?.reasoningEffort),
    };
  }
  return {
    model: string(configOption(sessionNew, "model")?.currentValue),
    effort: string(configOption(sessionNew, "effort")?.currentValue),
  };
}

function configOption(
  payload: unknown,
  kind: "model" | "effort",
): Record<string, unknown> | null {
  const options = object(payload)?.configOptions;
  if (!Array.isArray(options)) return null;
  return (
    options.map(object).find((entry) => {
      const id = string(entry?.id);
      const category = string(entry?.category);
      return kind === "model"
        ? id === "model" || category === "model"
        : id === "thinking" || category === "thought_level";
    }) ?? null
  );
}

function optionEntries(
  config: Record<string, unknown>,
): Array<{ value: string; name: string | null }> {
  if (!Array.isArray(config.options)) return [];
  return config.options.flatMap(
    (
      raw,
    ): Array<{
      value: string;
      name: string | null;
    }> => {
      const option = object(raw);
      const value = string(option?.value);
      return value === null ? [] : [{ value, name: string(option?.name) }];
    },
  );
}

function optionValues(config: Record<string, unknown>): string[] {
  return optionEntries(config).map((option) => option.value);
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
