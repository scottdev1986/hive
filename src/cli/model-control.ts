import {
  ClaudeCapabilityProbe,
  CodexCapabilityProbe,
  GrokCapabilityProbe,
  type CapabilityDiscoveryResult,
} from "../daemon/capability-discovery";
import {
  readBillingWithMemory,
  type AccountBilling,
} from "../daemon/usage-credits";
import {
  forEachProvider,
  unknownVendor,
  type CapabilityProvider,
} from "../schemas/capability";
import type { QuotaStatus } from "../schemas";
import { readDaemonPort } from "../daemon/lifecycle";
import { fetchQuotaStatus } from "./mcp";

/**
 * `hive model-control-snapshot` — the Workspace app's read surface for the
 * Model Control Center. One JSON document on stdout: the live capability
 * catalogs, the billing money-guard state, and the daemon's quota statuses.
 *
 * Honesty contract (docs/architecture/model-control-center-settings-ui.md):
 *
 * - Everything here is a passthrough of measured facts. Capability records
 *   keep their per-field `Discovered` provenance (known/unknown-with-reason),
 *   so the app can tell "the vendor said no effort axis" from "we could not
 *   read the effort axis" — the two facts model-inventory still merges.
 * - `quota: null` means the daemon could not be asked. It is NOT an empty
 *   list, and the app renders it as unknown, never as 0% used.
 * - `usageSurfaces` records whether Hive has ANY capacity-reading source for
 *   a provider. Grok has none — its billing endpoint is a money guard, not a
 *   gauge — so its entry is "none" and the app shows the unmetered panel
 *   instead of meters. The switch below fails closed on a vendor nobody
 *   classified: a new provider will not silently render as metered-and-empty.
 */

export interface ModelControlSnapshotDependencies {
  discover?: (provider: CapabilityProvider) => Promise<CapabilityDiscoveryResult>;
  readBilling?: (provider: CapabilityProvider) => Promise<AccountBilling | null>;
  daemonPort?: () => number | null;
  quota?: (port: number) => Promise<QuotaStatus[]>;
  now?: () => Date;
}

function defaultDiscover(
  provider: CapabilityProvider,
): Promise<CapabilityDiscoveryResult> {
  switch (provider) {
    case "claude":
      return new ClaudeCapabilityProbe().read();
    case "codex":
      return new CodexCapabilityProbe().read();
    case "grok":
      return new GrokCapabilityProbe().read();
    default:
      return unknownVendor(provider, "model-control-snapshot discover");
  }
}

/**
 * Whether Hive can read this provider's capacity at all. This mirrors the
 * structure of `src/daemon/quota-sources.ts`: Claude (`get_usage`) and Codex
 * (`account/rateLimits/read`) have discovery sources; Grok exposes no capacity
 * surface — `_x.ai/billing` answers "would this spend money", never "how full
 * is the plan" (grok-integration-spec §10).
 */
function usageSurface(provider: CapabilityProvider): "metered" | "none" {
  switch (provider) {
    case "claude":
      return "metered";
    case "codex":
      return "metered";
    case "grok":
      return "none";
    default:
      return unknownVendor(provider, "model-control-snapshot usageSurface");
  }
}

export interface ModelControlSnapshot {
  generatedAt: string;
  providers: Record<CapabilityProvider, CapabilityDiscoveryResult>;
  billing: Record<CapabilityProvider, AccountBilling | null>;
  usageSurfaces: Record<CapabilityProvider, "metered" | "none">;
  quota: QuotaStatus[] | null;
  quotaError: string | null;
}

export async function buildModelControlSnapshot(
  dependencies: ModelControlSnapshotDependencies = {},
): Promise<ModelControlSnapshot> {
  const discover = dependencies.discover ?? defaultDiscover;
  const readBilling = dependencies.readBilling ??
    ((provider: CapabilityProvider) => readBillingWithMemory(provider));
  const daemonPort = dependencies.daemonPort ?? readDaemonPort;
  const quota = dependencies.quota ?? fetchQuotaStatus;
  const now = dependencies.now ?? (() => new Date());

  const readQuota = async (): Promise<
    { quota: QuotaStatus[] | null; quotaError: string | null }
  > => {
    const port = daemonPort();
    if (port === null || port <= 0 || port > 65_535) {
      return {
        quota: null,
        quotaError: "no daemon is running — usage readings are unavailable",
      };
    }
    try {
      return { quota: await quota(port), quotaError: null };
    } catch (error) {
      return {
        quota: null,
        quotaError: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // A probe that throws is an unavailable provider with a measured reason —
  // one vendor's bad morning must not blank the other cards.
  const discoverSafely = async (
    provider: CapabilityProvider,
  ): Promise<CapabilityDiscoveryResult> => {
    try {
      return await discover(provider);
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const [providers, billing, quotaResult] = await Promise.all([
    forEachProvider(discoverSafely),
    forEachProvider((provider) => readBilling(provider).catch(() => null)),
    readQuota(),
  ]);

  return {
    generatedAt: now().toISOString(),
    providers,
    billing,
    usageSurfaces: Object.fromEntries(
      Object.keys(providers).map((provider) => [
        provider,
        usageSurface(provider as CapabilityProvider),
      ]),
    ) as Record<CapabilityProvider, "metered" | "none">,
    quota: quotaResult.quota,
    quotaError: quotaResult.quotaError,
  };
}

export async function printModelControlSnapshot(): Promise<void> {
  console.log(JSON.stringify(await buildModelControlSnapshot()));
}
