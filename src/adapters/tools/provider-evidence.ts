import {
  TERMINAL_EVIDENCE_CONTRACTS,
  type AttemptContext,
  type ProviderEvidenceResult,
  type ProviderSurfaceId,
  type ReadinessEvidenceKind,
  type ReceiptEvidenceKind,
} from "../../schemas/provider-manifest";

/**
 * Readiness / receipt evidence collection for §25.
 * Evidence only — no delivery scheduling, injection, ledger, or status fusion.
 *
 * Receipt ladder (never claim above proven prerequisites):
 * - provider-observed: matching attempt (id + committed + exact session +
 *   observation timestamp AFTER commit) plus adapter boundary marker.
 * - attempt-in-doubt: committed attempt whose proof boundary was lost.
 * - Without attempt context: receipt stays evidence-absent (cannot invent
 *   transport-written; that is sessiond/native commit proof elsewhere).
 *
 * Readiness prerequisites (§25 rows):
 * - Claude/Codex TUI ready: hook kind + processHealth + exact session + no modal.
 * - Codex app-server: native turn/thread ids in params, not method string alone.
 * - Grok: processState + exact sessionId + activity advancement on that session.
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

const parseTimeMs = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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
    ["ready", "provider-observed", "attempt-in-doubt", "negative-claim-from-absence"],
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

/**
 * Receipt from a boundary observation under optional attempt context.
 * Never upgrades without all matching-attempt prerequisites.
 */
function receiptForBoundary(
  attempt: AttemptContext | undefined,
  observationSessionId: string | undefined,
  observationTimestamp: string | undefined,
): { receipt: ReceiptEvidenceKind; path: string; means: string } {
  if (attempt === undefined) {
    return {
      receipt: "evidence-absent",
      path: "attempt-context",
      means:
        "no attempt context — receipt ceiling is evidence-absent (transport-written requires sessiond/native commit proof elsewhere)",
    };
  }
  if (attempt.committed !== true) {
    return {
      receipt: "evidence-absent",
      path: "attempt.committed",
      means: "attempt not committed — cannot claim provider-observed or in-doubt",
    };
  }
  if (
    observationSessionId === undefined ||
    observationSessionId !== attempt.providerSessionId
  ) {
    return {
      receipt: "evidence-absent",
      path: "providerSessionId",
      means:
        "observation session missing or does not match attempt.providerSessionId",
    };
  }
  const observedMs = parseTimeMs(observationTimestamp);
  const committedMs = parseTimeMs(attempt.committedAt);
  if (observedMs === null || committedMs === null || observedMs <= committedMs) {
    return {
      receipt: "evidence-absent",
      path: "timestamp-after-commit",
      means:
        "observation timestamp missing or not after attempt.committedAt — no later marker",
    };
  }
  return {
    receipt: "provider-observed",
    path: "matching-attempt+boundary",
    means:
      "matching committed attempt, same provider session, later boundary after injection",
  };
}

/**
 * Disconnect/death receipt: attempt-in-doubt only when a committed attempt
 * targeted this session; bare death is disconnected with evidence-absent.
 */
function receiptForLostBoundary(
  attempt: AttemptContext | undefined,
  observationSessionId: string | undefined,
): { receipt: ReceiptEvidenceKind; path: string; means: string } {
  if (attempt === undefined || attempt.committed !== true) {
    return {
      receipt: "evidence-absent",
      path: "attempt-context",
      means:
        "death/disconnect with no committed attempt is not attempt-in-doubt",
    };
  }
  if (
    observationSessionId !== undefined &&
    observationSessionId !== attempt.providerSessionId
  ) {
    return {
      receipt: "evidence-absent",
      path: "providerSessionId",
      means: "disconnect session does not match committed attempt session",
    };
  }
  return {
    receipt: "attempt-in-doubt",
    path: "committed-attempt+lost-boundary",
    means:
      "committed attempt proof boundary lost at disconnect — outcome unknown",
  };
}

/** Claude notification_type measured blocked in daemon/server.ts:396-407. */
export const CLAUDE_PERMISSION_PROMPT_TYPE = "permission_prompt" as const;
export const CLAUDE_IDLE_PROMPT_TYPE = "idle_prompt" as const;

/**
 * Claude/Codex TUI hook observation (Hive HookEvent shape + host prerequisites).
 * Ready requires: kind + processHealth=alive + toolSessionId + unresolvedModal=false.
 */
