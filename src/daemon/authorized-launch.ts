import type { CapabilityProvider } from "../schemas/capability";

export interface RawLaunchCandidate {
  tool: CapabilityProvider;
  model: string;
  effort?: string;
}

export type LaunchRefusalReason =
  | "resolution"
  | "enablement"
  | "availability"
  | "capability-floor"
  | "effort";

export interface LaunchRefusal {
  reason: LaunchRefusalReason;
  detail: string;
}

export type LaunchGateResult =
  | { authorized: AuthorizedLaunch; refusal?: never }
  | { authorized?: never; refusal: LaunchRefusal };

type Guard = (candidate: Readonly<RawLaunchCandidate>) =>
  Promise<string | null> | string | null;

export interface LaunchGateChecks {
  resolution: Guard;
  enablement: Guard;
  availability: Guard;
  capabilityFloor: Guard;
  effort: (
    candidate: Readonly<RawLaunchCandidate>,
  ) => Promise<{ effort?: string; refusal: string | null }> |
    { effort?: string; refusal: string | null };
}

/**
 * The only value quota and the process adapter accept. Its private constructor
 * makes a raw candidate unlaunchable: callers must run the complete gate.
 */
export class AuthorizedLaunch {
  readonly #authorized = true;
  readonly tool: CapabilityProvider;
  readonly model: string;
  readonly effort?: string;

  private constructor(candidate: Readonly<RawLaunchCandidate>) {
    this.tool = candidate.tool;
    this.model = candidate.model;
    if (candidate.effort !== undefined) this.effort = candidate.effort;
    Object.freeze(this);
  }

  /** The sole mint. Guards run in this order for every primary and chain link. */
  static async gate(
    raw: Readonly<RawLaunchCandidate>,
    checks: LaunchGateChecks,
  ): Promise<LaunchGateResult> {
    const candidate: RawLaunchCandidate = { ...raw };
    const ordered: readonly [LaunchRefusalReason, Guard][] = [
      ["resolution", checks.resolution],
      ["enablement", checks.enablement],
      ["availability", checks.availability],
      ["capability-floor", checks.capabilityFloor],
    ];
    for (const [reason, guard] of ordered) {
      const detail = await guard(candidate);
      if (detail !== null) return { refusal: { reason, detail } };
    }
    const effort = await checks.effort(candidate);
    if (effort.refusal !== null) {
      return { refusal: { reason: "effort", detail: effort.refusal } };
    }
    if (effort.effort === undefined) delete candidate.effort;
    else candidate.effort = effort.effort;
    return { authorized: new AuthorizedLaunch(candidate) };
  }
}

/** Runtime half of the adapter boundary; structural impostors are refused. */
export function requireAuthorizedLaunch(value: AuthorizedLaunch): AuthorizedLaunch {
  if (!(value instanceof AuthorizedLaunch)) {
    throw new TypeError("Launch adapter requires an AuthorizedLaunch from the gate");
  }
  return value;
}
