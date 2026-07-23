import {
  AuthorizedLaunch,
  type LaunchGateChecks,
  type RawLaunchCandidate,
} from "../../src/daemon/authorized-launch";
import { QuotaLedger } from "../../src/daemon/quota-ledger";

const pass = (): null => null;
const checks: LaunchGateChecks = {
  resolution: pass,
  enablement: pass,
  availability: pass,
  capabilityFloor: pass,
  effort: (candidate) => ({ effort: candidate.effort, refusal: null }),
};

/** Quota unit tests exercise ranking after authorization, not the live guards. */
export async function authorizeForQuotaTest(
  candidates: readonly RawLaunchCandidate[],
): Promise<AuthorizedLaunch[]> {
  return await Promise.all(candidates.map(async (candidate) => {
    const result = await AuthorizedLaunch.gate(candidate, checks);
    if (result.refusal !== undefined) throw new Error(result.refusal.detail);
    return result.authorized;
  }));
}

/** Test ledgers model the vendor catalogs production launch authorization reads. */
export class CatalogedQuotaLedger extends QuotaLedger {
  constructor(...args: ConstructorParameters<typeof QuotaLedger>) {
    super(...args);
    const discoveredAt = "2026-07-09T12:00:00.000Z";
    const catalogs = {
      claude: [
        "claude-fable-5",
        "claude-model",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "some-other-model",
        "sonnet",
      ],
      codex: [
        "catalog-model",
        "codex-auto-review",
        "codex-model",
        "default",
        "gpt-5-codex",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.5",
        "gpt-5.6-sol",
        "gpt-hidden",
        "gpt-proved",
        "gpt-test",
        "ungated",
      ],
      grok: ["grok-4.5"],
    } as const;
    for (const provider of Object.keys(catalogs) as Array<keyof typeof catalogs>) {
      this.replaceModelCatalog(provider, catalogs[provider].map((model) => ({
        provider,
        modelId: model,
        displayName: model,
        discoveredAt,
      })));
    }
  }
}
