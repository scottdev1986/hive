import { z } from "zod";
import { discoverRuntimeCapabilities } from "../daemon/provider-capabilities/snapshot-authority";
import {
  buildModelInventory,
  formatModelInventory,
} from "../daemon/provider-capabilities/model-inventory";
import {
  type AccountBilling,
  type AccountBillings,
  knownBillings,
} from "../usage-service/usage-credits/usage-credit-types";
import { readBillingWithMemory } from "../usage-service/usage-credits/usage-credit-memory";
import {
  type EffortTarget,
  type RouteCandidate,
  type RoutePolicy,
  type RoutingPolicy,
  RoutingPolicySchema,
  ROUTING_CATEGORIES,
} from "../schemas/routing-policy";
import { EscalationSchema } from "../schemas/escalation";
import { forEachProvider, providersOf } from "../schemas/capability";
import { requireDaemonPort } from "./control";
import { isTestRunnerEnv } from "./invoker";
import { UserDaemonClient } from "./user-daemon-client";

const describeEffort = (effort: EffortTarget): string =>
  effort.mode === "exact"
    ? `@${effort.value}`
    : effort.mode === "none"
      ? "@none"
      : "";

const describeCandidate = (candidate: RouteCandidate): string =>
  `${candidate.provider}/${candidate.model}${describeEffort(candidate.effort)}=${candidate.weight}`;

const describeRoute = (route: RoutePolicy): string =>
  `[${route.mode}] ${route.candidates.map(describeCandidate).join(", ")}`;

function formatRoutes(policy: RoutingPolicy): string[] {
  const lines = [
    `Routing policy — revision ${policy.revision}` +
      (policy.provisional
        ? " (provisional Hive suggestions — edit anytime)"
        : ""),
  ];
  lines.push(
    `  ${"global".padEnd(16)}${
      policy.global === null
        ? "no route — automatic routing refuses"
        : describeRoute(policy.global)
    }`,
  );
  for (const category of ROUTING_CATEGORIES) {
    const route = policy.categories[category];
    lines.push(
      `  ${category.padEnd(16)}${
        route === undefined
          ? "no route — resolves to global"
          : describeRoute(route)
      }`,
    );
  }
  const configured = Object.entries(policy.providers);
  if (configured.length > 0) {
    lines.push(
      `  providers       ${configured
        .map(([provider, state]) => `${provider}: ${state}`)
        .join("; ")}`,
    );
  }
  return lines;
}

/** The measured billing state, in one line per vendor in the union. `unknown` prints as unknown: a credit flag Hive could not read is never rendered as "off", because "off" reads as "this model cannot run" and would silently disable a model the user is using. */
function describeBilling(billings: AccountBillings | null): string {
  if (billings === null) return "not read — spend evidence is unavailable";
  return providersOf(billings)
    .map(
      (provider) =>
        `${provider}: ${describeProviderBilling(billings[provider])}`,
    )
    .join("; ");
}

function describeProviderBilling(billing: AccountBilling | undefined): string {
  if (billing === undefined) return "not measurable";
  const credits =
    billing.creditsEnabled.state === "known"
      ? billing.creditsEnabled.value
        ? "credits ON — spawns can cost money"
        : "no credits"
      : "credits unknown";
  const used =
    billing.generalUtilization.state === "known"
      ? `${billing.generalUtilization.value}% of plan used`
      : "plan utilization unknown";
  return `${credits}, ${used}`;
}

export async function printRouting(): Promise<void> {
  const now = new Date();
  // The policy and the escalation record live in the store the daemon owns; they are read from the daemon, never side-read from its database. When no daemon is running that is the answer, reported by requireDaemonPort instead of a stale file opened behind the owner's back.
  const client = new UserDaemonClient({
    port: requireDaemonPort(),
    verifyIdentity: !isTestRunnerEnv(),
  });
  const [discovery, billings, policyBody, escalationsBody] = await Promise.all([
    forEachProvider(discoverRuntimeCapabilities),
    forEachProvider(readBillingWithMemory).then(knownBillings),
    client.json("/routing/policy", undefined, "throw"),
    client.json("/routing/escalations", undefined, "throw"),
  ]);
  // Fail-closed on purpose: a corrupt policy or escalation record fails the parse and this command reports it instead of printing a blank, permissive table.
  const policy = RoutingPolicySchema.parse(policyBody);
  const escalations = z.array(EscalationSchema).parse(escalationsBody);

  const lines = [
    ...formatRoutes(policy),
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
          [
            ...escalations.reduce((counts, entry) => {
              const key = `${entry.category} on ${entry.model}`;
              return counts.set(key, (counts.get(key) ?? 0) + 1);
            }, new Map<string, number>()),
          ]
            .map(([key, count]) => `${count}× ${key}`)
            .join(", ") +
          ".",
  );

  console.log(
    "\n" +
      formatModelInventory(
        buildModelInventory({
          discovery,
          policy,
          billing: billings,
          now,
        }),
      ),
  );
}
