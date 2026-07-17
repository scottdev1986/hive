import {
  TERMINAL_EVIDENCE_CONTRACTS,
  type ProviderEvidenceResult,
  type ProviderSurfaceId,
  type ReadinessEvidenceKind,
  type ReceiptEvidenceKind,
} from "../../schemas/provider-manifest";

/**
 * Readiness / receipt evidence collection for §25.
 * Evidence only — no delivery scheduling, injection, ledger, or status fusion.
 *
 * Fail-closed rules:
 * - missing or misspelled keys → evidence-absent (not ready, not a negative claim)
 * - unknown notification / modal types → blocked-unknown (never ready)
 * - capability this surface lacks → capability-absent
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readBoolean = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

function result(
  surface: ProviderSurfaceId,
  readiness: ReadinessEvidenceKind,
  receipt: ReceiptEvidenceKind,
  observedPath: string,
  means: string,
  excludes: readonly string[] = [],
): ProviderEvidenceResult {
  return {
    surface,
    readiness,
    receipt,
    observedPath,
    means,
    excludes: [...excludes],
  };
}

function absent(
  surface: ProviderSurfaceId,
  observedPath: string,
  means: string,
): ProviderEvidenceResult {
  return result(
    surface,
    "evidence-absent",
    "evidence-absent",
    observedPath,
    means,
    ["ready", "provider-observed", "negative-claim-from-absence"],
  );
}

function capabilityAbsent(
  surface: ProviderSurfaceId,
  observedPath: string,
  means: string,
): ProviderEvidenceResult {
  return result(
    surface,
    "capability-absent",
    "capability-absent",
    observedPath,
    means,
    ["ready", "provider-observed", "fabricated-hook"],
  );
}

/** Claude notification_type measured blocked in daemon/server.ts:396-407. */
export const CLAUDE_PERMISSION_PROMPT_TYPE = "permission_prompt" as const;
/** Claude idle notification; does not prove ready by itself without Stop. */
export const CLAUDE_IDLE_PROMPT_TYPE = "idle_prompt" as const;

/**
 * Classify a single Claude/Codex TUI hook observation (Hive HookEvent shape).
 * Callers pass the recorded fixture object; field access is exact-key only.
 */
