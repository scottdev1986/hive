import { z } from "zod";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "./capability";
import type { RoutingCategory } from "./routing-policy";
import { opaqueString } from "./wire-schema";

export const QuotaConfidenceSchema = z.enum([
  "authoritative",
  "reported",
  "estimated",
  "missing",
  "stale",
]);
export type QuotaConfidence = z.infer<typeof QuotaConfidenceSchema>;

export const QuotaSourceSchema = z.enum([
  "provider",
  "gateway",
  "manual",
  "statusline",
  "ledger",
  "none",
]);
export type QuotaSource = z.infer<typeof QuotaSourceSchema>;

export const QuotaMeterStateSchema = z.enum([
  "metered",
  "not-metered",
  "unknown",
]);
export type QuotaMeterState = z.infer<typeof QuotaMeterStateSchema>;

/** Where a pool's shape came from. `discovered` pools are read from the provider at startup and are denominated in percent of the window, because no provider reports an absolute capacity — only the fraction consumed. `manual` pools come from `quota.toml`, are denominated in the user's own planning units, and exist purely as an explicit override; Hive never requires one. */
export const QuotaPoolOriginSchema = z.enum(["discovered", "manual"]);
export type QuotaPoolOrigin = z.infer<typeof QuotaPoolOriginSchema>;

export const QuotaLimitSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  account: z.string().min(1).default("default"),
  pool: z.string().min(1),
  models: z.array(z.string().min(1)).min(1).default(["*"]),
  fiveHourAllowance: z.number().positive(),
  weeklyAllowance: z.number().positive(),
  weeklyWindow: z.enum(["rolling", "calendar"]).default("rolling"),
  timezone: z.string().min(1).default("UTC"),
  resetWeekday: z.number().int().min(0).max(6).default(1),
  resetHour: z.number().int().min(0).max(23).default(0),
  resetMinute: z.number().int().min(0).max(59).default(0),
  observationMaxAgeMinutes: z.number().positive().default(360),
});
export type QuotaLimit = z.infer<typeof QuotaLimitSchema>;

/** How much of each window one run of a category is expected to consume, as a percent of that window. This is Hive's own workload guess — never a provider number — so every reservation built from it is surfaced as `estimated`. It is separate from `estimates` because a discovered pool is percent-denominated, and a run is a much larger fraction of a five-hour bucket than of a week: a week does not hold 33 five-hour buckets' worth of capacity. Defaults ship so that no user ever has to enter one. Provider observations overwrite the *usage* these estimates stand in for as soon as a real number arrives; the estimate only ever governs in-flight reservations. */
export const DEFAULT_PERCENT_ESTIMATES: Record<
  RoutingCategory,
  { fiveHour: number; weekly: number }
> = {
  // Workload guesses, never provider numbers; observations overwrite them.
  complex_coding: { fiveHour: 8, weekly: 1.5 },
  debugging: { fiveHour: 8, weekly: 1.5 },
  heavy_research: { fiveHour: 8, weekly: 1.5 },
  planning: { fiveHour: 4, weekly: 0.75 },
  standard_coding: { fiveHour: 4, weekly: 0.75 },
  simple_coding: { fiveHour: 4, weekly: 0.75 },
  default: { fiveHour: 4, weekly: 0.75 },
  code_review: { fiveHour: 3, weekly: 0.6 },
  light_research: { fiveHour: 1.5, weekly: 0.3 },
  summarization: { fiveHour: 1.5, weekly: 0.3 },
};

export const QuotaConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    discovery: z.boolean().default(true),
    refreshIntervalMinutes: z.number().positive().default(15),
    reservationTtlMinutes: z.number().positive().default(360),
    /** How long a route that failed to produce a working agent is passed over for automatic selection. It is a cooldown, not a ban: the route is retried when it lapses, and any successful launch clears it immediately. A permanent exclusion could never produce the success that would lift it, so the guard would silently become the outage it was meant to prevent. */
    launchQuarantineMinutes: z.number().positive().default(15),
    limits: z.array(QuotaLimitSchema).default([]),
  })
  .superRefine((value, context) => {
    const identities = new Set<string>();
    for (const [index, limit] of value.limits.entries()) {
      for (const model of limit.models) {
        const identity = `${limit.provider}\0${limit.account}\0${model}`;
        if (identities.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["limits", index, "models"],
            message: `duplicate provider/account/model mapping for ${model}`,
          });
        }
        identities.add(identity);
      }
    }
  });
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = QuotaConfigSchema.parse({});

const ObservedSourceSchema = z.enum([
  "provider",
  "gateway",
  "manual",
  "statusline",
]);
const ObservedConfidenceSchema = z.enum(["authoritative", "reported"]);

