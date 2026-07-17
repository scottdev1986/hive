import type {
  AttemptContext,
  ProviderEvidenceOrigin,
  ProviderSurfaceId,
  Tg4Scenario,
} from "../../../../schemas/provider-manifest";

/**
 * TG4 recorded-shape fixture corpus — grounded observations only.
 * evidenceOrigins distinguishes provider-adapter emission from host/schema
 * facts, and adapterSurface names every claimed adapter surface. No fabricated codex-tui
 * Notification/approval-request payloads; capability absences use
 * capabilityProbe shapes.
 */

export interface Tg4Fixture {
  surface: ProviderSurfaceId;
  evidenceOrigins: readonly ProviderEvidenceOrigin[];
  adapterSurface?: AdapterEvidenceSurface;
  scenario: Tg4Scenario;
  observation: unknown;
  attempt?: AttemptContext;
  /** Human note; not substring-asserted. */
  note: string;
  /** Sources grounding this observation shape. */
  sourceCitations: readonly string[];
}

export interface EmittableProbe {
  surface: ProviderSurfaceId;
  evidenceOrigins: readonly ProviderEvidenceOrigin[];
  adapterSurface?: AdapterEvidenceSurface;
  label: string;
  observation: unknown;
  attempt?: AttemptContext;
  /** Grounding sources; adapter origin requires the named adapter file. */
  sourceCitations: readonly string[];
}

export const ADAPTER_EVIDENCE_SURFACE_FILES = {
  "claude:Stop": "src/adapters/tools/claude.ts",
  "claude:UserPromptSubmit": "src/adapters/tools/claude.ts",
  "claude:PostToolUse": "src/adapters/tools/claude.ts",
  "claude:Notification": "src/adapters/tools/claude.ts",
  "codex:Stop": "src/adapters/tools/codex.ts",
  "codex:UserPromptSubmit": "src/adapters/tools/codex.ts",
  "codex:PostToolUse": "src/adapters/tools/codex.ts",
  "codex:registered-hooks": "src/adapters/tools/codex.ts",
  "codex-app-server:turn/completed": "src/adapters/tools/codex-app-server.ts",
  "codex-app-server:turn/started": "src/adapters/tools/codex-app-server.ts",
  "codex-app-server:requestApproval": "src/adapters/tools/codex-app-server.ts",
  "codex-app-server:unsupported-request": "src/adapters/tools/codex-app-server.ts",
  "grok:summary-reader": "src/adapters/tools/grok.ts",
  "grok:no-turn-stream": "src/adapters/tools/grok.ts",
  "grok:hooks-disabled": "src/adapters/tools/grok.ts",
} as const;
export type AdapterEvidenceSurface = keyof typeof ADAPTER_EVIDENCE_SURFACE_FILES;

export type EvidenceGrounding = Pick<
  EmittableProbe,
  "evidenceOrigins" | "adapterSurface" | "sourceCitations"
>;

export function hasRequiredEvidenceGrounding(
  probe: EvidenceGrounding,
): boolean {
  if (
    probe.evidenceOrigins.length === 0 ||
    probe.sourceCitations.length === 0 ||
    probe.sourceCitations.some((citation) => citation.length === 0)
  ) return false;
  if (!probe.evidenceOrigins.includes("adapter")) return true;
  if (probe.adapterSurface === undefined) return false;
  const expectedFile = ADAPTER_EVIDENCE_SURFACE_FILES[probe.adapterSurface];
  return probe.sourceCitations.some((citation) =>
    citation.startsWith(`${expectedFile}:`)
  );
}

const T0 = "2026-07-16T12:00:00.000Z";
const T1 = "2026-07-16T12:00:01.000Z";
const T2 = "2026-07-16T12:00:02.000Z";
const T3 = "2026-07-16T12:00:03.000Z";

