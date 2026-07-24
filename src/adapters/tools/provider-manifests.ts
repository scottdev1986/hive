import {
  ProviderManifestSchema,
  WP8_OUT_OF_SCOPE_SEAMS,
  type ProviderManifest,
  type ProviderSurfaceId,
} from "../../schemas/provider-manifest";

/**
 * Versioned adapter manifests for §25 / WP8 early slice.
 * Every grounded field carries sourceCitations; absences are explicit.
 */

const LATER_SEAMS = Object.keys(WP8_OUT_OF_SCOPE_SEAMS);

export const CLAUDE_TUI_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "claude-tui",
  fixtureSet: {
    value: "tg4-claude-tui",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 version-support / CI fixture set",
      "src/adapters/tools/__fixtures__/tg4/corpus.ts (claude-tui scenarios)",
    ],
  },
  executableProbe: {
    argv: ["claude", "--version"],
    sourceCitations: [
      "src/adapters/tools/provider-executable.ts (launchability probe and candidate scan)",
    ],
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
        "src/schemas/event.ts:38-53",
        "src/daemon/server.ts:396-407",
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
  readinessStates: {
    value: [
      "ready",
      "busy",
      "turn-boundary",
      "awaiting-approval",
      "blocked-unknown",
      "disconnected",
      "restarting",
      "evidence-absent",
    ],
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Claude TUI row",
      "src/adapters/tools/claude.ts:610-621 (hooks that feed readiness)",
      "src/daemon/server.ts:396-407,3120-3133 (permission_prompt → awaiting-approval)",
      "src/adapters/tools/provider-evidence.ts classifyHookObservation",
    ],
  },
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
      "src/adapters/tools/claude.ts (hooks + TUI only; no app-server client)",
    ],
    note: "Claude TUI has no Hive-owned native input endpoint; delivery is PTY paste.",
  },
  strongestAutomaticReceipt: {
    value: "provider-observed",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Claude strongest automatic receipt",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS claude-tui",
    ],
  },
  unknownModalBlocksDelivery: {
    value: true,
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 unknown notification types block",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS.unknownModalBlocksDelivery",
    ],
  },
  capabilityAbsences: {
    value: [
      "native-session-state",
      "native-turn-state",
      "native-structured-input-endpoint",
    ],
    sourceCitations: [
      "src/adapters/tools/claude.ts (no native RPC surface)",
      "docs/design/terminal-stack-transition.html §25 Claude TUI row",
    ],
  },
  laterSeams: LATER_SEAMS,
});

export const CODEX_TUI_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "codex-tui",
  fixtureSet: {
    value: "tg4-codex-tui",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 version-support / CI fixture set",
      "src/adapters/tools/__fixtures__/tg4/corpus.ts (codex-tui scenarios)",
    ],
  },
  executableProbe: {
    argv: ["codex", "--version"],
    sourceCitations: [
      "src/adapters/tools/provider-executable.ts (launchability probe and candidate scan)",
    ],
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
      "src/adapters/tools/codex.ts:112-256",
      "src/adapters/tools/codex.ts:152-186",
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
        "src/adapters/tools/codex.ts:174-186 (SessionStart/UserPromptSubmit/PostToolUse/Stop only — no Notification)",
      ],
    },
    {
      id: "hive.hook.approval",
      providerName: "approval-request",
      role: "approval",
      available: false,
      sourceCitations: [
        "src/adapters/tools/codex.ts:174-186 (no structured approval hook on TUI spawn)",
      ],
    },
  ],
  readinessStates: {
    // No awaiting-approval: Notification/approval hooks are absent on this surface.
    value: [
      "ready",
      "busy",
      "turn-boundary",
      "blocked-unknown",
      "disconnected",
      "restarting",
      "evidence-absent",
      "capability-absent",
    ],
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Codex TUI row",
      "src/adapters/tools/codex.ts:174-186 (hooks registered; Notification absent)",
      "src/adapters/tools/provider-evidence.ts classifyHookObservation codex-tui gates",
    ],
  },
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
      "src/adapters/tools/codex.ts (TUI path; native endpoints are codex-app-server surface)",
    ],
    note: "Codex TUI delivery is PTY paste; structured input is the separate codex-app-server surface.",
  },
  strongestAutomaticReceipt: {
    value: "provider-observed",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Codex TUI strongest automatic receipt",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS codex-tui",
    ],
  },
  unknownModalBlocksDelivery: {
    value: true,
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 unclassified modal output blocks delivery",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS.unknownModalBlocksDelivery",
    ],
  },
  capabilityAbsences: {
    value: [
      "Notification-hook",
      "structured-approval-hook",
      "awaiting-approval-classification",
      "native-structured-input-endpoint-on-this-surface",
    ],
    sourceCitations: [
      "src/adapters/tools/codex.ts:174-186",
      "docs/design/terminal-stack-transition.html §25 Codex TUI row (approval-request events when available)",
    ],
  },
  laterSeams: LATER_SEAMS,
});

