import { createHash } from "node:crypto";
import { z } from "zod";

/** Unknown constraints are rejected; absence never grants terminal observation. */
export const Hv1CapabilityConstraintsSchema = z.strictObject({
  content: z.literal(true).optional(),
  scope: z.literal("user").optional(),
});
export type Hv1CapabilityConstraints = z.infer<
  typeof Hv1CapabilityConstraintsSchema
>;

const Hv1CapabilityCommonShape = {
  id: z.string().uuid(),
  subject: z.string().min(1),
  role: z.enum(["user", "orchestrator", "writer", "reader"]),
  epoch: z.number().int().nonnegative(),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
} as const;

export const Hv1CapabilityRecordSchema = z.union([
  z.strictObject({
    ...Hv1CapabilityCommonShape,
    constraints: z
      .strictObject({ content: z.literal(true).optional() })
      .optional(),
  }),
  z.strictObject({
    ...Hv1CapabilityCommonShape,
    constraints: z.strictObject({
      content: z.literal(true).optional(),
      scope: z.literal("user"),
    }),
    subjects: z.array(z.string().min(1)).min(1),
  }),
]);
export type Hv1CapabilityRecord = z.infer<typeof Hv1CapabilityRecordSchema>;

export const HV1_CAPABILITY_WIRE_SCHEMAS = {
  hv1CapabilityRecord: Hv1CapabilityRecordSchema,
} as const;

export const CapabilityProviderSchema = z.enum([
  "claude",
  "codex",
  "grok",
  "kimi",
  "opencode",
]);
export type CapabilityProvider = z.infer<typeof CapabilityProviderSchema>;

export const CAPABILITY_PROVIDERS = CapabilityProviderSchema.options;

export function unknownVendor(vendor: never, site: string): never {
  throw new Error(
    `${site}: unknown vendor ${JSON.stringify(vendor)}; Hive knows ${CAPABILITY_PROVIDERS.join(
      " and ",
    )}`,
  );
}

/** Enumerate every known provider plus sorted snapshot extras; never erase either. */
export function providersOf<T>(
  record: Partial<Record<CapabilityProvider, T>>,
): CapabilityProvider[] {
  const union = new Set<string>(CAPABILITY_PROVIDERS);
  const extras = Object.keys(record)
    .filter((key) => !union.has(key))
    .sort();
  return [...CAPABILITY_PROVIDERS, ...(extras as CapabilityProvider[])];
}

export const ProviderTransportSchema = z.enum([
  "acp",
  "codex-app-server",
  "claude-stream-json",
  "fake",
]);
export type ProviderTransport = z.infer<typeof ProviderTransportSchema>;

export const ResolvedRuntimeSchema = z
  .strictObject({
    executable: z.string().min(1),
    version: z.string().min(1),
    transport: ProviderTransportSchema,
    workingDirectory: z.string().min(1),
    accountFingerprint: z.string().min(1).optional(),
  })
  .readonly();
export type ResolvedRuntime = z.infer<typeof ResolvedRuntimeSchema>;

export const BASELINE_CAPABILITIES = [
  "newSession",
  "prompt",
  "cancel",
  "permissions",
  "streamingText",
  "toolLifecycle",
  "sessionRecovery",
] as const;

export const OPTIONAL_CAPABILITIES = [
  "questions",
  "commandCatalog",
  "modelCatalog",
  "modeCatalog",
  "contextUsage",
  "fork",
  "compact",
  "steering",
] as const;

export type BaselineCapability = (typeof BASELINE_CAPABILITIES)[number];
export type OptionalCapability = (typeof OPTIONAL_CAPABILITIES)[number];

export const CapabilityNameSchema = z.enum([
  ...BASELINE_CAPABILITIES,
  ...OPTIONAL_CAPABILITIES,
]);
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

export const CapabilitySupportSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

export const CapabilityMeasurementsSchema = z.partialRecord(
  CapabilityNameSchema,
  CapabilitySupportSchema,
);
export type CapabilityMeasurements = z.infer<
  typeof CapabilityMeasurementsSchema
>;

/** Proven absence carries evidence so a surface can distinguish it from ignorance. */
export const ProvenAbsenceSchema = z.strictObject({
  reason: z.string().min(1),
  citation: z.string().min(1),
});
export type ProvenAbsence = z.infer<typeof ProvenAbsenceSchema>;

export const CapabilityAbsencesSchema = z.partialRecord(
  CapabilityNameSchema,
  ProvenAbsenceSchema,
);
export type CapabilityAbsences = z.infer<typeof CapabilityAbsencesSchema>;

export const MeasuredProviderCapabilitiesSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  runtime: ResolvedRuntimeSchema,
  absences: CapabilityAbsencesSchema.optional(),
  measured: CapabilityMeasurementsSchema,
  handshake: z.unknown(),
});
export type MeasuredProviderCapabilities = z.infer<
  typeof MeasuredProviderCapabilitiesSchema
>;

