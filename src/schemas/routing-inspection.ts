import { z } from "zod";
import { CapabilityProviderSchema } from "./capability";
import {
  RouteCandidateSchema,
  RouterModeSchema,
  RoutingCategorySchema,
} from "./routing-policy";

/** RouterService.inspect's wire contract (docs/design/hive-router.html §13): the read-only view of one resolved route the Task Router screen renders. inspect never selects and never mutates — evaluating candidates through it touches no balance and records no decision. schemaVersion is frozen at 1; a breaking shape change bumps it. */

/** The one bounded reason "not this candidate" a gate reports for a target. `retryAt` is set only when the gate itself knows when it would lift. */
export const RouteCandidateRefusalSchema = z.strictObject({
  gate: z.string(),
  detail: z.string(),
  retryAt: z.iso.datetime({ offset: true }).nullable(),
});
export type RouteCandidateRefusal = z.infer<typeof RouteCandidateRefusalSchema>;

export const RouteCandidateInspectionSchema = z.strictObject({
  candidate: RouteCandidateSchema,
  effectiveWeight: z.number(),
  configuredShare: z.number(),
  /** Normalized share over only the currently ELIGIBLE candidates — what selection actually pays out right now. 0 for an ineligible candidate, and it moves for the others when an exclusion removes one, with no weight edited. */
  liveShare: z.number(),
  eligible: z.boolean(),
  effectiveEffort: z.string().nullable(),
  refusal: RouteCandidateRefusalSchema.nullable(),
});
export type RouteCandidateInspection = z.infer<
  typeof RouteCandidateInspectionSchema
>;

export const RouteInspectionRefusalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("never-configured"), detail: z.string() }),
  z.strictObject({ kind: z.literal("no-candidate"), detail: z.string() }),
]);

export const RouteBalanceEntrySchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: z.string(),
  current: z.number(),
});

export const RouteInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  category: RoutingCategorySchema,
  policyRevision: z.number().int().nonnegative(),
  scope: z.union([RoutingCategorySchema, z.literal("global")]).nullable(),
  mode: RouterModeSchema.nullable(),
  routeDigest: z.string().nullable(),
  candidates: z.array(RouteCandidateInspectionSchema),
  /** Whole-route refusal: no route configured, or every candidate ineligible. Null whenever at least one candidate is currently eligible. */
  refusal: RouteInspectionRefusalSchema.nullable(),
  balance: z.array(RouteBalanceEntrySchema),
  inspectedAt: z.iso.datetime({ offset: true }),
});
export type RouteInspection = z.infer<typeof RouteInspectionSchema>;
