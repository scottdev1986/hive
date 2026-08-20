import { z } from "zod";
import {
  type CapabilityProvider,
  CapabilityProviderSchema,
} from "./capability";

/** The user's routing policy — the store behind the Model Control Center and the router's only source of standing preference. A route is an UNORDERED set of exact (provider, model, effort) candidates with integer relative weights; there is no fallback ladder and order carries no meaning. The router selects one candidate with smooth weighted round-robin: user weights in `user-weighted` mode, effective weight 1 for everyone in `hive-equal`. FAIL-CLOSED READING, the rule every consumer must inherit: an absent row means NOT CONFIGURED, and not-configured never means allowed. The helpers at the bottom are the one implementation of that reading — a consumer that re-derives it by hand is how a null becomes permission again. */

/** `long_context` is deliberately NOT a category — it arrives as a requirement modifier on spawn, not as a routing bucket. */
export const ROUTING_CATEGORIES = [
  "light_research",
  "heavy_research",
  "simple_coding",
  "standard_coding",
  "complex_coding",
  "code_review",
  "planning",
  "debugging",
  "summarization",
  "default",
] as const;
export const RoutingCategorySchema = z.enum(ROUTING_CATEGORIES);
export type RoutingCategory = z.infer<typeof RoutingCategorySchema>;

/** User-facing category names travel from the daemon with the routing view.
 * Keeping the catalog beside the schema means adding a category cannot leave a
 * Swift release with a shorter, independently maintained menu. */
const ROUTING_CATEGORY_LABELS = {
  light_research: "Light research",
  heavy_research: "Heavy research / synthesis",
  simple_coding: "Simple coding",
  standard_coding: "Standard coding",
  complex_coding: "Complex coding",
  code_review: "Code review",
  planning: "Planning",
  debugging: "Debugging",
  summarization: "Summarization",
  default: "Everything else",
} as const satisfies Record<RoutingCategory, string>;

export const ROUTING_CATEGORY_CATALOG = ROUTING_CATEGORIES.map((id) => ({
  id,
  label: ROUTING_CATEGORY_LABELS[id],
}));

export const CODING_TIERS = ["simple", "standard", "complex"] as const;
export const CodingTierSchema = z.enum(CODING_TIERS);
export type CodingTier = z.infer<typeof CodingTierSchema>;

/** Effort intent is explicit: unanswered, Hive-decides, an exact advertised level, a positively absent effort axis, or provider-controlled. The latter omits the flag and lets the vendor decide without claiming to know its default; it is not AUTO. */
export const EffortTargetSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("never-configured") }),
  z.strictObject({ mode: z.literal("hive-decides") }),
  z.strictObject({ mode: z.literal("exact"), value: z.string().min(1) }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("provider-controlled") }),
]);
export type EffortTarget = z.infer<typeof EffortTargetSchema>;

/** A route candidate always answers effort: never-configured is a model-row state, not a launchable intent, so it cannot appear on a candidate. */
export const CandidateEffortSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("hive-decides") }),
  z.strictObject({ mode: z.literal("exact"), value: z.string().min(1) }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("provider-controlled") }),
]);
export type CandidateEffort = z.infer<typeof CandidateEffortSchema>;

export const ROUTE_WEIGHT_MIN = 1;
export const ROUTE_WEIGHT_MAX = 100;
export const ROUTE_DEFAULT_WEIGHT = 1;

const ExactModelIdSchema = z
  .string()
  .min(1)
  .refine((model) => model !== "default", {
    message:
      'a route names the specific model that will run; "default" is not a model',
  });

/** One exact candidate: a specific (provider, model, effort) with an integer relative weight. Weights are ratings, not percentages — 60/20/20 and 3/1/1 express the same distribution — and zero is illegal: disablement stays the explicit provider/model enablement control, never a weight. */
export const RouteCandidateSchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: ExactModelIdSchema,
  effort: CandidateEffortSchema,
  weight: z.number().int().min(ROUTE_WEIGHT_MIN).max(ROUTE_WEIGHT_MAX),
});
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;

export const routeTargetKey = (entry: {
  provider: CapabilityProvider;
  model: string;
}): string => `${entry.provider}\0${entry.model}`;

export const RouterModeSchema = z.enum(["user-weighted", "hive-equal"]);
export type RouterMode = z.infer<typeof RouterModeSchema>;

/** UI metadata belongs to the daemon with the routing semantics. Workspace
 * clients render this catalog instead of maintaining their own mode list or
 * deciding which modes expose weights. */
export const ROUTING_MODE_CATALOG = [
  {
    id: "user-weighted",
    label: "Weighted split",
    caption:
      "Hive splits spawns by the weights you set. Weights are ratings, not percentages — 3/1/1 and 60/20/20 are the same split.",
    weightEditable: true,
  },
  {
    id: "hive-equal",
    label: "Equal split",
    caption:
      "Every candidate gets the same share. Your weights are kept and apply again if you switch back.",
    weightEditable: false,
  },
] as const satisfies ReadonlyArray<{
  id: RouterMode;
  label: string;
  caption: string;
  weightEditable: boolean;
}>;

export const DEFAULT_ROUTER_MODE: RouterMode = "hive-equal";

/** An unordered candidate set. Duplicate targets are rejected — a route that names the same model twice is an editing bug, not a stronger preference. */
export const RoutePolicySchema = z.strictObject({
  mode: RouterModeSchema,
  candidates: z
    .array(RouteCandidateSchema)
    .min(1)
    .refine(
      (entries) => new Set(entries.map(routeTargetKey)).size === entries.length,
      { message: "a route must not name the same target twice" },
    ),
});
export type RoutePolicy = z.infer<typeof RoutePolicySchema>;

