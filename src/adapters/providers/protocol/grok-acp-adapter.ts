import type { AcpClient } from "./acp-client";
import { AcpRuntimeAdapter, type AcpVendorProfile } from "./acp-session";
import type { ProviderSpawn } from "./types";

/** Grok ACP profile measured against 0.2.118. - Auth: `authenticate` with methodId `cached_token` (or `grok.com`). - Cancel: notification `session/cancel` only; request form returns -32601. - Load: `session/load` + `session/list`; no distinct resume method. - Permissions/cancel baseline rows stay absent until live proof. - Do not create grok provider-native scheduled tasks (known footgun). */
export const GROK_PROFILE: AcpVendorProfile = {
  provider: "grok",
  transport: "acp",
  sessionOptionMethods: {
    model: "session/set_model",
    effort: "session/set_mode",
  },
  cancelAs: "notification",
  loadMethod: "session/load",
  resumeMethod: null,
  supportsSessionClose: false,
  supportsFork: false,
  extensionNotificationMethods: [
    "_x.ai/session/prompt_complete",
    "_x.ai/session_notification",
  ],
  initialMeasured: {},
  absences: {
    contextUsage: {
      reason: "Grok reports billing tokens, not context occupancy",
      citation: "docs/evidence/protocol-terminal/wave2/usage-parity/grok.json",
    },
    questions: {
      reason:
        "Grok ACP does not surface AskUserQuestion-style reverse-RPC; live probes only saw tool permission options (allow-once / reject-once).",
      citation:
        "docs/evidence/protocol-terminal/grok/permission-and-cancel.live.json",
    },
    modeCatalog: {
      reason:
        "Grok ACP advertises models and reasoning efforts but no session mode catalog on initialize or session/new.",
      citation: "docs/evidence/protocol-terminal/grok/handshake.sanitized.json",
    },
    fork: {
      reason:
        "Grok ACP sessionCapabilities advertise list (and loadSession) but not fork; session/fork is not part of the measured 0.2.118 surface.",
      citation: "docs/evidence/protocol-terminal/grok/handshake.sanitized.json",
    },
    compact: {
      reason:
        "Grok exposes /compact only as a slash command in availableCommands, not as a dedicated ACP compact method Hive can invoke as the compact capability.",
      citation: "docs/evidence/protocol-terminal/grok/handshake.sanitized.json",
    },
    steering: {
      reason:
        "Grok ACP has no same-turn steer method on 0.2.118; mid-turn control is queue and session/cancel only.",
      citation: "docs/evidence/protocol-terminal/grok/conformance.json",
    },
  },
  async afterInitialize(client: AcpClient, _handshake): Promise<void> {
    await client.request("authenticate", { methodId: "cached_token" });
  },
};

const GROK_ACP_ARGV = ["--no-auto-update", "agent", "stdio"] as const;

export class GrokAcpAdapter extends AcpRuntimeAdapter {
  constructor() {
    super("grok", GROK_PROFILE, GROK_ACP_ARGV, grokAcpSpawn);
  }
}

export function grokAcpSpawn(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): ProviderSpawn {
  return {
    provider: "grok",
    executable,
    argv: GROK_ACP_ARGV,
    cwd,
    env,
  };
}
