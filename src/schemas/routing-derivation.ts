import {
  CAPABILITY_PROVIDERS,
  splitVariant,
  type CapabilityProvider,
  type CapabilityRecord,
  type EffectiveDefault,
} from "./capability";

/**
 * What survives of the derivation era: vendor identity as a measured fact.
 *
 * The derivation engine itself — the four tiers, the hardcoded tier→vendor
 * preference, the tier→effort ladder, and the snapshot replay — died in the
 * 2026-07-13 cutover (user directive: the user is the router). Routes now
 * come from the routing policy store's category chains, walked link by link
 * through the launch gate. What this file keeps is the one thing that was
 * never a routing opinion: reading which vendor publishes a model, from the
 * vendors' own catalogs.
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