export const CODEX_APP_SERVER_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "codex-app-server",
  fixtureSet: {
    value: "tg4-codex-app-server",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 version-support / CI fixture set",
      "src/adapters/tools/__fixtures__/tg4/corpus.ts (codex-app-server scenarios)",
    ],
  },
  executableProbe: {
    argv: ["codex", "--version"],
    sourceCitations: [
      "src/adapters/tools/provider-executable.ts (launchability probe and candidate scan)",
    ],
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
      "src/adapters/tools/codex-app-server.ts:722-751",
      "src/adapters/tools/codex-app-server.ts:367-431",
    ],
  },
  eventSchemas: [
    {
      id: "hive.native.session-start",
      providerName: "thread/start response + hive session-start event",
      role: "native-session",
      available: true,
      sourceCitations: ["src/adapters/tools/codex-app-server.ts:388-409"],
    },
    {
      id: "hive.native.turn-started",
      providerName: "turn/started",
      role: "native-turn",
      available: true,
      sourceCitations: ["src/adapters/tools/codex-app-server.ts:554-562"],
    },
    {
      id: "hive.native.turn-completed",
      providerName: "turn/completed",
      role: "native-turn",
      available: true,
      sourceCitations: ["src/adapters/tools/codex-app-server.ts:578-601"],
    },
    {
      id: "hive.native.approval",
      providerName: "item/*/requestApproval",
      role: "approval",
      available: true,
      sourceCitations: [
        "src/adapters/tools/codex-app-server.ts:605-620",
        "src/adapters/tools/codex-app-server.ts:623+",
      ],
    },
  ],
  readinessStates: {
    value: [
      "ready",
      "busy",
      "awaiting-approval",
      "blocked-unknown",
      "disconnected",
      "restarting",
      "evidence-absent",
    ],
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Codex app-server row",
      "src/adapters/tools/codex-app-server.ts:554-620",
      "src/adapters/tools/provider-evidence.ts classifyCodexAppServerObservation",
    ],
  },
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
      sourceCitations: ["src/adapters/tools/codex-app-server.ts:461-479"],
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
  strongestAutomaticReceipt: {
    value: "provider-observed",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Codex app-server strongest automatic receipt",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS codex-app-server",
    ],
  },
  unknownModalBlocksDelivery: {
    value: true,
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS.unknownModalBlocksDelivery",
    ],
  },
  capabilityAbsences: {
    value: [
      "SessionStart/UserPromptSubmit/Stop/PostToolUse hooks (native RPC instead)",
      "PostToolUse-equivalent turn-boundary hook",
    ],
    sourceCitations: [
      "src/adapters/tools/codex-app-server.ts (JSON-RPC notifications, not TUI hooks)",
      "docs/design/terminal-stack-transition.html §25 Codex app-server row",
    ],
  },
  laterSeams: LATER_SEAMS,
});