export function classifyHookObservation(
  surface: "claude-tui" | "codex-tui",
  observation: unknown,
): ProviderEvidenceResult {
  if (!isRecord(observation)) {
    return absent(surface, "observation", "observation is not a record");
  }

  const kind = readString(observation, "kind");
  if (kind === undefined) {
    return absent(
      surface,
      "kind",
      "kind missing or non-string — evidence-absent (positive control: valid kind classifies)",
    );
  }

  switch (kind) {
    case "session-start":
      return result(
        surface,
        "ready",
        "provider-observed",
        "kind=session-start",
        "SessionStart proves provider session ready under host/process health",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    case "turn-start":
      return result(
        surface,
        "busy",
        "provider-observed",
        "kind=turn-start",
        "UserPromptSubmit / turn-start is a provider boundary after submission",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    case "turn-end":
      return result(
        surface,
        "ready",
        "provider-observed",
        "kind=turn-end",
        "Stop / turn-end proves idle/ready turn boundary",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    case "tool-boundary":
      return result(
        surface,
        "turn-boundary",
        "provider-observed",
        "kind=tool-boundary",
        "PostToolUse is the mid-turn safe boundary (steer), not idle ready",
        [
          ...TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
          "idle-ready-for-normal-injection",
        ],
      );
    case "notification": {
      // Exact key notificationType only — misspellings are evidence-absent.
      const notificationType = readString(observation, "notificationType");
      if (notificationType === undefined) {
        return absent(
          surface,
          "notificationType",
          "notification without notificationType is evidence-absent (not ready)",
        );
      }
      if (notificationType === CLAUDE_PERMISSION_PROMPT_TYPE) {
        return result(
          surface,
          "awaiting-approval",
          "evidence-absent",
          "notificationType=permission_prompt",
          "permission_prompt is a measured blocked dialog; no structured reply path",
          ["ready", "auto-dismiss", "provider-observed-of-message"],
        );
      }
      if (notificationType === CLAUDE_IDLE_PROMPT_TYPE) {
        // idle_prompt alone does not re-classify ready; Stop/session-start does.
        return result(
          surface,
          "evidence-absent",
          "evidence-absent",
          "notificationType=idle_prompt",
          "idle_prompt is not readiness proof; Stop/SessionStart remain authoritative",
          ["ready", "busy"],
        );
      }
      // §25: unknown notification types block automated delivery until classified.
      return result(
        surface,
        "blocked-unknown",
        "evidence-absent",
        `notificationType=${notificationType}`,
        "unknown notification type blocks automated delivery until classified",
        ["ready", "timer-substitute", "screen-phrase"],
      );
    }
    case "approval-request":
      return result(
        surface,
        "awaiting-approval",
        "evidence-absent",
        "kind=approval-request",
        "structured approval-request blocks ready injection",
        ["ready"],
      );
    case "session-end":
    case "dead":
      return result(
        surface,
        "disconnected",
        "attempt-in-doubt",
        `kind=${kind}`,
        "session-end/dead loses the proof boundary at process teardown",
        TERMINAL_EVIDENCE_CONTRACTS["attempt-in-doubt"].excludes,
      );
    case "session-launch":
      return result(
        surface,
        "restarting",
        "evidence-absent",
        "kind=session-launch",
        "session-launch is process lifecycle spawning, not provider UI ready",
        ["ready", "idle"],
      );
    default:
      return result(
        surface,
        "blocked-unknown",
        "evidence-absent",
        `kind=${kind}`,
        "unclassified hook kind blocks automated delivery until classified",
        ["ready"],
      );
  }
}

/**
 * Classify a Codex app-server RPC notification / request observation.
 * Shapes mirror codex-app-server.ts handleNotification / handleRequest.
 */
export function classifyCodexAppServerObservation(
  observation: unknown,
): ProviderEvidenceResult {
  const surface: ProviderSurfaceId = "codex-app-server";
  if (!isRecord(observation)) {
    return absent(surface, "observation", "observation is not a record");
  }

  // Notifications use `method`; responses may use nested turn/thread.
  const method = readString(observation, "method");
  if (method === undefined) {
    // Allow hive-normalized kind for fixtures that already map notifications.
    const kind = readString(observation, "kind");
    if (kind === "session-start") {
      return result(
        surface,
        "ready",
        "provider-observed",
        "kind=session-start",
        "native thread/session start is ready evidence",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    }
    if (kind === "turn-start") {
      return result(
        surface,
        "busy",
        "provider-observed",
        "kind=turn-start",
        "native turn/started is busy + provider-observed boundary",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    }
    if (kind === "turn-end") {
      return result(
        surface,
        "ready",
        "provider-observed",
        "kind=turn-end",
        "native turn/completed is ready + provider-observed boundary",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    }
    if (kind === "approval-request") {
      return result(
        surface,
        "awaiting-approval",
        "evidence-absent",
        "kind=approval-request",
        "structured approval request blocks ready",
        ["ready"],
      );
    }
    if (kind === "session-end" || kind === "dead") {
      return result(
        surface,
        "disconnected",
        "attempt-in-doubt",
        `kind=${kind}`,
        "session teardown loses the native proof boundary",
        TERMINAL_EVIDENCE_CONTRACTS["attempt-in-doubt"].excludes,
      );
    }
    return absent(
      surface,
      "method|kind",
      "method and kind both missing — evidence-absent",
    );
  }

  switch (method) {
    case "turn/started":
      return result(
        surface,
        "busy",
        "provider-observed",
        "method=turn/started",
        "native turn/started is busy and a provider boundary",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    case "turn/completed":
      return result(
        surface,
        "ready",
        "provider-observed",
        "method=turn/completed",
        "native turn/completed is ready and a provider boundary",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    case "thread/tokenUsage/updated":
    case "account/rateLimits/updated":
      return result(
        surface,
        "evidence-absent",
        "evidence-absent",
        `method=${method}`,
        "quota/token notifications are not readiness or receipt evidence",
        ["ready", "busy"],
      );
    default: {
      if (method.includes("requestApproval")) {
        return result(
          surface,
          "awaiting-approval",
          "evidence-absent",
          `method=${method}`,
          "structured approval method blocks ready until resolved",
          ["ready"],
        );
      }
      if (method === "mcpServer/elicitation/request") {
        // codex-app-server declines this without queuing; treat as blocked-unknown
        // for automated delivery classification (not a classified approval path).
        return result(
          surface,
          "blocked-unknown",
          "evidence-absent",
          `method=${method}`,
          "elicitation request is not a classified readiness path for automation",
          ["ready"],
        );
      }
      // Unsupported methods throw in handleRequest — classify as blocked-unknown.
      return result(
        surface,
        "blocked-unknown",
        "evidence-absent",
        `method=${method}`,
        "unclassified app-server method blocks automated delivery until classified",
        ["ready"],
      );
    }
  }
}

/**
 * Classify Grok TUI evidence from process health + transcript telemetry.
 * No hook boundaries exist — never fabricate them.
 */
export function classifyGrokObservation(
  observation: unknown,
): ProviderEvidenceResult {
  const surface: ProviderSurfaceId = "grok-tui";
  if (!isRecord(observation)) {
    return absent(surface, "observation", "observation is not a record");
  }

  // Explicit capability probe: callers may ask about hooks.
  const probe = readString(observation, "capabilityProbe");
  if (probe !== undefined) {
    if (
      probe === "SessionStart" ||
      probe === "UserPromptSubmit" ||
      probe === "Stop" ||
      probe === "PostToolUse" ||
      probe === "Notification"
    ) {
      return capabilityAbsent(
        surface,
        `capabilityProbe=${probe}`,
        "Grok TUI has no lifecycle hooks; capability absent (never fabricate)",
      );
    }
  }

  const processState = readString(observation, "processState");
  if (processState === "dead" || processState === "missing") {
    return result(
      surface,
      "disconnected",
      "attempt-in-doubt",
      `processState=${processState}`,
      "process not alive — proof boundary lost",
      TERMINAL_EVIDENCE_CONTRACTS["attempt-in-doubt"].excludes,
    );
  }
  if (processState === "restarting") {
    return result(
      surface,
      "restarting",
      "evidence-absent",
      "processState=restarting",
      "process restarting; preassigned session id may reattach",
      ["ready"],
    );
  }

  // Possible modal without structured proof (§25 Grok row): blocks automation.
  const possibleModal = readBoolean(observation, "possibleModal");
  if (possibleModal === true) {
    return result(
      surface,
      "blocked-unknown",
      "evidence-absent",
      "possibleModal=true",
      "no structured modal proof in v1; possible modal blocks automatic delivery",
      ["ready", "screen-phrase"],
    );
  }

  // Exact keys only for transcript telemetry (tool-telemetry GrokTelemetry shape).
  const lastActivityAt = readString(observation, "lastActivityAt");
  const turnCompleted = observation["turnCompleted"];
  const hasTurnCompletedField = Object.prototype.hasOwnProperty.call(
    observation,
    "turnCompleted",
  );

  if (processState === "alive" && lastActivityAt === undefined && !hasTurnCompletedField) {
    return result(
      surface,
      "evidence-absent",
      "evidence-absent",
      "processState=alive",
      "process health alone is not idle/ready without transcript activity",
      ["ready", "busy", "provider-observed"],
    );
  }

  if (hasTurnCompletedField) {
    if (turnCompleted === true) {
      return result(
        surface,
        "ready",
        "provider-observed",
        "turnCompleted=true",
        "updates.jsonl last record turn_completed — idle ready; activity can reconcile receipt",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    }
    if (turnCompleted === false) {
      return result(
        surface,
        "busy",
        "provider-observed",
        "turnCompleted=false",
        "transcript shows turn still streaming",
        TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes,
      );
    }
    if (turnCompleted === null) {
      return absent(
        surface,
        "turnCompleted",
        "turnCompleted null means unknown — not idle and not working",
      );
    }
    // Wrong type (string etc.) — evidence-absent, not ready.
    return absent(
      surface,
      "turnCompleted",
      "turnCompleted present but not boolean|null — evidence-absent",
    );
  }

  if (lastActivityAt !== undefined) {
    return result(
      surface,
      "evidence-absent",
      "provider-observed",
      "lastActivityAt",
      "transcript activity advanced; without turnCompleted readiness stays unknown",
      ["ready", "understood", "applied"],
    );
  }

  // Misspelled keys (e.g. lastActivtyAt) fall through here.
  return absent(
    surface,
    "known-fields",
    "no recognized Grok evidence fields — evidence-absent (check key spelling)",
  );
}

export function classifyProviderObservation(
  surface: ProviderSurfaceId,
  observation: unknown,
): ProviderEvidenceResult {
  switch (surface) {
    case "claude-tui":
    case "codex-tui":
      return classifyHookObservation(surface, observation);
    case "codex-app-server":
      return classifyCodexAppServerObservation(observation);
    case "grok-tui":
      return classifyGrokObservation(observation);
  }
}
