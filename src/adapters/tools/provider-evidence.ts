import {
  AttemptContextSchema,
  TERMINAL_EVIDENCE_CONTRACTS,
  type AttemptContext,
  type ProviderEvidenceResult,
  type ProviderSurfaceId,
  type ReadinessEvidenceKind,
  type ReceiptEvidenceKind,
} from "../../schemas/provider-manifest";

/**
 * Readiness / receipt evidence collection for §25.
 * Evidence only — no delivery, injection, ledger, or status fusion.
 *
 * Receipt ladder:
 * - provider-observed: valid AttemptContext + committed + exact nonempty
 *   session match + observation timestamp AFTER commit + boundary.
 * - attempt-in-doubt: valid AttemptContext + committed + exact nonempty
 *   observationSessionId equality + loss timestamp >= committedAt.
 * - Invalid/misspelled attempt fields → treat as no attempt (evidence-absent).
 *
 * Grok: grounded only in what grok.ts reads (summary.json location/mtime +
 * preassigned session identity). Process health is a host fact. No
 * updates.jsonl / turn_completed.
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

const readFiniteNumber = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const parseTimeMs = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Fail-closed attempt parse. Misspelled keys (e.g. atemptId) or missing
 * attemptId → undefined (no attempt), never a partial upgrade path.
 */
export function parseAttemptContext(raw: unknown): AttemptContext | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = AttemptContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

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

