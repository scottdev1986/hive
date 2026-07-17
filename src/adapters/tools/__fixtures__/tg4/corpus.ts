import type {
  AttemptContext,
  ProviderSurfaceId,
  Tg4Scenario,
} from "../../../../schemas/provider-manifest";

/**
 * TG4 recorded-shape fixture corpus.
 * Observations only — expected readiness/receipt are asserted in tests from
 * §25 prerequisites, not stored as self-mirroring enums on the fixture.
 *
 * Shapes match what adapters can actually emit (hooks registered, app-server
 * notifications, grok process+transcript). Invented Notification/approval
 * paths for codex-tui are not included.
 */

export interface Tg4Fixture {
  surface: ProviderSurfaceId;
  scenario: Tg4Scenario;
  /** Recorded observation shape. */
  observation: unknown;
  /** Matching attempt when the scenario is about post-injection receipt. */
  attempt?: AttemptContext;
  /**
   * Free-text note for humans (not asserted by substring).
   * Tests derive expectations from §25, not from this string.
   */
  note: string;
}

const T0 = "2026-07-16T12:00:00.000Z";
const T1 = "2026-07-16T12:00:01.000Z";
const T2 = "2026-07-16T12:00:02.000Z";
const T3 = "2026-07-16T12:00:03.000Z";

const attemptFor = (sessionId: string, committedAt: string): AttemptContext => ({
  attemptId: "txn-test-1",
  committed: true,
  providerSessionId: sessionId,
  committedAt,
});

