import { z } from "zod";
import { CapabilityProviderSchema, type CapabilityProvider } from "./capability";

/**
 * The user's routing policy — the store behind the Model Control Center and,
 * once the AuthorizedLaunch gate lands, the router's only source of standing
 * preference. Governed by docs/architecture/router-redesign-recommended.md:
 * chains carry exact (provider, model, effort) targets and nothing else;
 * order is semantic (primary first, a fallback chain, never parallel); a
 * bare "default" string that looks like a model id is illegal, and no legal
 * form expresses "whatever the vendor picks".
 *
 * FAIL-CLOSED READING, the rule every consumer must inherit: an absent row
 * means NOT CONFIGURED, and not-configured never means allowed. The helpers
 * at the bottom are the one implementation of that reading — a consumer that
 * re-derives it by hand is how a null becomes permission again (repo memory:
 * unknown-read-as-permission).
 */

/** Task categories replace tiers (governing doc §2.4). `default` is the
 * user-authored global fallback chain, consulted when a category is empty.
 * `long_context` is deliberately NOT a category — it returns as a requirement
 * modifier on spawn, not as a routing bucket. */
export const ROUTING_CATEGORIES = [
  "light_research",
  "heavy_research",
  "simple_coding",
  "complex_coding",
  "code_review",
  "planning",
  "debugging",
  "summarization",
  "default",
] as const;
export const RoutingCategorySchema = z.enum(ROUTING_CATEGORIES);
export type RoutingCategory = z.infer<typeof RoutingCategorySchema>;

/**
 * Effort, three-valued to match the capability inventory: an exact advertised
 * level, an explicit "this model has no effort axis" (the vendor's statement,
 * never Hive's inference), or provider-controlled — omit the flag and let the
 * vendor decide, without ever claiming to know what its default is.
 */
export const EffortTargetSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("exact"), value: z.string().min(1) }),
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("provider-controlled") }),
]);
export type EffortTarget = z.infer<typeof EffortTargetSchema>;

/** A model id that could be mistaken for a routing instruction is refused
 * outright: quiet defaults return the moment "default" parses as a model. */
const ExactModelIdSchema = z.string().min(1).refine(
  (model) => model !== "default",
  {
    message:
      'a chain names the specific model that will run; "default" is not a model',
  },
);

/**
 * One link of a fallback chain: a specific (provider, model, effort). There
 * is deliberately NO other form — no "vendor default", no moving pointer of
 * any kind (user ruling 2026-07-13: "we are specific on the models that we
 * choose"). A default that quietly wins is the defect this store exists to
 * delete, and vendors move their defaults server-side mid-session (memory:
 * vendor-default-model-moves-under-you); an indirection that cannot be
 * written cannot bite.
 */
export const ChainEntrySchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: ExactModelIdSchema,
  effort: EffortTargetSchema,
});
export type ChainEntry = z.infer<typeof ChainEntrySchema>;

const chainTargetKey = (entry: ChainEntry): string =>
  `${entry.provider}\0${entry.model}`;

/** An ordered fallback chain: index 0 is the primary. Duplicate targets are
 * rejected — a chain that names the same model twice is a reorder bug, not a
 * preference. */
export const RoutingChainSchema = z.array(ChainEntrySchema).refine(
  (entries) => new Set(entries.map(chainTargetKey)).size === entries.length,
  { message: "a chain must not name the same target twice" },
);

export const ModelPolicySchema = z.strictObject({
  provider: CapabilityProviderSchema,
  model: ExactModelIdSchema,
  /** Absent state means the row exists only for its effort; enablement then
   * still inherits from the provider (or stays unconfigured). Choosing an
   * effort must never bless a model as a side effect. */
  state: z.enum(["enabled", "disabled"]).optional(),
  /** The user's standing effort choice for this model, if they made one. */
  effort: EffortTargetSchema.optional(),
}).refine((row) => row.state !== undefined || row.effort !== undefined, {
  message:
    "a model row must carry a state or an effort; an empty row is deleted, not stored",
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/**
 * The whole policy document. Only EXPLICIT settings appear: a provider or
 * model with no entry is unconfigured, and the reading helpers below say so
 * rather than inventing a state.
 */
export const RoutingPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Monotonic; every accepted mutation increments it. Writers must present
   * the revision they read (compare-and-set) so concurrent edits conflict
   * loudly instead of clobbering silently. */
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime({ offset: true }),
  /** True while the document is still the seeded baseline no human has
   * edited. Any accepted mutation clears it permanently — it is the UI's
   * "provisional Hive suggestions, edit anytime" banner flag. */
  provisional: z.boolean(),
  providers: z.partialRecord(
    CapabilityProviderSchema,
    z.enum(["enabled", "disabled"]),
  ),
  models: z.array(ModelPolicySchema),
  chains: z.partialRecord(RoutingCategorySchema, RoutingChainSchema),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

/** The document an empty store reads as: revision 0, nothing configured —
 * and "nothing configured" is not "everything permitted". */
export function emptyRoutingPolicy(updatedAt: string): RoutingPolicy {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt,
    provisional: false,
    providers: {},
    models: [],
    chains: {},
  };
}

/**
 * The mutations the daemon accepts — the CLI surface maps onto these 1:1.
 * Every mutation carries `expectedRevision`; a stale revision is rejected.
 * "unset" deletes the row, returning the subject to the inherited /
 * unconfigured state rather than to any invented one.
 */
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
    op: z.literal("set-chain"),
    expectedRevision: z.number().int().nonnegative(),
    category: RoutingCategorySchema,
    entries: RoutingChainSchema,
  }),
]);
export type RoutingPolicyMutation = z.infer<typeof RoutingPolicyMutationSchema>;

// ---------------------------------------------------------------------------
// Fail-closed reading. THE rule: absence is "unconfigured", a distinct answer
// a consumer must handle — never a synonym for "enabled" and never for
// "allowed to spend".
// ---------------------------------------------------------------------------

export type PolicyState = "enabled" | "disabled" | "unconfigured";

export function providerPolicyState(
  policy: RoutingPolicy,
  provider: CapabilityProvider,
): PolicyState {
  return policy.providers[provider] ?? "unconfigured";
}

/**
 * The effective per-model reading: provider-off overrides everything under
 * it; an absent model row inherits the provider's explicit state; absent
 * both is unconfigured. `source` names which row answered, so a UI can show
 * effective-vs-preference without re-deriving the rule.
 */
export function modelPolicyState(
  policy: RoutingPolicy,
  provider: CapabilityProvider,
  model: string,
): { state: PolicyState; source: "provider" | "model" | "none" } {
  const providerState = providerPolicyState(policy, provider);
  if (providerState === "disabled") {
    return { state: "disabled", source: "provider" };
  }
  const row = policy.models.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (row?.state !== undefined) return { state: row.state, source: "model" };
  if (providerState === "enabled") return { state: "enabled", source: "provider" };
  return { state: "unconfigured", source: "none" };
}
