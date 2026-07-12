import { z } from "zod";
import {
  applyFitPolicy,
  CODING_SCORE_COLUMN,
  type FitBenchmarkRow,
} from "./fit-policy";
import {
  CAPABILITY_PROVIDERS,
  capabilityFreshness,
  CapabilityProviderSchema,
  splitVariant,
  type CapabilityProvider,
  type CapabilityRecord,
  type EffectiveDefault,
} from "./capability";
import {
  poolAvailability,
  spendRisk,
  type AccountBillings,
} from "../daemon/usage-credits";
import {
  defaultTaskKind,
  kindRequiresCodingCapability,
  RoutingTierSchema,
  type RoutingTier,
  type TaskKind,
} from "./routing";

/**
 * The derivation engine: tier → concrete route, from sources that exist at
 * runtime and nowhere else.
 *
 *   user pin (routing.toml, format unchanged, always wins)
 *     → derived route (the vendor's own effective default, vouched by a fresh
 *       live capability record)
 *       → last-known-good derivation (replayed past its TTL, loudly)
 *         → REFUSAL, naming the vendor CLI Hive needs
 *
 * **The binary names no model.** The compiled manifest, the shipped alias
 * table, and the model-name constants were removed as route sources by the
 * user's directive (2026-07-12): routes derive from live discovery, the user's
 * own policy, and the benchmark surface once he activates it — nothing else.
 * The one vendor-declared rank Hive may pass through is the account's own
 * effective default (what an unflagged launch runs, read from `config/read` /
 * the menu's `default` entry): that is the vendor's judgment about the
 * account, reported rather than formed. Where no source can author a route,
 * the cell is a refusal with the reason, and the spawn path refuses with it —
 * never a fall to a baked-in list, because there is no baked-in list to fall
 * to.
 *
 * What DOES ship is policy that names no model: which vendor a tier prefers,
 * and what effort a tier reasons at. Task classification is Hive's to default
 * and the user's to override; model knowledge is neither.
 *
 * Every value carries the layer that authored it, per field rather than per
 * cell, because `routing.toml` merges per field: one cell's tool, model, and
 * effort routinely have three different authors. A field nobody could author
 * is `null` with the reason it is unknown. No rung is silent.
 */

export const ROUTING_TIERS = RoutingTierSchema.options;

/**
 * How old a capability record may be and still support *derivation*. Validation
 * accepts an older one (it remains the best evidence Hive has about what a model
 * accepts); choosing a model out of a catalog that may have changed is the silent
 * guess this design exists to prevent.
 */
export const DERIVATION_TTL_MINUTES = 60;

/**
 * The tier policies Hive ships: which vendor a tier prefers, and the effort it
 * reasons at. POLICY, not model knowledge — no model is named, and both are
 * user-overridable per cell in `routing.toml`. The effort is passed only when
 * the resolved model's live record advertises that exact level (the gate in
 * `resolveEffort`); the vendor's own per-model default may inform a human
 * editing this policy but never silently governs a derived cell.
 */
export const TIER_PREFERRED_TOOL: Record<RoutingTier, CapabilityProvider> = {
  deep: "claude",
  standard: "codex",
  cheap: "codex",
  review: "claude",
};

export const TIER_EFFORT_POLICY: Record<RoutingTier, string> = {
  deep: "high",
  standard: "medium",
  cheap: "low",
  review: "medium",
};

export type ResolutionLayer =
  /** A `routing.toml` entry. A standing user directive: it wins, always. */
  | "pinned"
  /** Derived at runtime: the vendor's effective default vouched by a fresh
   * record, or a shipped POLICY value (tool, effort) that names no model. */
  | "derived"
  /** The last non-empty derivation, replayed past its TTL. Guards discovery
   * outages: a provider being down must not erase what the last healthy run
   * learned. */
  | "ladder:last-known-good"
  /** No source could author this field. The value is `null` and stays `null`,
   * and the spawn path REFUSES rather than guessing. */
  | "unknown";

export interface Resolved<T> {
  /** `null` means unknown. It never means "false", "none", or "the default". */
  value: T | null;
  layer: ResolutionLayer;
  /** Why this layer, in the words the inspection surface prints verbatim. */
  reason: string;
}

// --------------------------------------------------------------------------
// Inputs.
// --------------------------------------------------------------------------

/**
 * The user's pins, read from `routing.toml`. The one hand-authored route
 * source, and the only one that outranks derivation.
 */
export const RoutingPinSchema = z.looseObject({
  tool: CapabilityProviderSchema.optional(),
  claude: z.looseObject({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }).optional(),
  codex: z.looseObject({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }).optional(),
  grok: z.looseObject({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }).optional(),
});

// Keyed by a plain string, not by the tier enum: a `z.record` over an enum
// demands every key, and pinning one tier is the normal case. Unknown tier
// names are rejected by `loadRoutingPins`, which checks the keys explicitly —
// a misspelled tier must not silently pin nothing.
export const RoutingPinsSchema = z.record(z.string().min(1), RoutingPinSchema);
export type RoutingPins = z.infer<typeof RoutingPinsSchema>;

