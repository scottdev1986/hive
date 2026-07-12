import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoutingFloors, loadRoutingPins } from "../config/load";
import {
  deriveRouting,
  forEachProvider,
  RoutingSnapshotSchema,
  type CapabilityProvider,
  type DerivedCell,
  type ProviderDiscovery,
  type RoutingSnapshot,
  type RoutingTier,
} from "../schemas";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import type { ConsentState } from "./cost-consent";
import { knownBillings, type AccountBilling } from "./usage-credits";

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
   * quota ranks under pressure. Empty until user policy supplies an ordered
   * candidate list.
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
   * The user's standing answer about a charge, and the way to ASK him one.
   *
   * Both halves are load-bearing, and the spawn path had NEITHER (fixed here).
   * Without the read, an approval he has already given is invisible to spawns and
   * the guard refuses him forever. Without the write, the guard refuses a cell
   * without ever filing the question — so there is nothing in his queue to answer,
   * and no answer he could give would help. That is a livelock, and it is exactly
   * what grok hit: refused for want of a consent that was never requested.
   *
   * Absent (a caller with no db) means the derivation runs unconsented: the guard
   * still refuses, because unknown billing resolves to ask, never to spend.
   */
  readConsent?: (subject: string) => ConsentState;
  requestConsent?: (subject: string, detail: string) => void;
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
  // Probed and billed per vendor, for every vendor Hive knows — not for a
  // hardcoded pair. A vendor added to the union is discovered and billed here
  // without an edit, so it can never route off an absent probe or land in no
  // quota pool at all.
  const [pins, floors, snapshot, discovery, billings] = await Promise.all([
    loadRoutingPins(),
    loadRoutingFloors(),
    readSnapshot(),
    forEachProvider(async (provider): Promise<ProviderDiscovery> =>
      (await io.discover(provider)) ?? unprobed("no discoverer is installed")
    ),
    forEachProvider((provider) => io.readBilling(provider)),
  ]);

  const derived = deriveRouting({
    discovery,
    pins,
    floors,
    snapshot,
    billing: knownBillings(billings),
    ...(io.readConsent === undefined ? {} : { costConsent: io.readConsent }),
    now,
  });

  // ASK HIM. The guard names what it would have spent money on; this is what
  // puts that question in the queue he actually answers. A guard that refuses
  // without asking is unanswerable — the user cannot approve a request nobody
  // filed — so the ask and the refusal have to happen on the SAME path, and
  // that path is this one, the one every spawn takes.
  if (io.requestConsent !== undefined) {
    for (const { subject, detail } of derived.consentRequired) {
      io.requestConsent(subject, detail);
    }
  }

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
      grok: governingCell(cell.grok),
    },
    chain: {
      claude: chainOf(cell.claude),
      codex: chainOf(cell.codex),
      grok: chainOf(cell.grok),
    },
    notes: [...cell.claude.notes, ...cell.codex.notes, ...cell.grok.notes],
  };
}
