import {
  CAPABILITY_PROVIDERS,
  type CapabilityProvider,
} from "../../src/schemas/capability";
import { TaskIdSchema } from "../../src/schemas/hierarchy-ids";

export const U5_FULL_SCOPE = "five-live-v1" as const;
export const U5_PARTIAL_SCOPE = "three-live-two-measured-blocks-v1" as const;
export const U5_REQUIRED_LIVE_PROVIDERS = [
  "claude",
  "codex",
  "opencode",
] as const;

export type U5Scope = typeof U5_FULL_SCOPE | typeof U5_PARTIAL_SCOPE;
export type U5ProviderOutcome =
  | "pending-attestation"
  | "attested"
  | "quota-blocked"
  | "schema-blocked"
  | "launch-refused"
  | "unknown";

export interface U5SpawnRequest {
  provider: CapabilityProvider;
  marker: string;
  state: "pending" | "admitted" | "refused" | "unknown";
  admissionId?: string;
  refusalReadback?: { state?: unknown };
}

export interface U5AgentRow {
  id: string;
  taskDescription: string;
}

export function requireU5WorkspaceApp(
  env: Readonly<Record<string, string | undefined>>,
): {
  executablePath: string;
  readyPath: string;
  releasePath: string;
  feedReceiptPath: string;
} {
  const executablePath = env.HIVE_QA_U5_APP_EXECUTABLE;
  const readyPath = env.HIVE_QA_U5_APP_READY_PATH;
  const releasePath = env.HIVE_QA_U5_APP_RELEASE_PATH;
  const feedReceiptPath = env.HIVE_QA_U5_APP_FEED_RECEIPT;
  if (
    executablePath === undefined ||
    executablePath.length === 0 ||
    readyPath === undefined ||
    readyPath.length === 0 ||
    releasePath === undefined ||
    releasePath.length === 0 ||
    feedReceiptPath === undefined ||
    feedReceiptPath.length === 0
  ) {
    throw new Error(
      "U5 Workspace SIGKILL proof requires HIVE_QA_U5_APP_EXECUTABLE, " +
        "HIVE_QA_U5_APP_READY_PATH, HIVE_QA_U5_APP_RELEASE_PATH, and " +
        "HIVE_QA_U5_APP_FEED_RECEIPT for a " +
        "prebuilt Workspace app; the rig never invokes make run",
    );
  }
  return { executablePath, readyPath, releasePath, feedReceiptPath };
}

export function requireU5SpawnTaskId(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const taskId = env.HIVE_QA_U5_TASK_ID;
  if (taskId === undefined || taskId.length === 0) {
    throw new Error(
      "U5 live spawn requires HIVE_QA_U5_TASK_ID; the harness does not mint a board task",
    );
  }
  return TaskIdSchema.parse(taskId);
}

export function classifyViewerReadback(
  completeness: "complete" | "gap",
  screen: string,
):
  | Readonly<{
      state: "observed-complete";
      completeness: "complete";
      nonEmptyScreen: true;
    }>
  | Readonly<{
      state: "not-established";
      completeness: "complete" | "gap";
      nonEmptyScreen: boolean;
      reason: string;
    }> {
  const nonEmptyScreen = screen.trim().length > 0;
  if (completeness === "complete" && nonEmptyScreen) {
    return { state: "observed-complete", completeness, nonEmptyScreen };
  }
  return {
    state: "not-established",
    completeness,
    nonEmptyScreen,
    reason:
      "the auxiliary readback client does not decode checkpoint snapshots; replay completeness is unclaimed",
  };
}

export function resolveU5Scope(rawScope: string | undefined): {
  scope: U5Scope;
  scopedPartial: boolean;
  attemptProviders: readonly CapabilityProvider[];
} {
  const scope = rawScope ?? U5_FULL_SCOPE;
  if (scope === U5_FULL_SCOPE) {
    return {
      scope,
      scopedPartial: false,
      attemptProviders: [...CAPABILITY_PROVIDERS],
    };
  }
  if (scope === U5_PARTIAL_SCOPE) {
    return {
      scope,
      scopedPartial: true,
      attemptProviders: [...U5_REQUIRED_LIVE_PROVIDERS, "grok", "kimi"],
    };
  }
  throw new Error(`unsupported HIVE_QA_U5_SCOPE: ${scope}`);
}