/** Primary scenario fixtures: one per provider × scenario. */
export const TG4_SCENARIO_FIXTURES: Tg4Fixture[] = [
  // ── Claude TUI ──────────────────────────────────────────────
  {
    surface: "claude-tui",
    scenario: "idle",
    observation: {
      kind: "turn-end",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      processHealth: "alive",
      unresolvedModal: false,
    },
    attempt: attemptFor("ses-claude-1", T1),
    note: "§25 Stop + host health + exact session + no modal; later than commit → ready + provider-observed",
  },
  {
    surface: "claude-tui",
    scenario: "busy",
    observation: {
      kind: "turn-start",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      processHealth: "alive",
    },
    attempt: attemptFor("ses-claude-1", T1),
    note: "§25 UserPromptSubmit under alive process + exact session after injection",
  },
  {
    surface: "claude-tui",
    scenario: "approval",
    observation: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationType: "permission_prompt",
      toolSessionId: "ses-claude-1",
    },
    note: "§25 / server.ts measured permission_prompt → awaiting-approval; receipt not upgraded",
  },
  {
    surface: "claude-tui",
    scenario: "modal",
    observation: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationType: "future_vendor_dialog_v9",
      toolSessionId: "ses-claude-1",
    },
    note: "§25 unknown notification type → blocked-unknown, never ready",
  },
  {
    surface: "claude-tui",
    scenario: "disconnect",
    observation: {
      kind: "dead",
      agentName: "worker",
      timestamp: T3,
      toolSessionId: "ses-claude-1",
    },
    attempt: attemptFor("ses-claude-1", T1),
    note: "committed attempt + dead → disconnected + attempt-in-doubt",
  },
  {
    surface: "claude-tui",
    scenario: "restart",
    observation: {
      kind: "session-launch",
      agentName: "worker",
      timestamp: T0,
    },
    note: "session-launch is supervisor process lifecycle (event.ts) — restarting, not ready",
  },

  // ── Codex TUI (no Notification / approval-request emissions) ──
  {
    surface: "codex-tui",
    scenario: "idle",
    observation: {
      kind: "turn-end",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "thread-codex-1",
      processHealth: "alive",
      unresolvedModal: false,
    },
    attempt: attemptFor("thread-codex-1", T1),
    note: "Stop hook + host prerequisites",
  },
  {
    surface: "codex-tui",
    scenario: "busy",
    observation: {
      kind: "turn-start",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "thread-codex-1",
      processHealth: "alive",
    },
    attempt: attemptFor("thread-codex-1", T1),
    note: "UserPromptSubmit hook under alive process",
  },
  {
    surface: "codex-tui",
    scenario: "approval",
    // Honest: adapter cannot emit structured approval. Probe documents absence.
    observation: {
      kind: "approval-request",
      agentName: "worker",
      timestamp: T2,
      description: "would-be approval",
    },
    note: "codex.ts:174-186 registers no approval path → capability-absent",
  },
  {
    surface: "codex-tui",
    scenario: "modal",
    // No Notification hook — unclassified modal via unknown kind is also blocked.
    // Using Notification shape documents capability-absent (not a real emission).
    observation: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationType: "unclassified_codex_modal",
    },
    note: "Notification hook not registered → capability-absent (not blocked-unknown via fake hook)",
  },
  {
    surface: "codex-tui",
    scenario: "disconnect",
    observation: {
      kind: "session-end",
      agentName: "worker",
      timestamp: T3,
      toolSessionId: "thread-codex-1",
    },
    attempt: attemptFor("thread-codex-1", T1),
    note: "committed attempt + session-end → attempt-in-doubt",
  },
  {
    surface: "codex-tui",
    scenario: "restart",
    // Real restart shape: supervisor session-launch before hooks re-fire.
    observation: {
      kind: "session-launch",
      agentName: "worker",
      timestamp: T0,
    },
    note: "session-launch during restart — not SessionStart ready",
  },

  // ── Codex app-server (params.turn.id required) ──────────────
  {
    surface: "codex-app-server",
    scenario: "idle",
    observation: {
      method: "turn/completed",
      timestamp: T2,
      params: {
        turn: { id: "turn-1" },
        threadId: "thread-app-1",
      },
    },
    attempt: attemptFor("thread-app-1", T1),
    note: "native turn/completed with turn id + thread id after commit",
  },
  {
    surface: "codex-app-server",
    scenario: "busy",
    observation: {
      method: "turn/started",
      timestamp: T2,
      params: {
        turn: { id: "turn-2" },
        threadId: "thread-app-1",
      },
    },
    attempt: attemptFor("thread-app-1", T1),
    note: "native turn/started with turn id + thread id",
  },
  {
    surface: "codex-app-server",
    scenario: "approval",
    observation: {
      method: "item/commandExecution/requestApproval",
      timestamp: T2,
      params: { command: "rm -rf /", cwd: "/tmp" },
    },
    note: "structured approval request from handleRequest",
  },
  {
    surface: "codex-app-server",
    scenario: "modal",
    observation: {
      method: "future/vendor/dialog",
      timestamp: T2,
      params: { code: "x" },
    },
    note: "unclassified method → blocked-unknown",
  },
  {
    surface: "codex-app-server",
    scenario: "disconnect",
    observation: {
      kind: "dead",
      agentName: "worker",
      timestamp: T3,
      toolSessionId: "thread-app-1",
    },
    attempt: attemptFor("thread-app-1", T1),
    note: "committed attempt + dead → attempt-in-doubt",
  },
  {
    surface: "codex-app-server",
    scenario: "restart",
    observation: {
      kind: "session-launch",
      agentName: "worker",
      timestamp: T0,
    },
    note: "restart before thread/start — restarting, not ready",
  },

  // ── Grok TUI ────────────────────────────────────────────────
  {
    surface: "grok-tui",
    scenario: "idle",
    observation: {
      processState: "alive",
      sessionId: "grok-ses-1",
      previousLastActivityAt: T0,
      lastActivityAt: T2,
      turnCompleted: true,
      timestamp: T2,
    },
    attempt: attemptFor("grok-ses-1", T1),
    note: "process + exact session + activity advance + turn_completed",
  },
  {
    surface: "grok-tui",
    scenario: "busy",
    observation: {
      processState: "alive",
      sessionId: "grok-ses-1",
      previousLastActivityAt: T0,
      lastActivityAt: T2,
      turnCompleted: false,
      timestamp: T2,
    },
    attempt: attemptFor("grok-ses-1", T1),
    note: "process + exact session + activity advance + streaming",
  },
  {
    surface: "grok-tui",
    scenario: "approval",
    observation: {
      processState: "alive",
      sessionId: "grok-ses-1",
      possibleModal: true,
    },
    note: "§25 no structured approval; possible modal blocks automation",
  },
  {
    surface: "grok-tui",
    scenario: "modal",
    observation: {
      processState: "alive",
      sessionId: "grok-ses-1",
      possibleModal: true,
    },
    note: "possibleModal blocks; no structured modal proof",
  },
  {
    surface: "grok-tui",
    scenario: "disconnect",
    observation: {
      processState: "dead",
      sessionId: "grok-ses-1",
    },
    attempt: attemptFor("grok-ses-1", T1),
    note: "committed attempt + process dead → attempt-in-doubt",
  },
  {
    surface: "grok-tui",
    scenario: "restart",
    observation: {
      processState: "restarting",
      sessionId: "grok-ses-1",
    },
    note: "preassigned session may reattach; not ready until activity after relaunch",
  },
];

