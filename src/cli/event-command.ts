import { createHash } from "node:crypto";
import { definedFields } from "../shared/defined-fields";
import { type HookEvent, HookEventSchema } from "../schemas/event";
import { PaneDaemonClient } from "./agent-ui/pane-daemon-client";
import { agentFetch } from "./credential";
import { responseErrorDetail } from "./daemon-response";
import { isRecord, isString } from "../shared/is-record";
import type { JsonValue } from "../shared/json";

export interface HookEventOptions {
  agent?: string;
  description?: string;
  usageUnits?: number;
  usageSource?: "provider" | "gateway" | "estimated";
  toolSessionId?: string;
  providerRunId?: string;
  toolName?: string;
  inputDigest?: string;
  timestamp?: string;
  ignore?: boolean;
  notificationType?: string;
}

export type EventFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function buildHookEvent(
  kind: string,
  options: HookEventOptions,
  timestamp = new Date().toISOString(),
): HookEvent {
  const base = {
    kind,
    agentName: options.agent,
    timestamp,
    ...definedFields({
      toolSessionId: options.toolSessionId,
      providerRunId: options.providerRunId,
    }),
  };
  if (kind === "turn-end") {
    return HookEventSchema.parse({
      ...base,
      ...definedFields({
        usageUnits: options.usageUnits,
        usageSource: options.usageSource,
      }),
    });
  }
  if (kind === "approval-request") {
    return HookEventSchema.parse({
      ...base,
      description: options.description ?? "Approval requested",
    });
  }
  if (kind === "notification") {
    return HookEventSchema.parse({
      ...base,
      ...definedFields({ notificationType: options.notificationType }),
    });
  }
  if (kind === "tool-start" || kind === "tool-boundary") {
    return HookEventSchema.parse({
      ...base,
      ...definedFields({
        toolName: options.toolName,
        inputDigest: options.inputDigest,
      }),
    });
  }
  return HookEventSchema.parse(base);
}

export async function postHookEvent(
  event: HookEvent,
  port: number,
  fetcher: EventFetcher = fetch,
): Promise<void> {
  // Through the agent-subject client rather than a URL assembled here. A hook speaks for exactly one agent, and that client cannot reach the user credential path — which is the reason the two daemon clients are separate and must stay that way. No retries and the same one-second ceiling as before: a hook runs at every turn boundary and must never hold up an agent CLI.
  const response = await new PaneDaemonClient({
    port,
    subject: event.agentName,
    fetch: fetcher,
    retries: 0,
  }).request("/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) {
    const detail = await responseErrorDetail(response);
    throw new Error(`daemon rejected ${event.kind}: ${detail}`);
  }
}

// Claude Code pipes a JSON payload with the current session_id into every hook command's stdin. That id is the handle crash recovery needs for `claude --resume`, so the event CLI forwards it on every hook event. The Notification payload also carries `notification_type`, which is the only thing that distinguishes an agent BLOCKED on a native permission dialog from one merely idle. Dropping it here is what let a blocked agent be reported as "working" indefinitely: the hook fired, said exactly what was wrong, and Hive kept only the session id.
export type CapturedHookStdin = Pick<
  HookEventOptions,
  | "toolSessionId"
  | "toolName"
  | "inputDigest"
  | "notificationType"
  | "description"
  | "timestamp"
  | "ignore"
>;

type HookPermissionRequest = {
  readonly tool_name: string;
  readonly tool_input?: {
    readonly command?: string;
    readonly description?: string;
  };
};

function approvalDescription(parsed: HookPermissionRequest): string {
  const input = parsed.tool_input;
  const detail =
    input?.command !== undefined
      ? input.command
      : input?.description !== undefined
        ? input.description
        : null;
  return detail === null ? parsed.tool_name : `${parsed.tool_name}: ${detail}`;
}

