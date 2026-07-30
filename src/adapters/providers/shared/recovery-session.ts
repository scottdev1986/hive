// Shared rules for finding the vendor conversation a crashed agent was in, so
// it can be resumed rather than restarted. Every provider stores its own
// transcript in its own shape — claude a per-project .jsonl, codex a rollout —
// and each adapter reads its own; what they share is the judgement below about
// which artifact is allowed to count as evidence.
//
// The whole module fails closed, because the cost of the two answers is not
// symmetric. Resuming the wrong conversation hands an agent someone else's
// context and the mistake is invisible from the outside; resuming nothing
// costs a fresh start, which is what the caller would have done anyway. So an
// artifact that cannot be read, parsed, or dated is an error rather than a
// skipped candidate, and two plausible artifacts are an error rather than a
// guess between them.

export type RecoverySessionDiscoveryFailure =
  | "invalid-evidence"
  | "ambiguous-artifacts";

export class RecoverySessionDiscoveryError extends Error {
  override readonly name = "RecoverySessionDiscoveryError";

  constructor(
    readonly reason: RecoverySessionDiscoveryFailure,
    message: string,
  ) {
    super(message);
  }
}

/** File mtimes are append times; recovery evidence must come from the vendor
 * artifact itself. */
export interface RecoverySessionArtifact {
  sessionId: string;
  createdAtMs: number;
  path: string;
}

export function isMissingRecoveryArtifact(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function invalidRecoveryArtifactEvidence(
  provider: string,
  path: string,
  detail: string,
): never {
  throw new RecoverySessionDiscoveryError(
    "invalid-evidence",
    `${provider} recovery artifact ${detail}: ${path}`,
  );
}

export function recoveryArtifactTimestamp(
  provider: string,
  path: string,
  value: unknown,
): number {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return invalidRecoveryArtifactEvidence(
    provider,
    path,
    "has no valid creation timestamp",
  );
}

/**
 * The one session belonging to this agent, or null if it never started one.
 *
 * The agent's own creation time is the filter: a worktree gets reused, so the
 * the same directory can hold transcripts from other agents. Creation time is
 * the only evidence that distinguishes them.
 *
 * More than one survivor throws rather than picking the newest. Two artifacts
 * dated after this agent was created violates the lookup's one-agent,
 * one-conversation assumption, and a tiebreak
 * would be inventing an answer that the caller could not tell from a real one.
 */
export function selectRecoverySessionId(
  provider: string,
  agentCreatedAt: string,
  artifacts: readonly RecoverySessionArtifact[],
): string | null {
  const threshold = Date.parse(agentCreatedAt);
  if (!Number.isFinite(threshold)) {
    throw new RecoverySessionDiscoveryError(
      "invalid-evidence",
      `Invalid agent creation timestamp for ${provider} recovery`,
    );
  }
  const [artifact, ...ambiguous] = artifacts.filter(
    (candidate) => candidate.createdAtMs >= threshold,
  );
  if (artifact === undefined) return null;
  if (ambiguous.length > 0) {
    throw new RecoverySessionDiscoveryError(
      "ambiguous-artifacts",
      `Ambiguous ${provider} recovery artifacts: ${[artifact, ...ambiguous].map((candidate) => candidate.path).join(", ")}`,
    );
  }
  return artifact.sessionId;
}
