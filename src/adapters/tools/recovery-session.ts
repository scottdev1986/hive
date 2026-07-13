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
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
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
  const eligible = artifacts.filter((artifact) =>
    artifact.createdAtMs >= threshold
  );
  if (eligible.length === 0) return null;
  if (eligible.length > 1) {
    throw new RecoverySessionDiscoveryError(
      "ambiguous-artifacts",
      `Ambiguous ${provider} recovery artifacts: ${eligible.map((artifact) => artifact.path).join(", ")}`,
    );
  }
  return eligible[0]!.sessionId;
}