/** A stored observation carries provenance *per window*, not per row. A Claude statusLine payload can report the five-hour window while the weekly one is still absent; stamping one row-level `observedAt` across both would backdate freshness onto a fact nobody observed. A null `*ObservedAt` means "never observed" — the corresponding `*Used` value is meaningless and is reported as unknown rather than as the zero that happens to sit in the column. */
export const QuotaObservationSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  account: z.string().min(1).default("default"),
  pool: z.string().min(1),
  fiveHourUsed: z.number().nonnegative(),
  weeklyUsed: z.number().nonnegative(),
  observedAt: opaqueString(z.iso.datetime({ offset: true })),
  fiveHourResetAt: opaqueString(z.iso.datetime({ offset: true }))
    .nullable()
    .default(null),
  weeklyResetAt: opaqueString(z.iso.datetime({ offset: true }))
    .nullable()
    .default(null),
  source: ObservedSourceSchema,
  confidence: ObservedConfidenceSchema,
  fiveHourObservedAt: opaqueString(z.iso.datetime({ offset: true }))
    .nullable()
    .default(null),
  fiveHourSource: ObservedSourceSchema.nullable().default(null),
  fiveHourConfidence: ObservedConfidenceSchema.nullable().default(null),
  weeklyObservedAt: opaqueString(z.iso.datetime({ offset: true }))
    .nullable()
    .default(null),
  weeklySource: ObservedSourceSchema.nullable().default(null),
  weeklyConfidence: ObservedConfidenceSchema.nullable().default(null),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;
export type QuotaObservationInput = z.input<typeof QuotaObservationSchema>;

export interface QuotaScope {
  provider: CapabilityProvider;
  account: string;
  pool: string;
}

export interface QuotaWindowStatus {
  availability: "available" | "not-metered" | "unknown";
  unit: "percent" | "units";
  allowance: number | null;
  used: number | null;
  reserved: number | null;
  reservedIsEstimate: true | null;
  remaining: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  confidence: QuotaConfidence;
  source: QuotaSource;
  observedAt: string | null;
  windowMinutes: number | null;
}

export interface QuotaPoolStatus extends QuotaScope {
  origin: QuotaPoolOrigin;
  overridesDiscovered: boolean;
  models: string[];
  label: string | null;
  /** Whether this pool participates in routing. Informational pools do not. */
  routable: boolean;
  confidence: QuotaConfidence;
  freshness: "fresh" | "stale" | "missing";
  source: QuotaSource;
  fiveHour: QuotaWindowStatus;
  weekly: QuotaWindowStatus;
}

export interface QuotaUnconfiguredStatus {
  provider: CapabilityProvider;
  model: string;
  configured: false;
  confidence: "missing";
  reason: string;
  probeError: string | null;
  reserved: number;
  /** Units Hive spent through its own ledger. Never the account's usage. */
  fiveHourRecorded: number;
  weeklyRecorded: number;
  recordedIsLocalEstimate: true;
}

export type QuotaStatus = QuotaPoolStatus | QuotaUnconfiguredStatus;

// These output validators stay bound to the public snapshot types so runtime validation and compile-time consumers cannot drift into different wires.
export const QuotaWindowStatusSchema = z.strictObject({
  availability: z.enum(["available", "not-metered", "unknown"]),
  unit: z.enum(["percent", "units"]),
  allowance: z.number().nullable(),
  used: z.number().nullable(),
  reserved: z.number().nullable(),
  reservedIsEstimate: z.literal(true).nullable(),
  remaining: z.number().nullable(),
  remainingPct: z.number().nullable(),
  resetsAt: z.iso.datetime({ offset: true }).nullable(),
  confidence: QuotaConfidenceSchema,
  source: QuotaSourceSchema,
  observedAt: z.iso.datetime({ offset: true }).nullable(),
  windowMinutes: z.number().nullable(),
}) satisfies z.ZodType<QuotaWindowStatus>;

export const QuotaPoolStatusSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  account: z.string().min(1),
  pool: z.string().min(1),
  origin: QuotaPoolOriginSchema,
  overridesDiscovered: z.boolean(),
  models: z.array(z.string().min(1)),
  label: z.string().nullable(),
  routable: z.boolean(),
  confidence: QuotaConfidenceSchema,
  freshness: z.enum(["fresh", "stale", "missing"]),
  source: QuotaSourceSchema,
  fiveHour: QuotaWindowStatusSchema,
  weekly: QuotaWindowStatusSchema,
}) satisfies z.ZodType<QuotaPoolStatus>;

export const QuotaUnconfiguredStatusSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: z.string().min(1),
  configured: z.literal(false),
  confidence: z.literal("missing"),
  reason: z.string(),
  probeError: z.string().nullable(),
  reserved: z.number(),
  fiveHourRecorded: z.number(),
  weeklyRecorded: z.number(),
  recordedIsLocalEstimate: z.literal(true),
}) satisfies z.ZodType<QuotaUnconfiguredStatus>;

export const QuotaStatusSchema = z.union([
  QuotaPoolStatusSchema,
  QuotaUnconfiguredStatusSchema,
]) satisfies z.ZodType<QuotaStatus>;