/** Receipt for a post-injection boundary. Exported raw input parses fail-closed. */
export function receiptForBoundary(
  attemptRaw: unknown,
  observationSessionId: string | undefined,
  observationTimestamp: string | undefined,
): { receipt: ReceiptEvidenceKind; path: string; means: string } {
  const attempt = parseAttemptContext(attemptRaw);
  if (attempt === undefined) {
    return {
      receipt: "evidence-absent",
      path: "attempt-context",
      means:
        "no valid attempt context — receipt ceiling is evidence-absent",
    };
  }
  if (attempt.committed !== true) {
    return {
      receipt: "evidence-absent",
      path: "attempt.committed",
      means: "attempt not committed — cannot claim provider-observed",
    };
  }
  if (
    observationSessionId === undefined ||
    observationSessionId.length === 0 ||
    observationSessionId !== attempt.providerSessionId
  ) {
    return {
      receipt: "evidence-absent",
      path: "providerSessionId",
      means:
        "observation session missing/empty or does not match attempt.providerSessionId",
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
 * attempt-in-doubt only when:
 * - valid committed attempt
 * - exact NONEMPTY observationSessionId === attempt.providerSessionId
 * - valid loss timestamp with lossMs >= committedAt
 * Missing session, missing timestamp, or pre-commit timestamp → evidence-absent.
 */
export function receiptForLostBoundary(
  attemptRaw: unknown,
  observationSessionId: string | undefined,
  lossTimestamp: string | undefined,
): { receipt: ReceiptEvidenceKind; path: string; means: string } {
  const attempt = parseAttemptContext(attemptRaw);
  if (attempt === undefined || attempt.committed !== true) {
    return {
      receipt: "evidence-absent",
      path: "attempt-context",
      means:
        "death/disconnect with no valid committed attempt is not attempt-in-doubt",
    };
  }
  if (
    observationSessionId === undefined ||
    observationSessionId.length === 0
  ) {
    return {
      receipt: "evidence-absent",
      path: "observationSessionId",
      means:
        "missing/empty observation session — not attempt-in-doubt",
    };
  }
  if (observationSessionId !== attempt.providerSessionId) {
    return {
      receipt: "evidence-absent",
      path: "providerSessionId",
      means: "disconnect session does not equal committed attempt session",
    };
  }
  const lossMs = parseTimeMs(lossTimestamp);
  const committedMs = parseTimeMs(attempt.committedAt);
  if (lossMs === null || committedMs === null) {
    return {
      receipt: "evidence-absent",
      path: "lossTimestamp",
      means: "missing or invalid loss timestamp — not attempt-in-doubt",
    };
  }
  if (lossMs < committedMs) {
    return {
      receipt: "evidence-absent",
      path: "lossTimestamp",
      means: "loss timestamp before commit — not attempt-in-doubt",
    };
  }
  return {
    receipt: "attempt-in-doubt",
    path: "committed-attempt+lost-boundary",
    means:
      "committed attempt proof boundary lost at/after commit under same session",
  };
}

export const CLAUDE_PERMISSION_PROMPT_TYPE = "permission_prompt" as const;
export const CLAUDE_IDLE_PROMPT_TYPE = "idle_prompt" as const;

export function classifyHookObservation(
  surface: "claude-tui" | "codex-tui",
  observation: unknown,
  attemptRaw?: unknown,
): ProviderEvidenceResult {
  const attempt = parseAttemptContext(attemptRaw);
  if (!isRecord(observation)) {
    return absent(surface, "observation", "observation is not a record");
  }

  // Capability probes — not fabricated provider payloads.
  const capabilityProbe = readString(observation, "capabilityProbe");
  if (capabilityProbe !== undefined) {
    if (surface === "codex-tui") {
      if (
        capabilityProbe === "structured-approval" ||
        capabilityProbe === "Notification" ||
        capabilityProbe === "structured-modal"
      ) {
        return capabilityAbsent(
          surface,
          `capabilityProbe=${capabilityProbe}`,
          "codex.ts:174-186 registers SessionStart/UserPromptSubmit/PostToolUse/Stop only — no Notification or structured approval",
        );
      }
    }
  }

  const kind = readString(observation, "kind");
  if (kind === undefined) {
    return absent(
      surface,
      "kind",
      "kind missing or non-string — evidence-absent",
    );
  }

  // Never classify fabricated Notification/approval payloads for codex-tui.
  if (surface === "codex-tui" && (kind === "notification" || kind === "approval-request")) {
    return capabilityAbsent(
      surface,
      `kind=${kind}`,
      "Codex TUI does not emit this kind (hooks not registered) — use capabilityProbe, not a fake payload",
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
        "process/host health missing — not ready",
      );
    }
    if (processHealth !== "alive") {
      const r = receiptForLostBoundary(attempt, toolSessionId, timestamp);
      return result(
        surface,
        "disconnected",
        r.receipt,
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
      if (processHealth === undefined) {
        return absent(surface, "processHealth", "processHealth missing — not busy proof");
      }
      if (processHealth !== "alive") {
        const r = receiptForLostBoundary(attempt, toolSessionId, timestamp);
        return result(
          surface,
          "disconnected",
          r.receipt,
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
      const r = receiptForLostBoundary(attempt, toolSessionId, timestamp);
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

export function classifyCodexAppServerObservation(
  observation: unknown,
  attemptRaw?: unknown,
): ProviderEvidenceResult {
  const attempt = parseAttemptContext(attemptRaw);
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
    const sid = sessionId ?? readString(observation, "toolSessionId");
    const r = receiptForLostBoundary(attempt, sid, timestamp);
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
 * Grok TUI evidence grounded in grok.ts only:
 * - preassigned sessionId (spawn --session-id)
 * - process health (external host fact)
 * - summary.json location + mtimeMs (findGrokSummaries / GrokSummaryLocation)
 *
 * Does NOT read updates.jsonl or turn_completed (those live outside grok.ts
 * adapter surface). Turn busy-state is capability-absent.
 */
export function classifyGrokObservation(
  observation: unknown,
  attemptRaw?: unknown,
): ProviderEvidenceResult {
  const attempt = parseAttemptContext(attemptRaw);
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
      probe === "Notification" ||
      probe === "structured-approval" ||
      probe === "structured-modal" ||
      probe === "turn-busy-state" ||
      probe === "updates.jsonl" ||
      probe === "turn_completed"
    ) {
      return capabilityAbsent(
        surface,
        `capabilityProbe=${probe}`,
        "grok.ts has no lifecycle hooks and does not read updates.jsonl/turn_completed; only summary.json location/mtime",
      );
    }
  }

  const processState = readString(observation, "processState");
  const sessionId = readString(observation, "sessionId");
  const timestamp = readString(observation, "timestamp");
  const summaryLocated = readBoolean(observation, "summaryLocated");
  const summaryMtimeMs = readFiniteNumber(observation, "summaryMtimeMs");
  const previousSummaryMtimeMs = readFiniteNumber(
    observation,
    "previousSummaryMtimeMs",
  );

  if (processState === "dead" || processState === "missing") {
    const r = receiptForLostBoundary(attempt, sessionId, timestamp);
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

  if (processState === undefined) {
    return absent(surface, "processState", "processState missing — unknown");
  }
  if (processState !== "alive") {
    return absent(
      surface,
      "processState",
      `processState=${processState} is not a classified alive state`,
    );
  }
  if (sessionId === undefined) {
    return absent(
      surface,
      "sessionId",
      "exact preassigned session id missing — unknown",
    );
  }

  // summary.json located for this exact session + mtime advance proves artifact
  // activity only (grok.ts:353-414 GrokSummaryLocation.mtimeMs), never idle/ready.
  if (summaryLocated !== true) {
    return absent(
      surface,
      "summaryLocated",
      "summary.json not located for session — no artifact activity evidence",
    );
  }
  if (summaryMtimeMs === undefined || previousSummaryMtimeMs === undefined) {
    return absent(
      surface,
      "summaryMtimeMs|previousSummaryMtimeMs",
      "summary mtime advancement not proven — evidence-absent",
    );
  }
  if (!(summaryMtimeMs > previousSummaryMtimeMs)) {
    return absent(
      surface,
      "summaryMtimeMs",
      "summary mtime did not advance on exact session — no activity evidence",
    );
  }

  // observedAt for receipt: require ISO timestamp (not mtime alone) for attempt match.
  const observedAt = timestamp;
  const r = receiptForBoundary(attempt, sessionId, observedAt);
  return result(
    surface,
    "evidence-absent",
    r.receipt,
    "sessionId+summaryLocated+summaryMtime-advance",
    "exact session summary.json mtime advanced after the attempt; this is artifact activity, not an idle/ready boundary",
    r.receipt === "provider-observed"
      ? [...TERMINAL_EVIDENCE_CONTRACTS["provider-observed"].excludes, "ready"]
      : ["provider-observed", "ready", "turn-busy-state", "updates.jsonl"],
  );
}

export function classifyProviderObservation(
  surface: ProviderSurfaceId,
  observation: unknown,
  attemptRaw?: unknown,
): ProviderEvidenceResult {
  // Parse once at the entry point so all paths are fail-closed on attempt shape.
  const attempt = parseAttemptContext(attemptRaw);
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