export async function forEachProvider<T>(
  read: (provider: CapabilityProvider) => Promise<T>,
): Promise<Record<CapabilityProvider, T>> {
  const entries = await Promise.all(
    CAPABILITY_PROVIDERS.map(
      async (provider) => [provider, await read(provider)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<CapabilityProvider, T>;
}

export const CapabilitySurfaceSchema = z.enum([
  "claude.initialize",
  "codex.model/list",
  "codex.config/read",
  "grok.acp",
  "kimi.acp",
  "opencode.acp",
  "grok.models",
  "kimi.provider/list",
  "kimi.config",
  "opencode.models",
  "opencode.config",
  "grok.models_cache",
  "grok._x.ai/billing",
  "grok.updates.jsonl",
  "grok._x.ai/session/info",
  "claude.get_usage",
  "codex.account/rateLimits/read",
  "kimi.usages",
]);
export type CapabilitySurface = z.infer<typeof CapabilitySurfaceSchema>;

/** Missing, silent, and malformed facts are distinct states, never one null. */
export const CapabilityUnknownReasonSchema = z.enum([
  "field-absent",
  "surface-silent",
  "malformed",
]);
export type CapabilityUnknownReason = z.infer<
  typeof CapabilityUnknownReasonSchema
>;

export type Discovered<T> =
  | {
      state: "known";
      value: T;
      surface: CapabilitySurface;
      observedAt: string;
    }
  | {
      state: "unknown";
      reason: CapabilityUnknownReason;
      surface: CapabilitySurface;
      observedAt: string;
    };

export const discovered = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("known"),
      value,
      surface: CapabilitySurfaceSchema,
      observedAt: z.iso.datetime({ offset: true }),
    }),
    z.strictObject({
      state: z.literal("unknown"),
      reason: CapabilityUnknownReasonSchema,
      surface: CapabilitySurfaceSchema,
      observedAt: z.iso.datetime({ offset: true }),
    }),
  ]);

export const known = <T>(
  value: T,
  surface: CapabilitySurface,
  observedAt: string,
): Discovered<T> => ({ state: "known", value, surface, observedAt });

export const unknown = <T>(
  reason: CapabilityUnknownReason,
  surface: CapabilitySurface,
  observedAt: string,
): Discovered<T> => ({ state: "unknown", reason, surface, observedAt });

/** Raw vendor effort strings preserve future values across ingestion and restart. */
export const EffortLevelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);

export const CapabilityRecordSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  /** Account-scoped facts use a non-PII hash, never raw handshake identity. */
  accountFingerprint: z.string().min(1),
  cliVersion: z.string().min(1),
  canonicalId: z.string().min(1),
  /** Stored context entitlement suffixes never reach `--model`. */
  variant: z.string().min(1).nullable(),
  launchToken: z.string().min(1),
  aliases: z.array(z.string().min(1)),

  displayName: z.string().min(1).nullable(),
  entitled: discovered(z.boolean()),
  hidden: discovered(z.boolean()),
  supportsEffort: discovered(z.boolean()),
  supportedEffortLevels: discovered(z.array(EffortLevelSchema)),
  defaultEffort: discovered(EffortLevelSchema),

  observedAt: z.iso.datetime({ offset: true }),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;

export const capabilityKey = (
  record: Pick<
    CapabilityRecord,
    "provider" | "accountFingerprint" | "cliVersion" | "canonicalId" | "variant"
  >,
): string =>
  [
    record.provider,
    record.accountFingerprint,
    record.cliVersion,
    record.variant === null
      ? record.canonicalId
      : `${record.canonicalId}[${record.variant}]`,
  ].join("\0");

export const fingerprintAccount = (
  provider: CapabilityProvider,
  identifiers: readonly (string | null | undefined)[],
): string => {
  const material = identifiers
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .map((part) => part.trim().toLowerCase());
  if (material.length === 0) return `${provider}:unidentified`;
  return createHash("sha256")
    .update([provider, ...material].join("\0"))
    .digest("hex")
    .slice(0, 16);
};

const VARIANT_PATTERN = /\[([^\]]+)\]$/;

export const splitVariant = (
  name: string,
): { base: string; variant: string | null } => {
  const match = VARIANT_PATTERN.exec(name);
  if (match === null) return { base: name, variant: null };
  const variant = match[1];
  return variant === undefined
    ? { base: name, variant: null }
    : { base: name.slice(0, match.index), variant };
};

/** Account-level effective default, never a catalog recommendation or shipped fallback. */
export const EffectiveDefaultSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: discovered(z.string().min(1)),
  effort: discovered(EffortLevelSchema),
});
export type EffectiveDefault = z.infer<typeof EffectiveDefaultSchema>;

export const CapabilityDiscoveryResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    records: z.array(CapabilityRecordSchema),
    effectiveDefault: EffectiveDefaultSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);
export type CapabilityDiscoveryResult = z.infer<
  typeof CapabilityDiscoveryResultSchema
>;

// Stale discovery is still better evidence than turning a discovery hiccup into an outage.
