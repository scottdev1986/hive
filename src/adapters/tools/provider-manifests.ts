import {
  ProviderManifestSchema,
  WP8_OUT_OF_SCOPE_SEAMS,
  type ProviderManifest,
  type ProviderSurfaceId,
} from "../../schemas/provider-manifest";

/**
 * Versioned adapter manifests for §25 / WP8 early slice.
 * Every field is grounded in existing adapter source; absences are explicit.
 */

const LATER_SEAMS = Object.keys(WP8_OUT_OF_SCOPE_SEAMS);

export const CLAUDE_TUI_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "claude-tui",
  fixtureSet: "tg4-claude-tui",
  versionRange: {
    measured: ["2.1.206", "2.1.207"],
    unknownVersionPolicy:
      "interactive-ok-automatic-features-disabled-until-classified",
    versionProbeArgv: ["claude", "--version"],
  },
  launchArgv: {
    executable: "claude",
    spawnShape: [
      "claude",
      "[--model <model>]",
      "[--effort <effort>]",
      "[--permission-mode default]",
      "[--settings <path> --setting-sources user]",
      "[--mcp-config <path> --strict-mcp-config]",
      "[--append-system-prompt <text>]",
    ],
    resumeShape: ["claude", "--resume", "<session-id>", "...same spawn flags..."],
    sourceCitations: [
      "src/adapters/tools/claude.ts:267-320 (buildClaudeSpawnCommand / buildClaudeResumeCommand)",
      "src/adapters/tools/claude.ts:99-125 (probeClaudeVersion / probeClaudeVersion sync)",
      "src/adapters/tools/claude.ts:168-178 (resolveWorkingClaudeExecutable)",
    ],
  },
  eventSchemas: [
    {
      id: "hive.hook.session-start",
      providerName: "SessionStart",
      role: "session-start",
      available: true,
      sourceCitations: ["src/adapters/tools/claude.ts:610-611"],
    },
    {
      id: "hive.hook.turn-start",
      providerName: "UserPromptSubmit",
      role: "turn-start",
      available: true,
      sourceCitations: ["src/adapters/tools/claude.ts:614"],
    },
    {
      id: "hive.hook.turn-end",
      providerName: "Stop",
      role: "turn-end",
      available: true,
      sourceCitations: ["src/adapters/tools/claude.ts:615"],
    },
    {
      id: "hive.hook.notification",
      providerName: "Notification",
      role: "notification",
      available: true,
      sourceCitations: [
        "src/adapters/tools/claude.ts:616",
        "src/schemas/event.ts:38-53 (notificationType free string; unknown must not reject)",
        "src/daemon/server.ts:396-407 (permission_prompt measured blocked)",
      ],
    },
    {
      id: "hive.hook.tool-boundary",
      providerName: "PostToolUse",
      role: "tool-boundary",
      available: true,
      sourceCitations: ["src/adapters/tools/claude.ts:617-621"],
    },
  ],
  readinessStates: [
    "ready",
    "busy",
    "turn-boundary",
    "awaiting-approval",
    "blocked-unknown",
    "disconnected",
    "restarting",
    "evidence-absent",
  ],
  cancelSubmit: {
    submit: {
      encoding: "tmux load-buffer + paste-buffer -p + send-keys Enter",
      available: true,
      sourceCitations: ["src/adapters/tmux.ts:207-242"],
    },
    cancel: {
      encoding:
        "tmux send-keys Escape then C-u (interruptComposer) before re-paste; urgent path",
      available: true,
      sourceCitations: ["src/adapters/tmux.ts:190-215"],
    },
  },
  nativeEndpoint: {
    available: false,
    endpoints: [],
    sourceCitations: [
      "src/adapters/tools/claude.ts (no app-server client; hooks + TUI only)",
    ],
    note: "Claude TUI has no Hive-owned native input endpoint; delivery is PTY paste.",
  },
  strongestAutomaticReceipt: "provider-observed",
  unknownModalBlocksDelivery: true,
  capabilityAbsences: [
    "native-session-state",
    "native-turn-state",
    "native-structured-input-endpoint",
  ],
  laterSeams: LATER_SEAMS,
});

