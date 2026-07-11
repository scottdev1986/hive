import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Capability records: what the providers themselves say about the models an
 * account can launch.
 *
 * A record holds only discovered facts, read from a signed-in CLI at runtime for
 * free. Nothing here is judgment: no record says which model should carry a
 * coding tier, how good a model is, or what a turn will cost. That is the
 * manifest's job, and keeping the two apart is the point of this file.
 *
 * Three rules from the vendor-surfaces research govern every field below.
 *
 * **Presence is positive evidence; absence is unknown.** Claude's menu omits
 * aliases that launch fine (`best`, bare `claude-opus-4-8`), so no absence
 * anywhere is proof of impossibility. A field the provider did not send is
 * `unknown`, never `false` and never a shipped default.
 *
 * **Vendor-hidden entries are not Hive's to route.** An entry the vendor flags
 * hidden is excluded from automatic selection even when a stale manifest still
 * lists it.
 *
 * **A model name is three facts, not one.** The record keeps the launch token
 * (what `--model` receives), the canonical id (the join key for quota pools and
 * the manifest), and the variant (`[1m]` names a context-window entitlement the
 * CLI appends and the launch flag must never receive).
 */

export const CapabilityProviderSchema = z.enum(["claude", "codex"]);
export type CapabilityProvider = z.infer<typeof CapabilityProviderSchema>;

/**
 * The exact surface a fact was read from. Provenance is per field, not per
 * record, because one record is assembled from more than one read and the two
 * providers do not answer the same questions: merging them into an
 * undifferentiated "model record" is how an API price ends up masquerading as
 * subscription burn.
 */
export const CapabilitySurfaceSchema = z.enum([
  /** Claude Code's stream-json control `initialize` response, `models[]`. */
  "claude.initialize",
  /** The Codex app-server's `model/list` reply. */
  "codex.model/list",
]);
export type CapabilitySurface = z.infer<typeof CapabilitySurfaceSchema>;

/**
 * Why a fact has no value. These are three different things and are never
 * collapsed into one null:
 *
 * - `field-absent` — the surface answered for this model and simply did not
 *   carry the field. Claude's Haiku entry omits every effort field. Omission may
 *   mean unsupported, rollout-gated, or missing from this protocol version, and
 *   the record must not choose between those on the provider's behalf.
 * - `surface-silent` — this surface carries the field for *no* model, so its
 *   absence says nothing about this one. Claude's menu has no `hidden` flag at
 *   all; Codex's `model/list` has no `supportsEffort` boolean at all.
 * - `malformed` — the field was present but not the shape the protocol
 *   documents. A payload we cannot parse is not a payload that said `false`.
 */
export const CapabilityUnknownReasonSchema = z.enum([
  "field-absent",
  "surface-silent",
  "malformed",
]);
export type CapabilityUnknownReason = z.infer<
  typeof CapabilityUnknownReasonSchema
>;

/**
 * One discovered fact, carrying where it came from and when. A consumer must
 * branch on `state` to read a value, so there is no way to accidentally treat an
 * undiscovered field as a real one — the type makes the guess impossible rather
 * than merely discouraged.
 */
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

const discovered = <T extends z.ZodType>(value: T) =>
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

/**
 * Read a discovered fact, or fall back. The fallback is always the caller's own
 * explicit choice at the call site — there is no default hidden in here.
 */
export const valueOr = <T>(fact: Discovered<T>, fallback: T): T =>
  fact.state === "known" ? fact.value : fallback;

/**
 * Effort levels are stored as the raw strings the vendor sent, never as a Hive
 * enum. A strict enum at the ingestion boundary recreates the release dependency
 * this whole design exists to remove: codex 0.144.1 already advertises `max` and
 * `ultra`, which Hive's shipped schemas do not know, while no live model
 * advertises Hive's `minimal`. An unknown future string must survive ingestion
 * and persistence intact so a critical restart can replay it.
 */
export const EffortLevelSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/);

