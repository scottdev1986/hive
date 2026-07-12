import { homedir } from "node:os";
import { join } from "node:path";
import { loadHiveConfig, loadRoutingPins } from "../config/load";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
} from "../daemon/capability-discovery";
import {
  readBillingWithMemory,
  type AccountBilling,
  type AccountBillings,
} from "../daemon/usage-credits";
import { readCostConsent, requestCostConsent } from "../daemon/cost-consent";
import { HiveDatabase } from "../daemon/db";
import {
  readShadowObservations,
  summarizeShadow,
  type ShadowSummary,
  type Verdict,
} from "../daemon/routing-shadow";
import {
  deriveRouting,
  describeAge,
  RoutingSnapshotSchema,
  snapshotOf,
  type DerivedCell,
  type DerivedRouting,
  type ProviderDiscovery,
  type Resolved,
  type RoutingSnapshot,
} from "../schemas";
import {
  buildModelInventory,
  formatModelInventory,
} from "../daemon/model-inventory";
import { readBenchmarkCatalog } from "../daemon/benchmarks";
import { configuredBenchmarkSources } from "../daemon/benchmark-sources";

/**
 * `hive routing` — the derived table, with per-cell provenance.
 *
 * This is the auditability answer, and it is the reason the derivation engine is
 * trustworthy at all: a router whose choices cannot be inspected will be
 * distrusted the first time it surprises someone, and it should be.
 *
 * The surface prints nothing it did not derive. A value no layer could author
 * prints as `—` with the reason it is unknown; a record used past its TTL prints
 * its age; a cell that nothing could author prints the refusal the spawn path
 * fails with. A number that was really measured but measures the wrong thing
 * carries authority it has not earned, which makes it worse than no number at
 * all.
 *
 * This IS what live spawns launch: the spawner asks the same engine, and there
 * is no other table for either of them to consult.
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
  "ladder:last-known-good": "last-known-good",
  "unknown": "REFUSED/unknown",
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

export function formatDerivedRouting(
  derived: DerivedRouting,
  now: Date,
  billing: AccountBillings | null = null,
): string {
  const lines: string[] = [
    "Derived routing — GOVERNING. This is what live spawns launch: every " +
    "unpinned route below",
    "is the one an agent gets. Hive ships no model list — every model here was " +
    "learned from the",
    "vendors at runtime, and a cell nothing could author REFUSES the spawn with " +
    "its reason.",
    "Override any cell in ~/.hive/routing.toml; a pin always wins.",
    "",
  ];

  // What the account is actually charged. This is what decides whether a
  // model may be auto-routed on cost grounds — measured, never a date.
  lines.push(`  billing    ${describeBilling(billing)}`);
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

  if (derived.warnings.length > 0) {
    lines.push("WARNINGS");
    for (const warning of derived.warnings) lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

export async function printRouting(): Promise<void> {
  const now = new Date();
  const config = await loadHiveConfig();
  const [pins, claude, codex, snapshot, billing] = await Promise.all([
    loadRoutingPins(),
    new ClaudeCapabilityProbe().read(),
    new CodexCapabilityProbe().read(),
    readSnapshot(),
    // What the account is actually charged. Measured, not dated.
    Promise.all([
      readBillingWithMemory("claude"),
      readBillingWithMemory("codex"),
    ]).then(([claudeBilling, codexBilling]): AccountBillings => ({
      ...(claudeBilling === null ? {} : { claude: claudeBilling }),
      ...(codexBilling === null ? {} : { codex: codexBilling }),
    })),
  ]);
  const benchmarkCatalog = await readBenchmarkCatalog({
    mode: config.benchmarks.mode,
    discovery: { claude, codex },
    sources: configuredBenchmarkSources(),
  });

  // The consent ledger is the approvals queue Hive already has. Opened read-only
  // here; the only write is filing a question nobody has been asked yet.
  const db = new HiveDatabase();
  const derived = deriveRouting({
    costConsent: (model) => readCostConsent(db, model),
    discovery: { claude, codex },
    pins,
    snapshot,
    billing,
    now,
  });

  // Ask — once — about every model the router wanted but may not pay for. The
  // question goes to the approvals queue, where the user answers it; Hive never
  // answers it for him, and never asks twice.
  for (const { canonicalId, detail } of derived.consentRequired) {
    const state = requestCostConsent(db, canonicalId, detail);
    console.log(
      `\nSPEND CONSENT ${state === "pending" ? "REQUESTED" : state.toUpperCase()}: ` +
        `a spawn on ${canonicalId} would cost you real money. ${detail} ` +
        "Answer it in the approvals queue (hive_approvals / hive_approve).",
    );
  }
  db.close();

  console.log(formatDerivedRouting(derived, now, billing));
  console.log("\n" + formatModelInventory(buildModelInventory({
    discovery: { claude, codex },
    routing: derived,
    billing,
    benchmarks: benchmarkCatalog.models,
    benchmarkCatalog,
    now,
  })));

  // Feed the next run's first ladder rung. Only cells this run actually derived
  // are recorded, and cells it could not derive keep what the last healthy run
  // learned (`snapshotOf`), so neither a pin, nor a compiled-in guess, nor a
  // provider outage can rewrite the engine's memory of what it once derived.
  const next = snapshotOf(derived, snapshot);
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

  // Post-flip, this is the section that matters: the derived router is deciding,
  // and this is the only thing still comparing what it DOES against what the old
  // table WOULD have done.
  if (summary.governed.derived > 0) {
    const post = summary.postFlip;
    lines.push(
      `GOVERNED BY THE DERIVED ROUTER — ${summary.governed.derived} spawns ` +
        `(${post.judged} router-chosen), against ${summary.governed.shipped} on the shipped table`,
      "  what the OLD STATIC TABLE would have launched instead:",
    );
    if (post.divergences.length === 0) {
      lines.push(
        `  nothing. On every one of the ${post.judged} judged spawns the router ` +
          "launched exactly what the shipped table would have.",
        "",
      );
    } else {
      for (const divergence of post.divergences) {
        lines.push(
          `  ${divergence.tier}.${divergence.field} ×${divergence.count}: ` +
            `shipped would launch ${divergence.shipped} → router launched ` +
            `${divergence.actual} [${divergence.layer}]`,
          `      ${divergence.reason}`,
        );
      }
      lines.push("");
    }
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
  // Escalation rows live in the daemon's database, not the shadow log: read
  // them here so the escalation criterion reports a measured count instead of
  // "not read".
  const db = new HiveDatabase();
  try {
    console.log(
      formatShadowSummary(summarizeShadow(observations, db.listEscalations())),
    );
  } finally {
    db.close();
  }
}

/**
 * The measured billing state, in one line. `unknown` prints as unknown: a credit
 * flag Hive could not read is never rendered as "off", because "off" reads as
 * "this model cannot run" and would silently disable a model the user is using.
 */