/**
 * The user's capability floors, read from `routing.toml`'s `[floors]` table.
 * A standing structural rule (rule B), never a standing model choice: it
 * says nothing below the user's allow-listed models may route for building
 * work, but which models clear that bar is the user's CURRENT setting, not
 * durable truth — it is expected to change as the model lineup does. An
 * explicit allowlist per vendor, not a rank Hive invents: the router matches
 * ids the user wrote and never judges model quality itself (no-model-judgment
 * ruling). The binary ships this schema and its enforcement only — no floor
 * value is ever compiled in, and none is pre-filled: unset by default, and it
 * stays that way until the user writes one.
 */
export const RoutingFloorSchema = z.strictObject({
  allow: z.array(z.string().min(1)).min(1),
  /** The user's own note on why this floor is set — never read by the
   * enforcement logic, purely for their future reference. */
  note: z.string().min(1).optional(),
});
export type RoutingFloor = z.infer<typeof RoutingFloorSchema>;

export const RoutingFloorsSchema = z.strictObject({
  claude: RoutingFloorSchema.optional(),
  codex: RoutingFloorSchema.optional(),
  grok: RoutingFloorSchema.optional(),
});
export type RoutingFloors = z.infer<typeof RoutingFloorsSchema>;

/**
 * The one tier the building floor does not bind. The user's rule is that the
 * simplest work goes to haiku-class models, so `cheap` is exempt by design.
 */
export function tierIsFloorBound(tier: RoutingTier): boolean {
  return tier !== "cheap";
}

/** The provenance stamp on a snapshot cell. `manifestRevision` predates the
 * manifest's removal; the field name survives so snapshots already on disk
 * keep parsing, and new writes stamp the deriving source (`"discovery"`). */
const SnapshotProvenanceSchema = {
  derivedAt: z.iso.datetime({ offset: true }),
  manifestRevision: z.string().min(1),
};

/** What a fresh derivation stamps into `manifestRevision` today. */
export const DERIVED_FROM_DISCOVERY = "discovery";

const SnapshotCellSchema = z.strictObject({
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
  ...SnapshotProvenanceSchema,
});

const SnapshotToolSchema = z.strictObject({
  value: CapabilityProviderSchema,
  ...SnapshotProvenanceSchema,
});

/**
 * Rung 1: the last non-empty derivation, per cell.
 *
 * Two properties this shape exists to guarantee. **Only genuinely derived cells
 * are recorded** — replaying a pin as "last-known-good derived" would credit the
 * user's choice to the engine. And **each cell carries its own age**, because a
 * run where one provider was down must not erase what the last healthy run
 * learned about it: the surviving cells are carried forward, and a
 * carried-forward cell reports the age it actually has. A memory a single bad
 * run can wipe is not a memory, and without this rung a discovery outage would
 * fall straight through to refusal.
 */
export const RoutingSnapshotSchema = z.strictObject({
  // Partial by construction: a tier whose cells were all pinned or laddered has
  // nothing derived to remember, and gets no entry.
  tiers: z.record(
    z.string().min(1),
    z.strictObject({
      tool: SnapshotToolSchema.nullable(),
      claude: SnapshotCellSchema.nullable(),
      codex: SnapshotCellSchema.nullable(),
      grok: SnapshotCellSchema.nullable().default(null),
    }),
  ),
});
export type RoutingSnapshot = z.infer<typeof RoutingSnapshotSchema>;

/**
 * One provider's discovery result. Structurally the daemon's
 * `CapabilityDiscoveryResult`, restated here so the schema layer does not import
 * the transport layer.
 */
export type ProviderDiscovery =
  | {
    status: "ok";
    records: CapabilityRecord[];
    effectiveDefault: EffectiveDefault;
  }
  | { status: "unavailable"; reason: string };

/**
 * Which vendor a model belongs to — and, when that cannot be established, WHY.
 *
 * The three states are not decoration. Hive used to answer this question by
 * regex over the model's spelling (`/^claude([-.]|$)/`, `/^(gpt|codex)/`) and
 * return null for anything it could not place — and both callers read that
 * null as PERMISSION. A model no pattern recognised was allowed onto whatever
 * tool the router had picked, and its spend was billed to whatever meter it
 * was handed. Unknown read as yes, which is how a vendor's model ends up in
 * another vendor's TUI and another vendor's pool.
 *
 * A model's vendor is a FACT the vendor itself publishes, so it is read from
 * the discovered catalog, never inferred from the name. And "nobody claims
 * it" (every catalog was read; none lists this model — a measurement, and
 * grounds to refuse) is kept strictly apart from "I could not read the
 * catalogs" (no evidence either way — which must say so, and must never be
 * quietly converted into either a yes or a no).
 */
export type ModelVendorVerdict =
  | { state: "claimed"; provider: CapabilityProvider }
  | { state: "unclaimed" }
  | { state: "unreadable"; reason: string };

/** Identify a model against live discovery: launch token, canonical id, or any
 * alias the vendor publishes (`best`, `default` — real aliases that no name
 * pattern could ever place). */
