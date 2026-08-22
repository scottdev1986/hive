import { z } from "zod";
import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
  discovered,
} from "../../schemas/capability";

/** Measures whether running a model would overflow its plan pool into paid usage credits. Model names and dates do not establish billing mode. A model can spend money only after a plan pool that gates it is exhausted. Whether paid overflow is disabled is provider-specific: Claude exposes it, while Codex exposes a current balance but not its auto-top-up switch. `spendRisk()` therefore treats plan headroom as free, exhausted paid capacity as requiring consent, proven-disabled overflow as unable to charge, and an unobservable overflow switch as unknown. Every measured fact is `Discovered`. **An absent key is unknown, never `false`** — and here that rule has teeth: a misspelled key would read back as "credits are off", which renders as "this model cannot run", and Hive would silently disable a model the user is happily using while every test stayed green. */
export const AccountBillingSchema = z.strictObject({
  creditsEnabled: discovered(z.boolean()),
  generalUtilization: discovered(z.number().min(0).max(100)),
  modelUtilization: z.record(z.string(), z.number().min(0).max(100)),
  overflowUncertainty: z.string().nullable(),
});

export type AccountBilling = z.infer<typeof AccountBillingSchema>;

export type AccountBillings = Partial<
  Record<CapabilityProvider, AccountBilling>
>;

/** The vendors whose billing actually read back. A vendor that answered null is omitted — absent means unknown here, and the derivation reads it as such — but the caller supplies a slot for every known vendor, so "unknown" is a measured null and never a vendor nobody remembered to ask. */
export function knownBillings(
  read: Record<CapabilityProvider, AccountBilling | null>,
) {
  const billings: AccountBillings = {};
  for (const provider of CAPABILITY_PROVIDERS) {
    const billing = read[provider];
    if (billing !== null) billings[provider] = billing;
  }
  return billings;
}