export function summarizeProviderOutcomes(
  attemptProviders: readonly CapabilityProvider[],
  outcomes: ReadonlyMap<CapabilityProvider, U5ProviderOutcome>,
): {
  result: "passed" | "partial";
  acceptance: "met" | "not-met";
  attestedProviders: CapabilityProvider[];
  blockedProviders: CapabilityProvider[];
} {
  const orderedOutcomes = attemptProviders.map((provider) => {
    const outcome = outcomes.get(provider);
    if (outcome === undefined) {
      throw new Error(`${provider} has no provider outcome`);
    }
    return { provider, outcome };
  });
  if (
    orderedOutcomes.some(
      ({ outcome }) =>
        outcome === "pending-attestation" || outcome === "unknown",
    )
  ) {
    throw new Error("one or more provider outcomes stayed indeterminate");
  }
  const attestedProviders = orderedOutcomes.flatMap(({ provider, outcome }) =>
    outcome === "attested" ? [provider] : [],
  );
  const blockedProviders = orderedOutcomes.flatMap(({ provider, outcome }) =>
    outcome === "quota-blocked" ||
    outcome === "schema-blocked" ||
    outcome === "launch-refused"
      ? [provider]
      : [],
  );
  const attempted = new Set(attemptProviders);
  const acceptanceMet =
    attemptProviders.length === CAPABILITY_PROVIDERS.length &&
    attempted.size === CAPABILITY_PROVIDERS.length &&
    CAPABILITY_PROVIDERS.every(
      (provider) =>
        attempted.has(provider) && outcomes.get(provider) === "attested",
    ) &&
    blockedProviders.length === 0;
  return {
    result: acceptanceMet ? "passed" : "partial",
    acceptance: acceptanceMet ? "met" : "not-met",
    attestedProviders,
    blockedProviders,
  };
}

export function finalU5Result(
  proof: "passed" | "partial" | "failed",
  cleanup: "clean" | "failed" | "unknown",
  routingRestore: "restored" | "failed",
): {
  result: "passed" | "partial" | "failed";
  acceptance: "met" | "not-met";
  exitCode: 0 | 1;
} {
  const passed =
    proof === "passed" && cleanup === "clean" && routingRestore === "restored";
  const partial =
    proof === "partial" && cleanup === "clean" && routingRestore === "restored";
  return {
    result: passed ? "passed" : partial ? "partial" : "failed",
    acceptance: passed ? "met" : "not-met",
    exitCode: passed ? 0 : 1,
  };
}

export function reconcileSpawnRequests(
  requests: readonly U5SpawnRequest[],
  targets: readonly U5AgentRow[],
): {
  complete: boolean;
  requestCount: number;
  admittedIds: string[];
  missingAdmissionIds: string[];
  refusedSideEffectIds: string[];
  unknownProviders: CapabilityProvider[];
  invalidAdmissionProviders: CapabilityProvider[];
  refusalReadbacksComplete: boolean;
} {
  const admitted = requests.filter((request) => request.state === "admitted");
  const admittedIds = admitted.flatMap((request) =>
    request.admissionId === undefined ? [] : [request.admissionId],
  );
  const invalidAdmissionProviders = admitted.flatMap((request) =>
    request.admissionId === undefined ? [request.provider] : [],
  );
  const missingAdmissionIds = admittedIds.filter(
    (id) => !targets.some((target) => target.id === id),
  );
  const refused = requests.filter((request) => request.state === "refused");
  const refusedSideEffectIds = targets.flatMap((target) =>
    refused.some((request) => target.taskDescription.includes(request.marker))
      ? [target.id]
      : [],
  );
  const unknownProviders = requests.flatMap((request) =>
    request.state === "pending" || request.state === "unknown"
      ? [request.provider]
      : [],
  );
  const refusalReadbacksComplete = refused.every(
    (request) => request.refusalReadback?.state === "absent",
  );
  const complete =
    invalidAdmissionProviders.length === 0 &&
    missingAdmissionIds.length === 0 &&
    refusedSideEffectIds.length === 0 &&
    unknownProviders.length === 0 &&
    refusalReadbacksComplete;
  return {
    complete,
    requestCount: requests.length,
    admittedIds,
    missingAdmissionIds,
    refusedSideEffectIds,
    unknownProviders,
    invalidAdmissionProviders,
    refusalReadbacksComplete,
  };
}
