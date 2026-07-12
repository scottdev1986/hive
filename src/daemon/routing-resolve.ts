import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoutingPins } from "../config/load";
import {
  deriveRouting,
  RoutingSnapshotSchema,
  type CapabilityProvider,
  type DerivedCell,
  type ProviderDiscovery,
  type RoutingSnapshot,
  type RoutingTier,
} from "../schemas";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import type { BenchmarkCatalog } from "./benchmarks";
import type { AccountBilling } from "./usage-credits";

/**
 * What governs a spawn: the derivation engine, and nothing else.
 *
 * This module used to be "the flip" — the switch between the derived router
 * and a compiled-in table. The user's directive (2026-07-12) removed the
 * table, the manifest, and every other piece of predetermined model knowledge
 * from the binary, so there is nothing left to flip to: every spawn resolves
 * here, from live discovery + the user's pins + the last-known-good
 * derivation, and a cell none of those can author arrives as `model: null`
 * with the refusal reason. The SPAWNER refuses on it — launching from a
 * baked-in guess is the exact behavior this removal exists to end.
 *
 * The old escape hatches (`router = "shipped"`, `routingManifest = "off"`)
 * are parsed for compatibility but have nothing to revert to; the escape from
 * a bad derivation is a pin, which is user policy and always wins.
 */

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

export interface GoverningCell {
  /** The concrete launch token, or `null` — meaning REFUSE, with the reason. */
  model: string | null;
  effort?: string;
  /** Why this value (or why there is none), verbatim from the engine. */
  reason: string;
}

export interface GoverningRoute {
  tool: CapabilityProvider;
  cells: Record<CapabilityProvider, GoverningCell>;
  /**
   * Eligible candidates after the primary, per column — the downshift chain
   * quota ranks under pressure. Empty until the benchmark surface or user
   * policy supplies an ordered candidate list.
   */
  chain: Record<CapabilityProvider, string[]>;
  /** Conflicts and refusals named out loud, verbatim. */
  notes: string[];
}

export interface RoutingIo {
  discover: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult | undefined>;
  readBilling: (provider: CapabilityProvider) => Promise<AccountBilling | null>;
  /**
   * The approved benchmark catalog, for the live fit policy's ordering
   * evidence. Absent means the derivation runs without benchmark influence —
   * the composition root wires the real reader; a caller that cannot supply
   * one still gets a route, because absence of data never gates.
   */
  readBenchmarks?: (
    discovery: Record<CapabilityProvider, ProviderDiscovery>,
  ) => Promise<BenchmarkCatalog>;
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

/** The route that governs this spawn. Cells that nothing could author carry
 * `model: null` and their refusal reason; the caller refuses on the cell it
 * actually needs. */
export async function resolveGoverningRoute(
  tier: RoutingTier,
  io: RoutingIo,
): Promise<GoverningRoute | null> {
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

  const discovery = {
    claude: (claude ?? unprobed("no discoverer is installed")) as ProviderDiscovery,
    codex: (codex ?? unprobed("no discoverer is installed")) as ProviderDiscovery,
  };
  // The catalog read never blocks a route: a source failure surfaces as an
  // unavailable catalog with no rows, and the fit policy is simply inert.
  const benchmarks = io.readBenchmarks === undefined
    ? undefined
    : await io.readBenchmarks(discovery).catch(() => undefined);
  const derived = deriveRouting({
    discovery,
    pins,
    snapshot,
    ...(benchmarks === undefined ? {} : { benchmarks: benchmarks.models }),
    billing: {
      ...(claudeBilling === null ? {} : { claude: claudeBilling }),
      ...(codexBilling === null ? {} : { codex: codexBilling }),
    },
    now,
  });

  const cell = derived.tiers.find((entry) => entry.tier === tier);
  if (cell === undefined) return null;

  // A PINNED cell offers no alternatives. The user's explicit choice outranks the
  // router, always — and a downshift chain underneath a pin is the router quietly
  // reserving the right to overrule it the moment a pool gets tight.
  const chainOf = (column: DerivedCell): string[] =>
    column.model.layer === "pinned" ? [] : column.chain;

  const governingCell = (column: DerivedCell): GoverningCell => ({
    model: column.model.value,
    ...(column.effort.value === null ? {} : { effort: column.effort.value }),
    reason: column.model.reason,
  });

  return {
    // The tool never resolves to null: policy authors it when no pin does.
    tool: cell.tool.value ?? "claude",
    cells: {
      claude: governingCell(cell.claude),
      codex: governingCell(cell.codex),
    },
    chain: { claude: chainOf(cell.claude), codex: chainOf(cell.codex) },
    notes: [...cell.claude.notes, ...cell.codex.notes],
  };
}