export function identifyModelVendor(
  model: string,
  discovery: Partial<Record<CapabilityProvider, ProviderDiscovery | undefined>>,
): ModelVendorVerdict {
  const wanted = splitVariant(model.trim()).base.toLowerCase();
  const claims: CapabilityProvider[] = [];
  const unread: CapabilityProvider[] = [];
  for (const provider of CAPABILITY_PROVIDERS) {
    const entry = discovery[provider];
    if (entry === undefined || entry.status !== "ok") {
      unread.push(provider);
      continue;
    }
    const claimed = entry.records.some((record) =>
      record.launchToken.toLowerCase() === wanted ||
      record.canonicalId.toLowerCase() === wanted ||
      record.aliases.some((alias) => alias.toLowerCase() === wanted)
    );
    if (claimed) claims.push(provider);
  }
  if (claims.length === 1) return { state: "claimed", provider: claims[0]! };
  // Two vendors claiming one name is not an answer, it is a collision. Saying
  // "unreadable" keeps it from being resolved by whichever happened to be first.
  if (claims.length > 1) {
    return {
      state: "unreadable",
      reason: `${claims.join(" and ")} both list ${JSON.stringify(model)}`,
    };
  }
  if (unread.length > 0) {
    return {
      state: "unreadable",
      reason: `no model catalog could be read for ${unread.join(" or ")}`,
    };
  }
  return { state: "unclaimed" };
}

export interface DerivationInput {
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  pins: RoutingPins;
  /**
   * The user's capability floors (`routing.toml` `[floors]`). Missing means no
   * floor is configured for that vendor — the derivation runs exactly as it
   * did before floors existed. Applied after pins, per the ruled order (pins
   * → capability floors → user policy → benchmark ordering → quota).
   */
  floors?: RoutingFloors;
  snapshot: RoutingSnapshot | null;
  /**
   * Published benchmark rows keyed `${provider}\0${canonicalId}`, from the
   * approved source catalog. Ordering evidence ONLY (the adopted fit policy,
   * docs/benchmark-fit-policy-proposal.md): it can reorder eligible candidates
   * and pick a lower sufficient effort, and has no code path by which to add,
   * remove, or veto a candidate. Missing means no benchmark influence at all —
   * absence of data never gates a route.
   */
  benchmarks?: ReadonlyMap<string, FitBenchmarkRow[]>;
  /**
   * What this account is actually charged, measured per provider. Missing means
   * Hive could not read it; that provider is not auto-routable on a guess.
   */
  billing: AccountBillings | null;
  /**
   * The user's standing answer to a charge he was asked about. The SUBJECT is
   * the vendor when its billing is unreadable (Hive cannot then ask a per-model
   * question honestly, and a model id is not a stable thing to have answered —
   * the vendor's default can move underneath it); otherwise it is the model's
   * canonical id. See `ConsentSubject` in daemon/cost-consent.
   */
  costConsent?: (subject: string) => "approved" | "denied" | "pending" | "none";
  now: Date;
  ttlMinutes?: number;
}

// --------------------------------------------------------------------------
// Outputs.
// --------------------------------------------------------------------------

export interface DerivedCell {
  provider: CapabilityProvider;
  model: Resolved<string>;
  effort: Resolved<string>;
  /**
   * Eligible candidates after the primary: the downshift chain quota ranks
   * under pressure at spawn time. Empty today — with the manifest gone there
   * is no ordered candidate list until the benchmark surface or user policy
   * supplies one — and kept in the shape so that list has somewhere vetted to
   * arrive.
   */
  chain: string[];
  /** Conflicts named out loud. A disagreement Hive resolved silently is a lie. */
  notes: string[];
}

export interface DerivedTier {
  tier: RoutingTier;
  kind: TaskKind;
  tool: Resolved<CapabilityProvider>;
  claude: DerivedCell;
  codex: DerivedCell;
  grok: DerivedCell;
}

export interface DerivedRouting {
  derivedAt: string;
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  tiers: DerivedTier[];
  /** Deduplicated, and loud: which rung failed, and why. */
  warnings: string[];
  /**
   * Models the router would have chosen but may not, because running them would
   * spend the user's real money. The caller asks him — through the approvals
   * queue — and never on Hive's own authority.
   */
  consentRequired: { subject: string; detail: string }[];
}

// --------------------------------------------------------------------------
// Derivation.
// --------------------------------------------------------------------------

const ageMinutes = (iso: string, now: Date): number =>
  (now.getTime() - Date.parse(iso)) / 60_000;

export function describeAge(iso: string, now: Date): string {
  const minutes = ageMinutes(iso, now);
  if (Number.isNaN(minutes)) return "age unknown";
  if (minutes < 1) return `${Math.max(0, Math.round(minutes * 60))}s old`;
  if (minutes < 90) return `${Math.round(minutes)}m old`;
  return `${Math.round(minutes / 60)}h old`;
}

export function deriveRouting(input: DerivationInput): DerivedRouting {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  const consentRequired: { subject: string; detail: string }[] = [];
  const needConsent = (subject: string, detail: string): void => {
    if (!consentRequired.some((entry) => entry.subject === subject)) {
      consentRequired.push({ subject, detail });
    }
  };
  const tiers = ROUTING_TIERS.map((tier) =>
    deriveTier(tier, input, warn, needConsent)
  );
  return {
    derivedAt: input.now.toISOString(),
    discovery: input.discovery,
    tiers,
    warnings,
    consentRequired,
  };
}

type ConsentSink = (subject: string, detail: string) => void;

