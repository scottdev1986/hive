import type {
  CapabilityProvider,
  CapabilityRecord,
  CodingTier,
  RoutingCategory,
} from "../schemas";

export interface ValidatedEffort {
  effort?: string;
  warning?: string;
}

export interface AutoEffortResolution {
  effort?: string;
  orderedLevels: string[];
  basis: string;
}

/**
 * Exact vendor spellings with source-proved ordinal semantics. This is not a
 * validation enum: discovery still preserves and explicit choices may still
 * use any advertised future value. It is only the smaller set Hive may order
 * automatically without turning array position into meaning.
 *
 * Claude documents low→medium→high→xhigh→max as increasing capability/token
 * spend. OpenAI documents reduced effort as faster/fewer reasoning tokens, and
 * Codex model/list describes max as maximum reasoning and ultra as maximum
 * reasoning plus task delegation. xAI documents low→medium→high as increasing
 * reasoning depth. Unknown spellings therefore remain explicitly selectable
 * but make AUTO refuse until their order is proved.
 */
const PROVED_EFFORT_ORDER: Record<CapabilityProvider, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  grok: ["low", "medium", "high"],
};

const EFFORT_ORDER_BASIS: Record<CapabilityProvider, string> = {
  claude: "Claude effort documentation and the model's advertised levels",
  codex: "Codex model/list descriptions and OpenAI reasoning-effort documentation",
  grok: "xAI reasoning-effort documentation and the model's advertised levels",
};

export function codingTierForCategory(category: RoutingCategory): CodingTier {
  switch (category) {
    case "simple_coding":
    case "light_research":
    case "summarization":
      return "simple";
    case "complex_coding":
    case "debugging":
    case "heavy_research":
      return "complex";
    case "standard_coding":
    case "code_review":
    case "planning":
    case "profiling":
    case "default":
      return "standard";
  }
}

/** Choose one exact advertised value, or refuse when ordering is unproved. */
export function resolveAutoEffort(
  record: CapabilityRecord | undefined,
  category: RoutingCategory,
): AutoEffortResolution {
  if (record === undefined) {
    throw new Error("Hive-decides effort requires a readable model capability record");
  }
  if (record.supportsEffort.state === "known" && !record.supportsEffort.value) {
    return {
      orderedLevels: [],
      basis: `${record.provider} reports that this model has no effort setting`,
    };
  }
  if (record.supportedEffortLevels.state !== "known") {
    throw new Error(
      `Hive-decides effort cannot read ${record.canonicalId}'s available effort levels`,
    );
  }
  const advertised = [...new Set(record.supportedEffortLevels.value)];
  if (advertised.length === 0) {
    throw new Error(
      `Hive-decides effort found no advertised levels for ${record.canonicalId}`,
    );
  }
  const rank = new Map(
    PROVED_EFFORT_ORDER[record.provider].map((level, index) => [level, index]),
  );
  const unproved = advertised.filter((level) => !rank.has(level));
  if (unproved.length > 0) {
    throw new Error(
      `Hive-decides effort does not know the ordering semantics of ` +
        `${record.provider} ${unproved.join(", ")}; choose an exact advertised level`,
    );
  }
  const orderedLevels = advertised.sort((left, right) =>
    rank.get(left)! - rank.get(right)!
  );
  const tier = codingTierForCategory(category);
  let effort: string;
  if (tier === "simple") effort = orderedLevels[0]!;
  else if (tier === "complex") effort = orderedLevels.at(-1)!;
  else if (
    record.defaultEffort.state === "known" &&
    orderedLevels.includes(record.defaultEffort.value)
  ) {
    effort = record.defaultEffort.value;
  } else {
    effort = orderedLevels[Math.floor(orderedLevels.length / 2)]!;
  }
  return {
    effort,
    orderedLevels,
    basis: EFFORT_ORDER_BASIS[record.provider],
  };
}

/**
 * Validate a user-authored effort against the resolved model's own record.
 * Unknown evidence passes through with a warning; only a positive vendor
 * exclusion refuses the spawn. The value is never coerced.
 */
export function validateEffort(
  record: CapabilityRecord | undefined,
  model: string,
  effort: string | undefined,
): ValidatedEffort {
  if (effort === undefined) return {};
  if (record === undefined) {
    return {
      effort,
      warning:
        `No capability record is available for ${model}; passing effort ${effort} ` +
        "verbatim for the provider CLI to validate",
    };
  }
  if (record.supportsEffort.state === "known" && !record.supportsEffort.value) {
    throw new Error(
      `Cannot launch ${model} with effort ${effort}: the provider reports that ` +
        "this model does not support effort",
    );
  }
  const levels = record.supportedEffortLevels;
  if (levels.state === "known") {
    if (!levels.value.includes(effort)) {
      const supported = levels.value.length === 0
        ? "none"
        : levels.value.join(", ");
      throw new Error(
        `Cannot launch ${model} with effort ${effort}: supported effort levels are ${supported}`,
      );
    }
    return { effort };
  }
  return {
    effort,
    warning:
      `The capability record for ${model} does not report supported effort levels; ` +
      `passing ${effort} verbatim for the provider CLI to validate`,
  };
}
