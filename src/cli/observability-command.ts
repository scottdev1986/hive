import { ObservabilityListSchema } from "../schemas/observability";
import { UserDaemonClient } from "./user-daemon-client";
import { requireDaemonPort } from "./control";

export interface ErrorsCliOptions {
  readonly since?: string;
  readonly until?: string;
  readonly severity?: string;
  readonly source?: string;
  readonly subject?: string;
  readonly session?: string;
  readonly tool?: string;
  readonly limit?: string;
  readonly json?: boolean;
  readonly port?: number;
}

function queryString(options: ErrorsCliOptions): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of [
    ["since", options.since],
    ["until", options.until],
    ["severity", options.severity],
    ["source", options.source],
    ["subject", options.subject],
    ["session", options.session],
    ["tool", options.tool],
    ["limit", options.limit],
  ] as const) {
    if (value !== undefined) parameters.set(key, value);
  }
  const encoded = parameters.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function correlation(event: {
  subject: string | null;
  providerRunId: string | null;
  vendorSessionId: string | null;
  toolName: string | null;
  callId: string | null;
}): string {
  return [
    event.subject === null ? null : `subject=${event.subject}`,
    event.toolName === null ? null : `tool=${event.toolName}`,
    event.callId === null ? null : `call=${event.callId}`,
    event.providerRunId === null ? null : `run=${event.providerRunId}`,
    event.vendorSessionId === null ? null : `session=${event.vendorSessionId}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/** `hive errors` is a read-only projection of the daemon-owned audit store. */
export async function printErrors(options: ErrorsCliOptions): Promise<void> {
  const port = options.port ?? requireDaemonPort();
  const body = await new UserDaemonClient({ port }).json(
    `/observability/errors${queryString(options)}`,
    undefined,
    "throw",
  );
  const result = ObservabilityListSchema.parse(body);
  if (options.json === true) {
    console.log(JSON.stringify(result.events, null, 2));
    return;
  }
  if (result.events.length === 0) {
    console.log("No recorded Hive errors matched.");
    return;
  }
  for (const event of result.events) {
    const context = correlation(event);
    console.log(
      `${event.occurredAt} ${event.severity.toUpperCase()} ${event.source} ${event.operation}`,
    );
    if (context !== "") console.log(`  ${context}`);
    for (const line of event.reason.split("\n")) console.log(`  ${line}`);
  }
}
