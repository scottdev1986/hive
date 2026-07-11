import { homedir } from "node:os";
import { join } from "node:path";
import { loadRoutingPins } from "../config/load";
import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
} from "../daemon/capability-discovery";
import {
  deriveRouting,
  describeAge,
  defaultRoutingTable,
  FIRST_ROUTING_MANIFEST,
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

export function formatDerivedRouting(
  derived: DerivedRouting,
  now: Date,
): string {
  const lines: string[] = [
    "Derived routing — INERT. Live spawns still resolve through the shipped " +
    "table + routing.toml;",
    "this is what the engine would pick, and where every value came from.",
    "",
  ];

  lines.push(
    derived.manifest === null
      ? "  manifest   none installed — every cell falls to the ladder"
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

  if (derived.warnings.length > 0) {
    lines.push("WARNINGS");
    for (const warning of derived.warnings) lines.push(`  ! ${warning}`);
  }
  return lines.join("\n");
}

export async function printRouting(): Promise<void> {
  const now = new Date();
  const [pins, claude, codex, snapshot] = await Promise.all([
    loadRoutingPins(),
    new ClaudeCapabilityProbe().read(),
    new CodexCapabilityProbe().read(),
    readSnapshot(),
  ]);

  const derived = deriveRouting({
    // The shipped manifest. There is no signed manifest pipeline yet, so there
    // is nothing else to read: an unsigned manifest installed from disk is the
    // trust hole the pipeline exists to close, and this surface will not open it
    // early for its own convenience.
    manifest: FIRST_ROUTING_MANIFEST,
    discovery: { claude, codex },
    pins,
    snapshot,
    shipped: defaultRoutingTable(now),
    now,
  });

  console.log(formatDerivedRouting(derived, now));

  // Feed the next run's first ladder rung. Only cells this run actually derived
  // are recorded, and cells it could not derive keep what the last healthy run
  // learned (`snapshotOf`), so neither a pin, nor a compiled-in guess, nor a
  // provider outage can rewrite the engine's memory of what it once derived.
  const next = snapshotOf(derived, snapshot);
  if (next !== null) {
    await Bun.write(snapshotPath(), `${JSON.stringify(next, null, 2)}\n`);
  }
}
