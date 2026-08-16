import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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

export function requireU5AccountabilityTaskId(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const taskId = env.HIVE_QA_U5_ACCOUNTABILITY_TASK_ID;
  if (taskId === undefined || taskId.length === 0) {
    throw new Error(
      "U5 live evidence requires HIVE_QA_U5_ACCOUNTABILITY_TASK_ID; the harness does not default a live-board id",
    );
  }
  return TaskIdSchema.parse(taskId);
}

/** Sessiond's AF_UNIX path is built under the resolved QA home. On macOS
 * `/tmp` is `/private/tmp` (13 characters including the trailing slash).
 * This bound is a socket-path fact — do not raise it to fit a longer default.
 * Keep the label short so the per-checkout tag can stay long enough that
 * two worktrees do not silently share a home. */
export const U5_QA_HOME_SOCKET_MAX_LENGTH = 20;
export const QA_HOME_DEFAULT_LABEL = "hq";
export const U5_DEFAULT_QA_HOME_TAG_HEX_LENGTH = 5;
export const QA_HOME_OWNER_STAMP_NAME = "qa-owner";

export function assertQaHomeFitsSocketPath(home: string): string {
  if (home.length > U5_QA_HOME_SOCKET_MAX_LENGTH) {
    throw new Error(
      `QA home is too long for the session host socket path: ${home}`,
    );
  }
  return home;
}

export function isIsolatedQaHomePath(home: string): boolean {
  return (
    home.startsWith("/tmp/hq") ||
    home.startsWith("/private/tmp/hq") ||
    home.startsWith("/tmp/hvqa-") ||
    home.startsWith("/private/tmp/hvqa-")
  );
}

/** The path `rig.sh` uses when QA_HOME is unset. Must stay in lockstep with
 * `qa_default_home_requested` in qa-home.sh. */
export function defaultQaHomeRequested(sourceRoot: string): string {
  const tag = createHash("sha256")
    .update(sourceRoot)
    .digest("hex")
    .slice(0, U5_DEFAULT_QA_HOME_TAG_HEX_LENGTH);
  return `/tmp/${QA_HOME_DEFAULT_LABEL}${tag}`;
}

export function defaultQaHomeResolved(sourceRoot: string): string {
  const requested = defaultQaHomeRequested(sourceRoot);
  try {
    return realpathSync(requested);
  } catch {
    return requested.startsWith("/tmp/")
      ? `/private${requested}`
      : resolve(requested);
  }
}

/** Same-checkout reuse is allowed. A stamp naming a different checkout is a
 * collision and must refuse by name, not silently share the home. */
export function assertQaHomeOwner(
  existingOwner: string | undefined,
  checkoutPath: string,
): void {
  if (existingOwner === undefined || existingOwner.length === 0) return;
  const existing = resolvedPath(existingOwner);
  const checkout = resolvedPath(checkoutPath);
  if (existing !== checkout) {
    throw new Error(`QA_HOME is owned by ${existing}, not ${checkout}`);
  }
}

export function requireHeadlessRootRunning(state: string): void {
  if (state !== "running") {
    throw new Error(
      `U5 headless root open refused: state is ${state}, not running`,
    );
  }
}

export function headlessRootReapVerdict(
  opened: boolean,
  beforeState: "live" | "absent" | "unknown" | null,
  afterState: "live" | "absent" | "unknown" | null,
): "clean" | "failed" | "not-opened" {
  if (!opened) return "not-opened";
  return beforeState === "live" && afterState === "absent" ? "clean" : "failed";
}

function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function assertIsolatedQaHiveHome(
  hiveHome: string,
  userHiveHome: string,
): string {
  const resolvedHome = resolvedPath(hiveHome);
  const resolvedUserHive = resolvedPath(userHiveHome);
  if (
    resolvedHome === resolvedUserHive ||
    resolvedHome.startsWith(`${resolvedUserHive}/`)
  ) {
    throw new Error(
      `U5 fixture-task seeding refuses HIVE_HOME that resolves to the machine hive: ${resolvedHome}`,
    );
  }
  if (!isIsolatedQaHomePath(resolvedHome)) {
    throw new Error(
      `U5 fixture-task seeding refuses a HIVE_HOME that is not an isolated QA root: ${resolvedHome}`,
    );
  }
  return resolvedHome;
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
