import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  type CapabilityRecord,
  type EffectiveDefault,
  splitVariant,
} from "./capability";

/**
 * Reads vendor identity as a measured fact. Routes come from the routing
 * policy store's category chains and pass link by link through the launch gate;
 * this module only identifies which vendor publishes a model.
 */

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
 * Do not infer this with a regex over the model name or collapse an unknown
 * result to null: callers can mistake null for permission and route a model
 * through another vendor's UI and quota pool.
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
    const claimed = entry.records.some(
      (record) =>
        record.launchToken.toLowerCase() === wanted ||
        record.canonicalId.toLowerCase() === wanted ||
        record.aliases.some((alias) => alias.toLowerCase() === wanted),
    );
    if (claimed) claims.push(provider);
  }
  const [provider] = claims;
  if (claims.length === 1 && provider !== undefined) {
    return { state: "claimed", provider };
  }
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