export const GROK_TUI_MANIFEST: ProviderManifest = ProviderManifestSchema.parse({
  schemaVersion: 1,
  surface: "grok-tui",
  fixtureSet: {
    value: "tg4-grok-tui",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 version-support / CI fixture set",
      "src/adapters/tools/__fixtures__/tg4/corpus.ts (grok-tui scenarios)",
    ],
  },
  executableProbe: {
    argv: ["grok", "--version"],
    sourceCitations: [
      "src/adapters/tools/provider-executable.ts (launchability probe and candidate scan)",
    ],
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
      "src/adapters/tools/grok.ts:118-144",
      "src/adapters/tools/grok.ts:39-50 (GROK_COMPATIBILITY_ENV)",
    ],
  },
  eventSchemas: [
    {
      id: "hive.grok.preassigned-session",
      providerName: "--session-id preassigned at spawn",
      role: "session-identity",
      available: true,
      sourceCitations: [
        "src/adapters/tools/grok.ts:18-20",
        "src/adapters/tools/grok.ts:127-133",
      ],
    },
    {
      // grok.ts reads summary.json + mtimeMs only — not updates.jsonl / turn_completed.
      id: "hive.grok.summary-mtime",
      providerName: "summary.json location + mtimeMs (GrokSummaryLocation)",
      role: "transcript-activity",
      available: true,
      sourceCitations: [
        "src/adapters/tools/grok.ts:270-279 (GrokSummaryLocation.mtimeMs)",
        "src/adapters/tools/grok.ts:353-414 (read summary.json + stat mtime)",
      ],
    },
    {
      id: "hive.grok.updates-jsonl",
      providerName: "updates.jsonl / turn_completed",
      role: "transcript-activity",
      available: false,
      sourceCitations: [
        "src/adapters/tools/grok.ts:264-417 (findGrokSummaries stops at summary.json; does not open updates.jsonl)",
        "src/adapters/tools/grok.ts:277-278 (comment notes updates.jsonl exist on disk but adapter does not read them)",
      ],
    },
    {
      id: "hive.hook.session-start",
      providerName: "SessionStart",
      role: "session-start",
      available: false,
      sourceCitations: [
        "src/adapters/tools/grok.ts (no hook registration in entire module)",
        "src/adapters/tools/grok.ts:39-50 (GROK_CLAUDE_HOOKS_ENABLED / GROK_CURSOR_HOOKS_ENABLED = false)",
      ],
    },
    {
      id: "hive.hook.turn-start",
      providerName: "UserPromptSubmit",
      role: "turn-start",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent — no hooks)"],
    },
    {
      id: "hive.hook.turn-end",
      providerName: "Stop",
      role: "turn-end",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent — no hooks)"],
    },
    {
      id: "hive.hook.tool-boundary",
      providerName: "PostToolUse",
      role: "tool-boundary",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent — no hooks)"],
    },
    {
      id: "hive.hook.notification",
      providerName: "Notification",
      role: "notification",
      available: false,
      sourceCitations: ["src/adapters/tools/grok.ts (capability absent — no hooks)"],
    },
  ],
  readinessStates: {
    // Neither ready nor busy is available: summary mtime is artifact activity.
    value: [
      "disconnected",
      "restarting",
      "evidence-absent",
      "capability-absent",
    ],
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Grok TUI row (conservative readiness)",
      "src/adapters/tools/grok.ts:270-279,353-414 (summary mtime is artifact activity only)",
      "src/adapters/tools/provider-evidence.ts classifyGrokObservation",
    ],
  },
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
    sourceCitations: ["src/adapters/tools/grok.ts (TUI spawn/resume only)"],
    note: "No structured input endpoint; session id is preassigned at spawn.",
  },
  strongestAutomaticReceipt: {
    value: "provider-observed",
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Grok strongest automatic receipt (transcript last-activity advancing)",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS grok-tui",
    ],
  },
  unknownModalBlocksDelivery: {
    value: true,
    sourceCitations: [
      "docs/design/terminal-stack-transition.html §25 Grok row (possible modal blocks automatic delivery)",
      "src/schemas/message-envelope.ts PROVIDER_ADAPTER_CONTRACTS.unknownModalBlocksDelivery",
    ],
  },
  capabilityAbsences: {
    value: [
      "SessionStart hook",
      "UserPromptSubmit hook",
      "Stop hook",
      "PostToolUse hook",
      "Notification hook",
      "structured approval/modal proof in v1",
      "awaiting-approval-classification",
      "turn-boundary-hook",
      "turn-busy-state (no turn stream)",
      "idle/ready boundary (summary mtime proves artifact activity only)",
      "updates.jsonl / turn_completed reads",
      "native-structured-input-endpoint",
    ],
    sourceCitations: [
      "src/adapters/tools/grok.ts (spawn/resume/summary discovery only)",
      "src/adapters/tools/grok.ts:39-50",
      "src/adapters/tools/grok.ts:264-417 (summary.json only)",
      "docs/design/terminal-stack-transition.html §25 Grok TUI row",
    ],
  },
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

/**
 * Walk every sourceCitations list on a manifest (for tests).
 * Returns paths like "executableProbe", "readinessStates", "eventSchemas[0]", ...
 */
export function collectManifestCitationPaths(
  manifest: ProviderManifest,
): Array<{ path: string; citations: readonly string[] }> {
  const rows: Array<{ path: string; citations: readonly string[] }> = [];
  rows.push({
    path: "fixtureSet",
    citations: manifest.fixtureSet.sourceCitations,
  });
  rows.push({
    path: "executableProbe",
    citations: manifest.executableProbe.sourceCitations,
  });
  rows.push({
    path: "launchArgv",
    citations: manifest.launchArgv.sourceCitations,
  });
  manifest.eventSchemas.forEach((event, index) => {
    rows.push({
      path: `eventSchemas[${index}]`,
      citations: event.sourceCitations,
    });
  });
  rows.push({
    path: "readinessStates",
    citations: manifest.readinessStates.sourceCitations,
  });
  rows.push({
    path: "cancelSubmit.submit",
    citations: manifest.cancelSubmit.submit.sourceCitations,
  });
  rows.push({
    path: "cancelSubmit.cancel",
    citations: manifest.cancelSubmit.cancel.sourceCitations,
  });
  rows.push({
    path: "nativeEndpoint",
    citations: manifest.nativeEndpoint.sourceCitations,
  });
  rows.push({
    path: "strongestAutomaticReceipt",
    citations: manifest.strongestAutomaticReceipt.sourceCitations,
  });
  rows.push({
    path: "unknownModalBlocksDelivery",
    citations: manifest.unknownModalBlocksDelivery.sourceCitations,
  });
  rows.push({
    path: "capabilityAbsences",
    citations: manifest.capabilityAbsences.sourceCitations,
  });
  return rows;
}