export const ModelPolicySchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: ExactModelIdSchema,
  state: z.enum(["enabled", "disabled"]).optional(),
  /** Explicit even when unanswered: absence must never acquire AUTO meaning. */
  effort: EffortTargetSchema,
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/** The whole policy document. Only EXPLICIT settings appear: an absent provider is unconfigured; under an enabled provider, an absent model state inherits that provider until the user explicitly disables the model. `global` is the route for categories without their own; a category route that refuses every candidate does NOT fall through to global — the category was an explicit boundary, not the first half of a hidden fallback chain. */
export const RoutingPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    /** Monotonic; every accepted mutation increments it. Writers must present the revision they read (compare-and-set) so concurrent edits conflict loudly instead of clobbering silently. */
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime({ offset: true }),
    provisional: z.boolean(),
    providers: z.partialRecord(
      CapabilityProviderSchema,
      z.enum(["enabled", "disabled"]),
    ),
    models: z.array(ModelPolicySchema),
    global: RoutePolicySchema.nullable(),
    categories: z.partialRecord(RoutingCategorySchema, RoutePolicySchema),
  })
  .superRefine((policy, context) => {
    const targets = new Set<string>();
    for (const [index, model] of policy.models.entries()) {
      const target = routeTargetKey(model);
      if (targets.has(target)) {
        context.addIssue({
          code: "custom",
          path: ["models", index],
          message: `duplicate model policy for ${model.provider}/${model.model}`,
        });
      }
      targets.add(target);
    }
  });
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export function emptyRoutingPolicy(updatedAt: string): RoutingPolicy {
  return {
    schemaVersion: 3,
    revision: 0,
    updatedAt,
    provisional: false,
    providers: {},
    models: [],
    global: null,
    categories: {},
  };
}

/** The one resolution rule: the exact category route when present, else `global`, else nothing. A configured category never appends global after a refusal, and there is no third tier. */
export function resolveRoute(
  policy: RoutingPolicy,
  category: RoutingCategory,
): { scope: RoutingCategory | "global"; route: RoutePolicy } | null {
  const own = policy.categories[category];
  if (own !== undefined) return { scope: category, route: own };
  if (policy.global !== null) return { scope: "global", route: policy.global };
  return null;
}

export function effectiveWeight(
  mode: RouterMode,
  candidate: RouteCandidate,
): number {
  return mode === "hive-equal" ? 1 : candidate.weight;
}

/** The share of spawns each candidate is configured to receive: its effective weight over the route's total. This is the ONE place that arithmetic lives — the router's inspection and the workspace projection both publish it, and clients render what they are given rather than re-deriving it from stored weights. */
export function routeShares(
  route: RoutePolicy,
): { candidate: RouteCandidate; effectiveWeight: number; share: number }[] {
  const total = route.candidates.reduce(
    (sum, candidate) => sum + effectiveWeight(route.mode, candidate),
    0,
  );
  return route.candidates.map((candidate) => {
    const weight = effectiveWeight(route.mode, candidate);
    return {
      candidate,
      effectiveWeight: weight,
      share: total > 0 ? weight / total : 0,
    };
  });
}

/** The mutations the daemon accepts — the CLI surface maps onto these 1:1. Every mutation carries `expectedRevision`; a stale revision is rejected. "unset" writes or returns to the explicit unconfigured state rather than to any invented automatic answer. */
export const RoutingPolicyMutationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set-provider"),
    expectedRevision: z.number().int().nonnegative(),
    provider: CapabilityProviderSchema,
    state: z.enum(["enabled", "disabled", "unset"]),
  }),
  z.strictObject({
    op: z.literal("set-model"),
    expectedRevision: z.number().int().nonnegative(),
    provider: CapabilityProviderSchema,
    model: ExactModelIdSchema,
    state: z.enum(["enabled", "disabled", "unset"]),
  }),
  z.strictObject({
    op: z.literal("set-effort"),
    expectedRevision: z.number().int().nonnegative(),
    provider: CapabilityProviderSchema,
    model: ExactModelIdSchema,
    effort: z.union([EffortTargetSchema, z.literal("unset")]),
  }),
  z.strictObject({
    op: z.literal("set-route"),
    expectedRevision: z.number().int().nonnegative(),
    scope: z.union([RoutingCategorySchema, z.literal("global")]),
    route: RoutePolicySchema.nullable(),
  }),
]);
export type RoutingPolicyMutation = z.infer<typeof RoutingPolicyMutationSchema>;

export type PolicyState = "enabled" | "disabled" | "unconfigured";
export type ModelEnablementDecision = boolean | null | { refusal: string };

export function providerPolicyState(
  policy: RoutingPolicy,
  provider: CapabilityProvider,
): PolicyState {
  return policy.providers[provider] ?? "unconfigured";
}

export function modelPolicyState(
  policy: RoutingPolicy,
  provider: CapabilityProvider,
  model: string,
): { state: PolicyState; source: "provider" | "model" | "none" } {
  const providerState = providerPolicyState(policy, provider);
  if (providerState !== "enabled") {
    return providerState === "disabled"
      ? { state: "disabled", source: "provider" }
      : { state: "unconfigured", source: "none" };
  }
  const row = policy.models.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (row?.state !== undefined) return { state: row.state, source: "model" };
  return { state: "enabled", source: "provider" };
}
