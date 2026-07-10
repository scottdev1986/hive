import { z } from "zod";
import { RoutingTierSchema } from "./routing";

export const QuotaConfidenceSchema = z.enum([
  "authoritative",
  "reported",
  "estimated",
  "missing",
  "stale",
]);
export type QuotaConfidence = z.infer<typeof QuotaConfidenceSchema>;

export const QuotaLimitSchema = z.strictObject({
  provider: z.enum(["claude", "codex"]),
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

export const QuotaConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  warningRemainingPct: z.number().min(0).max(1).default(0.25),
  criticalRemainingPct: z.number().min(0).max(1).default(0.1),
  hysteresisPct: z.number().min(0).max(0.5).default(0.05),
  reserveFiveHourPct: z.number().min(0).max(1).default(0.15),
  reserveWeeklyPct: z.number().min(0).max(1).default(0.2),
  reservationTtlMinutes: z.number().positive().default(360),
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

export const QuotaObservationSchema = z.strictObject({
  provider: z.enum(["claude", "codex"]),
  account: z.string().min(1).default("default"),
  pool: z.string().min(1),
  fiveHourUsed: z.number().nonnegative(),
  weeklyUsed: z.number().nonnegative(),
  observedAt: z.iso.datetime({ offset: true }),
  fiveHourResetAt: z.iso.datetime({ offset: true }).nullable().default(null),
  weeklyResetAt: z.iso.datetime({ offset: true }).nullable().default(null),
  source: z.enum(["provider", "gateway", "manual"]),
  confidence: z.enum(["authoritative", "reported"]),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;

export interface QuotaScope {
  provider: "claude" | "codex";
  account: string;
  pool: string;
}

export interface QuotaWindowStatus {
  allowance: number;
  used: number;
  reserved: number;
  remaining: number;
  remainingPct: number;
  resetsAt: string | null;
}

export interface QuotaPoolStatus extends QuotaScope {
  models: string[];
  confidence: QuotaConfidence;
  freshness: "fresh" | "stale" | "missing";
  source: "provider" | "gateway" | "manual" | "ledger" | "none";
  fiveHour: QuotaWindowStatus;
  weekly: QuotaWindowStatus;
}

export interface QuotaUnconfiguredStatus {
  provider: "claude" | "codex";
  model: string;
  configured: false;
  confidence: "missing";
  reason: string;
  reserved: number;
  fiveHourRecorded: number;
  weeklyRecorded: number;
}

export type QuotaStatus = QuotaPoolStatus | QuotaUnconfiguredStatus;
