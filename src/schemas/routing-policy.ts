import { z } from "zod";
import { CapabilityProviderSchema, type CapabilityProvider } from "./capability";

/**
 * The user's routing policy — the store behind the Model Control Center and,
 * once the AuthorizedLaunch gate lands, the router's only source of standing
 * preference. Governed by docs/routing/routing-policy.md:
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

export const CODING_TIERS = ["simple", "standard", "complex"] as const;
export const CodingTierSchema = z.enum(CODING_TIERS);
export type CodingTier = z.infer<typeof CodingTierSchema>;

/**
 * Effort intent is explicit: unanswered, Hive-decides, an exact advertised
 * level, a positively absent effort axis, or provider-controlled. The latter
 * omits the flag and lets the vendor decide without claiming to know its
 * default; it is not AUTO.
 */
export const EffortTargetSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("never-configured") }),
  z.strictObject({ mode: z.literal("hive-decides") }),
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
  /** Absent state means the row exists only for effort intent and inherits
   * the provider switch. An explicit model state overrides that inheritance. */
  state: z.enum(["enabled", "disabled"]).optional(),
  /** Explicit even when unanswered: absence must never acquire AUTO meaning. */
  effort: EffortTargetSchema,
});
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/**
 * How a category picks among its chain's ELIGIBLE links (every link still
 * passes the full launch gate first — selection never bypasses a gate):
 *
 * - `never-configured`: the user has not answered; automatic routing refuses.
 * - `auto`: Hive considers every explicitly enabled model whose policy fit
 *   clears the category, then distributes among the capable providers.
 * - `choice`: the category's exact chain is the user's ordered preference.
 */
export const SelectionModeSchema = z.enum([
  "never-configured",
  "auto",
  "choice",
]);
export type SelectionMode = z.infer<typeof SelectionModeSchema>;

export const SelectionPolicySchema = z.strictObject({
  global: SelectionModeSchema,
  categories: z.partialRecord(RoutingCategorySchema, SelectionModeSchema),
});
export type SelectionPolicy = z.infer<typeof SelectionPolicySchema>;

/**
 * The whole policy document. Only EXPLICIT settings appear: an absent provider
 * is unconfigured; under an enabled provider, an absent model state inherits
 * that provider until the user explicitly disables the model.
 */
export const RoutingPolicySchema = z.strictObject({
  schemaVersion: z.literal(2),
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
  selection: SelectionPolicySchema,
}).superRefine((policy, context) => {
  const targets = new Set<string>();
  for (const [index, model] of policy.models.entries()) {
    const target = chainTargetKey(model);
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


/** The document an empty store reads as: revision 0, nothing configured —
 * and "nothing configured" is not "everything permitted". */
export function emptyRoutingPolicy(updatedAt: string): RoutingPolicy {
  return {
    schemaVersion: 2,
    revision: 0,
    updatedAt,
    provisional: false,
    providers: {},
    models: [],
    chains: {},
    selection: { global: "never-configured", categories: {} },
  };
}

/** The mode governing one category: its override, else the global setting. */
export function selectionModeFor(
  policy: RoutingPolicy,
  category: RoutingCategory,
): SelectionMode {
  return policy.selection.categories[category] ?? policy.selection.global;
}

export interface CategoryFitDecision {
  fits: boolean;
  basis: string;
}

/**
 * Policy-authored capability fit. Hive does not infer strength from a model
 * name or provider. An exact chain placement is the user's positive evidence;
 * coding tiers are monotonic, so complex proves standard and simple, while
 * standard proves simple. Other categories require exact membership.
 */
export function modelCategoryFit(
  policy: RoutingPolicy,
  provider: CapabilityProvider,
  model: string,
  category: RoutingCategory,
): CategoryFitDecision {
  const has = (candidate: RoutingCategory): boolean =>
    (policy.chains[candidate] ?? []).some((entry) =>
      entry.provider === provider && entry.model === model
    );
  const label = `${provider}/${model}`;
  if (category === "simple_coding") {
    const evidence = (["complex_coding", "standard_coding", "simple_coding"] as const)
      .find(has);
    return evidence === undefined
      ? { fits: false, basis: `${label} has no explicit coding-tier fit evidence` }
      : { fits: true, basis: `${label} is explicitly placed in ${evidence}` };
  }
  if (category === "standard_coding") {
    const evidence = (["complex_coding", "standard_coding"] as const).find(has);
    return evidence === undefined
      ? { fits: false, basis: `${label} has no standard-or-complex fit evidence` }
      : { fits: true, basis: `${label} is explicitly placed in ${evidence}` };
  }
  if (category === "complex_coding") {
    return has(category)
      ? { fits: true, basis: `${label} is explicitly placed in complex_coding` }
      : { fits: false, basis: `${label} has no explicit complex fit evidence` };
  }
  return has(category)
    ? { fits: true, basis: `${label} is explicitly placed in ${category}` }
    : { fits: false, basis: `${label} has no explicit ${category} fit evidence` };
}

/**
 * The mutations the daemon accepts — the CLI surface maps onto these 1:1.
 * Every mutation carries `expectedRevision`; a stale revision is rejected.
 * "unset" writes or returns to the explicit unconfigured state rather than to
 * any invented automatic answer.
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
  z.strictObject({
    op: z.literal("set-selection"),
    expectedRevision: z.number().int().nonnegative(),
    /** Absent category sets the global mode; "unset" (category only) removes
     * the override so the category follows the global setting again. */
    category: RoutingCategorySchema.optional(),
    mode: z.union([SelectionModeSchema, z.literal("unset")]),
  }).refine((mutation) => !(mutation.category === undefined && mutation.mode === "unset"), {
    message:
      'the global selection mode is always explicit; choose "never-configured", "auto", or "choice"',
  }),
]);
export type RoutingPolicyMutation = z.infer<typeof RoutingPolicyMutationSchema>;

// ---------------------------------------------------------------------------
// Fail-closed reading. THE rule: absence is "unconfigured", a distinct answer
// a consumer must handle — never a synonym for "enabled" and never for
// "allowed to spend".
// ---------------------------------------------------------------------------

export type PolicyState = "enabled" | "disabled" | "unconfigured";
export type ModelEnablementDecision = boolean | null | { refusal: string };

export function providerPolicyState(
  policy: RoutingPolicy,
  provider: CapabilityProvider,
): PolicyState {
  return policy.providers[provider] ?? "unconfigured";
}

/**
 * The effective per-model reading: provider-off overrides everything under
 * it; under an enabled provider, an explicit model row answers next and an
 * absent state inherits the provider. `source` names which row answered, so a
 * UI can show effective-vs-preference without re-deriving the rule.
 */
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