export const CapabilityRecordSchema = z.strictObject({
  // --- Identity. Together these form the record's key. ---
  provider: CapabilityProviderSchema,
  /**
   * A non-PII hash of the signed-in account. Entitlement and the alias menu are
   * facts about an account, not about a model, so the account belongs in the
   * key — but the raw handshake carries the user's email and organization, which
   * a routing store has no business retaining.
   */
  accountFingerprint: z.string().min(1),
  /**
   * The CLI build the catalog was read from. A catalog read from claude 2.1.207
   * is not a claim about 2.2's, and an upgrade must not silently overwrite the
   * pre-upgrade truth it will be compared against.
   */
  cliVersion: z.string().min(1),
  /** The stable id: the join key for quota pools and for the manifest. */
  canonicalId: z.string().min(1),
  /**
   * A context-window entitlement the CLI appends to a name (`1m` from
   * `claude-opus-4-8[1m]`). It is a real fact about what the account gets, so it
   * is stored — and it is never launched, because `--model` rejects it.
   */
  variant: z.string().min(1).nullable(),
  /** What `--model` actually receives. Never carries the variant. */
  launchToken: z.string().min(1),
  /** Every other name this model answers to on this account's menu. */
  aliases: z.array(z.string().min(1)),

  // --- Discovered facts, each stamped with its own surface and time. ---
  // No display name lives here. It is a real discovered fact, but nothing in
  // this layer reads it, and the quota ledger already derives its own
  // display-name → id catalog (`ModelCatalogEntry` in quota-sources.ts) for the
  // pool join. A second copy would be a field with no reader and a second name
  // to disagree with the first. Add it when something needs it.
  /**
   * That the account can use this model. Derived from presence in an
   * account-scoped catalog, which is the only evidence either vendor offers:
   * neither returns an entitlement boolean. It is therefore never `known: false`
   * — a model the account cannot use is absent from the menu, and absence
   * produces no record at all rather than a record saying "not entitled".
   */
  entitled: discovered(z.boolean()),
  /** The vendor's own "internal, do not offer this" flag. */
  hidden: discovered(z.boolean()),
  /**
   * The vendor's `supportsEffort` boolean and its list of levels are stored as
   * the two separate fields the vendor sent, never merged into one. A merged
   * field collapses "advertised unsupported", "field omitted", and "malformed
   * payload" into a single null, and those are three different facts.
   */
  supportsEffort: discovered(z.boolean()),
  supportedEffortLevels: discovered(z.array(EffortLevelSchema)),
  /** The effort the vendor recommends for this model. */
  defaultEffort: discovered(EffortLevelSchema),

  /** When the catalog this record was built from was read. */
  observedAt: z.iso.datetime({ offset: true }),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;

/**
 * The record's identity: provider, account, CLI build, and the model's canonical
 * id *with* its variant. The variant is part of the key because a 1M-context
 * entitlement is a different thing to route than the 200k one of the same name.
 */
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

/**
 * A stable, non-reversible account key. The raw identifiers (email, org) are
 * hashed and never stored: Hive needs to tell two accounts apart, not to know
 * who they are. The provider is mixed in so the same address on two vendors does
 * not collide.
 */
export const fingerprintAccount = (
  provider: CapabilityProvider,
  identifiers: readonly (string | null | undefined)[],
): string => {
  const material = identifiers
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .map((part) => part.trim().toLowerCase());
  if (material.length === 0) return `${provider}:unidentified`;
  return createHash("sha256")
    .update([provider, ...material].join("\0"))
    .digest("hex")
    .slice(0, 16);
};

/**
 * The CLI appends `[1m]` to name a context-window variant. It can appear on the
 * menu's `value`, on its `resolvedModel`, or on both — Claude 2.1.207 sends
 * `opus[1m]` → `claude-opus-4-8[1m]` but `claude-fable-5[1m]` → `claude-fable-5`.
 */
const VARIANT_PATTERN = /\[([^\]]+)\]$/;

export const splitVariant = (
  name: string,
): { base: string; variant: string | null } => {
  const match = VARIANT_PATTERN.exec(name);
  if (match === null) return { base: name, variant: null };
  return { base: name.slice(0, match.index), variant: match[1]! };
};

/**
 * Whether a record is fresh enough to *derive* a route from.
 *
 * A stale record still supports validation — it remains the best evidence Hive
 * has about what a model accepts, and rejecting a launch because the catalog is
 * old would turn a discovery hiccup into an outage. It no longer supports
 * derivation: choosing a model from a catalog that may have changed is exactly
 * the silent guess this design exists to prevent. Callers that derive must check
 * this; callers that validate must name the staleness in their warning instead.
 */
export const capabilityFreshness = (
  record: Pick<CapabilityRecord, "observedAt">,
  ttlMinutes: number,
  now: Date = new Date(),
): "fresh" | "stale" => {
  const observed = new Date(record.observedAt).getTime();
  if (Number.isNaN(observed)) return "stale";
  const ageMinutes = (now.getTime() - observed) / 60_000;
  return ageMinutes <= ttlMinutes ? "fresh" : "stale";
};
