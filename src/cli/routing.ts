import { homedir } from "node:os";
import { join } from "node:path";
import { loadHiveConfig, loadRoutingPins } from "../config/load";
import {
  loadTrustedRoutingManifest,
  type ManifestOrigin,
  type TrustedRoutingManifest,
} from "../config/routing-manifest";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
} from "../daemon/capability-discovery";
import {
  readShadowObservations,
  summarizeShadow,
  type ShadowSummary,
  type Verdict,
} from "../daemon/routing-shadow";
import {
  deriveRouting,
  describeAge,
  defaultRoutingTable,
  RoutingSnapshotSchema,
  snapshotOf,
  type DerivedCell,
  type DerivedRouting,
  type ProviderDiscovery,
  type Resolved,
  type RoutingSnapshot,
} from "../schemas";

/**
 * `hive routing` — the derived table, with per-cell provenance.
 *
 * This is the auditability answer, and it is the reason the derivation engine is
 * trustworthy at all: a router whose choices cannot be inspected will be
 * distrusted the first time it surprises someone, and it should be.
 *
 * The surface prints nothing it did not derive. A value no layer could author
 * prints as `—` with the reason it is unknown; a record used past its TTL prints
 * its age; a cell that fell through the manifest to the compiled-in table says
 * which rung failed and why. A number that was really measured but measures the
 * wrong thing carries authority it has not earned, which makes it worse than no
 * number at all.
 *
 * Deriving is not routing. Live spawns still resolve through `resolveRoute()`
 * and the shipped table; nothing here governs them.
 */

const hiveHome = (): string => Bun.env.HIVE_HOME ?? join(homedir(), ".hive");

const snapshotPath = (): string => join(hiveHome(), "routing-snapshot.json");

/**
 * The last-known-good derived snapshot: the ladder's first rung. A file we cannot
 * read or cannot validate is *no snapshot*, never a partially-trusted one.
 */
async function readSnapshot(): Promise<RoutingSnapshot | null> {
  const file = Bun.file(snapshotPath());
  if (!(await file.exists())) return null;
  const parsed = RoutingSnapshotSchema.safeParse(
    await file.json().catch(() => null),
  );
  return parsed.success ? parsed.data : null;
}

const VALUE_WIDTH = 26;
// Wider than the longest layer label, so a column never runs into the next one.
const LAYER_WIDTH = 26;

const LAYER_LABEL: Record<Resolved<string>["layer"], string> = {
  "pinned": "pinned",
  "derived": "derived",
  "ladder:last-known-good": "ladder 1/last-known-good",
  "ladder:provider-default": "ladder 2/provider-default",
  "ladder:shipped-table": "ladder 3/shipped-table",
  "unknown": "unknown",
};

function formatField(
  label: string,
  field: Resolved<string>,
): string {
  // Unknown renders as `—`. Never as a plausible value, never as a shipped
  // constant wearing a vendor's authority.
  const value = field.value ?? "—";
  return `          ${label.padEnd(7)}${value.padEnd(VALUE_WIDTH)}` +
    `${LAYER_LABEL[field.layer].padEnd(LAYER_WIDTH)}${field.reason}`;
}

function formatCell(cell: DerivedCell): string[] {
  const lines = [
    formatField("model", cell.model).replace("          ", `  ${cell.provider.padEnd(8)}`),
    formatField("effort", cell.effort),
  ];
  if (cell.chain.length > 0) {
    lines.push(`          chain  ${cell.chain.join(" → ")} (quota ranks these at spawn)`);
  }
  for (const note of cell.notes) lines.push(`          ! ${note}`);
  return lines;
}

function formatDiscovery(
  provider: string,
  discovery: ProviderDiscovery,
  now: Date,
): string {
  if (discovery.status === "unavailable") {
    return `${provider}: UNAVAILABLE (${discovery.reason})`;
  }
  const first = discovery.records[0];
  const age = first === undefined
    ? "age unknown"
    : describeAge(first.observedAt, now);
  const model = discovery.effectiveDefault.model;
  const effort = discovery.effectiveDefault.effort;
  const effective = model.state === "known"
    ? `${model.value}${effort.state === "known" ? `@${effort.value}` : "@unknown"}`
    : `unknown (${model.reason})`;
  return `${provider}: ${discovery.records.length} records, ${age}; ` +
    `unflagged launch → ${effective}`;
}

const ORIGIN_LABEL: Record<ManifestOrigin, string> = {
  "installed": "installed/signed",
  "built-in": "built-in",
  "kill-switch": "KILL SWITCH",
};

