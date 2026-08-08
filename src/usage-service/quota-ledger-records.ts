import { z } from "zod";
import { CapabilityProviderSchema } from "../schemas/capability";
import type { QuotaScope } from "../schemas/quota";
import { QuotaMeterStateSchema } from "../schemas/quota";
import {
  type RoutingCategory,
  RoutingCategorySchema,
} from "../schemas/routing-policy";

/**
 * The rows the quota ledger stores and hands back.
 *
 * Shapes only — every statement that reads or writes them lives in
 * quota-ledger.ts, which is the named owner of this database. Keeping the
 * shapes here means a reader can see what a reservation, a discovered pool or
 * a route-health record *is* without reading the DDL that persists it.
 */

export const ReservationSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  instanceHome: z.string(),
  groupId: z.string().nullable().default(null),
  agentName: z.string(),
  provider: CapabilityProviderSchema,
  account: z.string(),
  pool: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  category: RoutingCategorySchema,
  estimatedUnits: z.number(),
  estimatedWeeklyUnits: z.number().nullable(),
  status: z.enum(["active", "reconciled", "released"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  startedAt: z.string().nullable(),
  reconciledAt: z.string().nullable(),
  actualUnits: z.number().nullable(),
  source: z.string().nullable(),
  purpose: z.enum(["agent", "control"]),
  controlMessageId: z.string().nullable(),
});

export type QuotaReservation = z.infer<typeof ReservationSchema>;

/** A quota pool Hive learned about from the provider itself rather than from a user-written `quota.toml`. The provider reports *percentages consumed*, never an absolute capacity, so a discovered pool is denominated in percent: its allowance is 100 by construction and every usage figure is a percent of the window. Window durations are recorded as the provider reported them. */
export const DiscoveredPoolSchema = z.object({
  provider: CapabilityProviderSchema,
  account: z.string(),
  pool: z.string(),
  /** Empty means the pool is informational: it never matches a routing model. */
  models: z.array(z.string()),
  label: z.string().nullable(),
  fiveHourWindowMinutes: z.number().nullable(),
  weeklyWindowMinutes: z.number().nullable(),
  fiveHourMeterState: QuotaMeterStateSchema,
  weeklyMeterState: QuotaMeterStateSchema,
  discoveredAt: z.string(),
  source: z.enum(["provider", "statusline"]),
});
export type DiscoveredQuotaPool = z.infer<typeof DiscoveredPoolSchema>;

/** One row of a provider's own model catalog: which display name a model answers to. This is what binds a metered sub-pool to the models it meters — the quota payloads name their pools ("Fable", "GPT-5.3-Codex-Spark") but never carry a model id, and the catalog is where the provider publishes both. It is stored rather than resolved on the fly because the free live feeds — the Codex app-server's push notifications and Claude's statusLine — refresh pool *usage* without carrying a catalog. Binding at read time from the stored catalog means a usage update can never silently unbind a pool. */
export const ModelCatalogSchema = z.object({
  provider: CapabilityProviderSchema,
  modelId: z.string(),
  displayName: z.string(),
  discoveredAt: z.string(),
});
export type ModelCatalogRow = z.infer<typeof ModelCatalogSchema>;

/** Whether a route actually starts, learned from what happened when Hive tried. Headroom is not eligibility. A route can have all the quota in the world and still be incapable of producing a working agent — deep-category Codex was exactly this on 2026-07-11 — and a gate that refuses an exhausted model only to hand the work to a route that cannot start has protected nothing. So a launch that never proves life is recorded against its route, and a route that recently failed to start is not offered as an automatic choice. This is an observation, never a belief. Nothing here names a vendor or encodes "codex deep is broken" — that fact expires the moment someone fixes it. A success clears the route instantly, and the quarantine lapses on its own, so the guard stops guarding the moment the route starts working again. That expiry is not a nicety: a route excluded forever can never produce the success that would clear it, and the guard would quietly become the outage. */
export const RouteHealthSchema = z.object({
  provider: CapabilityProviderSchema,
  model: z.string(),
  effort: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastFailureAt: z.string().nullable(),
  lastFailureReason: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
});
export type RouteHealth = z.infer<typeof RouteHealthSchema>;

export const AlertStateSchema = z.object({
  provider: z.string(),
  account: z.string(),
  pool: z.string(),
  window: z.enum(["five-hour", "weekly", "data"]),
  level: z.enum(["normal", "warning", "critical", "unknown"]),
  notifiedAt: z.string().nullable(),
  boundaryAt: z.string().nullable(),
});
export type QuotaAlertState = z.infer<typeof AlertStateSchema>;

export interface UsageTotals {
  fiveHour: number;
  weekly: number;
  afterFiveHourObservation: number;
  afterWeeklyObservation: number;
  reserved: number;
  reservedWeekly: number;
}

export const LedgerIntegritySchema = z.object({
  usageRows: z.number().int().nonnegative(),
  reservationRows: z.number().int().nonnegative(),
  nextUsageSeq: z.number().int().nonnegative(),
});

export class QuotaLedgerUnknownError extends Error {
  constructor(reason: string) {
    super(
      `The quota ledger history is unknown (${reason}). Refusing to report fresh ` +
        "headroom or reserve more quota; restore the intact quota.db before launching.",
    );
    this.name = "QuotaLedgerUnknownError";
  }
}

/** The last spend each window's own reading had already been able to see. Each window is observed on its own schedule, so each carries its own boundary: one row-level boundary for both would drop every unit spent between an older weekly reading and a newer five-hour one, and that spend is exactly the headroom a concurrent spawn would then overcommit. These are ledger sequence numbers, not timestamps — see `usageWatermark`. Null means the window was never observed, and there is nothing to be "after". */
export interface ObservationWatermarks {
  fiveHour: number | null;
  weekly: number | null;
}

export interface UnconfiguredQuotaScope extends QuotaScope {
  model: string;
}

export interface ReserveQuotaInput extends QuotaScope {
  id: string;
  agentName: string;
  model: string;
  effort?: string | null;
  category: RoutingCategory;
  estimatedUnits: number;
  estimatedWeeklyUnits?: number;
  now: string;
  expiresAt: string;
  purpose?: "agent" | "control";
  controlMessageId?: string;
}