function deriveTier(
  tier: RoutingTier,
  input: DerivationInput,
  warn: (message: string) => void,
  needConsent: ConsentSink,
): DerivedTier {
  const kind = defaultTaskKind(tier);
  return {
    tier,
    kind,
    tool: resolveTool(tier, input),
    claude: deriveCell("claude", tier, kind, input, warn, needConsent),
    codex: deriveCell("codex", tier, kind, input, warn, needConsent),
    grok: deriveCell("grok", tier, kind, input, warn, needConsent),
  };
}

function resolveTool(
  tier: RoutingTier,
  input: DerivationInput,
): Resolved<CapabilityProvider> {
  const pinned = input.pins[tier]?.tool;
  if (pinned !== undefined) {
    return {
      value: pinned,
      layer: "pinned",
      reason: `routing.toml [${tier}].tool`,
    };
  }
  // Vendor preference is shipped POLICY: it names no model, and a pin
  // overrides it per tier. It never falls to unknown — preferring a vendor
  // requires no evidence about any model.
  return {
    value: TIER_PREFERRED_TOOL[tier],
    layer: "derived",
    reason: `tier tool policy (override with routing.toml [${tier}].tool)`,
  };
}

const staleReason = (
  entry: { derivedAt: string; manifestRevision: string },
  input: DerivationInput,
): string =>
  `last derived ${describeAge(entry.derivedAt, input.now)} ` +
  `(source: ${entry.manifestRevision}); stale`;

function deriveCell(
  provider: CapabilityProvider,
  tier: RoutingTier,
  kind: TaskKind,
  input: DerivationInput,
  warn: (message: string) => void,
  needConsent: ConsentSink,
): DerivedCell {
  const notes: string[] = [];
  const discovery = input.discovery[provider];
  const records = discovery.status === "ok" ? discovery.records : [];
  if (discovery.status === "unavailable") {
    notes.push(`${provider} discovery unavailable: ${discovery.reason}`);
  }

  const model = resolveModel(
    provider,
    tier,
    kind,
    input,
    records,
    notes,
    warn,
    needConsent,
  );

  // The record for the model we actually resolved. Effort is validated against
  // *this* model or it is not validated at all.
  const resolvedRecord = model.value === null
    ? undefined
    : records.find((record) =>
      record.launchToken === model.value || record.canonicalId === model.value ||
      record.aliases.includes(model.value!)
    );

  // CONSENT TO ROUTE IS NOT CONSENT TO SPEND. A pin settles the ROUTE and the
  // engine never overrules it — the model below stays exactly what he pinned. But
  // naming a model is not agreeing to be charged for it, so a pinned model that
  // would really cost money still raises the consent request, and the spawn path
  // asks him once. It is NOT excluded: excluding it would be the router overruling
  // the user, which is the one thing a pin exists to prevent.
  if (model.layer === "pinned" && resolvedRecord !== undefined) {
    const refusal = spendGuard(input, resolvedRecord, needConsent);
    if (refusal !== null) notes.push(refusal);
  }

  const effort = resolveEffort(
    provider,
    tier,
    model,
    resolvedRecord,
    input,
    notes,
  );

  return {
    provider,
    model,
    effort: benchmarkFit(provider, kind, model, effort, resolvedRecord, input, notes),
    chain: [],
    notes,
  };
}

/**
 * The adopted fit policy, live in the real derivation (user order 2026-07-12):
 * ordering evidence applied after pins, floors, and policy have resolved the
 * cell, and before quota ranks candidates at spawn. With the candidate list a
 * single model today (`chain` is empty until policy supplies alternatives),
 * its live effect is effort economy — a lower advertised effort measured
 * within the band of the routed one routes instead — plus the evidence basis
 * named in the cell's notes. A pinned effort is the user's and is never moved.
 */
function benchmarkFit(
  provider: CapabilityProvider,
  kind: TaskKind,
  model: Resolved<string>,
  effort: Resolved<string>,
  record: CapabilityRecord | undefined,
  input: DerivationInput,
  notes: string[],
): Resolved<string> {
  if (
    input.benchmarks === undefined || model.value === null ||
    !kindRequiresCodingCapability(kind)
  ) {
    return effort;
  }
  const canonicalId = record?.canonicalId ?? model.value;
  const decision = applyFitPolicy({
    candidates: [{
      token: model.value,
      canonicalId,
      advertisedEfforts:
        record !== undefined && record.supportedEffortLevels.state === "known"
          ? [...record.supportedEffortLevels.value]
          : null,
      rows: input.benchmarks.get(`${provider}\0${canonicalId}`) ?? [],
    }],
    routedEffort: effort.value,
    column: CODING_SCORE_COLUMN,
  });
  notes.push(
    effort.layer === "pinned" && decision.effort !== null
      ? `${decision.detail} — effort is pinned and stays ${effort.value}`
      : decision.detail,
  );
  if (decision.effort === null || effort.layer === "pinned") return effort;
  return {
    value: decision.effort.value,
    layer: "derived",
    reason: decision.effort.basis,
  };
}

/**
 * Does `candidateId` (or its live record, if one exists) appear in the user's
 * floor allowlist? Matched by id only — canonicalId, launchToken, or any
 * alias — never by a rank Hive infers about the model.
 */
