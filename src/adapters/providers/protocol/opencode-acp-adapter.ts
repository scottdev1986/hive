import { AcpRuntimeAdapter, type AcpVendorProfile } from "./acp-session";
import type { ProviderSpawn } from "./types";

/** OpenCode ACP profile measured against 1.18.11 (source pin 1882c338). - User config and plugins ENABLED. `--pure` is test-only isolation — never the production spawn argv. - Session surface: new/load/resume/list/close/fork. - Documented ACP gap: /undo and /redo are ABSENT from command catalogs (filtered in parseAvailableCommands; never advertised). - Permission reverse-RPC and usage updates are measured live, not inferred. */
const OPENCODE_PROFILE: AcpVendorProfile = {
  provider: "opencode",
  transport: "acp",
  cancelAs: "notification",
  loadMethod: "session/load",
  resumeMethod: "session/resume",
  supportsSessionClose: true,
  supportsFork: true,
  configOptionIds: { model: "model", effort: "effort" },
  incompatibleReason: (handshake) => {
    const caps = capabilitiesFrom(handshake);
    return caps.loadSession &&
      caps.close &&
      caps.fork &&
      caps.list &&
      caps.resume
      ? null
      : "initialize missing expected sessionCapabilities (close/fork/list/resume/loadSession)";
  },
  initialMeasured: {},
  absences: {
    questions: {
      reason:
        "OpenCode ACP permission reverse-RPC covers tool approvals; live probes did not observe an AskUserQuestion-style question surface distinct from permissions.",
      citation: "docs/evidence/protocol-terminal/opencode/conformance.json",
    },
    compact: {
      reason:
        "OpenCode ACP does not advertise a dedicated compact method; compaction is not a measured session capability on 1.18.11.",
      citation:
        "docs/evidence/protocol-terminal/opencode/handshake.sanitized.json",
    },
    steering: {
      reason:
        "OpenCode ACP has no same-turn steer method; mid-turn control is prompt queue and session/cancel only.",
      citation: "docs/evidence/protocol-terminal/opencode/conformance.json",
    },
  },
};

const OPENCODE_ACP_ARGV = ["acp"] as const;

/** Never injects --pure. Callers that want test isolation pass it in argv. */
export class OpenCodeAcpAdapter extends AcpRuntimeAdapter {
  constructor() {
    super("opencode", OPENCODE_PROFILE, OPENCODE_ACP_ARGV, openCodeAcpSpawn);
  }
}

export function openCodeAcpSpawn(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>> = {},
  options: { pure?: boolean } = {},
): ProviderSpawn {
  const argv = options.pure === true ? ["acp", "--pure"] : OPENCODE_ACP_ARGV;
  return {
    provider: "opencode",
    executable,
    argv,
    cwd,
    env,
  };
}

function capabilitiesFrom(handshake: unknown): {
  loadSession: boolean;
  close: boolean;
  fork: boolean;
  list: boolean;
  resume: boolean;
} {
  if (typeof handshake !== "object" || handshake === null) {
    return {
      loadSession: false,
      close: false,
      fork: false,
      list: false,
      resume: false,
    };
  }
  const agent = (
    handshake as {
      agentCapabilities?: {
        loadSession?: unknown;
        sessionCapabilities?: Record<string, unknown>;
      };
    }
  ).agentCapabilities;
  const session = agent?.sessionCapabilities ?? {};
  return {
    loadSession: agent?.loadSession === true,
    close: "close" in session,
    fork: "fork" in session,
    list: "list" in session,
    resume: "resume" in session,
  };
}
