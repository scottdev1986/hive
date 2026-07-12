import { z } from "zod";
import {
  CapabilityProviderSchema,
  type CapabilityProvider,
} from "./capability";
import { RoutingTierSchema } from "./routing";

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

/**
 * Where a pool's shape came from. `discovered` pools are read from the provider
 * at startup and are denominated in percent of the window, because no provider
 * reports an absolute capacity — only the fraction consumed. `manual` pools come
 * from `quota.toml`, are denominated in the operator's own planning units, and
 * exist purely as an explicit override; Hive never requires one.
 */
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

const EstimateSchema = z.record(RoutingTierSchema, z.number().positive());

/**
 * How much of each window one run of a tier is expected to consume, as a percent
 * of that window. This is Hive's own workload guess — never a provider number —
 * so every reservation built from it is surfaced as `estimated`. It is separate
 * from `estimates` because a discovered pool is percent-denominated, and a run
 * is a much larger fraction of a five-hour bucket than of a week: a week does
 * not hold 33 five-hour buckets' worth of capacity.
 *
 * Defaults ship so that no operator ever has to enter one. Provider observations
 * overwrite the *usage* these estimates stand in for as soon as a real number
 * arrives; the estimate only ever governs in-flight reservations.
 */
const PercentEstimateSchema = z.strictObject({
  fiveHour: z.number().positive().max(100),
  weekly: z.number().positive().max(100),
});

const PercentEstimateTableSchema = z.record(
  RoutingTierSchema,
  PercentEstimateSchema,
);

export const DEFAULT_PERCENT_ESTIMATES = {
  deep: { fiveHour: 8, weekly: 1.5 },
  standard: { fiveHour: 4, weekly: 0.75 },
  cheap: { fiveHour: 1.5, weekly: 0.3 },
  review: { fiveHour: 3, weekly: 0.6 },
} as const;

