import type { NormalizedProviderEvent } from "../../adapters/providers/protocol/types";
import {
  providerStatusReportForEvent,
  type ProviderStatusReport,
} from "./status-projection-service";

/** A request already bound to one daemon and one agent's credential, supplied by the pane. This module projects and orders status reports; it does not own the way to reach the daemon. Building a URL here would put a second daemon client in the daemon layer, reachable from code that has no business choosing which credential to present — so the capability is handed in instead. */
export type StatusPoster = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type ProviderStatusForwarder = ((
  event: NormalizedProviderEvent,
) => void) & { flush: () => Promise<void> };

export async function postProviderStatus(
  report: ProviderStatusReport,
  post: StatusPoster,
): Promise<void> {
  const response = await post("/agent-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `agent status report failed (${response.status})`,
    );
  }
}

/** Sends the exact status projection the pane applies to the one daemon-owned status service. Reports stay ordered; a failure is surfaced to the pane but never interrupts the provider event stream or the user's terminal. */
export function providerStatusForwarder(options: {
  readonly subject: string;
  readonly providerRunId: string | undefined;
  readonly vendorSessionId: string;
  readonly post: StatusPoster | null;
  readonly onError?: (error: unknown) => void;
}): ProviderStatusForwarder {
  if (options.post === null || options.providerRunId === undefined) {
    return Object.assign(() => {}, { flush: async () => {} });
  }
  const post = options.post;
  const providerRunId = options.providerRunId;
  let posted = Promise.resolve();
  const forward = (event: NormalizedProviderEvent) => {
    const report = providerStatusReportForEvent(
      {
        agent: options.subject,
        providerRunId,
        vendorSessionId: options.vendorSessionId,
      },
      event,
    );
    if (report === null) return;
    posted = posted
      .then(() => postProviderStatus(report, post))
      .catch((error: unknown) => options.onError?.(error));
  };
  return Object.assign(forward, { flush: () => posted });
}
