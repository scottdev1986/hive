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