function clearsFloor(
  candidateId: string,
  record: CapabilityRecord | undefined,
  allow: readonly string[],
): boolean {
  if (allow.includes(candidateId)) return true;
  if (record === undefined) return false;
  return allow.includes(record.canonicalId) || allow.includes(record.launchToken) ||
    record.aliases.some((alias) => allow.includes(alias));
}

/** The floor bound to this cell, or `null` when none applies: the tier is
 * exempt (`cheap`), or the user has not configured one for this vendor. */
function floorFor(
  provider: CapabilityProvider,
  tier: RoutingTier,
  input: DerivationInput,
): readonly string[] | null {
  if (!tierIsFloorBound(tier)) return null;
  return input.floors?.[provider]?.allow ?? null;
}

function resolveModel(
  provider: CapabilityProvider,
  tier: RoutingTier,
  kind: TaskKind,
  input: DerivationInput,
  records: readonly CapabilityRecord[],
  notes: string[],
  warn: (message: string) => void,
  needConsent: ConsentSink,
): Resolved<string> {
  const allow = floorFor(provider, tier, input);
  // Every candidate the floor excluded, across every rung: if none of them
  // clear it, the cell refuses on THIS, not on the generic discovery message
  // below — the user's own policy is the reason, and it is named as such.
  const floorExcluded: string[] = [];
  // The spend guard's refusal, if it is what emptied this cell. A guard that
  // refuses for reason X must SAY X: refusing an answerable consent question
  // with the generic "install or sign in to the CLI" names a remedy the user
  // has already satisfied and hides the only one that works.
  let consentBlocked: string | null = null;
  const passesFloor = (
    candidateId: string,
    record: CapabilityRecord | undefined,
  ): boolean => {
    if (allow === null) return true;
    if (clearsFloor(candidateId, record, allow)) return true;
    floorExcluded.push(candidateId);
    return false;
  };

  // Layer 1: the pin. A standing user directive about the user's own account
  // — but the capability floor is rule A's "nothing pushes a route below it",
  // unconditional, so it is checked even against a pin (ruled order: pins →
  // capability floors → user policy → benchmark ordering → quota). A pin the
  // floor blocks is not silently obeyed; it falls through to the next rung.
  const pinned = input.pins[tier]?.[provider]?.model;
  if (pinned !== undefined) {
    notePinConflicts(provider, pinned, input, records, notes);
    const pinnedRecord = records.find((entry) =>
      entry.canonicalId === pinned || entry.launchToken === pinned ||
      entry.aliases.includes(pinned)
    );
    if (passesFloor(pinned, pinnedRecord)) {
      // A pin is the user's direct instruction and therefore their consent to run
      // this route. The spend guard governs Hive's automatic choices only.
      return {
        value: pinned,
        layer: "pinned",
        reason: `routing.toml [${tier}.${provider}].model`,
      };
    }
    notes.push(
      `pinned model ${pinned} does not clear the capability floor for ` +
        `${provider} (routing.toml [floors.${provider}].allow: ${
          allow!.join(", ")
        }); the pin is not honoured for ${tier}`,
    );
  }

  // Layer 2: the derived route — the account's own effective default, the one
  // vendor-declared rank Hive passes through. It must be vouched by a FRESH
  // record (a default read off a catalog that may have changed is the silent
  // guess this design exists to prevent), and it must clear availability and
  // the spend guard like any automatic choice.
  const ttl = input.ttlMinutes ?? DERIVATION_TTL_MINUTES;
  const discovery = input.discovery[provider];
  const effective = discovery.status === "ok"
    ? discovery.effectiveDefault
    : undefined;
  if (effective !== undefined && effective.model.state === "known") {
    const value = effective.model.value;
    const record = records.find((entry) =>
      entry.canonicalId === value || entry.launchToken === value ||
      entry.aliases.includes(value)
    );
    if (record === undefined) {
      notes.push(
        `${provider}'s effective default ${value} matches no record in its own ` +
          "catalog; nothing vouches for it, so it is not derived",
      );
    } else if (capabilityFreshness(record, ttl, input.now) === "stale") {
      notes.push(
        `${provider}'s effective default ${value} has only a stale record ` +
          `(${describeAge(record.observedAt, input.now)}); not derived`,
      );
    } else {
      const gone = availabilityRefusal(input, record);
      if (gone !== null) {
        notes.push(gone);
      } else {
        const refusal = spendGuard(input, record, needConsent);
        if (refusal !== null) {
          notes.push(refusal);
          consentBlocked = refusal;
        } else if (!passesFloor(record.launchToken, record)) {
          notes.push(
            `${record.launchToken} does not clear the capability floor for ` +
              `${provider} (routing.toml [floors.${provider}].allow: ${
                allow!.join(", ")
              }); not derived for ${tier}`,
          );
        } else {
          // The capability floor has no declarer yet: the manifest that vouched
          // codingCapable is gone, and neither the benchmark surface nor user
          // policy has replaced it. Saying so per cell is what keeps the floor's
          // absence a visible fact instead of a silent regression. Once the
          // user HAS configured a floor for this vendor, this candidate cleared
          // it above, and that is what's said instead.
          if (kindRequiresCodingCapability(kind)) {
            notes.push(
              allow === null
                ? `no capability evidence for ${record.launchToken} (kind=${kind}): ` +
                  "no benchmark data or user policy vouches for it yet; the " +
                  "vendor's own default is passed through"
                : `${record.launchToken} clears the capability floor for ` +
                  `${provider} (routing.toml [floors.${provider}].allow)`,
            );
          }
          return {
            value: record.launchToken,
            layer: "derived",
            reason: `${provider}'s effective unflagged launch, from ` +
              `${effective.model.surface} ` +
              `(record ${describeAge(record.observedAt, input.now)}, ${record.cliVersion})`,
          };
        }
      }
    }
  }

  // Layer 3: the last-known-good derivation — the guard for discovery outages.
  const snapshotCell = input.snapshot?.tiers[tier]?.[provider];
  if (snapshotCell != null) {
    const snapshotRecord = records.find((entry) =>
      entry.canonicalId === snapshotCell.model ||
      entry.launchToken === snapshotCell.model ||
      entry.aliases.includes(snapshotCell.model)
    );
    if (passesFloor(snapshotCell.model, snapshotRecord)) {
      warn(
        `${tier}.${provider}: derivation is riding the last-known-good snapshot ` +
          `(${describeAge(snapshotCell.derivedAt, input.now)}); ${provider} ` +
          "discovery is not currently supplying a route",
      );
      return {
        value: snapshotCell.model,
        layer: "ladder:last-known-good",
        reason: staleReason(snapshotCell, input),
      };
    }
    notes.push(
      `last-known-good model ${snapshotCell.model} does not clear the ` +
        `capability floor for ${provider} (routing.toml [floors.${provider}` +
        `].allow: ${allow!.join(", ")}); not replayed for ${tier}`,
    );
  }

  // The floor blocked every candidate this cell had. Refuse on THAT, never on
  // the generic discovery message below — the reason is the user's own
  // policy, not a vendor outage, and it is named as such.
  if (floorExcluded.length > 0) {
    const reason = `capability floor blocks ${tier}.${provider}: ${
      floorExcluded.join(", ")
    } excluded (routing.toml [floors.${provider}].allow: ${allow!.join(", ")})`;
    warn(`${tier}.${provider}: NO ROUTE — ${reason}`);
    return { value: null, layer: "unknown", reason };
  }

  // THE CELL IS EMPTY BECAUSE HE HAS NOT ANSWERED, AND THAT IS WHAT IT SAYS.
  // Discovery worked, a default was found, and the only thing standing between
  // him and a route is a question sitting in his own queue. Refusing this with
  // the discovery message below would be a lie — it claims the vendor told Hive
  // nothing usable when in fact it did, and it sends him to reinstall a CLI that
  // is already installed and signed in. A guard refuses for the reason it
  // refused, and it names the remedy that actually works.
  if (consentBlocked !== null) {
    const reason = `${consentBlocked}. Approve it in the approvals queue ` +
      `(hive_approvals / hive_approve) and Hive will route ${tier}.${provider} ` +
      `without asking again; pinning routing.toml [${tier}.${provider}] also ` +
      `counts as your consent`;
    warn(`${tier}.${provider}: NO ROUTE — ${reason}`);
    return { value: null, layer: "unknown", reason };
  }

  // Nothing can author this cell, and nothing is invented: the refusal names
  // what Hive needs. This reaches the user twice — as a warning on every
  // derivation surface, and as the refusal reason when a spawn needs this cell.
  const why = discovery.status === "unavailable"
    ? `${provider} discovery is unavailable (${discovery.reason})`
    : `${provider} discovery answered but declared no usable default`;
  warn(
    `${tier}.${provider}: NO ROUTE — ${why} and no last-known-good derivation ` +
      `exists. Hive ships no model list to fall back on: install or sign in to ` +
      `the ${provider} CLI so Hive can learn what this account may launch, or ` +
      `pin a model in routing.toml [${tier}.${provider}].`,
  );
  return {
    value: null,
    layer: "unknown",
    reason: `${why}; no last-known-good derivation; Hive ships no fallback ` +
      `list. Install or sign in to the ${provider} CLI, or pin ` +
      `routing.toml [${tier}.${provider}].`,
  };
}

