import { toolNameFromPermission } from "./acp-normalize";
import { AcpRuntimeAdapter, type AcpVendorProfile } from "./acp-session";
import type { ProviderSpawn } from "./types";

/** Kimi Code ACP profile measured against the installed 0.31.1 binary (`kimi acp`, NDJSON over anonymous pipes; source pinned at e22479a). Measured live on 2026-08-02: - initialize advertises loadSession, session list+resume, image/embedded- context prompts; auth method is the terminal device-code login. - session/new returns configOptions: model select, thinking select (low/high/max), mode select (default/plan/auto/yolo). - session/set_config_option works: setting mode=plan returned the updated configOptions. - session/cancel is a notification; the request form returns -32601. - Questions arrive through session/request_permission with toolCall.title === "AskUserQuestion" — distinct from permissions. - session/load replays history (user/agent message chunks); session/resume replays nothing. Replay is measured from observed frames, never asserted. */
const KIMI_PROFILE: AcpVendorProfile = {
  provider: "kimi",
  transport: "acp",
  cancelAs: "notification",
  loadMethod: "session/load",
  resumeMethod: "session/resume",
  supportsSessionClose: false,
  supportsFork: false,
  initialMeasured: {},
  isQuestion: (params) => toolNameFromPermission(params) === "AskUserQuestion",
  measureLoadReplay: true,
  configOptionIds: { model: "model", effort: "thinking", mode: "mode" },
  // Kimi opens a session in "default", described by its own configOptions as "Manual approvals; tools execute normally": every tool call raises session/request_permission and waits for a user who is never there, so the agent blocks on its first Bash call. "auto" is Kimi's fully autonomous mode — the agent decides without asking — which is the posture Hive already grants a launched agent through --yolo/--auto on the argv path. This stops the request from being raised; it does not answer one. A request that still arrives is surfaced through the reverse-RPC as before.
  sessionMode: "auto",
  // Researched does-not-report findings (Scott's rule: a proven absence is a known state, ignorance is not). Citations point at the evidence rows.
  absences: {
    contextUsage: {
      reason: "Kimi does not report context usage",
      citation:
        "docs/evidence/protocol-terminal/kimi/conformance.json — 517 events, no usage update kind; initialize agentCapabilities carry no usage surface",
    },
    fork: {
      reason: "Kimi does not expose session fork",
      citation:
        "test/fixtures/protocol/kimi/initialize.response.json — sessionCapabilities advertises only list and resume",
    },
    compact: {
      reason:
        "Kimi exposes compaction only as the /compact session command, not a structured ACP capability",
      citation:
        "test/fixtures/protocol/kimi/commands.update.json — compact is a command entry, no compaction event or method exists on the wire",
    },
    steering: {
      reason: "Kimi does not expose same-turn steering",
      citation:
        "docs/evidence/protocol-terminal/kimi/conformance.json — the measured ACP surface has prompt/cancel and no same-turn steer method",
    },
  },
};

const KIMI_ACP_ARGV = ["acp"] as const;

/** Kimi names its manual-approval mode `default` on the ACP wire. An explicit read-only Hive launch selects it; writers keep the profile's autonomous default. This is best-effort containment inside Kimi, not a filesystem sandbox. */
export function kimiSessionMode(readOnly: boolean): string | undefined {
  return readOnly ? "default" : undefined;
}

export class KimiAcpAdapter extends AcpRuntimeAdapter {
  constructor() {
    super("kimi", KIMI_PROFILE, KIMI_ACP_ARGV, kimiAcpSpawn, true);
  }
}

export function kimiAcpSpawn(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): ProviderSpawn {
  return {
    provider: "kimi",
    executable,
    argv: KIMI_ACP_ARGV,
    cwd,
    env,
  };
}
