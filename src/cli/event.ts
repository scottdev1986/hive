import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  const response = await fetcher(`http://127.0.0.1:${port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(1_000),
  });
  // An HTTP rejection is a lost boundary, not a delivered one: swallowing it
  // here left agent status stale while every hook invocation exited 0.
  if (!response.ok) {
    throw new Error(
      `hook event rejected: HTTP ${response.status} for ${event.kind}`,
    );
  }
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
export function parseHookStdin(
  text: string,
): Pick<HookEventOptions, "toolSessionId" | "notificationType"> {
  const captured: Pick<
    HookEventOptions,
    "toolSessionId" | "notificationType"
  > = {};
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
): Promise<Pick<HookEventOptions, "toolSessionId">> {
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

/** Where lost hook boundaries leave their durable trace. Failures here mean
 * an agent's status went stale until the telemetry sweep healed it; a file
 * that says so beats a silence that says nothing. */
export function hookFailureTracePath(): string {
  return join(
    Bun.env.HIVE_HOME ?? join(homedir(), ".hive"),
    "hook-event-failures.jsonl",
  );
}

const MAX_TRACE_BYTES = 512_000;

/** Append one bounded trace line for a hook event that could not be
 * delivered. Best-effort and size-capped: the trace must never become its own
 * failure mode. */
async function traceHookFailure(
  kind: string,
  agent: string | undefined,
  error: unknown,
): Promise<void> {
  const path = hookFailureTracePath();
  const file = Bun.file(path);
  if (await file.exists() && file.size > MAX_TRACE_BYTES) return;
  await appendFile(
    path,
    JSON.stringify({
      at: new Date().toISOString(),
      kind,
      agent: agent ?? null,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
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
    const send = () =>
      postHookEvent(event, port, fetcher ?? agentFetch(event.agentName));
    try {
      await send();
    } catch {
      // One bounded retry covers a transient daemon blip; a second failure is
      // a LOST turn boundary — the agent's status is stale until the sweep
      // heals it — and that must leave a durable trace, never a silence.
      await Bun.sleep(100);
      try {
        await send();
      } catch (error) {
        await traceHookFailure(kind, options.agent, error);
      }
    }
  } catch {
    // Hooks run at every turn boundary and must never disrupt an agent CLI —
    // even when the failure is the trace file itself.
  }
  return 0;
}
