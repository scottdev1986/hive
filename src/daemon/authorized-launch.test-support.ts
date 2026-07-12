import {
  AuthorizedLaunch,
  type LaunchGateChecks,
  type RawLaunchCandidate,
} from "./authorized-launch";

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
