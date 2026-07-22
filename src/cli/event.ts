import {
  HookEventSchema,
  type HookEvent,
} from "../schemas";
import { agentFetch } from "./credential";

export interface HookEventOptions {
  agent?: string;
  description?: string;
  usageUnits?: number;
  usageSource?: "provider" | "gateway" | "estimated";
  toolSessionId?: string;
  /** Claude's `notification_type`, read off the Notification hook's stdin.
   * Never a CLI flag: only the vendor can say why it raised the notification. */
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
    ...(options.toolSessionId === undefined
      ? {}
      : { toolSessionId: options.toolSessionId }),
  };
  if (kind === "turn-end") {
    return HookEventSchema.parse({
      ...base,
      ...(options.usageUnits === undefined
        ? {}
        : { usageUnits: options.usageUnits }),
      ...(options.usageSource === undefined
        ? {}
        : { usageSource: options.usageSource }),
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
      ...(options.notificationType === undefined
        ? {}
        : { notificationType: options.notificationType }),
    });
  }
  return HookEventSchema.parse(base);
}

export async function postHookEvent(
  event: HookEvent,
  port: number,
  fetcher: EventFetcher = fetch,
): Promise<void> {
  await fetcher(`http://127.0.0.1:${port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(1_000),
  });
}

// Claude Code pipes a JSON payload with the current session_id into every
// hook command's stdin. That id is the handle crash recovery needs for
// `claude --resume`, so the event CLI forwards it on every hook event.
//
// The Notification payload also carries `notification_type`, which is the only
// thing that distinguishes an agent BLOCKED on a native permission dialog from
// one merely idle. Dropping it here is what let a blocked agent be reported as
// "working" indefinitely: the hook fired, said exactly what was wrong, and Hive
// kept only the session id.
export type CapturedHookStdin = Pick<
  HookEventOptions,
  "toolSessionId" | "notificationType" | "description"
>;

/**
 * What a Codex `PermissionRequest` payload is asking about, as the approval
 * description an orchestrator has to decide on. Codex 0.145.0 sends the tool
 * and its input (`tool_input.command` for a shell approval, otherwise the
 * vendor's own one-line description); without it the bridged approval reads
 * "Approval requested", which names neither the agent's intent nor its risk.
 */
function approvalDescription(parsed: object): string | undefined {
  if (!("tool_name" in parsed) || typeof parsed.tool_name !== "string") {
    return undefined;
  }
  const input = "tool_input" in parsed && typeof parsed.tool_input === "object" &&
      parsed.tool_input !== null
    ? parsed.tool_input as Record<string, unknown>
    : {};
  const detail = typeof input.command === "string"
    ? input.command
    : typeof input.description === "string"
    ? input.description
    : null;
  return detail === null ? parsed.tool_name : `${parsed.tool_name}: ${detail}`;
}

export function parseHookStdin(text: string): CapturedHookStdin {
  const captured: CapturedHookStdin = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return captured;
    if (
      "session_id" in parsed && typeof parsed.session_id === "string" &&
      parsed.session_id.length > 0
    ) {
      captured.toolSessionId = parsed.session_id;
    }
    if (
      "notification_type" in parsed &&
      typeof parsed.notification_type === "string" &&
      parsed.notification_type.length > 0
    ) {
      captured.notificationType = parsed.notification_type;
    }
    const description = approvalDescription(parsed);
    if (description !== undefined) captured.description = description;
  } catch {
    // Anything that is not the documented hook JSON is simply not a capture.
  }
  return captured;
}

export interface HookStdinSource {
  isTTY: boolean;
  text(): Promise<string>;
}

const processStdinSource: HookStdinSource = {
  isTTY: process.stdin.isTTY === true,
  text: () => new Response(Bun.stdin.stream()).text(),
};

export async function readHookStdin(
  source: HookStdinSource = processStdinSource,
  timeoutMs = 750,
): Promise<CapturedHookStdin> {
  if (source.isTTY) {
    return {};
  }
  // A hook runner writes its payload and closes stdin immediately; anything
  // slower is not a hook payload and must never stall the agent's turn.
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
    const event = buildHookEvent(kind, options);
    // A hook speaks only for the agent it was installed for, and presents that
    // agent's capability. The credential is read from its 0600 file, never
    // from this process's environment.
    await postHookEvent(event, port, fetcher ?? agentFetch(event.agentName));
  } catch {
    // Hooks run at every turn boundary and must never disrupt an agent CLI.
  }
  return 0;
}
