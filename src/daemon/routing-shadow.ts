import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadHiveConfig, loadRoutingPins } from "../config/load";
import { loadTrustedRoutingManifest } from "../config/routing-manifest";
import {
  defaultRoutingTable,
  deriveRouting,
  kindRequiresCodingCapability,
  RoutingSnapshotSchema,
  type CapabilityProvider,
  type DerivedTier,
  type ProviderDiscovery,
  type ResolutionLayer,
  type RoutingTier,
} from "../schemas";
import type { CapabilityDiscoveryResult } from "./capability-discovery";
import { readAccountBilling, type AccountBilling } from "./usage-credits";

/**
 * Shadow mode: derive what the router *would* have chosen, record it beside what
 * the static table actually chose, and change nothing about the launch.
 *
 * This is the evidence that earns the flip, and it is worth being precise about
 * why it must be inert. A shadow that can alter a spawn is not a shadow, it is an
 * unreviewed flip — so nothing here returns a value the spawner reads, nothing
 * here throws into the spawn path, and the derived route never reaches an argv.
 * `resolveRoute()` still decides.
 *
 * One rule inherited from the spawn path and worth naming, because it decides
 * what the rollback baseline even means: **a failure before the transport is not
 * evidence about a route** (`spawner-impl.ts` says so where it catches them —
 * building an argv and handing it to tmux happen before the model is contacted).
 * So an observation is recorded only once the launch is past the transport, and
 * its outcome is the model's answer rather than this machine's.
 */

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

export const shadowLogPath = (): string => join(hiveHome(), "routing-shadow.jsonl");

const RouteSchema = z.strictObject({
  tool: z.enum(["claude", "codex"]),
  model: z.string().min(1).nullable(),
  effort: z.string().min(1).nullable(),
});

export const ShadowObservationSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  agent: z.string().min(1),
  tier: z.string().min(1),
  kind: z.string().min(1),
  /** What actually launched. The static table's choice, after quota. */
  actual: RouteSchema,
  /** What the derivation engine would have chosen for the same spawn. */
  derived: RouteSchema,
  /** Which layer authored each derived field: the audit trail for a divergence. */
  layers: z.strictObject({
    tool: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1),
  }),
  /** Why the derived model is what it is, verbatim from the engine. */
  reason: z.string(),
  agrees: z.strictObject({
    tool: z.boolean(),
    model: z.boolean(),
    effort: z.boolean(),
  }),
  /** The derived model came off a ladder rung rather than the manifest. */
  ladderFallback: z.boolean(),
  /**
   * The derived model is not declared coding-capable for this tier's kind. Only
   * a ladder rung can produce this — the manifest path filters the floor before
   * quota — so it is exactly the criterion the flip must see at zero.
   */
  floorViolation: z.boolean(),
  /** A user-pinned spawn model. The router did not choose it, so it is excluded. */
  userPinned: z.boolean(),
  manifestRevision: z.string().nullable(),
  /** The model's answer, past the transport. */
  outcome: z.enum(["launched", "failed"]),
  failureReason: z.string().nullable(),
});

export type ShadowObservation = z.infer<typeof ShadowObservationSchema>;

export interface ShadowSpawn {
  agent: string;
  tier: RoutingTier;
  /** The route that actually launched. */
  tool: CapabilityProvider;
  model: string;
  effort: string | undefined;
  /** True when the caller named the model: not the router's choice to judge. */
  userPinned: boolean;
  outcome: "launched" | "failed";
  failureReason: string | null;
}

export interface ShadowDependencies {
  discoverCapabilities: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult>;
  now?: () => Date;
  append?: (line: string) => Promise<void>;
  readBilling?: () => Promise<AccountBilling | null>;
}

const ladderLayers: ReadonlySet<ResolutionLayer> = new Set([
  "ladder:last-known-good",
  "ladder:provider-default",
  "ladder:shipped-table",
]);

