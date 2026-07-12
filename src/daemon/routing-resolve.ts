import { homedir } from "node:os";
import { join } from "node:path";
import { loadHiveConfig, loadRoutingPins } from "../config/load";
import {
  loadTrustedRoutingManifest,
  type ManifestOrigin,
} from "../config/routing-manifest";
import {
  defaultRoutingTable,
  deriveRouting,
  RoutingSnapshotSchema,
  type CapabilityProvider,
  type DerivedCell,
  type HiveConfig,
  type ProviderDiscovery,
  type Route,
  type RoutingSnapshot,
  type RoutingTier,
} from "../schemas";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import type { AccountBilling } from "./usage-credits";

/**
 * The flip (design step 5): the derived router GOVERNS live spawns.
 *
 * Everything the six phases built until now inspected, recorded, or refused.
 * This is the one module that decides. It sits between the spawner and the
 * derivation engine and answers one question per spawn — *what governs this
 * tier* — returning either the derived route or `null`, which means "the shipped
 * table still does".
 *
 * THE ESCAPE HATCH IS THE POINT. Both switches are re-read from `config.toml` on
 * every single call, and a `null` here is a full revert:
 *
 *   router = "shipped"        -> the derived router does not govern. The manifest
 *                                is untouched, so `hive routing` still derives and
 *                                shadow mode still records: the instrument that
 *                                would explain the misbehaviour survives the
 *                                retreat from it.
 *   routingManifest = "off"   -> the kill switch. The manifest and everything
 *                                derived from it (including the last-known-good
 *                                snapshot, itself manifest-derived judgment) are
 *                                disowned, and every cell reverts to the compiled-in
 *                                table.
 *
 * Neither needs a rebuild, and neither needs a daemon restart: `resolveRoute()`
 * has always re-read `routing.toml` per spawn, and this re-reads `config.toml` on
 * the same schedule. An escape hatch that only opens after a rebuild of the thing
 * you are escaping is theatre — and this repo has just finished deleting one
 * belief (`FABLE_AUTO_ROUTING_CUTOFF`) that was frozen into code exactly that way.
 *
 * What this module does NOT do is relax anything the earlier phases established.
 * Pins still win (the engine resolves them at layer 1 and they arrive here already
 * on top). The capability floor still gates candidates — and now gates the DOWNSHIFT
 * CHAIN too, which is why the chain travels with the route: quota's alternatives
 * used to come from a hardcoded valve that no floor had ever vetted, and a floor
 * that only guards the primary is not a floor. The spend guard still runs on the
 * live path, and effort is still validated against the resolved model at spawn.
 */

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

export interface GoverningRoute {
  /** Pin → derived → ladder, per field. What the spawn launches. */
  route: Route;
  /**
   * The manifest's list remainders, per column: eligible candidates after the
   * primary, in manifest order, already filtered by the capability floor and the
   * spend guard. These replace the hardcoded release valve — quota ranks them
   * under pressure, and it can no longer downshift onto a model nobody vetted.
   */
  chain: Record<CapabilityProvider, string[]>;
  /** Models the router wanted but may not pay for, and the reason, verbatim. */
  notes: string[];
}

export interface RoutingIo {
  discover: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult | undefined>;
  readBilling: (provider: CapabilityProvider) => Promise<AccountBilling | null>;
  now?: () => Date;
}

