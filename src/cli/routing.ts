import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  GrokCapabilityProbe,
} from "../daemon/capability-discovery";
import {
  knownBillings,
  readBillingWithMemory,
  type AccountBilling,
  type AccountBillings,
} from "../daemon/usage-credits";
import { forEachProvider, providersOf, ROUTING_CATEGORIES } from "../schemas";
import type { ChainEntry, EffortTarget, RoutingPolicy } from "../schemas";
import { HiveDatabase } from "../daemon/db";
import { RoutingPolicyStore } from "../daemon/routing-policy-store";
import {
  buildModelInventory,
  formatModelInventory,
} from "../daemon/model-inventory";

/**
 * `hive routing` — the auditability answer for the policy-era router: what
 * the user's chains say, what the vendors' catalogs hold, what the account
 * is billed, and what the escalation record has measured. There is no
 * derived table any more because there is no derivation: the user is the
 * router, and this prints their policy verbatim next to the live facts the
 * launch gate will check it against.
 */

const describeEffort = (effort: EffortTarget): string =>
  effort.mode === "exact"
    ? `@${effort.value}`
    : effort.mode === "none"
    ? "@none"
    : "";

const describeEntry = (entry: ChainEntry): string =>
  `${entry.provider}/${entry.model}${describeEffort(entry.effort)}`;

function formatChains(policy: RoutingPolicy): string[] {
  const lines = [
    `Routing policy — revision ${policy.revision}` +
      (policy.provisional ? " (provisional Hive suggestions — edit anytime)" : ""),
  ];
  for (const category of ROUTING_CATEGORIES) {
    const chain = policy.chains[category];
    lines.push(
      `  ${category.padEnd(16)}${
        chain === undefined || chain.length === 0
          ? "no chain — falls back to the default chain"
          : chain.map(describeEntry).join(" → ")
      }`,
    );
  }
  const configured = Object.entries(policy.providers);
  if (configured.length > 0) {
    lines.push(
      `  providers       ${
        configured.map(([provider, state]) => `${provider}: ${state}`).join("; ")
      }`,
    );
  }
  return lines;
}

/**
 * The measured billing state, in one line per vendor in the union. `unknown`
 * prints as unknown: a credit flag Hive could not read is never rendered as
 * "off", because "off" reads as "this model cannot run" and would silently
 * disable a model the user is using.
 */
function describeBilling(billings: AccountBillings | null): string {
  if (billings === null) return "not read — spend evidence is unavailable";
  return providersOf(billings)
    .map((provider) => `${provider}: ${describeProviderBilling(billings[provider])}`)
    .join("; ");
}

function describeProviderBilling(billing: AccountBilling | undefined): string {
  if (billing === undefined) return "not measurable";
  const credits = billing.creditsEnabled.state === "known"
    ? billing.creditsEnabled.value ? "credits ON — spawns can cost money" : "no credits"
    : "credits unknown";
  const used = billing.generalUtilization.state === "known"
    ? `${billing.generalUtilization.value}% of plan used`
    : "plan utilization unknown";
  return `${credits}, ${used}`;
}

export async function printRouting(): Promise<void> {
  const now = new Date();
  const [claude, codex, grok, billings] = await Promise.all([
    new ClaudeCapabilityProbe().read(),
    new CodexCapabilityProbe().read(),
    new GrokCapabilityProbe().read(),
    forEachProvider(readBillingWithMemory).then(knownBillings),
  ]);
  const discovery = { claude, codex, grok };

  const db = new HiveDatabase();
  // Fail-closed on purpose: a corrupt policy store throws out of read() and
  // this command reports it instead of printing a blank, permissive table.
  const policy = new RoutingPolicyStore(db).read(now);
  const escalations = db.listEscalations();
  db.close();

  const lines = [
    ...formatChains(policy),
    "",
    `  billing    ${describeBilling(billings)}`,
    ...providersOf(discovery).map((provider) => {
      const probed = discovery[provider];
      return `  discovery  ${provider}: ${
        probed === undefined || probed.status !== "ok"
          ? `UNAVAILABLE — ${probed === undefined ? "never probed" : probed.reason}`
          : `${probed.records.length} models`
      }`;
    }),
  ];
  console.log(lines.join("\n"));

  console.log(
    escalations.length === 0
      ? "\nEscalations — MEASURED: 0 wrong-model claims recorded."
      : `\nEscalations — MEASURED: ${escalations.length} wrong-model claim(s): ` +
        [...escalations.reduce((counts, entry) => {
          const key = `${entry.category} on ${entry.model}`;
          return counts.set(key, (counts.get(key) ?? 0) + 1);
        }, new Map<string, number>())].map(([key, count]) => `${count}× ${key}`)
          .join(", ") + ".",
  );

  console.log("\n" + formatModelInventory(buildModelInventory({
    discovery,
    policy,
    billing: billings,
    now,
  })));
}