export function classifyHookObservation(
  surface: "claude-tui" | "codex-tui",
  observation: unknown,
  attempt?: AttemptContext,
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

  // Codex TUI never registers Notification (codex.ts:174-186).
  if (surface === "codex-tui" && kind === "notification") {
    return capabilityAbsent(
      surface,
      "kind=notification",
      "Codex TUI spawn registers no Notification hook — capability absent",
    );
  }
  // Codex TUI has no structured approval-request emission path in adapter hooks.
  if (surface === "codex-tui" && kind === "approval-request") {
    return capabilityAbsent(
      surface,
      "kind=approval-request",
      "Codex TUI has no structured approval hook path — capability absent",
    );
  }

  const toolSessionId = readString(observation, "toolSessionId");
  const timestamp = readString(observation, "timestamp");
  const processHealth = readString(observation, "processHealth");
  const unresolvedModal = readBoolean(observation, "unresolvedModal");

  const hostReady = (): ProviderEvidenceResult | null => {
    if (processHealth === undefined) {
      return absent(
        surface,
        "processHealth",
        "process/host health missing — not ready (§25 requires provider session ID plus host/process health)",
      );
    }
    if (processHealth !== "alive") {
      return result(
        surface,
        "disconnected",
        receiptForLostBoundary(attempt, toolSessionId).receipt,
        `processHealth=${processHealth}`,
        "process/host not alive",
        ["ready"],
      );
    }
    if (toolSessionId === undefined) {
      return absent(
        surface,
        "toolSessionId",
        "exact provider session/generation missing — not ready",
      );
    }
    if (unresolvedModal === undefined) {
      return absent(
        surface,
        "unresolvedModal",
        "unresolvedModal missing — cannot prove no modal; not ready",
      );
    }
    if (unresolvedModal === true) {
      return result(
        surface,
        "blocked-unknown",
        "evidence-absent",
        "unresolvedModal=true",
        "unresolved modal blocks ready and automated delivery",
        ["ready"],
      );
    }
    return null;
  };

  switch (kind) {
    case "session-start":
    case "turn-end": {
      const blocked = hostReady();
      if (blocked !== null) return blocked;
      const r = receiptForBoundary(attempt, toolSessionId, timestamp);
      return result(
        surface,
        "ready",
        r.receipt,
        `kind=${kind}+host-prerequisites`,
        kind === "session-start"
          ? "SessionStart with host health, exact session, no modal"
          : "Stop/turn-end with host health, exact session, no modal",
        r.receipt === "provider-observed"
          ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
          : ["provider-observed"],
      );
    }
    case "turn-start": {
      // Busy does not require "no modal" the same way, but session + health still apply.
      if (processHealth === undefined) {
        return absent(surface, "processHealth", "processHealth missing — not busy proof");
      }
      if (processHealth !== "alive") {
        return result(
          surface,
          "disconnected",
          receiptForLostBoundary(attempt, toolSessionId).receipt,
          `processHealth=${processHealth}`,
          "process not alive",
          ["busy", "ready"],
        );
      }
      if (toolSessionId === undefined) {
        return absent(surface, "toolSessionId", "exact session missing — not busy proof");
      }
      const r = receiptForBoundary(attempt, toolSessionId, timestamp);
      return result(
        surface,
        "busy",
        r.receipt,
        "kind=turn-start+session+health",
        "UserPromptSubmit / turn-start under alive process and exact session",
        r.receipt === "provider-observed"
          ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
          : ["provider-observed"],
      );
    }
    case "tool-boundary": {
      if (processHealth !== "alive" || toolSessionId === undefined) {
        return absent(
          surface,
          "processHealth|toolSessionId",
          "tool-boundary requires alive process and exact session",
        );
      }
      const r = receiptForBoundary(attempt, toolSessionId, timestamp);
      return result(
        surface,
        "turn-boundary",
        r.receipt,
        "kind=tool-boundary",
        "PostToolUse mid-turn safe boundary (steer), not idle ready",
        [
          "idle-ready-for-normal-injection",
          ...(r.receipt === "provider-observed"
            ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
            : ["provider-observed"]),
        ],
      );
    }
    case "notification": {
      // Claude only (codex-tui gated above).
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
        return result(
          surface,
          "evidence-absent",
          "evidence-absent",
          "notificationType=idle_prompt",
          "idle_prompt is not readiness proof; Stop/SessionStart remain authoritative",
          ["ready", "busy"],
        );
      }
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
      // Claude path if ever emitted; codex-tui gated above.
      return result(
        surface,
        "awaiting-approval",
        "evidence-absent",
        "kind=approval-request",
        "structured approval-request blocks ready injection",
        ["ready"],
      );
    case "session-end":
    case "dead": {
      const r = receiptForLostBoundary(attempt, toolSessionId);
      return result(
        surface,
        "disconnected",
        r.receipt,
        `kind=${kind}`,
        r.means,
        r.receipt === "attempt-in-doubt"
          ? TERMINAL_EVIDENCE_CONTRACTS["attempt-in-doubt"].excludes
          : ["attempt-in-doubt"],
      );
    }
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
 * Codex app-server RPC observation.
 * Validates nested turn/thread ids — method string alone is insufficient.
 */
export function classifyCodexAppServerObservation(
  observation: unknown,
  attempt?: AttemptContext,
): ProviderEvidenceResult {
  const surface: ProviderSurfaceId = "codex-app-server";
  if (!isRecord(observation)) {
    return absent(surface, "observation", "observation is not a record");
  }

  const method = readString(observation, "method");
  const params = isRecord(observation.params) ? observation.params : undefined;
  const timestamp = readString(observation, "timestamp");

  const turnId = ((): string | undefined => {
    if (params === undefined) return undefined;
    const turn = params.turn;
    if (!isRecord(turn)) return undefined;
    return readString(turn, "id");
  })();

  const threadId = ((): string | undefined => {
    if (params === undefined) return undefined;
    const direct = readString(params, "threadId");
    if (direct !== undefined) return direct;
    const thread = params.thread;
    if (!isRecord(thread)) return undefined;
    return readString(thread, "id");
  })();

  // Session identity for matching attempts is the thread id when present.
  const sessionId = threadId ?? readString(observation, "toolSessionId");

  if (method === "turn/started") {
    if (turnId === undefined) {
      return absent(
        surface,
        "params.turn.id",
        "turn/started without params.turn.id is not busy proof",
      );
    }
    if (sessionId === undefined) {
      return absent(
        surface,
        "params.threadId|thread.id",
        "turn/started without thread identity is not busy proof",
      );
    }
    const r = receiptForBoundary(attempt, sessionId, timestamp);
    return result(
      surface,
      "busy",
      r.receipt,
      "method=turn/started+params.turn.id",
      "native turn/started with turn id and thread identity",
      r.receipt === "provider-observed"
        ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
        : ["provider-observed"],
    );
  }

  if (method === "turn/completed") {
    if (turnId === undefined) {
      return absent(
        surface,
        "params.turn.id",
        "turn/completed without params.turn.id is not ready proof",
      );
    }
    if (sessionId === undefined) {
      return absent(
        surface,
        "params.threadId|thread.id",
        "turn/completed without thread identity is not ready proof",
      );
    }
    const r = receiptForBoundary(attempt, sessionId, timestamp);
    return result(
      surface,
      "ready",
      r.receipt,
      "method=turn/completed+params.turn.id",
      "native turn/completed with turn id and thread identity",
      r.receipt === "provider-observed"
        ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
        : ["provider-observed"],
    );
  }

  if (method === "thread/tokenUsage/updated" || method === "account/rateLimits/updated") {
    return result(
      surface,
      "evidence-absent",
      "evidence-absent",
      `method=${method}`,
      "quota/token notifications are not readiness or receipt evidence",
      ["ready", "busy"],
    );
  }

  if (method !== undefined && method.includes("requestApproval")) {
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
    return result(
      surface,
      "blocked-unknown",
      "evidence-absent",
      `method=${method}`,
      "elicitation request is not a classified readiness path for automation",
      ["ready"],
    );
  }

  // Hive-normalized kinds emitted after app-server mapping (session-start on thread).
  const kind = readString(observation, "kind");
  if (kind === "session-start") {
    const thread = sessionId ?? readString(observation, "toolSessionId");
    if (thread === undefined) {
      return absent(surface, "toolSessionId|thread", "session-start without thread id");
    }
    if (readString(observation, "processHealth") !== "alive") {
      return absent(surface, "processHealth", "session-start requires processHealth=alive");
    }
    const r = receiptForBoundary(attempt, thread, timestamp);
    return result(
      surface,
      "ready",
      r.receipt,
      "kind=session-start+thread",
      "native thread/session start with identity",
      r.receipt === "provider-observed"
        ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
        : ["provider-observed"],
    );
  }

  if (kind === "dead" || kind === "session-end") {
    const r = receiptForLostBoundary(attempt, sessionId ?? readString(observation, "toolSessionId"));
    return result(
      surface,
      "disconnected",
      r.receipt,
      `kind=${kind}`,
      r.means,
      r.receipt === "attempt-in-doubt"
        ? TERMINAL_EVIDENCE_CONTRACTS["attempt-in-doubt"].excludes
        : ["attempt-in-doubt"],
    );
  }

  if (kind === "session-launch") {
    return result(
      surface,
      "restarting",
      "evidence-absent",
      "kind=session-launch",
      "process lifecycle restart before native thread is ready",
      ["ready"],
    );
  }

  if (method !== undefined) {
    return result(
      surface,
      "blocked-unknown",
      "evidence-absent",
      `method=${method}`,
      "unclassified app-server method blocks automated delivery until classified",
      ["ready"],
    );
  }

  return absent(surface, "method|kind", "method and kind both missing — evidence-absent");
}

/**
 * Grok TUI: process health + preassigned session + transcript activity.
 * No hooks. ready/busy require processState + exact sessionId + activity
 * advancement on that exact session (§25 / §18).
 */
export function classifyGrokObservation(
  observation: unknown,
  attempt?: AttemptContext,
): ProviderEvidenceResult {
  const surface: ProviderSurfaceId = "grok-tui";
  if (!isRecord(observation)) {
    return absent(surface, "observation", "observation is not a record");
  }

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
        "Grok TUI has no lifecycle hooks (grok.ts registers none; GROK_COMPATIBILITY_ENV disables inherited hooks)",
      );
    }
  }

  const processState = readString(observation, "processState");
  const sessionId = readString(observation, "sessionId");
  const lastActivityAt = readString(observation, "lastActivityAt");
  const previousLastActivityAt = readString(observation, "previousLastActivityAt");
  const timestamp = readString(observation, "timestamp") ?? lastActivityAt;

  if (processState === "dead" || processState === "missing") {
    const r = receiptForLostBoundary(attempt, sessionId);
    return result(
      surface,
      "disconnected",
      r.receipt,
      `processState=${processState}`,
      r.means,
      r.receipt === "attempt-in-doubt"
        ? TERMINAL_EVIDENCE_CONTRACTS["attempt-in-doubt"].excludes
        : ["attempt-in-doubt"],
    );
  }

  if (processState === "restarting") {
    return result(
      surface,
      "restarting",
      "evidence-absent",
      "processState=restarting",
      "process restarting; preassigned session id may reattach after relaunch",
      ["ready"],
    );
  }

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

  // Ready/busy prerequisites: processState present, exact sessionId, activity advance.
  if (processState === undefined) {
    return absent(surface, "processState", "processState missing — unknown, not ready/busy");
  }
  if (processState !== "alive") {
    return absent(
      surface,
      "processState",
      `processState=${processState} is not a classified ready/busy state`,
    );
  }
  if (sessionId === undefined) {
    return absent(
      surface,
      "sessionId",
      "exact preassigned session id missing — unknown, not ready/busy",
    );
  }

  const prevMs = parseTimeMs(previousLastActivityAt);
  const lastMs = parseTimeMs(lastActivityAt);
  const activityAdvanced =
    prevMs !== null && lastMs !== null && lastMs > prevMs;

  if (!activityAdvanced) {
    return absent(
      surface,
      "previousLastActivityAt|lastActivityAt",
      "activity advancement on exact session not proven — unknown, not ready/busy",
    );
  }

  // Session must match attempt when claiming receipt.
  const turnCompleted = observation["turnCompleted"];
  const hasTurnCompleted = Object.prototype.hasOwnProperty.call(
    observation,
    "turnCompleted",
  );

  if (hasTurnCompleted && turnCompleted === true) {
    const r = receiptForBoundary(attempt, sessionId, timestamp);
    return result(
      surface,
      "ready",
      r.receipt,
      "processState+sessionId+activity-advance+turnCompleted=true",
      "alive process, exact session, activity advanced, turn_completed",
      r.receipt === "provider-observed"
        ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
        : ["provider-observed"],
    );
  }

  if (hasTurnCompleted && turnCompleted === false) {
    const r = receiptForBoundary(attempt, sessionId, timestamp);
    return result(
      surface,
      "busy",
      r.receipt,
      "processState+sessionId+activity-advance+turnCompleted=false",
      "alive process, exact session, activity advanced, turn still streaming",
      r.receipt === "provider-observed"
        ? TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes
        : ["provider-observed"],
    );
  }

  if (hasTurnCompleted && turnCompleted === null) {
    return absent(
      surface,
      "turnCompleted",
      "turnCompleted null means unknown — not idle and not working",
    );
  }

  // Activity advanced but turn state unknown — not ready/busy.
  return absent(
    surface,
    "turnCompleted",
    "activity advanced but turnCompleted absent/invalid — readiness unknown",
  );
}

export function classifyProviderObservation(
  surface: ProviderSurfaceId,
  observation: unknown,
  attempt?: AttemptContext,
): ProviderEvidenceResult {
  switch (surface) {
    case "claude-tui":
    case "codex-tui":
      return classifyHookObservation(surface, observation, attempt);
    case "codex-app-server":
      return classifyCodexAppServerObservation(observation, attempt);
    case "grok-tui":
      return classifyGrokObservation(observation, attempt);
  }
}