async function readSnapshot() {
  const file = Bun.file(join(hiveHome(), "routing-snapshot.json"));
  if (!(await file.exists())) return null;
  const parsed = RoutingSnapshotSchema.safeParse(
    await file.json().catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Derive the shadow route for one real spawn and append the comparison.
 *
 * Never throws: shadow mode failing must never fail a spawn, because a spawn that
 * dies because its *observer* died is a spawn the observer altered.
 */
export async function recordShadowObservation(
  spawn: ShadowSpawn,
  dependencies: ShadowDependencies,
): Promise<ShadowObservation | null> {
  try {
    const now = dependencies.now?.() ?? new Date();
    const [config, pins, snapshot, claude, codex, billing] = await Promise.all([
      loadHiveConfig(),
      loadRoutingPins(),
      readSnapshot(),
      dependencies.discoverCapabilities("claude"),
      dependencies.discoverCapabilities("codex"),
      dependencies.readBilling?.() ?? readAccountBilling(),
    ]);
    const trusted = await loadTrustedRoutingManifest(config);

    const derivation = deriveRouting({
      manifest: trusted.manifest,
      manifestAbsentReason: trusted.detail,
      discovery: {
        claude: claude as ProviderDiscovery,
        codex: codex as ProviderDiscovery,
      },
      pins,
      snapshot,
      shipped: defaultRoutingTable(now),
      billing,
      now,
    });

    const tier = derivation.tiers.find((entry) => entry.tier === spawn.tier);
    if (tier === undefined) return null;

    const observation = compare(spawn, tier, trusted.manifest?.revision ?? null, now);
    const line = `${JSON.stringify(observation)}\n`;
    if (dependencies.append !== undefined) {
      await dependencies.append(line);
    } else {
      await appendFile(shadowLogPath(), line);
    }
    return observation;
  } catch {
    // Deliberately silent about its own failure to the spawn path, and it
    // reports nothing it did not derive: no observation is written at all.
    return null;
  }
}

function compare(
  spawn: ShadowSpawn,
  tier: DerivedTier,
  manifestRevision: string | null,
  now: Date,
): ShadowObservation {
  // The derived route is read from the tool the derivation itself chose, not from
  // the tool that actually launched: comparing the derived model of one vendor
  // against the actual model of the other would manufacture a divergence that is
  // really just a tool disagreement, already counted on its own axis.
  const derivedTool = tier.tool.value ?? spawn.tool;
  const cell = derivedTool === "claude" ? tier.claude : tier.codex;

  const floorViolation = kindRequiresCodingCapability(tier.kind) &&
    cell.notes.some((note) => note.includes("not declared coding-capable"));

  return {
    at: now.toISOString(),
    agent: spawn.agent,
    tier: tier.tier,
    kind: tier.kind,
    actual: {
      tool: spawn.tool,
      model: spawn.model,
      effort: spawn.effort ?? null,
    },
    derived: {
      tool: derivedTool,
      model: cell.model.value,
      effort: cell.effort.value,
    },
    layers: {
      tool: tier.tool.layer,
      model: cell.model.layer,
      effort: cell.effort.layer,
    },
    reason: cell.model.reason,
    agrees: {
      tool: derivedTool === spawn.tool,
      model: cell.model.value === spawn.model,
      effort: (cell.effort.value ?? null) === (spawn.effort ?? null),
    },
    ladderFallback: ladderLayers.has(cell.model.layer),
    floorViolation,
    userPinned: spawn.userPinned,
    manifestRevision,
    outcome: spawn.outcome,
    failureReason: spawn.failureReason,
  };
}

export async function readShadowObservations(
  path: string = shadowLogPath(),
): Promise<ShadowObservation[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const observations: ShadowObservation[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = ShadowObservationSchema.safeParse(JSON.parse(line));
      if (parsed.success) observations.push(parsed.data);
    } catch {
      // A torn or hand-edited line is dropped rather than guessed at. It is not
      // counted as anything — least of all as an agreement.
    }
  }
  return observations;
}

// --------------------------------------------------------------------------
// The flip criteria, made checkable.
// --------------------------------------------------------------------------

/**
 * A quiet fortnight proves nothing, so the window does not count until the
 * volume exists. The number is judgment — there is no data to derive it from —
 * and it is printed beside every verdict rather than buried here.
 */
export const MIN_JUDGED_SPAWNS = 50;

/**
 * Derivation that routinely cannot produce an answer is not ready to govern,
 * however good its answers are when it has them.
 */
export const MAX_LADDER_FALLBACK_RATE = 0.1;

export type Verdict = "pass" | "fail" | "unknown";

export interface Criterion {
  id: string;
  question: string;
  verdict: Verdict;
  /** The measured number, or precisely why there isn't one. Never a guess. */
  detail: string;
}

export interface Divergence {
  tier: string;
  field: "tool" | "model" | "effort";
  actual: string;
  derived: string;
  layer: string;
  reason: string;
  count: number;
}

export interface ShadowSummary {
  spawns: number;
  /** Spawns the router actually chose. A user-pinned model is not its judgment. */
  judged: number;
  agreement: { tool: number; model: number; effort: number };
  divergences: Divergence[];
  criteria: Criterion[];
  rollback: Criterion[];
  flipReady: boolean;
}

export function summarizeShadow(
  observations: readonly ShadowObservation[],
): ShadowSummary {
  const judged = observations.filter((entry) => !entry.userPinned);
  const n = judged.length;
  const rate = (count: number) => n === 0 ? "—" : `${((count / n) * 100).toFixed(1)}%`;

  const agreement = {
    tool: judged.filter((entry) => entry.agrees.tool).length,
    model: judged.filter((entry) => entry.agrees.model).length,
    effort: judged.filter((entry) => entry.agrees.effort).length,
  };

  const divergences = new Map<string, Divergence>();
  for (const entry of judged) {
    for (const field of ["tool", "model", "effort"] as const) {
      if (entry.agrees[field]) continue;
      const actual = entry.actual[field] ?? "—";
      const derived = entry.derived[field] ?? "—";
      const key = `${entry.tier}\0${field}\0${actual}\0${derived}`;
      const existing = divergences.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        continue;
      }
      divergences.set(key, {
        tier: entry.tier,
        field,
        actual: String(actual),
        derived: String(derived),
        layer: entry.layers[field],
        reason: entry.reason,
        count: 1,
      });
    }
  }

  const floorViolations = judged.filter((entry) => entry.floorViolation).length;
  const ladder = judged.filter((entry) => entry.ladderFallback).length;
  // A derived route that DIVERGED never ran, so whether it would have launched is
  // a counterfactual no log can answer. Only the agreeing spawns test the derived
  // choice against reality — and there, a failure is a real contradiction.
  const agreeing = judged.filter((entry) =>
    entry.agrees.tool && entry.agrees.model
  );
  const contradicted = agreeing.filter((entry) => entry.outcome === "failed").length;
  const unobservable = n - agreeing.length;

  const criteria: Criterion[] = [
    {
      id: "volume",
      question: `at least ${MIN_JUDGED_SPAWNS} router-chosen spawns in the window`,
      verdict: n >= MIN_JUDGED_SPAWNS ? "pass" : "fail",
      detail: `${n} judged (${observations.length} observed, ${
        observations.length - n
      } user-pinned and excluded)`,
    },
    {
      id: "floor",
      question: "zero kind-floor violations by the derived choice",
      verdict: n === 0 ? "unknown" : floorViolations === 0 ? "pass" : "fail",
      detail: n === 0
        ? "no judged spawns yet"
        : `${floorViolations} of ${n} (${rate(floorViolations)})`,
    },
    {
      id: "contradicted",
      question: "zero derived candidates that discovery later contradicted",
      // Never auto-passes while divergences exist: their derived routes never
      // launched, so the evidence for them does not exist and cannot be implied.
      verdict: n === 0 || unobservable > 0
        ? "unknown"
        : contradicted === 0
        ? "pass"
        : "fail",
      detail: n === 0
        ? "no judged spawns yet"
        : `${contradicted} contradicted of ${agreeing.length} observable; ` +
          `${unobservable} divergent spawns are UNOBSERVABLE by construction ` +
          "(their derived route never ran, so nothing measured it)",
    },
    {
      id: "ladder-rate",
      question: `ladder-fallback rate below ${(MAX_LADDER_FALLBACK_RATE * 100).toFixed(0)}%`,
      verdict: n === 0
        ? "unknown"
        : ladder / n < MAX_LADDER_FALLBACK_RATE
        ? "pass"
        : "fail",
      detail: n === 0 ? "no judged spawns yet" : `${ladder} of ${n} (${rate(ladder)})`,
    },
    {
      id: "attributable",
      question:
        "every divergent cell attributable to a discovered or manifest fact, not a resolution bug",
      // A machine cannot tell a correct divergence from a resolution bug — that
      // is a judgment about whether the reason is *right*, and asserting it
      // automatically would be the flip deciding its own case.
      verdict: "unknown",
      detail: divergences.size === 0
        ? "no divergences to attribute"
        : `${divergences.size} distinct divergences below, each with the layer and ` +
          "reason that authored it. HUMAN REVIEW: this criterion cannot be " +
          "self-certified",
    },
    {
      id: "cost",
      question: "projected planning-unit cost no worse than shipped for the same task mix",
      verdict: "unknown",
      detail: "NOT MEASURABLE TODAY: nothing prices a planning unit per model, so " +
        "no projection exists. Inventing a multiplier would make this criterion " +
        "decorative — it must be measured before the flip, not assumed",
    },
  ];

  const failures = judged.filter((entry) => entry.outcome === "failed").length;
  const rollback: Criterion[] = [
    {
      id: "launch-failure-baseline",
      question: "pre-flip launch-failure rate of the SHIPPED routes (the revert trigger)",
      verdict: n === 0 ? "unknown" : "pass",
      detail: n === 0
        ? "no judged spawns yet — with no baseline, a post-flip regression is " +
          "undetectable and the rollback trigger is decorative"
        : `${failures} of ${n} actual launches failed past the transport ` +
          `(${rate(failures)}). This is the measured baseline a post-flip rate ` +
          "is compared against",
    },
    {
      id: "escalation-baseline",
      question: "pre-flip escalation rate (the doc's second revert trigger)",
      verdict: "unknown",
      detail: "NOT MEASURED ANYWHERE IN HIVE: 'escalation' exists only as prompt " +
        "wording, and nothing counts one. Until something does, this half of the " +
        "rollback trigger cannot fire, and saying otherwise would be a number " +
        "nobody measured",
    },
  ];

  return {
    spawns: observations.length,
    judged: n,
    agreement,
    divergences: [...divergences.values()].sort((a, b) => b.count - a.count),
    criteria,
    rollback,
    // The flip is ready only when EVERY criterion passes. An `unknown` is not a
    // pass: it is a criterion nobody checked, and the whole point of the gate is
    // that it cannot be cleared by not looking.
    flipReady: criteria.every((entry) => entry.verdict === "pass"),
  };
}
