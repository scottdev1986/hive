import { readDaemonPort } from "../daemon/lifecycle/daemon-lifecycle";
import { discoverRuntimeCapabilities } from "../daemon/provider-capabilities/snapshot-authority";
import type { ModelControlSnapshot } from "../daemon/routing-service/model-control-snapshot";
import {
  type CapabilityDiscoveryResult,
  type CapabilityProvider,
  forEachProvider,
  unknownVendor,
} from "../schemas/capability";
import type { QuotaStatus } from "../schemas/quota";
import type { TokenUsageSnapshot } from "../schemas/token-usage-schema";
import { systemClock } from "../shared/clock";
import { isDaemonPort } from "../shared/daemon-port";
import { errorMessage } from "../shared/error-message";
import { fetchTokenUsage } from "../usage-service/token-usage-client";
import { readBillingWithMemory } from "../usage-service/usage-credits/usage-credit-memory";
import type { AccountBilling } from "../usage-service/usage-credits/usage-credit-types";
import { fetchQuotaStatus } from "./mcp";

export type { ModelControlSnapshot } from "../daemon/routing-service/model-control-snapshot";

/** `hive model-control-snapshot` — the Workspace app's read surface for the Model Control Center. One JSON document on stdout: the live capability catalogs, the billing money-guard state, and the daemon's quota statuses. Honesty contract: - Everything here is a passthrough of measured facts. Capability records keep their per-field `Discovered` provenance (known/unknown-with-reason), so the app can tell "the vendor said no effort axis" from "we could not read the effort axis" — the two facts model-inventory still merges. - `quota: null` means the daemon could not be asked. It is NOT an empty list, and the app renders it as unknown, never as 0% used. - `usageSurfaces` records whether Hive has ANY capacity-reading source for a provider. Grok's `_x.ai/billing` carries `creditUsagePercent` (weekly gauge) as of grok 0.2.99, so it is "metered" like Claude/Codex. The money rails on the same payload remain a guard, never a gauge. The switch fails closed on a vendor nobody classified: a new provider will not silently render as metered-and-empty. */

export interface ModelControlSnapshotDependencies {
  discover?: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult>;
  readBilling?: (
    provider: CapabilityProvider,
  ) => Promise<AccountBilling | null>;
  daemonPort?: () => number | null;
  quota?: (port: number) => Promise<QuotaStatus[]>;
  tokenUsage?: (port: number) => Promise<TokenUsageSnapshot>;
  now?: () => Date;
}

export interface ModelControlSnapshotReaders {
  discover: (
    provider: CapabilityProvider,
  ) => Promise<CapabilityDiscoveryResult>;
  readBilling: (provider: CapabilityProvider) => Promise<AccountBilling | null>;
  readQuota: () => Promise<QuotaStatus[]>;
  readTokenUsage: () => Promise<TokenUsageSnapshot>;
  now?: () => Date;
}

function defaultDiscover(
  provider: CapabilityProvider,
): Promise<CapabilityDiscoveryResult> {
  return discoverRuntimeCapabilities(provider);
}

function usageSurface(provider: CapabilityProvider): "metered" | "none" {
  switch (provider) {
    case "claude":
      return "metered";
    case "codex":
      return "metered";
    case "grok":
      return "metered";
    case "kimi":
      return "metered";
    case "opencode":
      return "none";
    default:
      return unknownVendor(provider, "model-control-snapshot usageSurface");
  }
}

export async function composeModelControlSnapshot(
  readers: ModelControlSnapshotReaders,
): Promise<ModelControlSnapshot> {
  const now = readers.now ?? systemClock;

  const readQuota = async (): Promise<{
    quota: QuotaStatus[] | null;
    quotaError: string | null;
  }> => {
    try {
      return { quota: await readers.readQuota(), quotaError: null };
    } catch (error) {
      return {
        quota: null,
        quotaError: errorMessage(error),
      };
    }
  };

  const readTokenUsage = async (): Promise<{
    tokenUsage: TokenUsageSnapshot | null;
    tokenUsageError: string | null;
  }> => {
    try {
      return {
        tokenUsage: await readers.readTokenUsage(),
        tokenUsageError: null,
      };
    } catch (error) {
      return {
        tokenUsage: null,
        tokenUsageError: errorMessage(error),
      };
    }
  };

  // A reader that throws is an unavailable provider with a measured reason — one vendor's bad morning must not blank the other cards.
  const discoverSafely = async (
    provider: CapabilityProvider,
  ): Promise<CapabilityDiscoveryResult> => {
    try {
      return await readers.discover(provider);
    } catch (error) {
      return {
        status: "unavailable",
        reason: errorMessage(error),
      };
    }
  };

  const [providers, billing, quotaResult, tokenUsageResult] = await Promise.all(
    [
      forEachProvider(discoverSafely),
      forEachProvider((provider) =>
        readers.readBilling(provider).catch(() => null),
      ),
      readQuota(),
      readTokenUsage(),
    ],
  );

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

export async function buildModelControlSnapshot(
  dependencies: ModelControlSnapshotDependencies = {},
): Promise<ModelControlSnapshot> {
  const discover = dependencies.discover ?? defaultDiscover;
  const readBilling =
    dependencies.readBilling ??
    ((provider: CapabilityProvider) => readBillingWithMemory(provider));
  const daemonPort = dependencies.daemonPort ?? readDaemonPort;
  const quota = dependencies.quota ?? fetchQuotaStatus;
  const tokenUsage = dependencies.tokenUsage ?? fetchTokenUsage;
  const readQuota = async (): Promise<QuotaStatus[]> => {
    const port = daemonPort();
    if (port === null || !isDaemonPort(port)) {
      throw new Error("no daemon is running — usage readings are unavailable");
    }
    return quota(port);
  };

  const readTokenUsage = async (): Promise<TokenUsageSnapshot> => {
    const port = daemonPort();
    if (port === null || !isDaemonPort(port)) {
      throw new Error("no daemon is running — token readings are unavailable");
    }
    return tokenUsage(port);
  };

  return composeModelControlSnapshot({
    discover,
    readBilling,
    readQuota,
    readTokenUsage,
    now: dependencies.now,
  });
}

export async function printModelControlSnapshot(port?: number): Promise<void> {
  console.log(
    JSON.stringify(
      await buildModelControlSnapshot(
        port === undefined ? {} : { daemonPort: () => port },
      ),
    ),
  );
}