/** Positive controls: misspelled key → evidence-absent; correct key classifies. */
export interface AbsentFieldControl {
  surface: ProviderSurfaceId;
  label: string;
  misspelled: unknown;
  correctlySpelled: unknown;
  attempt?: AttemptContext;
}

export const ABSENT_FIELD_CONTROLS: AbsentFieldControl[] = [
  {
    surface: "claude-tui",
    label: "notificationType misspelled",
    misspelled: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationTypo: "permission_prompt",
    },
    correctlySpelled: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationType: "permission_prompt",
    },
  },
  {
    surface: "claude-tui",
    label: "kind misspelled",
    misspelled: {
      knd: "turn-end",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      processHealth: "alive",
      unresolvedModal: false,
    },
    correctlySpelled: {
      kind: "turn-end",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      processHealth: "alive",
      unresolvedModal: false,
    },
  },
  {
    surface: "claude-tui",
    label: "processHealth missing blocks ready",
    misspelled: {
      kind: "turn-end",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      unresolvedModal: false,
      // processHealth intentionally absent
    },
    correctlySpelled: {
      kind: "turn-end",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      processHealth: "alive",
      unresolvedModal: false,
    },
  },
  {
    surface: "codex-app-server",
    label: "params.turn.id missing",
    misspelled: {
      method: "turn/started",
      timestamp: T2,
      params: { threadId: "thread-app-1" },
    },
    correctlySpelled: {
      method: "turn/started",
      timestamp: T2,
      params: { turn: { id: "turn-2" }, threadId: "thread-app-1" },
    },
  },
  {
    surface: "grok-tui",
    label: "activity keys misspelled / no advance",
    misspelled: {
      processState: "alive",
      sessionId: "grok-ses-1",
      lastActivtyAt: T2,
      turnCompletd: true,
    },
    correctlySpelled: {
      processState: "alive",
      sessionId: "grok-ses-1",
      previousLastActivityAt: T0,
      lastActivityAt: T2,
      turnCompleted: true,
      timestamp: T2,
    },
  },
];

export const GROK_HOOK_ABSENCE_PROBES = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PostToolUse",
  "Notification",
] as const;