export const attemptFor = (
  sessionId: string,
  committedAt: string,
): AttemptContext => ({
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
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:Stop",
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
    note: "Stop hook + host prerequisites + matching attempt",
    sourceCitations: [
      "src/adapters/tools/claude.ts:615 (Stop → turn-end)",
      "src/schemas/event.ts:23-37 (turn-end HookEvent)",
    ],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:UserPromptSubmit",
    scenario: "busy",
    observation: {
      kind: "turn-start",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "ses-claude-1",
      processHealth: "alive",
    },
    attempt: attemptFor("ses-claude-1", T1),
    note: "UserPromptSubmit under alive process",
    sourceCitations: [
      "src/adapters/tools/claude.ts:614 (UserPromptSubmit → turn-start)",
    ],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:Notification",
    scenario: "approval",
    observation: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationType: "permission_prompt",
      toolSessionId: "ses-claude-1",
    },
    note: "Claude Notification hook with permission_prompt",
    sourceCitations: [
      "src/adapters/tools/claude.ts:616 (Notification hook)",
      "src/daemon/server.ts:396-407 (permission_prompt measured)",
      "src/schemas/event.ts:38-53",
    ],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:Notification",
    scenario: "modal",
    observation: {
      kind: "notification",
      agentName: "worker",
      timestamp: T2,
      notificationType: "future_vendor_dialog_v9",
      toolSessionId: "ses-claude-1",
    },
    note: "unknown notificationType → blocked-unknown",
    sourceCitations: [
      "src/adapters/tools/claude.ts:616",
      "src/schemas/event.ts:48-52 (unrecognized type must not reject parse)",
    ],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["host"],
    scenario: "disconnect",
    observation: {
      kind: "dead",
      agentName: "worker",
      timestamp: T3,
      toolSessionId: "ses-claude-1",
    },
    attempt: attemptFor("ses-claude-1", T1),
    note: "dead + exact session + loss timestamp >= commit → attempt-in-doubt",
    sourceCitations: [
      "src/schemas/event.ts:70 (dead kind)",
    ],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["host"],
    scenario: "restart",
    observation: {
      kind: "session-launch",
      agentName: "worker",
      timestamp: T0,
    },
    note: "supervisor session-launch — restarting, not ready",
    sourceCitations: [
      "src/schemas/event.ts:12-15 (session-launch)",
    ],
  },

  // ── Codex TUI ───────────────────────────────────────────────
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "codex:Stop",
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
    note: "Stop hook",
    sourceCitations: ["src/adapters/tools/codex.ts:186"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "codex:UserPromptSubmit",
    scenario: "busy",
    observation: {
      kind: "turn-start",
      agentName: "worker",
      timestamp: T2,
      toolSessionId: "thread-codex-1",
      processHealth: "alive",
    },
    attempt: attemptFor("thread-codex-1", T1),
    note: "UserPromptSubmit hook",
    sourceCitations: ["src/adapters/tools/codex.ts:182"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex:registered-hooks",
    scenario: "approval",
    // capability probe — not a fabricated approval-request payload
    observation: { capabilityProbe: "structured-approval" },
    note: "no structured approval hook on codex TUI spawn",
    sourceCitations: [
      "src/adapters/tools/codex.ts:174-186 (hooks registered; no approval path)",
    ],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex:registered-hooks",
    scenario: "modal",
    // distinct capability probe for Notification absence
    observation: { capabilityProbe: "Notification" },
    note: "Notification hook not registered",
    sourceCitations: [
      "src/adapters/tools/codex.ts:174-186 (SessionStart/UserPromptSubmit/PostToolUse/Stop only)",
    ],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["host"],
    scenario: "disconnect",
    observation: {
      kind: "session-end",
      agentName: "worker",
      timestamp: T3,
      toolSessionId: "thread-codex-1",
    },
    attempt: attemptFor("thread-codex-1", T1),
    note: "session-end + exact session + loss timestamp ≥ commit",
    sourceCitations: ["src/schemas/event.ts:17-21 (session-end)"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["host"],
    scenario: "restart",
    observation: {
      kind: "session-launch",
      agentName: "worker",
      timestamp: T0,
    },
    note: "session-launch during restart",
    sourceCitations: ["src/schemas/event.ts:12-15"],
  },

  // ── Codex app-server ────────────────────────────────────────
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:turn/completed",
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
    note: "turn/completed with turn id + thread id",
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:578-601",
    ],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:turn/started",
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
    note: "turn/started with turn id + thread id",
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:554-562",
    ],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:requestApproval",
    scenario: "approval",
    observation: {
      method: "item/commandExecution/requestApproval",
      timestamp: T2,
      params: { command: "rm -rf /", cwd: "/tmp" },
    },
    note: "structured approval request",
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:605-620",
      "src/adapters/tools/codex-app-server.ts:623+",
    ],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:unsupported-request",
    scenario: "modal",
    observation: {
      method: "future/vendor/dialog",
      timestamp: T2,
      params: { code: "x" },
    },
    note: "unclassified method → blocked-unknown",
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:605-614 (unsupported request throws; unclassified blocks)",
    ],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["host"],
    scenario: "disconnect",
    observation: {
      kind: "dead",
      agentName: "worker",
      timestamp: T3,
      toolSessionId: "thread-app-1",
    },
    attempt: attemptFor("thread-app-1", T1),
    note: "dead + session + loss timestamp ≥ commit",
    sourceCitations: [
      "src/schemas/event.ts:70",
      "src/adapters/tools/codex-app-server.ts:499-503 (disconnect)",
    ],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["host"],
    scenario: "restart",
    observation: {
      kind: "session-launch",
      agentName: "worker",
      timestamp: T0,
    },
    note: "restart before thread/start",
    sourceCitations: ["src/schemas/event.ts:12-15"],
  },

  // ── Grok TUI (summary.json mtime is activity only — grok.ts:264-417) ────
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "grok:summary-reader",
    scenario: "idle",
    observation: {
      processState: "alive",
      sessionId: "grok-ses-1",
      summaryLocated: true,
      previousSummaryMtimeMs: 1_000,
      summaryMtimeMs: 2_000,
      timestamp: T2,
    },
    attempt: attemptFor("grok-ses-1", T1),
    note: "summary.json mtime advance proves artifact activity, not idle/ready",
    sourceCitations: [
      "src/adapters/tools/grok.ts:18-20,127-133 (preassigned sessionId)",
      "src/adapters/tools/grok.ts:270-279,353-414 (summary.json + mtimeMs)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:no-turn-stream",
    scenario: "busy",
    // turn-busy-state is not available from grok.ts
    observation: { capabilityProbe: "turn-busy-state" },
    note: "no turn stream in grok.ts — busy is capability-absent",
    sourceCitations: [
      "src/adapters/tools/grok.ts:264-417 (summary discovery only; no turn_completed)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:hooks-disabled",
    scenario: "approval",
    observation: { capabilityProbe: "structured-approval" },
    note: "no structured approval in grok.ts",
    sourceCitations: [
      "src/adapters/tools/grok.ts:39-50 (provider hook imports disabled)",
      "docs/design/terminal-stack-transition.html §25 Grok row",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:hooks-disabled",
    scenario: "modal",
    // distinct probe from approval
    observation: { capabilityProbe: "structured-modal" },
    note: "no structured modal proof in grok.ts",
    sourceCitations: [
      "src/adapters/tools/grok.ts:39-50 (provider hook imports disabled)",
      "docs/design/terminal-stack-transition.html §25 Grok row",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["host"],
    scenario: "disconnect",
    observation: {
      processState: "dead",
      sessionId: "grok-ses-1",
      timestamp: T3,
    },
    attempt: attemptFor("grok-ses-1", T1),
    note: "dead + exact session + loss timestamp ≥ commit",
    sourceCitations: [
      "src/adapters/tools/grok.ts:18-20 (session identity)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["host"],
    scenario: "restart",
    observation: {
      processState: "restarting",
      sessionId: "grok-ses-1",
    },
    note: "restarting process; not ready until summary reappears",
    sourceCitations: [
      "src/adapters/tools/grok.ts:127-143 (spawn/resume with session id)",
    ],
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
    label: "summary mtime keys misspelled",
    misspelled: {
      processState: "alive",
      sessionId: "grok-ses-1",
      summaryLocatd: true,
      summaryMtimMs: 2_000,
    },
    correctlySpelled: {
      processState: "alive",
      sessionId: "grok-ses-1",
      summaryLocated: true,
      previousSummaryMtimeMs: 1_000,
      summaryMtimeMs: 2_000,
      timestamp: T2,
    },
    attempt: attemptFor("grok-ses-1", T1),
  },
];

/** attempt-in-doubt negative controls (must stay evidence-absent for receipt). */
export const IN_DOUBT_NEGATIVE_CONTROLS: Array<{
  label: string;
  surface: ProviderSurfaceId;
  observation: unknown;
  attempt: AttemptContext;
}> = [
  {
    label: "missing session",
    surface: "claude-tui",
    observation: {
      kind: "dead",
      agentName: "w",
      timestamp: T3,
      // toolSessionId absent
    },
    attempt: attemptFor("ses-1", T1),
  },
  {
    label: "mismatched session",
    surface: "claude-tui",
    observation: {
      kind: "dead",
      agentName: "w",
      timestamp: T3,
      toolSessionId: "other-session",
    },
    attempt: attemptFor("ses-1", T1),
  },
  {
    label: "missing loss timestamp",
    surface: "claude-tui",
    observation: {
      kind: "dead",
      agentName: "w",
      toolSessionId: "ses-1",
      // timestamp absent
    },
    attempt: attemptFor("ses-1", T1),
  },
  {
    label: "pre-commit loss timestamp",
    surface: "claude-tui",
    observation: {
      kind: "dead",
      agentName: "w",
      timestamp: T0,
      toolSessionId: "ses-1",
    },
    attempt: attemptFor("ses-1", T1),
  },
  {
    label: "grok missing session on death",
    surface: "grok-tui",
    observation: {
      processState: "dead",
      timestamp: T3,
    },
    attempt: attemptFor("grok-ses-1", T1),
  },
  {
    label: "grok missing timestamp on death",
    surface: "grok-tui",
    observation: {
      processState: "dead",
      sessionId: "grok-ses-1",
    },
    attempt: attemptFor("grok-ses-1", T1),
  },
];

export const GROK_HOOK_ABSENCE_PROBES = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PostToolUse",
  "Notification",
  "structured-approval",
  "structured-modal",
  "turn-busy-state",
  "updates.jsonl",
  "turn_completed",
] as const;

/**
 * Conformance probes with explicit evidence origins. Adapter-origin rows name
 * the provider surface and cite its adapter; host-only rows cannot be reported
 * as adapter emission. CONFORMANCE_PROBES applies the metadata citation gate.
 */
export const EMITTABLE_PROBES: EmittableProbe[] = [
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:Stop",
    label: "ready-stop",
    observation: {
      kind: "turn-end",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
      unresolvedModal: false,
    },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/adapters/tools/claude.ts:615"],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:UserPromptSubmit",
    label: "busy-turn-start",
    observation: {
      kind: "turn-start",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/adapters/tools/claude.ts:614"],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:PostToolUse",
    label: "turn-boundary",
    observation: {
      kind: "tool-boundary",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/adapters/tools/claude.ts:617-621"],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:Notification",
    label: "awaiting-approval",
    observation: {
      kind: "notification",
      timestamp: T2,
      notificationType: "permission_prompt",
    },
    sourceCitations: [
      "src/adapters/tools/claude.ts:616",
      "src/daemon/server.ts:396-407",
    ],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "claude:Notification",
    label: "blocked-unknown",
    observation: {
      kind: "notification",
      timestamp: T2,
      notificationType: "unknown_x",
    },
    sourceCitations: ["src/adapters/tools/claude.ts:616", "src/schemas/event.ts:48-52"],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["host"],
    label: "disconnected-in-doubt",
    observation: { kind: "dead", timestamp: T3, toolSessionId: "s" },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/schemas/event.ts:70"],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["host"],
    label: "restarting",
    observation: { kind: "session-launch", timestamp: T0 },
    sourceCitations: ["src/schemas/event.ts:12-15"],
  },
  {
    surface: "claude-tui",
    evidenceOrigins: ["host"],
    label: "evidence-absent-kind",
    observation: { knd: "turn-end" },
    sourceCitations: [
      "src/schemas/event.ts (kind is required; misspelling is reader fail-closed)",
    ],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "codex:Stop",
    label: "ready-stop",
    observation: {
      kind: "turn-end",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
      unresolvedModal: false,
    },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/adapters/tools/codex.ts:186"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "codex:UserPromptSubmit",
    label: "busy",
    observation: {
      kind: "turn-start",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/adapters/tools/codex.ts:182"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "codex:PostToolUse",
    label: "turn-boundary",
    observation: {
      kind: "tool-boundary",
      timestamp: T2,
      toolSessionId: "s",
      processHealth: "alive",
    },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/adapters/tools/codex.ts:184"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex:registered-hooks",
    label: "approval-capability-absent",
    observation: { capabilityProbe: "structured-approval" },
    sourceCitations: ["src/adapters/tools/codex.ts:174-186"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex:registered-hooks",
    label: "notification-capability-absent",
    observation: { capabilityProbe: "Notification" },
    sourceCitations: ["src/adapters/tools/codex.ts:174-186"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["host"],
    label: "disconnected",
    observation: { kind: "dead", timestamp: T3, toolSessionId: "s" },
    attempt: attemptFor("s", T1),
    sourceCitations: ["src/schemas/event.ts:70"],
  },
  {
    surface: "codex-tui",
    evidenceOrigins: ["host"],
    label: "restarting",
    observation: { kind: "session-launch", timestamp: T0 },
    sourceCitations: ["src/schemas/event.ts:12-15"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:turn/completed",
    label: "ready",
    observation: {
      method: "turn/completed",
      timestamp: T2,
      params: { turn: { id: "t" }, threadId: "th" },
    },
    attempt: attemptFor("th", T1),
    sourceCitations: ["src/adapters/tools/codex-app-server.ts:578-601"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:turn/started",
    label: "busy",
    observation: {
      method: "turn/started",
      timestamp: T2,
      params: { turn: { id: "t" }, threadId: "th" },
    },
    attempt: attemptFor("th", T1),
    sourceCitations: ["src/adapters/tools/codex-app-server.ts:554-562"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:requestApproval",
    label: "approval",
    observation: {
      method: "item/commandExecution/requestApproval",
      params: { command: "x" },
    },
    sourceCitations: ["src/adapters/tools/codex-app-server.ts:605-620"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:unsupported-request",
    label: "blocked-unknown",
    observation: { method: "future/dialog", params: {} },
    sourceCitations: ["src/adapters/tools/codex-app-server.ts:605-614"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["host"],
    label: "disconnected",
    observation: { kind: "dead", toolSessionId: "th", timestamp: T3 },
    attempt: attemptFor("th", T1),
    sourceCitations: ["src/schemas/event.ts:70"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["host"],
    label: "restarting",
    observation: { kind: "session-launch", timestamp: T0 },
    sourceCitations: ["src/schemas/event.ts:12-15"],
  },
  {
    surface: "codex-app-server",
    evidenceOrigins: ["adapter"],
    adapterSurface: "codex-app-server:turn/started",
    label: "evidence-absent-no-turn-id",
    observation: {
      method: "turn/started",
      timestamp: T2,
      params: { threadId: "th" },
    },
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:554-556 (requires turn.id)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter", "host"],
    adapterSurface: "grok:summary-reader",
    label: "artifact-activity-summary-mtime",
    observation: {
      processState: "alive",
      sessionId: "g",
      summaryLocated: true,
      previousSummaryMtimeMs: 1_000,
      summaryMtimeMs: 2_000,
      timestamp: T2,
    },
    attempt: attemptFor("g", T1),
    sourceCitations: [
      "src/adapters/tools/grok.ts:270-279,353-414 (summary.json mtimeMs)",
      "src/adapters/tools/grok.ts:18-20,127-133 (sessionId)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:no-turn-stream",
    label: "busy-capability-absent",
    observation: { capabilityProbe: "turn-busy-state" },
    sourceCitations: [
      "src/adapters/tools/grok.ts:264-417 (no turn stream)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:hooks-disabled",
    label: "approval-capability-absent",
    observation: { capabilityProbe: "structured-approval" },
    sourceCitations: [
      "src/adapters/tools/grok.ts:39-50 (provider hook imports disabled)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:hooks-disabled",
    label: "modal-capability-absent",
    observation: { capabilityProbe: "structured-modal" },
    sourceCitations: [
      "src/adapters/tools/grok.ts:39-50 (provider hook imports disabled)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["host"],
    label: "disconnected",
    observation: {
      processState: "dead",
      sessionId: "g",
      timestamp: T3,
    },
    attempt: attemptFor("g", T1),
    sourceCitations: ["src/adapters/tools/grok.ts:18-20"],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["host"],
    label: "restarting",
    observation: { processState: "restarting", sessionId: "g" },
    sourceCitations: ["src/adapters/tools/grok.ts:127-143"],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:hooks-disabled",
    label: "hook-absent",
    observation: { capabilityProbe: "SessionStart" },
    sourceCitations: [
      "src/adapters/tools/grok.ts:39-50 (hooks disabled; none registered)",
    ],
  },
  {
    surface: "grok-tui",
    evidenceOrigins: ["adapter"],
    adapterSurface: "grok:summary-reader",
    label: "evidence-absent-no-summary",
    observation: { processState: "alive", sessionId: "g" },
    sourceCitations: [
      "src/adapters/tools/grok.ts:353-414 (summaryLocated required)",
    ],
  },
];

/** Probes that pass origin metadata and adapter-file citation gates. */
export const CONFORMANCE_PROBES: EmittableProbe[] = EMITTABLE_PROBES.filter(
  hasRequiredEvidenceGrounding,
);
