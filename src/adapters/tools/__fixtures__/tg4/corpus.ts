import type {
  ProviderSurfaceId,
  ReadinessEvidenceKind,
  ReceiptEvidenceKind,
  Tg4Scenario,
} from "../../../../schemas/provider-manifest";

/**
 * TG4 recorded-shape fixture corpus.
 * Fixtures are structural observations only — tests assert classifications,
 * never substring-pin fixture prose.
 */

export interface Tg4Fixture {
  surface: ProviderSurfaceId;
  scenario: Tg4Scenario;
  /** Recorded observation shape fed to classifyProviderObservation. */
  observation: unknown;
  /** Expected readiness kind from evidence functions. */
  expectedReadiness: ReadinessEvidenceKind;
  /** Expected receipt kind from evidence functions. */
  expectedReceipt: ReceiptEvidenceKind;
}

const claude = (
  scenario: Tg4Scenario,
  observation: unknown,
  expectedReadiness: ReadinessEvidenceKind,
  expectedReceipt: ReceiptEvidenceKind,
): Tg4Fixture => ({
  surface: "claude-tui",
  scenario,
  observation,
  expectedReadiness,
  expectedReceipt,
});

const codexTui = (
  scenario: Tg4Scenario,
  observation: unknown,
  expectedReadiness: ReadinessEvidenceKind,
  expectedReceipt: ReceiptEvidenceKind,
): Tg4Fixture => ({
  surface: "codex-tui",
  scenario,
  observation,
  expectedReadiness,
  expectedReceipt,
});

const codexApp = (
  scenario: Tg4Scenario,
  observation: unknown,
  expectedReadiness: ReadinessEvidenceKind,
  expectedReceipt: ReceiptEvidenceKind,
): Tg4Fixture => ({
  surface: "codex-app-server",
  scenario,
  observation,
  expectedReadiness,
  expectedReceipt,
});

const grok = (
  scenario: Tg4Scenario,
  observation: unknown,
  expectedReadiness: ReadinessEvidenceKind,
  expectedReceipt: ReceiptEvidenceKind,
): Tg4Fixture => ({
  surface: "grok-tui",
  scenario,
  observation,
  expectedReadiness,
  expectedReceipt,
});