/**
 * The availability filter: can this model actually run, for free, right now?
 *
 * Distinct from the spend guard on purpose. The spend guard protects his WALLET
 * and asks him when money is at stake. This protects his WORK and never asks him
 * anything — an exhausted, unpayable model is not a choice he needs to make, it is
 * a model the vendor will refuse. Routing to it anyway would hand him a dead deep
 * agent and call it thrift.
 */
function availabilityRefusal(
  input: DerivationInput,
  record: CapabilityRecord,
): string | null {
  const billing = input.billing?.[record.provider];
  // No billing reading is the spend guard's problem (it asks), not this filter's:
  // an unknown pool must never be turned into a confident "unavailable" either.
  if (billing === undefined || record.displayName === null) return null;
  const availability = poolAvailability(billing, record.displayName);
  return availability.state === "exhausted"
    ? `${record.launchToken} is not routable: ${availability.detail}`
    : null;
}

/**
 * The spend guard: would this spawn cost the user real money?
 *
 * It keys on MONEY, not on a model. There is no premium list and no date — the
 * thing being guarded is his wallet, so the rule is the same for every model.
 * `null` means the spawn cannot cost him anything and may proceed.
 *
 * A pinned model reaches this function too, but only to RAISE the question — it is
 * never excluded by the answer. The route is his; the money is still his to be
 * asked about.
 */