async function readSnapshot(): Promise<RoutingSnapshot | null> {
  const file = Bun.file(join(hiveHome(), "routing-snapshot.json"));
  if (!(await file.exists())) return null;
  const parsed = RoutingSnapshotSchema.safeParse(
    await file.json().catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

const unprobed = (reason: string): ProviderDiscovery => ({
  status: "unavailable",
  reason,
});

/**
 * Who decides a spawn's route: the derived router, or the shipped table?
 *
 * ONE function answers this, and both the router and the shadow log call it. If
 * they each decided for themselves, the log could record "the derived router
 * chose this" about a spawn the shipped table actually decided — an act reported
 * as a state, which is the bug this repo keeps dying of, and it would poison the
 * only evidence we have that the flip is safe.
 */
export function whatGoverns(
  config: Pick<HiveConfig, "router">,
  origin: ManifestOrigin,
): "derived" | "shipped" {
  if (config.router === "shipped") return "shipped";
  if (origin === "kill-switch") return "shipped";
  return "derived";
}

/**
 * The route that governs this spawn, or `null` when the shipped table still does.
 *
 * A `null` return is the ONLY way this module can revert, and it is deliberately
 * the same answer for every reason to revert: the caller keeps its existing
 * `resolveRoute()` path untouched, so a reverted spawn takes byte-for-byte the
 * code path it took before the flip existed rather than a derived imitation of it.
 */
export async function resolveGoverningRoute(
  tier: RoutingTier,
  io: RoutingIo,
): Promise<GoverningRoute | null> {
  const config = await loadHiveConfig();
  const trusted = await loadTrustedRoutingManifest(config);
  // The kill switch disowns the manifest, and the snapshot with it. There is
  // nothing left to derive from, so nothing is derived: the spawn falls back to
  // the shipped table by the caller's own untouched path.
  if (whatGoverns(config, trusted.origin) === "shipped") return null;

  const now = io.now?.() ?? new Date();
  const [pins, snapshot, claude, codex, claudeBilling, codexBilling] =
    await Promise.all([
      loadRoutingPins(),
      readSnapshot(),
      io.discover("claude"),
      io.discover("codex"),
      io.readBilling("claude"),
      io.readBilling("codex"),
    ]);

  const derived = deriveRouting({
    manifest: trusted.manifest,
    manifestAbsentReason: trusted.detail,
    discovery: {
      claude: (claude ?? unprobed("no discoverer is installed")) as ProviderDiscovery,
      codex: (codex ?? unprobed("no discoverer is installed")) as ProviderDiscovery,
    },
    pins,
    snapshot,
    shipped: defaultRoutingTable(),
    billing: {
      ...(claudeBilling === null ? {} : { claude: claudeBilling }),
      ...(codexBilling === null ? {} : { codex: codexBilling }),
    },
    now,
  });

  const cell = derived.tiers.find((entry) => entry.tier === tier);
  if (cell === undefined) return null;

  const shipped = defaultRoutingTable()[tier];
  // A field no layer could author stays on the shipped value rather than becoming
  // `null` in an argv. The engine's ladder makes this unreachable for the four
  // shipped tiers — its last rung IS this table — but a route is not the place to
  // discover that assumption was wrong.
  const model = (column: DerivedCell, fallback: string): string =>
    column.model.value ?? fallback;
  const effort = (column: DerivedCell): { effort?: string } =>
    column.effort.value === null ? {} : { effort: column.effort.value };
  // A PINNED cell offers no alternatives. The user's explicit choice outranks the
  // router, always — and a downshift chain underneath a pin is the router quietly
  // reserving the right to overrule it the moment a pool gets tight. (The valve
  // this replaces did exactly that: it offered quota a substitute for a pinned
  // model without anyone deciding it could.)
  const chainOf = (column: DerivedCell): string[] =>
    column.model.layer === "pinned" ? [] : column.chain;

  const notes = [...cell.claude.notes, ...cell.codex.notes];
  // An expired manifest is named on every spawn it fails to govern, not only in
  // `hive routing` for whoever thinks to look: this launch resolved through the
  // ladder, and a route that silently stopped being derived is the exact silence
  // the derivation engine exists to end.
  if (derived.manifest?.expired === true) {
    notes.unshift(
      `manifest ${derived.manifest.revision} EXPIRED at ` +
        `${derived.manifest.validUntil}; this spawn resolved without it ` +
        "(last-known-good → provider default → compiled-in table). Update hive.",
    );
  }

  return {
    route: {
      tool: cell.tool.value ?? shipped!.tool,
      claude: {
        model: model(cell.claude, shipped!.claude.model),
        ...effort(cell.claude),
      },
      codex: {
        model: model(cell.codex, shipped!.codex.model),
        ...effort(cell.codex),
      },
    },
    chain: { claude: chainOf(cell.claude), codex: chainOf(cell.codex) },
    notes,
  };
}
