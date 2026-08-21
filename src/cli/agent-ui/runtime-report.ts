import type { SubmissionReceipt } from "../../adapters/providers/protocol/types";
import {
  type AdapterChildIdentity,
  type ProviderRuntimeReport,
  ProviderRuntimeReportSchema,
} from "../../schemas/provider-run";
import { definedFields } from "../../shared/defined-fields";
import { PaneDaemonClient } from "./pane-daemon-client";

export type RuntimeReportFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function observeAdapterChild(
  child: { readonly pid: number; readonly processGroupId: number },
  processIdentity: (pid: number) => { startToken: string },
  now = new Date(),
): AdapterChildIdentity {
  return {
    ...child,
    startToken: processIdentity(child.pid).startToken,
    observedAt: now.toISOString(),
  };
}

export function providerRuntimeReporter(
  subject: string,
  providerRunId: string,
  port: number,
  fetcher?: RuntimeReportFetcher,
): {
  reportChild(identity: AdapterChildIdentity): Promise<void>;
  reportReceipt(receipt: SubmissionReceipt): Promise<void>;
} {
  const daemon = new PaneDaemonClient({
    port,
    subject,
    ...definedFields({ fetch: fetcher }),
  });
  /** A failed attempt is retried before the caller hears about it. This report is sent from inside a launch burst — the moment the daemon is busiest — and the first attempt can lose two races that resolve themselves: a response that outlives its timeout because the daemon is behind, and a 409 because the daemon's own spawn pipeline has not yet inserted the run row this pane was launched under. Both cost every agent in a batch its life before this retried; a report that still fails after the backoff is a real answer and still ends the launch loudly. */
  const post = async (report: ProviderRuntimeReport): Promise<void> => {
    const body = JSON.stringify(ProviderRuntimeReportSchema.parse(report));
    const response = await daemon.request("/provider-runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(
        `provider runtime report failed (${response.status}): ${await daemon.errorDetail(response)}`,
      );
    }
  };
  return {
    reportChild: (identity) =>
      post({
        schemaVersion: 1,
        kind: "adapter-child",
        providerRunId,
        identity,
      }),
    reportReceipt: (receipt) =>
      post({
        schemaVersion: 1,
        kind: "protocol-receipt",
        providerRunId,
        receipt,
      }),
  };
}
