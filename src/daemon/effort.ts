import type { CapabilityRecord } from "../schemas";

export interface ValidatedEffort {
  effort?: string;
  warning?: string;
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