function describeBilling(billings: AccountBillings | null): string {
  if (billings === null) return "not read — automatic cost routing is unavailable";
  return (["claude", "codex"] as const)
    .map((provider) => `${provider}: ${describeProviderBilling(billings[provider])}`)
    .join("; ");
}

function describeProviderBilling(billing: AccountBilling | undefined): string {
  if (billing === undefined) return "not measurable — not auto-routable";
  // The guard's armed/disarmed state, because a guard nobody can see the state of
  // is a guard nobody can trust. With credits off nothing can be charged, so it
  // is disarmed by fact rather than by configuration.
  const credits = billing.creditsEnabled.state === "known"
    ? billing.creditsEnabled.value
      ? "usage credits ON — spend guard ARMED"
      : "usage credits OFF — nothing can be charged, spend guard cannot fire"
    : `usage credits UNKNOWN (${billing.creditsEnabled.reason}) — guard asks rather than assumes`;
  const general = billing.generalUtilization.state === "known"
    ? `plan ${billing.generalUtilization.value}% used`
    : "plan usage unknown";
  const scoped = Object.entries(billing.modelUtilization)
    .map(([name, used]) => `${name} ${used}%`)
    .join(", ");
  const surface = billing.creditsEnabled.surface;
  return `${credits}; ${general}${scoped === "" ? "" : `; caps: ${scoped}`} ` +
    `[${surface}]`;
}