export const CODEX_TUI_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "codex-tui",
  fixtureSet: "tg4-codex-tui",
  versionRange: {
    measured: ["0.144.0", "0.144.1"],
    unknownVersionPolicy:
      "interactive-ok-automatic-features-disabled-until-classified",
    versionProbeArgv: ["codex", "--version"],
  },
  launchArgv: {
    executable: "codex",
    spawnShape: [
      "codex",
      "-c features.apps=false",
      "[-c model=...]",
      "-c model_reasoning_effort=...",
      "[--sandbox read-only | -c sandbox_mode=...]",
      "-c projects.<cwd>.trust_level=trusted",
      "--dangerously-bypass-hook-trust",
      "-c features.hooks=true",
      "-c hooks.SessionStart=...",
      "-c hooks.UserPromptSubmit=...",
      "-c hooks.PostToolUse=...",
      "-c hooks.Stop=...",
      "-c mcp_servers.hive.url=...",
    ],
    resumeShape: [
      "codex",
      "resume",
      "...same -c overrides with sandbox as config override...",
      "<session-id>",
    ],
    sourceCitations: [
      "src/adapters/tools/codex.ts:112-256 (buildCodexConfigArgs / spawn / resume)",
      "src/adapters/tools/codex.ts:152-186 (lifecycle hooks on CLI -c, not project file)",
    ],
  },
  eventSchemas: [
    {
      id: "hive.hook.session-start",
      providerName: "SessionStart",
      role: "session-start",
      available: true,
      sourceCitations: ["src/adapters/tools/codex.ts:180"],
    },
    {
      id: "hive.hook.turn-start",
      providerName: "UserPromptSubmit",
      role: "turn-start",
      available: true,
      sourceCitations: ["src/adapters/tools/codex.ts:182"],
    },
    {
      id: "hive.hook.tool-boundary",
      providerName: "PostToolUse",
      role: "tool-boundary",
      available: true,
      sourceCitations: ["src/adapters/tools/codex.ts:184"],
    },
    {
      id: "hive.hook.turn-end",
      providerName: "Stop",
      role: "turn-end",
      available: true,
      sourceCitations: ["src/adapters/tools/codex.ts:186"],
    },
    {
      id: "hive.hook.notification",
      providerName: "Notification",
      role: "notification",
      available: false,
      sourceCitations: [
        "src/adapters/tools/codex.ts:174-186 (no Notification hook registered)",
      ],
    },
  ],
  readinessStates: [
    "ready",
    "busy",
    "turn-boundary",
    "awaiting-approval",
    "blocked-unknown",
    "disconnected",
    "restarting",
    "evidence-absent",
    "capability-absent",
  ],
  cancelSubmit: {
    submit: {
      encoding: "tmux load-buffer + paste-buffer -p + send-keys Enter",
      available: true,
      sourceCitations: ["src/adapters/tmux.ts:207-242"],
    },
    cancel: {
      encoding:
        "tmux send-keys Escape then C-u (interruptComposer) before re-paste; urgent path",
      available: true,
      sourceCitations: ["src/adapters/tmux.ts:190-215"],
    },
  },
  nativeEndpoint: {
    available: false,
    endpoints: [],
    sourceCitations: [
      "src/adapters/tools/codex.ts (TUI path; native endpoints live on codex-app-server surface)",
    ],
    note: "Codex TUI delivery is PTY paste; structured input is the separate codex-app-server surface.",
  },
  strongestAutomaticReceipt: "provider-observed",
  unknownModalBlocksDelivery: true,
  capabilityAbsences: [
    "Notification-hook (not registered on TUI spawn)",
    "native-structured-input-endpoint-on-this-surface",
  ],
  laterSeams: LATER_SEAMS,
});

export const CODEX_APP_SERVER_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "codex-app-server",
  fixtureSet: "tg4-codex-app-server",
  versionRange: {
    measured: ["0.144.1"],
    unknownVersionPolicy:
      "interactive-ok-automatic-features-disabled-until-classified",
    versionProbeArgv: ["codex", "--version"],
  },
  launchArgv: {
    executable: "codex",
    spawnShape: [
      "codex",
      "app-server",
      "--stdio",
      "-c features.apps=false",
      "-c projects.<worktree>.trust_level=trusted",
      "-c mcp_servers.hive.url=...",
      "[-c mcp_servers.graphify.url=...]",
    ],
    resumeShape: [
      "thread/start + turn/start over JSON-RPC (no CLI resume argv on this surface)",
    ],
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:722-751 (buildCodexAppServerCommand)",
      "src/adapters/tools/codex-app-server.ts:367-431 (initialize / thread/start / turn/start)",
    ],
  },
  eventSchemas: [
    {
      id: "hive.native.session-start",
      providerName: "thread/start response + hive session-start event",
      role: "native-session",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:388-409",
      ],
    },
    {
      id: "hive.native.turn-started",
      providerName: "turn/started",
      role: "native-turn",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:554-562",
      ],
    },
    {
      id: "hive.native.turn-completed",
      providerName: "turn/completed",
      role: "native-turn",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:578-601",
      ],
    },
    {
      id: "hive.native.approval",
      providerName: "item/*/requestApproval (+ related request methods)",
      role: "approval",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:605-620",
        "src/adapters/tools/codex-app-server.ts:623+",
      ],
    },
  ],
  readinessStates: [
    "ready",
    "busy",
    "turn-boundary",
    "awaiting-approval",
    "blocked-unknown",
    "disconnected",
    "restarting",
    "evidence-absent",
  ],
  cancelSubmit: {
    submit: {
      encoding:
        "JSON-RPC turn/start (idle) or turn/steer (active turn) with text input items",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:418-444",
        "src/adapters/tools/codex-app-server.ts:446-458",
      ],
    },
    cancel: {
      encoding: "JSON-RPC turn/interrupt { threadId, turnId }",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:461-479",
      ],
    },
  },
  nativeEndpoint: {
    available: true,
    endpoints: [
      "initialize",
      "thread/start",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "account/rateLimits/read",
    ],
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts:367-479",
      "src/adapters/tools/codex-app-server.ts:534-547",
    ],
  },
  strongestAutomaticReceipt: "provider-observed",
  unknownModalBlocksDelivery: true,
  capabilityAbsences: [
    "SessionStart/UserPromptSubmit/Stop/PostToolUse hooks (native RPC instead)",
    "tmux paste submit on this surface when conformance is green",
  ],
  laterSeams: LATER_SEAMS,
});

