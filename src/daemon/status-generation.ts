export type StatusIncarnationGenerationResult =
  | Readonly<{ kind: "available"; generation: number }>
  | Readonly<{
    kind: "unavailable";
    reason: "SESSION_LOCATOR_UNAVAILABLE";
  }>;

export interface StatusIncarnationGenerationSource {
  currentForAgent(agentId: string): Promise<StatusIncarnationGenerationResult>;
}

export const unavailableStatusIncarnationGenerationSource:
  StatusIncarnationGenerationSource = {
  async currentForAgent() {
    return { kind: "unavailable", reason: "SESSION_LOCATOR_UNAVAILABLE" };
  },
};

export class StatusIncarnationUnavailableError extends Error {
  readonly code = "STATUS_INCARNATION_UNAVAILABLE";

  constructor(reason: "SESSION_LOCATOR_UNAVAILABLE") {
    super(
      `STATUS_INCARNATION_UNAVAILABLE: ${reason}: ` +
        "no persisted session locator generation is bound to the caller",
    );
    this.name = "StatusIncarnationUnavailableError";
  }
}
