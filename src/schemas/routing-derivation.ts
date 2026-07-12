import { z } from "zod";
import {
  capabilityFreshness,
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
  manifestAlias,
  manifestCandidates,
  type RoutingManifest,
  type TaskKind,
} from "./routing-manifest";
import {
  RoutingTierSchema,
  type RoutingTable,
  type RoutingTier,
} from "./routing";

/**
 * The derivation engine: tier → concrete route, through the three-layer
 * resolution order.
 *
 *   user pin (routing.toml, format unchanged, always wins)
 *     → derived route (manifest list ∩ discovery)
 *       → the fallback ladder (last-known-good → provider's effective default →
 *         the shipped table, loudly)
 *
 * **This does not govern live spawns.** `resolveRoute()` in `config/load.ts` is
 * untouched and still returns the shipped table merged with `routing.toml`;
 * nothing in the spawn path imports this file. The engine is fully derivable and
 * inspectable — `hive routing` is its only caller — because the design forbids
 * flipping the middle layer before the signed manifest pipeline and the concrete
 * shadow criteria exist. Deriving is a claim about what Hive *would* pick; making
 * it pick is a later, separately-gated step.
 *
 * Every value carries the layer that authored it, per field rather than per cell,
 * because `routing.toml` merges per field: one cell's tool, model, and effort
 * routinely have three different authors. A field nobody could author is `null`
 * with the reason it is unknown. Nothing here has a default to fall back on that
 * is not itself one of the rungs above, and no rung is silent.
 */

export const ROUTING_TIERS = RoutingTierSchema.options;

/**
 * How old a capability record may be and still support *derivation*. Validation
 * accepts an older one (it remains the best evidence Hive has about what a model
 * accepts); choosing a model out of a catalog that may have changed is the silent
 * guess this design exists to prevent.
 */
export const DERIVATION_TTL_MINUTES = 60;

export type ResolutionLayer =
  /** A `routing.toml` entry. A standing user directive: it wins, always. */
  | "pinned"
  /** The manifest's ordered list, intersected with fresh discovery. */
  | "derived"
  /** Ladder rung 1: the last non-empty intersection, replayed past its TTL. */
  | "ladder:last-known-good"
  /** Ladder rung 2: what an unflagged launch on this account actually runs. */
  | "ladder:provider-default"
  /** Ladder rung 3: the compiled-in table. A loud compatibility exception. */
  | "ladder:shipped-table"
  /** No layer could author this field. The value is `null` and stays `null`. */
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
 * The user's pins, read from `routing.toml` *before* the shipped table is merged
 * under them. `loadRoutingTable` merges the two and cannot tell them apart
 * afterwards, so a surface built on the merged table would report every shipped
 * default as a user pin.
 */
export const RoutingPinSchema = z.looseObject({
  tool: z.enum(["claude", "codex"]).optional(),
  claude: z.looseObject({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }).optional(),
  codex: z.looseObject({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  }).optional(),
});

// Keyed by a plain string, not by the tier enum: a `z.record` over an enum
// demands every key, and pinning one tier is the normal case. An unknown tier
// name is rejected by `loadRoutingTable`, which parses the same file against the
// strict table schema.
export const RoutingPinsSchema = z.record(z.string().min(1), RoutingPinSchema);
export type RoutingPins = z.infer<typeof RoutingPinsSchema>;

/**
 * Ladder rung 1: the last non-empty intersection, per cell.
 *
 * Two properties this shape exists to guarantee. **Only genuinely derived cells
 * are recorded** — replaying a pin as "last-known-good derived" would credit the
 * user's choice to the engine, and replaying the shipped table that way would
 * launder a compiled-in guess into a measurement. And **each cell carries its own
 * age**, because a run where one provider was down must not erase what the last
 * healthy run learned about it: the surviving cells are carried forward, and a
 * carried-forward cell reports the age it actually has. A memory a single bad run
 * can wipe is not a memory, and a ladder whose first rung silently vanishes falls
 * straight to the compiled-in guesses this design exists to end.
 */
