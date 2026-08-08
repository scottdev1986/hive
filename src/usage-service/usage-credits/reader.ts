import {
  type CapabilityProvider,
  unknown,
  unknownVendor,
} from "../../schemas/capability";
import { KimiHttpUsageTransport, type KimiUsageTransport } from "../kimi-usage";
import {
  type ClaudeProbeTransport,
  ClaudeStdioProbeTransport,
  type CodexProbeTransport,
  CodexStdioProbeTransport,
  type GrokProbeTransport,
  GrokStdioProbeTransport,
} from "../quota-sources";
import { accountBillingFromUsage } from "./claude";
import { accountBillingFromCodexRateLimits } from "./codex";
import { accountBillingFromGrokBilling } from "./grok";
import { accountBillingFromKimiUsage } from "./kimi";
import type { AccountBilling } from "./usage-credit-types";

interface BillingTransports {
  claude?: ClaudeProbeTransport;
  codex?: CodexProbeTransport;
  grok?: GrokProbeTransport;
  kimi?: KimiUsageTransport;
}

export async function readAccountBilling(
  provider: CapabilityProvider,
  observedAt: string = new Date().toISOString(),
  timeoutMs = 10_000,
  transports?: BillingTransports,
): Promise<AccountBilling | null> {
  switch (provider) {
    case "codex": {
      const payload = await (
        transports?.codex ?? new CodexStdioProbeTransport()
      ).readRateLimits(timeoutMs);
      return accountBillingFromCodexRateLimits(payload.limits, observedAt);
    }
    case "claude": {
      const payload = await (
        transports?.claude ?? new ClaudeStdioProbeTransport()
      ).readUsage(timeoutMs);
      return accountBillingFromUsage(payload.usage, observedAt);
    }
    case "grok": {
      const payload = await (
        transports?.grok ?? new GrokStdioProbeTransport()
      ).readBilling(timeoutMs);
      return accountBillingFromGrokBilling(payload.billing, observedAt);
    }
    case "kimi": {
      const payload = await (
        transports?.kimi ?? new KimiHttpUsageTransport()
      ).readUsage(timeoutMs);
      if (payload.status !== "ok") {
        // A quiet surface is an all-unknown billing, never a zero: the billing memory then serves the last real reading at its true age.
        return {
          creditsEnabled: unknown("surface-silent", "kimi.usages", observedAt),
          generalUtilization: unknown(
            "surface-silent",
            "kimi.usages",
            observedAt,
          ),
          modelUtilization: {},
          overflowUncertainty: `Kimi usage unreadable: ${payload.reason}`,
        };
      }
      return accountBillingFromKimiUsage(payload.response, observedAt);
    }
    case "opencode":
      return null;
    default:
      return unknownVendor(provider, "readAccountBilling");
  }
}
