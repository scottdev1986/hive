import {
  ProviderConformanceReportSchema,
  type ProviderConformanceReport,
} from "../../schemas/provider-manifest";

/**
 * TG4 adjudication input for WP8 early slice: which §25 evidence levels each
 * provider surface can prove TODAY with existing hooks / app-server /
 * transcript surfaces, and which are honestly unavailable.
 *
 * Does not invent timers, screen phrases, or delivery decisions.
 */
export const PROVIDER_CONFORMANCE_REPORT: ProviderConformanceReport =
  ProviderConformanceReportSchema.parse({
    schemaVersion: 1,
    generatedFor: "WP8-early-slice-TG4",
    designRefs: [
      "docs/design/terminal-stack-transition.html §25",
      "docs/design/terminal-stack-transition.html §17 TG4",
      "docs/design/terminal-stack-transition.html §07 turnState sources",
      "docs/design/terminal-stack-transition.html §28 WP8",
      "src/schemas/message-envelope.ts TERMINAL_DELIVERY_EVIDENCE",
      "src/schemas/event.ts HookEventSchema",
    ],
    surfaces: [
      {
        surface: "claude-tui",
        readiness: [
          {
            kind: "ready",
            status: "provable-today",
            evidence:
              "SessionStart and Stop hooks (claude.ts:611-615); daemon maps turn-end → idle",
          },
          {
            kind: "busy",
            status: "provable-today",
            evidence: "UserPromptSubmit → turn-start hook (claude.ts:614)",
          },
          {
            kind: "turn-boundary",
            status: "provable-today",
            evidence: "PostToolUse → tool-boundary (claude.ts:617-621)",
          },
          {
            kind: "awaiting-approval",
            status: "provable-today",
            evidence:
              "Notification notificationType=permission_prompt (server.ts:396-407, event.ts:43-47)",
          },
          {
            kind: "blocked-unknown",
            status: "provable-today",
            evidence:
              "unclassified notificationType → blocked-unknown (§25; never ready)",
          },
          {
            kind: "disconnected",
            status: "provable-today",
            evidence: "session-end / dead hook kinds",
          },
          {
            kind: "restarting",
            status: "provable-today",
            evidence: "session-launch process lifecycle event",
          },
          {
            kind: "evidence-absent",
            status: "provable-today",
            evidence: "missing/misspelled keys read as evidence-absent",
          },
          {
            kind: "capability-absent",
            status: "unavailable",
            evidence:
              "not used for Claude TUI primary paths; native endpoints absent only",
          },
        ],
        receipt: [
          {
            level: "transport-written",
            status: "unavailable",
            evidence:
              "sessiond PTY commit / byte-range receipt is WP4 host work, not adapter hooks",
          },
          {
            level: "provider-observed",
            status: "provable-today",
            evidence:
              "later UserPromptSubmit/turn-start after injection under same session (§25)",
          },
          {
            level: "attempt-in-doubt",
            status: "provable-today",
            evidence: "session-end/dead after commit loses proof boundary",
          },
        ],
      },
      {
        surface: "codex-tui",
        readiness: [
          {
            kind: "ready",
            status: "provable-today",
            evidence: "SessionStart + Stop via notify hooks (codex.ts:180-186)",
          },
          {
            kind: "busy",
            status: "provable-today",
            evidence: "UserPromptSubmit hook (codex.ts:182)",
          },
          {
            kind: "turn-boundary",
            status: "provable-today",
            evidence: "PostToolUse hook (codex.ts:184)",
          },
          {
            kind: "awaiting-approval",
            status: "provable-today",
            evidence:
              "approval-request when available; Notification hook not registered on TUI spawn",
          },
          {
            kind: "blocked-unknown",
            status: "provable-today",
            evidence: "unclassified modal/hook kinds fail closed",
          },
          {
            kind: "disconnected",
            status: "provable-today",
            evidence: "session-end / dead",
          },
          {
            kind: "restarting",
            status: "provable-today",
            evidence: "session-launch",
          },
          {
            kind: "evidence-absent",
            status: "provable-today",
            evidence: "missing hooks degrade receipt, not safety (§25)",
          },
          {
            kind: "capability-absent",
            status: "provable-today",
            evidence: "Notification hook not installed on codex TUI spawn",
          },
        ],
        receipt: [
          {
            level: "transport-written",
            status: "unavailable",
            evidence: "sessiond host concern; TUI uses paste transport",
          },
          {
            level: "provider-observed",
            status: "provable-today",
            evidence: "later matching turn-start after injection (§25)",
          },
          {
            level: "attempt-in-doubt",
            status: "provable-today",
            evidence: "lost boundary on disconnect/dead",
          },
        ],
      },
      {
        surface: "codex-app-server",
        readiness: [
          {
            kind: "ready",
            status: "provable-today",
            evidence:
              "thread/start + turn/completed; activeTurnId null (codex-app-server.ts)",
          },
          {
            kind: "busy",
            status: "provable-today",
            evidence: "turn/started + activeTurnId (codex-app-server.ts:554-562)",
          },
          {
            kind: "turn-boundary",
            status: "unavailable",
            evidence:
              "no PostToolUse equivalent; steer uses active turn precondition instead",
          },
          {
            kind: "awaiting-approval",
            status: "provable-today",
            evidence: "item/*/requestApproval request handlers",
          },
          {
            kind: "blocked-unknown",
            status: "provable-today",
            evidence: "unsupported request methods fail closed",
          },
          {
            kind: "disconnected",
            status: "provable-today",
            evidence: "disconnect() / socket loss",
          },
          {
            kind: "restarting",
            status: "provable-today",
            evidence: "reconnect + thread/start new generation",
          },
          {
            kind: "evidence-absent",
            status: "provable-today",
            evidence: "missing method/kind fields",
          },
          {
            kind: "capability-absent",
            status: "unavailable",
            evidence: "primary paths are native RPC, not hook-absent",
          },
        ],
        receipt: [
          {
            level: "transport-written",
            status: "provable-today",
            evidence:
              "native endpoint acceptance (turn/start, turn/steer) is transport receipt form when used",
          },
          {
            level: "provider-observed",
            status: "provable-today",
            evidence: "accepted input/turn ID + turn/started (§25)",
          },
          {
            level: "attempt-in-doubt",
            status: "provable-today",
            evidence: "disconnect mid-attempt loses proof boundary",
          },
        ],
      },
      {
        surface: "grok-tui",
        readiness: [
          {
            kind: "ready",
            status: "provable-today",
            evidence:
              "conservative: process alive + turnCompleted true from updates.jsonl",
          },
          {
            kind: "busy",
            status: "provable-today",
            evidence: "turnCompleted false from updates.jsonl last record",
          },
          {
            kind: "turn-boundary",
            status: "unavailable",
            evidence: "no PostToolUse / tool-boundary hook — capability absent",
          },
          {
            kind: "awaiting-approval",
            status: "unavailable",
            evidence: "no structured approval proof in v1 (§25 Grok row)",
          },
          {
            kind: "blocked-unknown",
            status: "provable-today",
            evidence:
              "possibleModal=true blocks automatic delivery; requests attention",
          },
          {
            kind: "disconnected",
            status: "provable-today",
            evidence: "processState dead/missing",
          },
          {
            kind: "restarting",
            status: "provable-today",
            evidence: "processState restarting + preassigned session id reattach",
          },
          {
            kind: "evidence-absent",
            status: "provable-today",
            evidence: "null turnCompleted / missing fields",
          },
          {
            kind: "capability-absent",
            status: "provable-today",
            evidence:
              "all lifecycle hooks absent (GROK_COMPATIBILITY_ENV disables inherited hooks too)",
          },
        ],
        receipt: [
          {
            level: "transport-written",
            status: "unavailable",
            evidence: "sessiond host concern",
          },
          {
            level: "provider-observed",
            status: "provable-today",
            evidence:
              "exact session transcript last-activity advancing after injection (§25); else remain in-doubt",
          },
          {
            level: "attempt-in-doubt",
            status: "provable-today",
            evidence:
              "no activity advance after injection, or process death — never fabricate hook receipt",
          },
        ],
      },
    ],
  });
