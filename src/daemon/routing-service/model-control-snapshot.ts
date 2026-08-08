import type {
  CapabilityDiscoveryResult,
  CapabilityProvider,
} from "../../schemas/capability";
import type { QuotaStatus } from "../../schemas/quota";
import type { TokenUsageSnapshot } from "../../schemas/token-usage-schema";
import type { AccountBilling } from "../../usage-service/usage-credits/usage-credit-types";

/** The measured facts that feed the daemon-owned Workspace presentation. The
 * CLI composes this contract, but the daemon owns it so lower layers never
 * depend on a command-line module. */
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