export const QuotaConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Read live limits from the providers at daemon start and on refresh. */
  discovery: z.boolean().default(true),
  /** How often the daemon re-reads provider limits, in minutes. */
  refreshIntervalMinutes: z.number().positive().default(15),
  estimatesPct: PercentEstimateTableSchema.default(DEFAULT_PERCENT_ESTIMATES),
  warningRemainingPct: z.number().min(0).max(1).default(0.25),
  criticalRemainingPct: z.number().min(0).max(1).default(0.1),
  hysteresisPct: z.number().min(0).max(0.5).default(0.05),
  reserveFiveHourPct: z.number().min(0).max(1).default(0.15),
  reserveWeeklyPct: z.number().min(0).max(1).default(0.2),
  reservationTtlMinutes: z.number().positive().default(360),
  /**
   * How long a route that failed to produce a working agent is passed over for
   * automatic selection. It is a cooldown, not a ban: the route is retried when
   * it lapses, and any successful launch clears it immediately. A permanent
   * exclusion could never produce the success that would lift it, so the guard
   * would silently become the outage it was meant to prevent.
   */
  launchQuarantineMinutes: z.number().positive().default(15),
  estimates: EstimateSchema.default({
    deep: 20,
    standard: 10,
    cheap: 4,
    review: 8,
  }),
  limits: z.array(QuotaLimitSchema).default([]),
}).superRefine((value, context) => {
  if (value.criticalRemainingPct > value.warningRemainingPct) {
    context.addIssue({
      code: "custom",
      path: ["criticalRemainingPct"],
      message: "must be less than or equal to warningRemainingPct",
    });
  }
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

/**
 * A stored observation carries provenance *per window*, not per row. A Claude
 * statusLine payload can report the five-hour window while the weekly one is
 * still absent; stamping one row-level `observedAt` across both would backdate
 * freshness onto a fact nobody observed. A null `*ObservedAt` means "never
 * observed" — the corresponding `*Used` value is meaningless and is reported as
 * unknown rather than as the zero that happens to sit in the column.
 */
export const QuotaObservationSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  account: z.string().min(1).default("default"),
  pool: z.string().min(1),
  fiveHourUsed: z.number().nonnegative(),
  weeklyUsed: z.number().nonnegative(),
  observedAt: z.iso.datetime({ offset: true }),
  fiveHourResetAt: z.iso.datetime({ offset: true }).nullable().default(null),
  weeklyResetAt: z.iso.datetime({ offset: true }).nullable().default(null),
  source: ObservedSourceSchema,
  confidence: ObservedConfidenceSchema,
  fiveHourObservedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  fiveHourSource: ObservedSourceSchema.nullable().default(null),
  fiveHourConfidence: ObservedConfidenceSchema.nullable().default(null),
  weeklyObservedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  weeklySource: ObservedSourceSchema.nullable().default(null),
  weeklyConfidence: ObservedConfidenceSchema.nullable().default(null),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;
/** What a caller may hand in: per-window provenance fields are optional. */
export type QuotaObservationInput = z.input<typeof QuotaObservationSchema>;

// The subscriber usage block Claude Code passes to its statusLine command:
// used percentage and reset time per rolling window, each window optionally
// absent (API-key accounts, or before the session's first response).
export const StatuslineRateWindowSchema = z.object({
  usedPct: z.number().min(0).max(100),
  resetsAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

export const StatuslineReportSchema = z.object({
  agent: z.string().min(1),
  effort: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  fiveHour: StatuslineRateWindowSchema.optional(),
  sevenDay: StatuslineRateWindowSchema.optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
  // No `model` here, though the payload carries one. The live model is
  // reconciled from the transcript instead (server.ts): the transcript stamps
  // every assistant turn with the model that produced it and is always present,
  // while this payload is absent entirely on an API-key account. A source that
  // cannot fail beats one that can — and carrying the same fact on two routes
  // is how the two routes end up disagreeing.
  /**
   * The context window this session actually has, in tokens, as Claude Code
   * resolved it against the account's plan — 200000, or 1000000 where the plan
   * upgrades it. This payload is the ONLY place Hive is ever told: the
   * transcript records how many tokens a turn used but never the window they
   * fill, and the model id cannot imply it, because the 1M upgrade tracks the
   * plan and not the name (`claude-opus-4-8` is 200k on one plan and 1M on
   * another, byte-identical). Absent when the payload carried no window, and
   * absent must stay absent: dividing by a plausible-looking 200000 is what
   * reported live agents at ~22% of a 1M window as 100% full.
   */
  contextWindow: z.number().int().positive().optional(),
  /**
   * Claude Code's own occupancy figure for that window. It measures; we do not
   * re-derive it.
   */
  contextUsedPct: z.number().min(0).max(100).optional(),
});
export type StatuslineReport = z.infer<typeof StatuslineReportSchema>;

export interface QuotaScope {
  provider: CapabilityProvider;
  account: string;
  pool: string;
}

/**
 * One window of one pool. Every number here is either a real measurement or
 * `null`; a window Hive has no observation for reports `used: null`, never `0`.
 * `reserved` is the exception that proves the rule: it is Hive's own in-flight
 * bookkeeping, is always known, and is always an estimate — hence
 * `reservedIsEstimate`, which is `true` unconditionally so no renderer can
 * mistake it for provider truth.
 */
export interface QuotaWindowStatus {
  /** `percent` for provider-discovered pools; `units` for manual overrides. */
  unit: "percent" | "units";
  /** Provider capacity. Always 100 for percent pools; null when unknowable. */
  allowance: number | null;
  used: number | null;
  reserved: number;
  reservedIsEstimate: true;
  remaining: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  /** Per-fact provenance: this window's own confidence, source, and freshness. */
  confidence: QuotaConfidence;
  source: QuotaSource;
  observedAt: string | null;
  windowMinutes: number | null;
}

export interface QuotaPoolStatus extends QuotaScope {
  origin: QuotaPoolOrigin;
  /** True when a manual `quota.toml` pool overrides a discovered one. */
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

/**
 * A provider whose real limits Hive could not read. Nothing here is a capacity
 * number: `fiveHourRecorded` is what Hive itself spent through this daemon, not
 * what the account has consumed, and it is labelled as such everywhere it is
 * rendered. `probeError` carries the provider's own reason for the gap.
 */
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
