// Codex execution-identity attestation (SPEC 2/6/13).
//
// The immutable launch identity (executionIdentity/model/effort) is an
// intention; the running identity is a separate fact read from the provider's
// own turn_context. This module compares the two into a fail-closed verdict.
// It never synthesizes an observation from the launch request: an `absent` or
// `unknown` observation leaves `observedIdentity` untouched and only records
// that the verdict could not be confirmed. `matching` is the sole state that
// is required for landing/reattest of any still-running legacy Codex process.
// New Codex writers are refused at launch (codex-containment); this module is
// not a per-mutation authorization gate.

import {
  compareObservedIdentity,
  type ExecutionIdentity,
  type IdentityState,
  type ObservedIdentity,
  type ObservedIdentitySource,
} from "../schemas/agent";
import type { CodexIdentityObservation } from "./tool-telemetry";

/** The attestation result for one observation. `observedIdentity`/`liveModel`/
 * `liveEffort` are null when the observation produced no fresh identity — the
 * caller keeps whatever it last recorded rather than clearing it, but the
 * verdict (`identityState`) always reflects the newest observation. */
export interface CodexIdentityAttestation {
  identityState: IdentityState;
  observedIdentity: ObservedIdentity | null;
  liveModel: string | null;
  liveEffort: string | null;
}

/**
 * Compare a Codex observation against its immutable launch identity.
 *
 * - `observed` -> `matching` when model AND effort equal the launch identity,
 *   else `drift`; the observation is recorded verbatim.
 * - `unknown` -> `unknown`: a live rollout that yields no complete identity.
 *   Fail closed without fabricating an observation.
 * - `absent` -> `unattested`: nothing has been observed yet.
 *
 * Never derives an observation from `launch`: the whole point of the field is
 * to stop a guess from standing in for a measurement.
 */
export function reconcileCodexIdentity(
  launch: ExecutionIdentity,
  observation: CodexIdentityObservation,
  source: ObservedIdentitySource = "codex-rollout",
): CodexIdentityAttestation {
  if (observation.status === "absent") {
    return {
      identityState: "unattested",
      observedIdentity: null,
      liveModel: null,
      liveEffort: null,
    };
  }
  if (observation.status === "unknown") {
    return {
      identityState: "unknown",
      observedIdentity: null,
      liveModel: null,
      liveEffort: null,
    };
  }
  const observedIdentity: ObservedIdentity = {
    model: observation.model,
    effort: observation.effort,
    source,
    observedAt: observation.observedAt,
    ...(observation.sessionId === undefined
      ? {}
      : { sessionId: observation.sessionId }),
    ...(observation.turnId === null ? {} : { turnId: observation.turnId }),
  };
  return {
    identityState: compareObservedIdentity(launch, observedIdentity),
    observedIdentity,
    liveModel: observation.model,
    liveEffort: observation.effort,
  };
}

/** True when two observations are the same measurement, so the sweep can skip a
 * no-op write. A different turn (new `observedAt`/`turnId`) is a fresh
 * observation even when the model and effort are unchanged. */
export function sameObservedIdentity(
  current: ObservedIdentity | undefined,
  next: ObservedIdentity,
): boolean {
  if (current === undefined) return false;
  return current.model === next.model && current.effort === next.effort &&
    current.turnId === next.turnId && current.sessionId === next.sessionId &&
    current.source === next.source && current.observedAt === next.observedAt;
}