function spendGuard(
  input: DerivationInput,
  record: CapabilityRecord,
  needConsent: ConsentSink,
): string | null {
  const billing = input.billing?.[record.provider];
  if (billing === undefined) {
    // THE SUBJECT IS THE VENDOR, NOT THE MODEL. With no billing surface at all,
    // Hive cannot tell one model's cost from another's, so a per-model question
    // is one it has no standing to ask — and worse, one the user cannot durably
    // answer: the vendor's default model can move between the ask and the spawn
    // (grok's did, silently, on 2026-07-12), orphaning the answer he gave and
    // refusing the spawn against a question that no longer exists. Asking about
    // the vendor is both the honest question and the answerable one.
    const detail = `Hive could not read ${record.provider} plan or billing ` +
      "state, so it cannot rule out a charge on any of its models";
    if (input.costConsent?.(record.provider) === "approved") return null;
    needConsent(record.provider, detail);
    return `${record.provider}: ${detail}; not auto-routed until you say so`;
  }
  // Without a display name the model cannot be joined to a pool, so whether it
  // would be billed is unknown — and unknown resolves to ask, never to spend.
  const name = record.displayName;
  if (name === null) {
    const detail = `Hive cannot join ${record.launchToken} to a plan pool, so it ` +
      "cannot rule out a charge";
    if (input.costConsent?.(record.canonicalId) === "approved") return null;
    needConsent(record.canonicalId, detail);
    return `${record.launchToken}: ${detail}; not auto-routed until you say so`;
  }

  const risk = spendRisk(billing, name);
  if (risk.state === "no-spend") return null;
  if (input.costConsent?.(record.canonicalId) === "approved") return null;

  needConsent(record.canonicalId, risk.detail);
  return `${name} WOULD SPEND YOUR MONEY: ${risk.detail}. Hive does not spend it ` +
    "without being asked — answer the request in the approvals queue";
}

/**
 * A pin is never silently overridden and never silently obeyed. It is used —
 * the user's standing judgment about their own account outranks anything Hive
 * derived — and every way it disagrees with what Hive knows is named here.
 */
function notePinConflicts(
  provider: CapabilityProvider,
  pinned: string,
  input: DerivationInput,
  records: readonly CapabilityRecord[],
  notes: string[],
): void {
  const record = records.find((entry) =>
    entry.canonicalId === pinned || entry.launchToken === pinned ||
    entry.aliases.includes(pinned)
  );
  if (record === undefined) {
    notes.push(
      `pinned model ${pinned} has no capability record on this account ` +
        "(discovery does not vouch for it); the pin is honoured anyway",
    );
  } else if (
    capabilityFreshness(
      record,
      input.ttlMinutes ?? DERIVATION_TTL_MINUTES,
      input.now,
    ) === "stale"
  ) {
    notes.push(
      `pinned model ${pinned} has only a stale record ` +
        `(${describeAge(record.observedAt, input.now)})`,
    );
  }
}

/**
 * Effort resolves *against the resolved model*, never in parallel with it. A
 * per-field merge would otherwise hand a user's pinned model an effort computed
 * for a different one, and the pin would silently launch at a value nobody chose.
 */
function resolveEffort(
  provider: CapabilityProvider,
  tier: RoutingTier,
  model: Resolved<string>,
  record: CapabilityRecord | undefined,
  input: DerivationInput,
  notes: string[],
): Resolved<string> {
  const resolved = effortLadder(provider, tier, model, record, input);
  if (resolved.value === null) return resolved;

  // The effort gate rides the *levels list*, which both vendors send, and never
  // the `supportsEffort` boolean, which only Claude sends: gating on the boolean
  // would refuse an effort flag to every Codex spawn.
  const levels = record?.supportedEffortLevels;
  if (levels?.state === "known" && levels.value.includes(resolved.value)) {
    return resolved;
  }
  if (resolved.layer === "pinned") {
    // A pin is honoured whatever the record says, and any disagreement is named.
    if (levels?.state === "known") {
      notes.push(
        `pinned effort ${resolved.value} is not among the levels ${model.value} ` +
          `advertises (${levels.value.join(", ") || "none"}); the pin is ` +
          "honoured and the conflict reported",
      );
    }
    return resolved;
  }
  // A DERIVED effort is a route Hive chose, so it holds itself to a stricter
  // standard than a pin or a ladder replay: it is passed only when the model's
  // live record advertises that exact level. An unadvertised level is refused,
  // and an *unpublished* levels list refuses too — the tier policy's choice is
  // not evidence about what this model accepts, and guessing that it is would
  // be a Hive belief wearing the vendor's authority.
  if (resolved.layer === "derived") {
    notes.push(
      levels?.state === "known"
        ? `refused effort ${resolved.value} (${resolved.layer}): ${model.value} ` +
          `advertises ${levels.value.join(", ") || "none"}. Hive does not pass ` +
          "a level the vendor never offered"
        : `refused effort ${resolved.value} (${resolved.layer}): ${model.value} ` +
          "advertises no effort levels on its live record, so Hive cannot " +
          "ground the choice and passes no flag",
    );
    return {
      value: null,
      layer: "unknown",
      reason: `no valid effort for ${model.value}; no flag is passed`,
    };
  }
  // A ladder effort was established together with its model and survives an
  // absent record — refusing it during a provider outage would strip the very
  // replay the ladder exists for. Only a positive vendor exclusion refuses it.
  if (levels?.state === "known") {
    notes.push(
      `refused effort ${resolved.value} (${resolved.layer}): ${model.value} ` +
        `advertises ${levels.value.join(", ") || "none"}. Hive does not pass ` +
        "a level the vendor never offered",
    );
    return {
      value: null,
      layer: "unknown",
      reason: `no valid effort for ${model.value}; no flag is passed`,
    };
  }
  return resolved;
}

