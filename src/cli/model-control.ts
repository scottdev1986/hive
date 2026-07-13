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
import type { QuotaStatus, TokenUsageSnapshot } from "../schemas";
import { readDaemonPort } from "../daemon/lifecycle";
import { fetchQuotaStatus } from "./mcp";
import { fetchTokenUsage } from "./token-usage";

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
 *   a provider. Grok's `_x.ai/billing` carries `creditUsagePercent` (weekly
 *   gauge) as of grok 0.2.99, so it is "metered" like Claude/Codex. The money
 *   rails on the same payload remain a guard, never a gauge. The switch fails
 *   closed on a vendor nobody classified: a new provider will not silently
 *   render as metered-and-empty.
 */

export interface ModelControlSnapshotDependencies {
  discover?: (provider: CapabilityProvider) => Promise<CapabilityDiscoveryResult>;
  readBilling?: (provider: CapabilityProvider) => Promise<AccountBilling | null>;
  daemonPort?: () => number | null;
  quota?: (port: number) => Promise<QuotaStatus[]>;
  tokenUsage?: (port: number) => Promise<TokenUsageSnapshot>;
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
 * Whether Hive can read this provider's capacity at all. Mirrors
 * `src/daemon/quota-sources.ts`: Claude (`get_usage`), Codex
 * (`account/rateLimits/read`), and Grok (`_x.ai/billing` →
 * `creditUsagePercent`) each have a session-free discovery source.
 */
function usageSurface(provider: CapabilityProvider): "metered" | "none" {
  switch (provider) {
    case "claude":
      return "metered";
    case "codex":
      return "metered";
    case "grok":
      return "metered";
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
  tokenUsage: TokenUsageSnapshot | null;
  tokenUsageError: string | null;
}

export async function buildModelControlSnapshot(
  dependencies: ModelControlSnapshotDependencies = {},
): Promise<ModelControlSnapshot> {
  const discover = dependencies.discover ?? defaultDiscover;
  const readBilling = dependencies.readBilling ??
    ((provider: CapabilityProvider) => readBillingWithMemory(provider));
  const daemonPort = dependencies.daemonPort ?? readDaemonPort;
  const quota = dependencies.quota ?? fetchQuotaStatus;
  const tokenUsage = dependencies.tokenUsage ?? fetchTokenUsage;
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

  const readTokenUsage = async (): Promise<{
    tokenUsage: TokenUsageSnapshot | null;
    tokenUsageError: string | null;
  }> => {
    const port = daemonPort();
    if (port === null || port <= 0 || port > 65_535) {
      return {
        tokenUsage: null,
        tokenUsageError: "no daemon is running — token readings are unavailable",
      };
    }
    try {
      return { tokenUsage: await tokenUsage(port), tokenUsageError: null };
    } catch (error) {
      return {
        tokenUsage: null,
        tokenUsageError: error instanceof Error ? error.message : String(error),
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

  const [providers, billing, quotaResult, tokenUsageResult] = await Promise.all([
    forEachProvider(discoverSafely),
    forEachProvider((provider) => readBilling(provider).catch(() => null)),
    readQuota(),
    readTokenUsage(),
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
    tokenUsage: tokenUsageResult.tokenUsage,
    tokenUsageError: tokenUsageResult.tokenUsageError,
  };
}

export async function printModelControlSnapshot(port?: number): Promise<void> {
  console.log(JSON.stringify(await buildModelControlSnapshot(
    port === undefined ? {} : { daemonPort: () => port },
  )));
}
