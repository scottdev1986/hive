import { z } from "zod";
import { capabilityFreshness, type CapabilityRecord } from "./capability";
import {
  FABLE_AUTO_ROUTING_CUTOFF,
  RoutingTierSchema,
  type RoutingTier,
} from "./routing";

export const TaskKindSchema = z.enum([
  "coding",
  "review",
  "research",
  "mechanical",
]);

export type TaskKind = z.infer<typeof TaskKindSchema>;

const TimestampSchema = z.string().datetime({ offset: true });

export const RoutingManifestCandidateSchema = z.looseObject({
  canonicalId: z.string().min(1),
  autoRoute: z.boolean().default(true),
  validFrom: TimestampSchema.optional(),
  validUntil: TimestampSchema.optional(),
}).refine(
  ({ validFrom, validUntil }) =>
    validFrom === undefined || validUntil === undefined ||
    Date.parse(validFrom) < Date.parse(validUntil),
  { message: "validFrom must precede validUntil" },
);

export type RoutingManifestCandidate = z.infer<
  typeof RoutingManifestCandidateSchema
>;

const CandidateListSchema = z.array(RoutingManifestCandidateSchema).min(1);

export const RoutingManifestTierSchema = z.looseObject({
  preferredProvider: z.enum(["claude", "codex"]),
  claude: CandidateListSchema,
  codex: CandidateListSchema,
  /**
   * The tier's effort default: the knob that makes a cheap tier actually reason
   * cheaply. It is a raw vendor string, validated against the *resolved* model's
   * advertised levels rather than a Hive enum, and it is optional because no
   * manifest should ship one yet: nothing measures whether an effort step pays
   * for itself, so automatic effort stays at the provider's default until
   * effort-sensitive telemetry exists to justify anything else.
   */
  defaultEffort: z.string().min(1).optional(),
});

export type RoutingManifestTier = z.infer<typeof RoutingManifestTierSchema>;

export const RoutingManifestModelSchema = z.looseObject({
  codingCapable: z.looseObject({
    value: z.boolean(),
    provenance: z.looseObject({
      source: z.string().min(1),
      declaredAt: TimestampSchema,
    }),
  }).optional(),
});

export type RoutingManifestModel = z.infer<typeof RoutingManifestModelSchema>;

export const RoutingManifestAliasSchema = z.looseObject({
  provider: z.enum(["claude", "codex"]),
  alias: z.string().min(1),
  canonicalId: z.string().min(1),
  provenance: z.looseObject({
    source: z.string().min(1),
    observedAt: TimestampSchema,
  }),
});

export type RoutingManifestAlias = z.infer<
  typeof RoutingManifestAliasSchema
>;

export const RoutingManifestSchema = z.looseObject({
  schema: z.looseObject({
    major: z.literal(1),
    minor: z.number().int().nonnegative(),
  }),
  revision: z.string().min(1),
  publishedAt: TimestampSchema,
  validUntil: TimestampSchema,
  models: z.record(z.string().min(1), RoutingManifestModelSchema),
  aliases: z.array(RoutingManifestAliasSchema),
  tiers: z.record(RoutingTierSchema, RoutingManifestTierSchema),
});

export type RoutingManifest = z.infer<typeof RoutingManifestSchema>;

export type ManifestCandidate = {
  record: CapabilityRecord;
  policy: RoutingManifestCandidate;
};

function activeAt(candidate: RoutingManifestCandidate, now: Date): boolean {
  const time = now.getTime();
  return (
    (candidate.validFrom === undefined ||
      time >= Date.parse(candidate.validFrom)) &&
    (candidate.validUntil === undefined ||
      time < Date.parse(candidate.validUntil))
  );
}

export function kindRequiresCodingCapability(kind: TaskKind): boolean {
  return kind === "coding" || kind === "review";
}

export function defaultTaskKind(tier: RoutingTier): TaskKind {
  return tier === "review" ? "review" : "coding";
}

export function manifestAlias(
  manifest: RoutingManifest,
  provider: CapabilityRecord["provider"],
  alias: string,
): RoutingManifestAlias | undefined {
  return manifest.aliases.find(
    (entry) => entry.provider === provider && entry.alias === alias,
  );
}

/**
 * Intersect one ordered manifest list with fresh discovery records. This is
 * deliberately inert: callers can shadow the result, but live routing does not
 * consult it until the signed-manifest migration gate is complete.
 */