function effortLadder(
  provider: CapabilityProvider,
  tier: RoutingTier,
  model: Resolved<string>,
  record: CapabilityRecord | undefined,
  input: DerivationInput,
): Resolved<string> {
  // 1. The cell's pinned effort: a standing user directive on either vendor.
  const pinned = input.pins[tier]?.[provider]?.effort;
  if (pinned !== undefined) {
    return {
      value: pinned,
      layer: "pinned",
      reason: `routing.toml [${tier}.${provider}].effort`,
    };
  }

  // 2. The tier's effort policy — the knob that makes a cheap tier reason
  //    cheaply — but only for a model the engine itself derived. A pinned
  //    model keeps its own advertised default (the engine does not layer its
  //    tier economy onto a choice the user made), and a ladder model replays
  //    the effort established with it, per the pairing rule below.
  if (model.layer === "derived") {
    return {
      value: TIER_EFFORT_POLICY[tier],
      layer: "derived",
      reason: `tier effort policy (override with ` +
        `routing.toml [${tier}.${provider}].effort)`,
    };
  }

  // 3. The effort that belongs to *the model this cell actually resolved*, from
  //    the same layer that supplied the model. A rung's model and its effort were
  //    established together and are replayed together: pairing one rung's model
  //    with another rung's effort is the cross-author mixing this ordering exists
  //    to prevent, and it launches at a value nobody chose.
  if (model.layer === "ladder:last-known-good") {
    const cell = input.snapshot?.tiers[tier]?.[provider];
    if (cell?.effort != null) {
      return {
        value: cell.effort,
        layer: "ladder:last-known-good",
        reason: `derived with this model ${
          describeAge(cell.derivedAt, input.now)
        }; stale`,
      };
    }
  } else if (record?.defaultEffort.state === "known") {
    // A pinned model with no pinned effort takes the vendor's own word about
    // that model — the one authored value that is actually about it.
    return {
      value: record.defaultEffort.value,
      layer: "derived",
      reason: `${model.value} advertises this default on ` +
        `${record.defaultEffort.surface} ` +
        `(${describeAge(record.defaultEffort.observedAt, input.now)})`,
    };
  }

  // 4. Nothing. Not a failure: Hive passes no effort flag and the vendor's own
  //    default governs the launch, which is the vendor's call to make.
  return {
    value: null,
    layer: "unknown",
    reason: `no source names an effort for this ${provider} cell; no flag is ` +
      "passed",
  };
}

/**
 * The snapshot the next run's rung-1 will read: this run's derived cells,
 * merged over the previous snapshot's.
 *
 * A cell this run derived replaces the remembered one. A cell it did not derive —
 * because the provider was unreachable, or because the user pinned it — keeps
 * whatever the last healthy run learned, at that run's timestamp. Overwriting the
 * file wholesale would let a single failed probe erase the rung that exists
 * precisely for failed probes, and derivation would drop straight to refusal
 * without anyone having decided that.
 *
 * Only MODEL-bearing values are remembered. Tool policy and effort policy are
 * compiled-in and need no memory; what the snapshot preserves is the thing only
 * discovery could have known — which concrete model this account launches.
 */
export function snapshotOf(
  derived: DerivedRouting,
  previous: RoutingSnapshot | null = null,
): RoutingSnapshot | null {
  const stamp = {
    derivedAt: derived.derivedAt,
    manifestRevision: DERIVED_FROM_DISCOVERY,
  };

  const tiers: RoutingSnapshot["tiers"] = { ...previous?.tiers };
  for (const tier of derived.tiers) {
    const remembered = previous?.tiers[tier.tier];
    const cell = (current: DerivedCell) =>
      current.model.layer === "derived" && current.model.value !== null
        ? {
          model: current.model.value,
          effort: current.effort.layer === "derived"
            ? current.effort.value
            : null,
          ...stamp,
        }
        : remembered?.[current.provider] ?? null;

    // Tool preference is compiled-in policy now: it needs no memory, and
    // stamping it as discovery-derived would be a lie. Old snapshots' tool
    // entries still parse; new writes let them age out.
    const tool = remembered?.tool ?? null;

    const claude = cell(tier.claude);
    const codex = cell(tier.codex);
    const grok = cell(tier.grok);
    if (claude === null && codex === null && grok === null && tool === null) {
      delete tiers[tier.tier];
      continue;
    }
    tiers[tier.tier] = { tool, claude, codex, grok };
  }
  if (Object.keys(tiers).length === 0) return null;
  return { tiers };
}
