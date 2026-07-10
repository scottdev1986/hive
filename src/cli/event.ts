import {
  HookEventSchema,
  type HookEvent,
} from "../schemas";

export interface HookEventOptions {
  agent?: string;
  contextPct?: number;
  description?: string;
  usageUnits?: number;
  usageSource?: "provider" | "gateway" | "estimated";
  toolSessionId?: string;
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
      ...(options.contextPct === undefined
        ? {}
        : { contextPct: options.contextPct }),
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
export function parseHookStdin(
  text: string,
): Pick<HookEventOptions, "toolSessionId"> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" && parsed !== null &&
      "session_id" in parsed && typeof parsed.session_id === "string" &&
      parsed.session_id.length > 0
    ) {
      return { toolSessionId: parsed.session_id };
    }
  } catch {
    // Anything that is not the documented hook JSON is simply not a capture.
  }
  return {};
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

export async function runHiveEvent(
  kind: string,
  port: number,
  options: HookEventOptions,
  fetcher: EventFetcher = fetch,
): Promise<0> {
  try {
    const event = buildHookEvent(kind, options);
    await postHookEvent(event, port, fetcher);
  } catch {
    // Hooks run at every turn boundary and must never disrupt an agent CLI.
  }
  return 0;
}