export const GROK_TUI_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "grok-tui",
  fixtureSet: "tg4-grok-tui",
  versionRange: {
    measured: ["0.2.101"],
    unknownVersionPolicy:
      "interactive-ok-automatic-features-disabled-until-classified",
    versionProbeArgv: ["grok", "--version"],
  },
  launchArgv: {
    executable: "grok",
    spawnShape: [
      "grok",
      "-m <model>",
      "[--reasoning-effort <effort>]",
      "[--always-approve | --deny/--allow rules]",
      "[--session-id <uuid>]",
    ],
    resumeShape: ["grok", "-r", "<session-id>", "-m <model>", "...permissions..."],
    sourceCitations: [
      "src/adapters/tools/grok.ts:118-144 (spawn / resume; --session-id create-only)",
      "src/adapters/tools/grok.ts:67-88 (probeGrokCliVersion)",
      "src/adapters/tools/grok.ts:39-50 (GROK_COMPATIBILITY_ENV disables inherited hooks)",
    ],
  },
  eventSchemas: [
    {
      id: "hive.grok.process-health",
      providerName: "process liveness (tmux/session presence)",
      role: "process-health",
      available: true,
      sourceCitations: [
        "docs/design/terminal-stack-transition.html §25 Grok TUI row",
        "src/daemon/delivery.ts:175-182 (no lifecycle hooks)",
      ],
    },
    {
      id: "hive.grok.transcript-activity",
      providerName: "updates.jsonl last activity / turn_completed",
      role: "transcript-activity",
      available: true,
      sourceCitations: [
        "src/daemon/tool-telemetry.ts:234-266 (GrokTelemetry.turnCompleted)",
        "src/daemon/server.ts:1433-1444 (sweep maps turnCompleted to idle/working)",
      ],
    },
    {
      id: "hive.hook.session-start",
      providerName: "SessionStart",
      role: "session-start",
      available: false,
      sourceCitations: [
        "src/adapters/tools/grok.ts (no hook registration)",
        "src/daemon/delivery.ts:175-176",
      ],
    },
    {
      id: "hive.hook.turn-start",
      providerName: "UserPromptSubmit",
      role: "turn-start",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent)"],
    },
    {
      id: "hive.hook.turn-end",
      providerName: "Stop",
      role: "turn-end",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent)"],
    },
    {
      id: "hive.hook.tool-boundary",
      providerName: "PostToolUse",
      role: "tool-boundary",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent)"],
    },
  ],
  readinessStates: [
    "ready",
    "busy",
    "blocked-unknown",
    "disconnected",
    "restarting",
    "evidence-absent",
    "capability-absent",
  ],
  cancelSubmit: {
    submit: {
      encoding: "tmux load-buffer + paste-buffer -p + send-keys Enter",
      available: true,
      sourceCitations: ["src/adapters/tmux.ts:207-242"],
    },
    cancel: {
      encoding:
        "tmux Escape+C-u interruptComposer available as PTY keystrokes; no provider hook receipt of cancel",
      available: true,
      sourceCitations: [
        "src/adapters/tmux.ts:190-215",
        "src/adapters/tools/grok.ts (no cancel-ack hook)",
      ],
    },
  },
  nativeEndpoint: {
    available: false,
    endpoints: [],
    sourceCitations: ["src/adapters/tools/grok.ts (TUI only)"],
    note: "No structured input endpoint; session id is preassigned at spawn.",
  },
  strongestAutomaticReceipt: "provider-observed",
  unknownModalBlocksDelivery: true,
  capabilityAbsences: [
    "SessionStart hook",
    "UserPromptSubmit hook",
    "Stop hook",
    "PostToolUse hook",
    "Notification hook",
    "structured approval/modal proof in v1",
    "native-structured-input-endpoint",
  ],
  laterSeams: LATER_SEAMS,
});

export const PROVIDER_MANIFESTS: Record<ProviderSurfaceId, ProviderManifest> = {
  "claude-tui": CLAUDE_TUI_MANIFEST,
  "codex-tui": CODEX_TUI_MANIFEST,
  "codex-app-server": CODEX_APP_SERVER_MANIFEST,
  "grok-tui": GROK_TUI_MANIFEST,
};

export function manifestFor(surface: ProviderSurfaceId): ProviderManifest {
  return PROVIDER_MANIFESTS[surface];
}

export function allProviderManifests(): ProviderManifest[] {
  return Object.values(PROVIDER_MANIFESTS);
}