export function formatDerivedRouting(
  derived: DerivedRouting,
  now: Date,
  trusted: TrustedRoutingManifest,
): string {
  const lines: string[] = [
    "Derived routing — INERT. Live spawns still resolve through the shipped " +
    "table + routing.toml;",
    "this is what the engine would pick, and where every value came from.",
    "",
  ];

  // The manifest's *trust* is the first thing printed, because every derived
  // cell below is only as trustworthy as the document that proposed it.
  lines.push(`  trust      ${ORIGIN_LABEL[trusted.origin]} — ${trusted.detail}`);
  lines.push(
    derived.manifest === null
      ? "  manifest   none in force — every cell falls to the ladder"
      : `  manifest   ${derived.manifest.revision} (published ${derived.manifest.publishedAt}, ` +
        `valid until ${derived.manifest.validUntil}${
          derived.manifest.expired ? " — EXPIRED" : ""
        })`,
  );
  for (const provider of ["claude", "codex"] as const) {
    lines.push(
      `  discovery  ${formatDiscovery(provider, derived.discovery[provider], now)}`,
    );
  }
  lines.push("");

  for (const tier of derived.tiers) {
    lines.push(
      `${tier.tier.padEnd(9)}kind=${tier.kind.padEnd(11)}` +
        `tool=${(tier.tool.value ?? "—").padEnd(8)}` +
        `${LAYER_LABEL[tier.tool.layer].padEnd(LAYER_WIDTH)}${tier.tool.reason}`,
    );
    lines.push(...formatCell(tier.claude), ...formatCell(tier.codex), "");
  }

  // The trust warnings lead: a rejected manifest is the reason the rest of the
  // table looks the way it does.
  const warnings = [...trusted.warnings, ...derived.warnings];
  if (warnings.length > 0) {
    lines.push("WARNINGS");
    for (const warning of warnings) lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

export async function printRouting(): Promise<void> {
  const now = new Date();
  const config = await loadHiveConfig();
  const trusted = await loadTrustedRoutingManifest(config);
  const killed = trusted.origin === "kill-switch";

  // Under the kill switch nothing manifest-derived is consulted — and that
  // includes the last-known-good snapshot, which was itself derived *from* a
  // manifest. Replaying it would route on exactly the judgment the switch was
  // thrown to disown. Discovery is not probed either: with no manifest and no
  // snapshot, every cell falls to the shipped table, which is what the switch
  // promises. The reason string says "not probed" rather than "unavailable",
  // because we did not look, and reporting an act we skipped as a state we
  // observed is the bug this repo keeps dying of.
  const unprobed: ProviderDiscovery = {
    status: "unavailable",
    reason: "not probed — the routing manifest kill switch is engaged",
  };
  const [pins, claude, codex, snapshot] = await Promise.all([
    loadRoutingPins(),
    killed ? unprobed : new ClaudeCapabilityProbe().read(),
    killed ? unprobed : new CodexCapabilityProbe().read(),
    killed ? null : readSnapshot(),
  ]);

  const derived = deriveRouting({
    manifest: trusted.manifest,
    manifestAbsentReason: trusted.detail,
    discovery: { claude, codex },
    pins,
    snapshot,
    shipped: defaultRoutingTable(now),
    now,
  });

  console.log(formatDerivedRouting(derived, now, trusted));

  // Feed the next run's first ladder rung. Only cells this run actually derived
  // are recorded, and cells it could not derive keep what the last healthy run
  // learned (`snapshotOf`), so neither a pin, nor a compiled-in guess, nor a
  // provider outage can rewrite the engine's memory of what it once derived.
  // A killed run derives nothing, so it writes nothing.
  const next = killed ? null : snapshotOf(derived, snapshot);
  if (next !== null) {
    await Bun.write(snapshotPath(), `${JSON.stringify(next, null, 2)}\n`);
  }
}

// --------------------------------------------------------------------------
// `hive routing shadow` — derived vs. actual, and the flip criteria.
// --------------------------------------------------------------------------

const VERDICT_MARK: Record<Verdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  unknown: "????",
};

export function formatShadowSummary(summary: ShadowSummary): string {
  if (summary.spawns === 0) {
    return "No shadow observations yet. Spawn an agent: every spawn records what " +
      "the derived router would have chosen beside what actually launched.";
  }

  const pct = (count: number) =>
    summary.judged === 0
      ? "—"
      : `${((count / summary.judged) * 100).toFixed(1)}%`;

  const lines = [
    `Shadow routing — ${summary.spawns} spawns observed, ${summary.judged} of them ` +
    "router-chosen (user-pinned models are the user's judgment, not the router's,",
    "and are excluded from every criterion below).",
    "",
    "AGREEMENT between the derived route and the table that actually decided",
    `  tool    ${summary.agreement.tool}/${summary.judged} (${pct(summary.agreement.tool)})`,
    `  model   ${summary.agreement.model}/${summary.judged} (${pct(summary.agreement.model)})`,
    `  effort  ${summary.agreement.effort}/${summary.judged} (${pct(summary.agreement.effort)})`,
    "",
  ];

  if (summary.divergences.length === 0) {
    lines.push(
      "DIVERGENCES: none. Derived and actual agree on every observed spawn.",
      "",
    );
  } else {
    lines.push("DIVERGENCES — what the router would have done differently, and why");
    for (const divergence of summary.divergences) {
      lines.push(
        `  ${divergence.tier}.${divergence.field} ×${divergence.count}: ` +
          `actual ${divergence.actual} → derived ${divergence.derived} ` +
          `[${divergence.layer}]`,
        `      ${divergence.reason}`,
      );
    }
    lines.push("");
  }

  lines.push("FLIP CRITERIA (every one must PASS; an unknown is not a pass)");
  for (const criterion of summary.criteria) {
    lines.push(`  [${VERDICT_MARK[criterion.verdict]}] ${criterion.question}`);
    lines.push(`         ${criterion.detail}`);
  }
  lines.push("");
  lines.push("ROLLBACK TRIGGER — the baselines a post-flip regression is measured against");
  for (const criterion of summary.rollback) {
    lines.push(`  [${VERDICT_MARK[criterion.verdict]}] ${criterion.question}`);
    lines.push(`         ${criterion.detail}`);
  }
  lines.push("");
  lines.push(
    summary.flipReady
      ? "FLIP: every criterion passes. The flip is defensible on this evidence."
      : "FLIP: NOT READY. Routing stays on the shipped table.",
  );
  return lines.join("\n");
}

export async function printShadowRouting(): Promise<void> {
  const observations = await readShadowObservations();
  console.log(formatShadowSummary(summarizeShadow(observations)));
}
