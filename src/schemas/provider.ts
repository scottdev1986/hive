import { z } from "zod";

/** Providers understood by Hive's runtime and wire contracts. */
export const CapabilityProviderSchema = z.enum([
  "claude",
  "codex",
  "grok",
  "kimi",
  "opencode",
]);
export type CapabilityProvider = z.infer<typeof CapabilityProviderSchema>;

export const CAPABILITY_PROVIDERS = CapabilityProviderSchema.options;