export function manifestCandidates(
  manifest: RoutingManifest,
  tier: RoutingTier,
  provider: CapabilityRecord["provider"],
  kind: TaskKind,
  records: readonly CapabilityRecord[],
  now: Date,
  freshnessMinutes: number,
): ManifestCandidate[] {
  if (now.getTime() >= Date.parse(manifest.validUntil)) return [];

  const recordsById = new Map(
    records
      .filter((record) => record.provider === provider)
      .map((record) => [record.canonicalId, record]),
  );
  const candidates = manifest.tiers[tier][provider].flatMap((policy) => {
    const record = recordsById.get(policy.canonicalId);
    if (record === undefined || !activeAt(policy, now)) return [];
    const codingCapable = manifest.models[policy.canonicalId]?.codingCapable;
    if (kindRequiresCodingCapability(kind) && codingCapable?.value !== true) {
      return [];
    }
    if (record.entitled.state !== "known" || !record.entitled.value) return [];
    if (record.hidden.state === "known" && record.hidden.value) return [];
    if (capabilityFreshness(record, freshnessMinutes, now) === "stale") {
      return [];
    }
    return [{ record, policy }];
  });

  const primaryIndex = candidates.findIndex(({ policy }) => policy.autoRoute);
  return primaryIndex === -1 ? [] : candidates.slice(primaryIndex);
}

export const FIRST_ROUTING_MANIFEST: RoutingManifest =
  RoutingManifestSchema.parse({
    schema: { major: 1, minor: 0 },
    revision: "initial",
    publishedAt: "2026-07-11T00:00:00Z",
    validUntil: "2026-08-11T00:00:00Z",
    models: Object.fromEntries(
      [
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
        "gpt-5.6-sol",
      ].map((canonicalId) => [canonicalId, {
        codingCapable: {
          value: true,
          provenance: {
            source: "docs/research/model-routing-and-token-efficiency.md",
            declaredAt: "2026-07-11T00:00:00Z",
          },
        },
      }]),
    ),
    aliases: [
      {
        provider: "claude",
        alias: "best",
        canonicalId: "claude-fable-5",
        provenance: {
          source: "live-cli-billing-probe",
          observedAt: "2026-07-09T00:00:00Z",
        },
      },
      {
        provider: "claude",
        alias: "sonnet",
        canonicalId: "claude-sonnet-5",
        provenance: {
          source: "claude-initialize",
          observedAt: "2026-07-11T00:00:00Z",
        },
      },
      {
        provider: "claude",
        alias: "haiku",
        canonicalId: "claude-haiku-4-5-20251001",
        provenance: {
          source: "claude-initialize",
          observedAt: "2026-07-11T00:00:00Z",
        },
      },
      {
        provider: "codex",
        alias: "default",
        canonicalId: "gpt-5.6-sol",
        provenance: {
          source: "codex-config-read",
          observedAt: "2026-07-11T00:00:00Z",
        },
      },
    ],
    tiers: {
      deep: {
        preferredProvider: "claude",
        claude: [
          {
            canonicalId: "claude-fable-5",
            // The Fable auto-routing cutoff, as *data* rather than as a branch in
            // the code — which is the whole point of the effective window, and
            // the design's own example of one. Without this the manifest would go
            // on deriving Fable for the deep tier after the shipped table had
            // stopped, and shadow mode caught exactly that divergence minutes
            // after the cutoff passed: a derived route that, had it governed,
            // would have kept sending deep spawns to a model that moved to
            // usage-only billing off the user's plan.
            //
            // It reads the same constant the shipped table branches on, so the
            // two cannot disagree about the date. When the constant is retired,
            // this becomes a literal and nothing else changes.
            validUntil: FABLE_AUTO_ROUTING_CUTOFF,
          },
          { canonicalId: "claude-opus-4-8" },
        ],
        codex: [{ canonicalId: "gpt-5.6-sol" }],
      },
      standard: {
        preferredProvider: "codex",
        claude: [{ canonicalId: "claude-sonnet-5" }],
        codex: [{ canonicalId: "gpt-5.6-sol" }],
      },
      cheap: {
        preferredProvider: "codex",
        claude: [
          {
            canonicalId: "claude-haiku-4-5-20251001",
          },
        ],
        codex: [{ canonicalId: "gpt-5.6-sol" }],
      },
      review: {
        preferredProvider: "claude",
        claude: [{ canonicalId: "claude-sonnet-5" }],
        codex: [{ canonicalId: "gpt-5.6-sol" }],
      },
    },
  });