/** Probes used only for conformance report derivation from collectors. */
export const CONFORMANCE_PROBES: Array<{
  surface: ProviderSurfaceId;
  label: string;
  observation: unknown;
  attempt?: AttemptContext;
}> = [
  // Claude readiness paths
  {
    surface: "claude-tui",
    label: "ready-stop",
    observation: {
      kind: "turn-end",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
      unresolvedModal: false,
    },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "claude-tui",
    label: "busy-turn-start",
    observation: {
      kind: "turn-start",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "claude-tui",
    label: "turn-boundary",
    observation: {
      kind: "tool-boundary",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "claude-tui",
    label: "awaiting-approval",
    observation: {
      kind: "notification",
      timestamp: T2,
      notificationType: "permission_prompt",
    },
  },
  {
    surface: "claude-tui",
    label: "blocked-unknown",
    observation: {
      kind: "notification",
      timestamp: T2,
      notificationType: "unknown_x",
    },
  },
  {
    surface: "claude-tui",
    label: "disconnected-in-doubt",
    observation: { kind: "dead", timestamp: T3, toolSessionId: "s" },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "claude-tui",
    label: "restarting",
    observation: { kind: "session-launch", timestamp: T0 },
  },
  {
    surface: "claude-tui",
    label: "evidence-absent-kind",
    observation: { knd: "turn-end" },
  },
  // Codex TUI
  {
    surface: "codex-tui",
    label: "ready-stop",
    observation: {
      kind: "turn-end",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
      unresolvedModal: false,
    },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "codex-tui",
    label: "busy",
    observation: {
      kind: "turn-start",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "codex-tui",
    label: "turn-boundary",
    observation: {
      kind: "tool-boundary",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "codex-tui",
    label: "approval-capability-absent",
    observation: { kind: "approval-request", timestamp: T2 },
  },
  {
    surface: "codex-tui",
    label: "notification-capability-absent",
    observation: {
      kind: "notification",
      timestamp: T2,
      notificationType: "x",
    },
  },
  {
    surface: "codex-tui",
    label: "disconnected",
    observation: { kind: "dead", timestamp: T3, toolSessionId: "s" },
    attempt: attemptFor("s", T1),
  },
  {
    surface: "codex-tui",
    label: "restarting",
    observation: { kind: "session-launch", timestamp: T0 },
  },
  // App-server
  {
    surface: "codex-app-server",
    label: "ready",
    observation: {
      method: "turn/completed",
      timestamp: T2,
      params: { turn: { id: "t" }, threadId: "th" },
    },
    attempt: attemptFor("th", T1),
  },
  {
    surface: "codex-app-server",
    label: "busy",
    observation: {
      method: "turn/started",
      timestamp: T2,
      params: { turn: { id: "t" }, threadId: "th" },
    },
    attempt: attemptFor("th", T1),
  },
  {
    surface: "codex-app-server",
    label: "approval",
    observation: {
      method: "item/commandExecution/requestApproval",
      params: { command: "x" },
    },
  },
  {
    surface: "codex-app-server",
    label: "blocked-unknown",
    observation: { method: "future/dialog", params: {} },
  },
  {
    surface: "codex-app-server",
    label: "disconnected",
    observation: { kind: "dead", toolSessionId: "th", timestamp: T3 },
    attempt: attemptFor("th", T1),
  },
  {
    surface: "codex-app-server",
    label: "restarting",
    observation: { kind: "session-launch", timestamp: T0 },
  },
  {
    surface: "codex-app-server",
    label: "evidence-absent-no-turn-id",
    observation: {
      method: "turn/started",
      timestamp: T2,
      params: { threadId: "th" },
    },
  },
  // Grok
  {
    surface: "grok-tui",
    label: "ready",
    observation: {
      processState: "alive",
      sessionId: "g",
      previousLastActivityAt: T0,
      lastActivityAt: T2,
      turnCompleted: true,
      timestamp: T2,
    },
    attempt: attemptFor("g", T1),
  },
  {
    surface: "grok-tui",
    label: "busy",
    observation: {
      processState: "alive",
      sessionId: "g",
      previousLastActivityAt: T0,
      lastActivityAt: T2,
      turnCompleted: false,
      timestamp: T2,
    },
    attempt: attemptFor("g", T1),
  },
  {
    surface: "grok-tui",
    label: "blocked-modal",
    observation: {
      processState: "alive",
      sessionId: "g",
      possibleModal: true,
    },
  },
  {
    surface: "grok-tui",
    label: "disconnected",
    observation: { processState: "dead", sessionId: "g" },
    attempt: attemptFor("g", T1),
  },
  {
    surface: "grok-tui",
    label: "restarting",
    observation: { processState: "restarting", sessionId: "g" },
  },
  {
    surface: "grok-tui",
    label: "hook-absent",
    observation: { capabilityProbe: "SessionStart" },
  },
  {
    surface: "grok-tui",
    label: "evidence-absent",
    observation: { processState: "alive", sessionId: "g" },
  },
];