const SnapshotProvenanceSchema = {
  derivedAt: z.iso.datetime({ offset: true }),
  manifestRevision: z.string().min(1),
};

const SnapshotCellSchema = z.strictObject({
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
  ...SnapshotProvenanceSchema,
});

const SnapshotToolSchema = z.strictObject({
  value: z.enum(["claude", "codex"]),
  ...SnapshotProvenanceSchema,
});

export const RoutingSnapshotSchema = z.strictObject({
  // Partial by construction: a tier whose cells were all pinned or laddered has
  // nothing derived to remember, and gets no entry.
  tiers: z.record(
    z.string().min(1),
    z.strictObject({
      tool: SnapshotToolSchema.nullable(),
      claude: SnapshotCellSchema.nullable(),
      codex: SnapshotCellSchema.nullable(),
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

export interface DerivationInput {
  /** No manifest at all is a real state: every cell then falls to the ladder. */
  manifest: RoutingManifest | null;
  /**
   * Why there is no manifest, in the words the warnings print. A manifest that
   * was *rejected* and one that was *killed* are different facts, and a warning
   * that says "none is installed" when one is installed and disabled describes a
   * machine the reader does not have.
   */
  manifestAbsentReason?: string;
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  pins: RoutingPins;
  snapshot: RoutingSnapshot | null;
  shipped: RoutingTable;
  /**
   * What this account is actually charged, measured per provider. Missing means
   * Hive could not read it; that provider is not auto-routable on a guess.
   */
  billing: AccountBillings | null;
  /** The user's standing answer for a model that would spend real money. */
  costConsent?: (canonicalId: string) => "approved" | "denied" | "pending" | "none";
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
   * The eligible candidates after the primary, in manifest order: the downshift
   * chain quota ranks under pressure at spawn time. Capability filters this list
   * before quota ever sees it, so no headroom number can downshift a coding task
   * below the floor — a floor that can be outbid is not a floor.
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
}

export interface DerivedRouting {
  derivedAt: string;
  manifest:
    | { revision: string; publishedAt: string; validUntil: string; expired: boolean }
    | null;
  discovery: Record<CapabilityProvider, ProviderDiscovery>;
  tiers: DerivedTier[];
  /** Deduplicated, and loud: which rung failed, and why. */
  warnings: string[];
  /**
   * Models the router would have chosen but may not, because running them would
   * spend the user's real money. The caller asks him — through the approvals
   * queue — and never on Hive's own authority.
   */
  consentRequired: { canonicalId: string; detail: string }[];
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
  const consentRequired: { canonicalId: string; detail: string }[] = [];
  const needConsent = (canonicalId: string, detail: string): void => {
    if (!consentRequired.some((entry) => entry.canonicalId === canonicalId)) {
      consentRequired.push({ canonicalId, detail });
    }
  };
  const tiers = ROUTING_TIERS.map((tier) =>
    deriveTier(tier, input, warn, needConsent)
  );
  const manifest = input.manifest;
  return {
    derivedAt: input.now.toISOString(),
    manifest: manifest === null ? null : {
      revision: manifest.revision,
      publishedAt: manifest.publishedAt,
      validUntil: manifest.validUntil,
      expired: input.now.getTime() >= Date.parse(manifest.validUntil),
    },
    discovery: input.discovery,
    tiers,
    warnings,
    consentRequired,
  };
}

type ConsentSink = (canonicalId: string, detail: string) => void;

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
    tool: resolveTool(tier, input, warn),
    claude: deriveCell("claude", tier, kind, input, warn, needConsent),
    codex: deriveCell("codex", tier, kind, input, warn, needConsent),
  };
}

function resolveTool(
  tier: RoutingTier,
  input: DerivationInput,
  warn: (message: string) => void,
): Resolved<CapabilityProvider> {
  const pinned = input.pins[tier]?.tool;
  if (pinned !== undefined) {
    return {
      value: pinned,
      layer: "pinned",
      reason: `routing.toml [${tier}].tool`,
    };
  }
  const manifest = input.manifest;
  if (manifest !== undefined && manifest !== null && !manifestExpired(input)) {
    return {
      value: manifest.tiers[tier]?.preferredProvider ?? null,
      layer: "derived",
      reason: `manifest ${manifest.revision} preferredProvider`,
    };
  }
  const snapshotTool = input.snapshot?.tiers[tier]?.tool;
  if (snapshotTool != null) {
    return {
      value: snapshotTool.value,
      layer: "ladder:last-known-good",
      reason: staleReason(snapshotTool, input),
    };
  }
  const shipped = input.shipped[tier]?.tool;
  if (shipped !== undefined) {
    warn(shippedWarning(tier, "tool", input));
    return {
      value: shipped,
      layer: "ladder:shipped-table",
      reason: "compiled-in table",
    };
  }
  return { value: null, layer: "unknown", reason: `no layer names a tool for ${tier}` };
}

const staleReason = (
  entry: { derivedAt: string; manifestRevision: string },
  input: DerivationInput,
): string =>
  `last derived ${describeAge(entry.derivedAt, input.now)} from manifest ` +
  `${entry.manifestRevision}; stale`;

const manifestExpired = (input: DerivationInput): boolean =>
  input.manifest !== null &&
  input.now.getTime() >= Date.parse(input.manifest.validUntil);

function shippedWarning(
  tier: RoutingTier,
  field: string,
  input: DerivationInput,
): string {
  const why = input.manifest === null
    ? input.manifestAbsentReason ?? "no manifest is installed"
    : manifestExpired(input)
    ? `manifest ${input.manifest.revision} expired at ${input.manifest.validUntil}`
    : "the manifest ∩ discovery intersection is empty";
  return `${tier}.${field}: fell through every rung to the compiled-in table ` +
    `(${why}, no last-known-good snapshot, no provider default). ` +
    "The shipped table names models no record vouches for — this is the " +
    "status quo the router exists to end, and it is a compatibility floor, " +
    "not a derivation.";
}

function deriveCell(
  provider: CapabilityProvider,
  tier: RoutingTier,
  kind: TaskKind,
  input: DerivationInput,
  warn: (message: string) => void,
  needConsent: ConsentSink,
): DerivedCell {
  const notes: string[] = [];
  const ttl = input.ttlMinutes ?? DERIVATION_TTL_MINUTES;
  const discovery = input.discovery[provider];
  const records = discovery.status === "ok" ? discovery.records : [];
  if (discovery.status === "unavailable") {
    notes.push(`${provider} discovery unavailable: ${discovery.reason}`);
  }
  const listed = input.manifest === null ? [] : manifestCandidates(
    input.manifest,
    tier,
    provider,
    kind,
    records,
    input.now,
    ttl,
  );

  // Cost is an eligibility filter, and it belongs beside capability rather than
  // inside quota for the same reason capability does: the user's money is not a
  // price that enough headroom can outbid. A model Hive would have to spend real
  // money to run is not auto-routable on Hive's own say-so — it is his money, so
  // it is his call. This filter applies to AUTO-ROUTING only: a pin never reaches
  // it, because an explicit instruction already IS the consent.
  // AVAILABILITY IS FILTERED BEFORE MONEY, AND IT IS NOT A MONEY QUESTION.
  // A model whose own metered pool is spent, with credits off, is not cheap — it
  // is REFUSED by the vendor. It must stop being a candidate so the next capable
  // model in the manifest's order takes the spawn, silently and with no consent
  // request, because there is nothing to consent to: no money is involved. This
  // applies to a pinned cell's LIST as well (it never touches the pin itself),
  // since a chain of models that cannot run is not a chain.
  const runnable = listed.filter((candidate) => {
    const gone = availabilityRefusal(input, candidate.record);
    if (gone === null) return true;
    notes.push(gone);
    return false;
  });

  const pinned = input.pins[tier]?.[provider]?.model;
  const candidates = pinned === undefined
    ? runnable.filter((candidate) => {
      const refusal = spendGuard(input, candidate.record, needConsent);
      if (refusal === null) return true;
      notes.push(refusal);
      return false;
    })
    : runnable;

  const model = resolveModel(
    provider,
    tier,
    kind,
    input,
    candidates.map((candidate) => candidate.record),
    records,
    notes,
    warn,
    needConsent,
  );

  // The record for the model we actually resolved — not for the primary
  // candidate, and not for the cell's other column. Effort is validated against
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
    kind,
    model,
    resolvedRecord,
    input,
    notes,
    warn,
  );

  const chain = candidates
    .map((candidate) => candidate.record.launchToken)
    .filter((token) => token !== model.value);

  return { provider, model, effort, chain, notes };
}

function resolveModel(
  provider: CapabilityProvider,
  tier: RoutingTier,
  kind: TaskKind,
  input: DerivationInput,
  eligible: readonly CapabilityRecord[],
  records: readonly CapabilityRecord[],
  notes: string[],
  warn: (message: string) => void,
  needConsent: ConsentSink,
): Resolved<string> {
  // Layer 1: the pin. A standing user directive about the user's own account.
  const pinned = input.pins[tier]?.[provider]?.model;
  if (pinned !== undefined) {
    notePinConflicts(provider, tier, kind, pinned, input, records, notes);
    // A pin is the user's direct instruction and therefore their consent to run
    // this route. The spend guard governs Hive's automatic choices only.
    return {
      value: pinned,
      layer: "pinned",
      reason: `routing.toml [${tier}.${provider}].model`,
    };
  }

  // Layer 2: the derived route — the manifest's ordered list intersected with
  // fresh discovery. Capability has already filtered this list (a model the
  // manifest does not declare coding-capable never entered it).
  const primary = eligible[0];
  if (primary !== undefined && input.manifest !== null) {
    return {
      value: primary.launchToken,
      layer: "derived",
      reason: `manifest ${input.manifest.revision} ∩ ${provider} discovery ` +
        `(record ${describeAge(primary.observedAt, input.now)}, ${primary.cliVersion})`,
    };
  }

  // Layer 3: the ladder.
  const snapshotCell = input.snapshot?.tiers[tier]?.[provider];
  if (snapshotCell != null) {
    return {
      value: snapshotCell.model,
      layer: "ladder:last-known-good",
      reason: staleReason(snapshotCell, input),
    };
  }

  const discovery = input.discovery[provider];
  const effective = discovery.status === "ok"
    ? discovery.effectiveDefault
    : undefined;
  if (effective !== undefined && effective.model.state === "known") {
    const value = effective.model.value;
    // The provider default is not a vetted candidate: it is whatever this
    // account happens to be pointed at. If the manifest has no coding-capable
    // declaration for it, say so — an unvouched model reached by the ladder is
    // still an unvouched model, and printing it as if the floor had been applied
    // would be the same lie in a nicer font.
    if (kindRequiresCodingCapability(kind) && !declaredCodingCapable(input, value)) {
      notes.push(
        `provider default ${value} is not declared coding-capable by the ` +
          `manifest (kind=${kind}); the ladder reached it because no vetted ` +
          "candidate survived, and Hive is not inferring the capability from " +
          "the name",
      );
    }
    return {
      value,
      layer: "ladder:provider-default",
      reason: `effective unflagged launch, from ${effective.model.surface} ` +
        `(${describeAge(effective.model.observedAt, input.now)}); not the ` +
        "catalog's isDefault flag",
    };
  }

  const shipped = input.shipped[tier]?.[provider]?.model;
  if (shipped !== undefined) {
    warn(shippedWarning(tier, `${provider}.model`, input));
    return {
      value: shipped,
      layer: "ladder:shipped-table",
      reason: "compiled-in table; no record vouches for this model",
    };
  }

  return {
    value: null,
    layer: "unknown",
    reason: `no layer names a ${provider} model for ${tier}`,
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
 * It keys on MONEY, not on a model. There is no Fable case, no premium list, no
 * date — the thing being guarded is his wallet, so the rule is the same for every
 * model. `null` means the spawn cannot cost him anything and may proceed.
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
    const detail = `Hive could not read ${record.provider} plan or billing ` +
      "state, so it cannot rule out a charge";
    if (input.costConsent?.(record.canonicalId) === "approved") return null;
    needConsent(record.canonicalId, detail);
    return `${record.launchToken}: ${detail}; not auto-routed until you say so`;
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
 * the user's standing judgment about their own account outranks the manifest's —
 * and every way it disagrees with what Hive knows is named here.
 */
function notePinConflicts(
  provider: CapabilityProvider,
  tier: RoutingTier,
  kind: TaskKind,
  pinned: string,
  input: DerivationInput,
  records: readonly CapabilityRecord[],
  notes: string[],
): void {
  const canonical = canonicalise(input, provider, pinned);
  const record = records.find((entry) =>
    entry.canonicalId === canonical || entry.launchToken === pinned ||
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
  if (kindRequiresCodingCapability(kind) && !declaredCodingCapable(input, canonical)) {
    notes.push(
      `pinned model ${pinned} is not declared coding-capable and this tier's ` +
        `kind is ${kind}; the pin wins and the conflict is reported — a table ` +
        "entry does not get to stop every coding spawn on the tier",
    );
  }
}

/**
 * Coding capability is a *declared* manifest value, never an inference. Absent
 * means unknown, and unknown is excluded — a model nobody vetted does not get to
 * write code because its name looked capable.
 */
function declaredCodingCapable(
  input: DerivationInput,
  canonicalId: string | null,
): boolean {
  if (canonicalId === null || input.manifest === null) return false;
  return input.manifest.models[canonicalId]?.codingCapable?.value === true;
}

const canonicalise = (
  input: DerivationInput,
  provider: CapabilityProvider,
  name: string,
): string =>
  input.manifest === null
    ? name
    : manifestAlias(input.manifest, provider, name)?.canonicalId ?? name;

/**
 * Effort resolves *against the resolved model*, never in parallel with it. A
 * per-field merge would otherwise hand a user's pinned model an effort computed
 * for a different one, and the pin would silently launch at a value nobody chose.
 */
function resolveEffort(
  provider: CapabilityProvider,
  tier: RoutingTier,
  kind: TaskKind,
  model: Resolved<string>,
  record: CapabilityRecord | undefined,
  input: DerivationInput,
  notes: string[],
  warn: (message: string) => void,
): Resolved<string> {
  const resolved = effortLadder(provider, tier, model, record, input, warn);
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
  // and an *unpublished* levels list refuses too — the manifest's choice is not
  // evidence about what this model accepts, and guessing that it is would be a
  // Hive belief wearing the vendor's authority.
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
  // A ladder effort was established together with its model (a replayed
  // derivation, or the account's own unflagged-launch config) and survives an
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
  warn: (message: string) => void,
): Resolved<string> {
  // 1. The cell's pinned effort: a standing user directive on either vendor.
  const pinned = input.pins[tier]?.[provider]?.effort;
  if (pinned !== undefined) {
    return {
      value: pinned,
      layer: "pinned",
      reason: `routing.toml [${tier}.codex].effort`,
    };
  }

  // 2. The manifest's per-tier default: the knob that makes a cheap tier reason
  //    cheaply — but only for a model the manifest itself resolved. A pinned
  //    model keeps its own advertised default (the engine does not layer its
  //    tier economy onto a choice the user made), and a ladder model replays
  //    the effort established with it, per the pairing rule below.
  const tierDefault = input.manifest?.tiers[tier]?.defaultEffort;
  if (tierDefault !== undefined && model.layer === "derived") {
    return {
      value: tierDefault,
      layer: "derived",
      reason: `manifest ${input.manifest!.revision} [${tier}].defaultEffort`,
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
  } else if (model.layer === "ladder:provider-default") {
    // A model the ladder reached by *not passing a model flag* takes the
    // effective config effort — the catalog's per-model recommendation describes
    // a launch Hive is not making.
    const discovery = input.discovery[provider];
    const effective = discovery.status === "ok"
      ? discovery.effectiveDefault.effort
      : undefined;
    if (effective?.state === "known") {
      return {
        value: effective.value,
        layer: "ladder:provider-default",
        reason: `effective unflagged launch, from ${effective.surface} ` +
          `(${describeAge(effective.observedAt, input.now)})`,
      };
    }
  } else if (record?.defaultEffort.state === "known") {
    return {
      value: record.defaultEffort.value,
      layer: "derived",
      reason: `${model.value} advertises this default on ` +
        `${record.defaultEffort.surface} ` +
        `(${describeAge(record.defaultEffort.observedAt, input.now)})`,
    };
  }

  // 4. The shipped constant — Codex only. Claude has no shipped effort to fall
  //    to, and inventing one here would present a Hive guess as a vendor default.
  if (provider === "codex") {
    const shipped = input.shipped[tier]?.codex?.effort;
    if (shipped !== undefined) {
      warn(shippedWarning(tier, "codex.effort", input));
      return {
        value: shipped,
        layer: "ladder:shipped-table",
        reason: "compiled-in table; no vendor surface recommends this",
      };
    }
  }

  // 5. Nothing. On Claude this is the common case and it is not a failure: Hive
  //    passes no effort flag. Discovery cannot name what the CLI will use; the
  //    first live statusLine observation completes identity after launch. A
  //    shipped `medium` here would still be a Hive guess wearing the vendor's
  //    authority.
  return {
    value: null,
    layer: "unknown",
    reason: provider === "claude"
      ? "claude publishes no per-model default effort and no tier default is " +
        "set; hive passes no flag and awaits the live statusLine observation"
      : "no layer names an effort",
  };
}

/**
 * The snapshot the next run's ladder rung 1 will read: this run's derived cells,
 * merged over the previous snapshot's.
 *
 * A cell this run derived replaces the remembered one. A cell it did not derive —
 * because the provider was unreachable, or because the user pinned it — keeps
 * whatever the last healthy run learned, at that run's timestamp. Overwriting the
 * file wholesale would let a single failed probe erase the rung that exists
 * precisely for failed probes, and the ladder would drop to the compiled-in table
 * without anyone having decided that.
 */
export function snapshotOf(
  derived: DerivedRouting,
  previous: RoutingSnapshot | null = null,
): RoutingSnapshot | null {
  const revision = derived.manifest?.revision;
  const stamp = { derivedAt: derived.derivedAt, manifestRevision: revision ?? "" };

  const tiers: RoutingSnapshot["tiers"] = { ...previous?.tiers };
  for (const tier of derived.tiers) {
    const remembered = previous?.tiers[tier.tier];
    const cell = (current: DerivedCell) =>
      revision !== undefined && current.model.layer === "derived" &&
        current.model.value !== null
        ? {
          model: current.model.value,
          effort: current.effort.layer === "derived"
            ? current.effort.value
            : null,
          ...stamp,
        }
        : remembered?.[current.provider] ?? null;

    const tool = revision !== undefined && tier.tool.layer === "derived" &&
        tier.tool.value !== null
      ? { value: tier.tool.value, ...stamp }
      : remembered?.tool ?? null;

    const claude = cell(tier.claude);
    const codex = cell(tier.codex);
    if (claude === null && codex === null && tool === null) {
      delete tiers[tier.tier];
      continue;
    }
    tiers[tier.tier] = { tool, claude, codex };
  }
  if (Object.keys(tiers).length === 0) return null;
  return { tiers };
}