/** Primary scenario fixtures: one per provider × scenario. */
export const TG4_SCENARIO_FIXTURES: Tg4Fixture[] = [
  // Claude TUI
  claude(
    "idle",
    {
      kind: "turn-end",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
      toolSessionId: "ses-claude-1",
    },
    "ready",
    "provider-observed",
  ),
  claude(
    "busy",
    {
      kind: "turn-start",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:01.000Z",
      toolSessionId: "ses-claude-1",
    },
    "busy",
    "provider-observed",
  ),
  claude(
    "approval",
    {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:02.000Z",
      notificationType: "permission_prompt",
      toolSessionId: "ses-claude-1",
    },
    "awaiting-approval",
    "evidence-absent",
  ),
  claude(
    "modal",
    {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:03.000Z",
      notificationType: "future_vendor_dialog_v9",
      toolSessionId: "ses-claude-1",
    },
    "blocked-unknown",
    "evidence-absent",
  ),
  claude(
    "disconnect",
    {
      kind: "dead",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:04.000Z",
    },
    "disconnected",
    "attempt-in-doubt",
  ),
  claude(
    "restart",
    {
      kind: "session-launch",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:05.000Z",
    },
    "restarting",
    "evidence-absent",
  ),

  // Codex TUI
  codexTui(
    "idle",
    {
      kind: "turn-end",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
      toolSessionId: "thread-codex-1",
    },
    "ready",
    "provider-observed",
  ),
  codexTui(
    "busy",
    {
      kind: "turn-start",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:01.000Z",
      toolSessionId: "thread-codex-1",
    },
    "busy",
    "provider-observed",
  ),
  codexTui(
    "approval",
    {
      kind: "approval-request",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:02.000Z",
      description: "command requiring additional permissions",
    },
    "awaiting-approval",
    "evidence-absent",
  ),
  codexTui(
    "modal",
    {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:03.000Z",
      notificationType: "unclassified_codex_modal",
    },
    "blocked-unknown",
    "evidence-absent",
  ),
  codexTui(
    "disconnect",
    {
      kind: "session-end",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:04.000Z",
    },
    "disconnected",
    "attempt-in-doubt",
  ),
  codexTui(
    "restart",
    {
      kind: "session-start",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:05.000Z",
      toolSessionId: "thread-codex-2",
    },
    "ready",
    "provider-observed",
  ),

  // Codex app-server
  codexApp(
    "idle",
    { method: "turn/completed", params: { turn: { id: "turn-1" } } },
    "ready",
    "provider-observed",
  ),
  codexApp(
    "busy",
    { method: "turn/started", params: { turn: { id: "turn-2" } } },
    "busy",
    "provider-observed",
  ),
  codexApp(
    "approval",
    {
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /", cwd: "/tmp" },
    },
    "awaiting-approval",
    "evidence-absent",
  ),
  codexApp(
    "modal",
    { method: "future/vendor/dialog", params: { code: "x" } },
    "blocked-unknown",
    "evidence-absent",
  ),
  codexApp(
    "disconnect",
    { kind: "dead", agentName: "worker", timestamp: "2026-07-16T12:00:04.000Z" },
    "disconnected",
    "attempt-in-doubt",
  ),
  codexApp(
    "restart",
    { kind: "session-start", agentName: "worker", timestamp: "2026-07-16T12:00:05.000Z" },
    "ready",
    "provider-observed",
  ),

  // Grok TUI
  grok(
    "idle",
    {
      processState: "alive",
      sessionId: "grok-ses-1",
      lastActivityAt: "2026-07-16T12:00:00.000Z",
      turnCompleted: true,
    },
    "ready",
    "provider-observed",
  ),
  grok(
    "busy",
    {
      processState: "alive",
      sessionId: "grok-ses-1",
      lastActivityAt: "2026-07-16T12:00:01.000Z",
      turnCompleted: false,
    },
    "busy",
    "provider-observed",
  ),
  grok(
    "approval",
    {
      processState: "alive",
      sessionId: "grok-ses-1",
      // No structured approval — capability absent path via possible modal.
      possibleModal: true,
    },
    "blocked-unknown",
    "evidence-absent",
  ),
  grok(
    "modal",
    {
      processState: "alive",
      sessionId: "grok-ses-1",
      possibleModal: true,
    },
    "blocked-unknown",
    "evidence-absent",
  ),
  grok(
    "disconnect",
    {
      processState: "dead",
      sessionId: "grok-ses-1",
    },
    "disconnected",
    "attempt-in-doubt",
  ),
  grok(
    "restart",
    {
      processState: "restarting",
      sessionId: "grok-ses-1",
    },
    "restarting",
    "evidence-absent",
  ),
];

/**
 * Positive-control fixtures: a misspelled key must read as evidence-absent,
 * and the correctly spelled key must produce a non-absent classification.
 */
export interface AbsentFieldControl {
  surface: ProviderSurfaceId;
  label: string;
  misspelled: unknown;
  correctlySpelled: unknown;
  expectedCorrectReadiness: ReadinessEvidenceKind;
}

export const ABSENT_FIELD_CONTROLS: AbsentFieldControl[] = [
  {
    surface: "claude-tui",
    label: "notificationType misspelled",
    misspelled: {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
      notificationTypo: "permission_prompt",
    },
    correctlySpelled: {
      kind: "notification",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
      notificationType: "permission_prompt",
    },
    expectedCorrectReadiness: "awaiting-approval",
  },
  {
    surface: "claude-tui",
    label: "kind misspelled",
    misspelled: {
      knd: "turn-end",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
    },
    correctlySpelled: {
      kind: "turn-end",
      agentName: "worker",
      timestamp: "2026-07-16T12:00:00.000Z",
    },
    expectedCorrectReadiness: "ready",
  },
  {
    surface: "codex-app-server",
    label: "method misspelled",
    misspelled: {
      mthod: "turn/started",
      params: { turn: { id: "t1" } },
    },
    correctlySpelled: {
      method: "turn/started",
      params: { turn: { id: "t1" } },
    },
    expectedCorrectReadiness: "busy",
  },
  {
    surface: "grok-tui",
    label: "lastActivityAt / turnCompleted misspelled",
    misspelled: {
      processState: "alive",
      lastActivtyAt: "2026-07-16T12:00:00.000Z",
      turnCompletd: true,
    },
    correctlySpelled: {
      processState: "alive",
      lastActivityAt: "2026-07-16T12:00:00.000Z",
      turnCompleted: true,
    },
    expectedCorrectReadiness: "ready",
  },
];

/** Hook capability probes that Grok must report capability-absent. */
export const GROK_HOOK_ABSENCE_PROBES = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PostToolUse",
  "Notification",
] as const;