export function parseHookStdin(text: string): CapturedHookStdin {
  const captured: CapturedHookStdin = {};
  try {
    const parsed: JsonValue = JSON.parse(text);
    if (!isRecord(parsed) && !Array.isArray(parsed)) return captured;
    if (
      "session_id" in parsed &&
      isString(parsed.session_id) &&
      parsed.session_id.length > 0
    ) {
      captured.toolSessionId = parsed.session_id;
    }
    if (
      "sessionId" in parsed &&
      isString(parsed.sessionId) &&
      parsed.sessionId.length > 0
    ) {
      captured.toolSessionId = parsed.sessionId;
    }
    if (
      "hook_event_name" in parsed &&
      parsed.hook_event_name === "PostToolUse" &&
      "tool_name" in parsed &&
      isString(parsed.tool_name) &&
      parsed.tool_name.length > 0
    ) {
      captured.toolName = parsed.tool_name;
    }
    if (
      "toolName" in parsed &&
      isString(parsed.toolName) &&
      parsed.toolName.length > 0
    ) {
      captured.toolName = parsed.toolName;
    }
    if ("toolInput" in parsed) {
      captured.inputDigest = createHash("sha256")
        .update(JSON.stringify(parsed.toolInput))
        .digest("hex");
    }
    if (
      "timestamp" in parsed &&
      isString(parsed.timestamp) &&
      !Number.isNaN(Date.parse(parsed.timestamp))
    ) {
      captured.timestamp = new Date(parsed.timestamp).toISOString();
    }
    if (
      "hookEventName" in parsed &&
      parsed.hookEventName === "Stop" &&
      (!("reason" in parsed) || parsed.reason !== "end_turn")
    ) {
      captured.ignore = true;
    }
    if (
      "notification_type" in parsed &&
      isString(parsed.notification_type) &&
      parsed.notification_type.length > 0
    ) {
      captured.notificationType = parsed.notification_type;
    }
    if (
      "hook_event_name" in parsed &&
      parsed.hook_event_name === "PermissionRequest" &&
      "tool_name" in parsed &&
      isString(parsed.tool_name)
    ) {
      const rawInput =
        "tool_input" in parsed && isRecord(parsed.tool_input)
          ? parsed.tool_input
          : undefined;
      captured.description = approvalDescription({
        tool_name: parsed.tool_name,
        tool_input: {
          command:
            rawInput !== undefined &&
            "command" in rawInput &&
            isString(rawInput.command)
              ? rawInput.command
              : undefined,
          description:
            rawInput !== undefined &&
            "description" in rawInput &&
            isString(rawInput.description)
              ? rawInput.description
              : undefined,
        },
      });
    }
  } catch {}
  return captured;
}

export interface HookStdinSource {
  isTTY: boolean;
  text(): Promise<string>;
}

const processStdinSource: HookStdinSource = {
  isTTY: process.stdin.isTTY,
  text: () => new Response(Bun.stdin.stream()).text(),
};

export async function readHookStdin(
  source: HookStdinSource = processStdinSource,
  timeoutMs = 750,
): Promise<CapturedHookStdin> {
  if (source.isTTY) {
    return {};
  }
  // A hook runner writes its payload and closes stdin immediately; anything slower is not a hook payload and must never stall the agent's turn.
  const text = await new Promise<string>((resolveText) => {
    const timer = setTimeout(() => resolveText(""), timeoutMs);
    source.text().then(
      (value) => {
        clearTimeout(timer);
        resolveText(value);
      },
      () => {
        clearTimeout(timer);
        resolveText("");
      },
    );
  });
  return parseHookStdin(text);
}

export async function runHiveEvent(
  kind: string,
  port: number,
  options: HookEventOptions,
  fetcher?: EventFetcher,
): Promise<0> {
  try {
    if (options.ignore === true) return 0;
    const event = buildHookEvent(kind, options, options.timestamp);
    // A hook speaks only for the agent it was installed for, and presents that agent's capability. The credential is read from its 0600 file, never from this process's environment.
    await postHookEvent(event, port, fetcher ?? agentFetch(event.agentName));
  } catch {
    // Hooks run at every turn boundary and must never disrupt an agent CLI.
  }
  return 0;
}
