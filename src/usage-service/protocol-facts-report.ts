import type { NormalizedProviderEvent } from "../adapters/providers/protocol/types";
import type { ProtocolSessionFactsReport } from "../schemas/token-usage-schema";
import {
  agentFactsFromProtocolEvent,
  tokenEventsFromProtocol,
} from "./protocol-session-facts";
import { PaneDaemonClient } from "../cli/agent-ui/pane-daemon-client";

export type ProtocolFactsFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function protocolSessionFactsReport(
  agent: string,
  event: NormalizedProviderEvent,
): ProtocolSessionFactsReport | null {
  const facts = agentFactsFromProtocolEvent(event);
  const tokens = tokenEventsFromProtocol([event]);
  const hasFacts =
    facts.liveModel !== undefined ||
    facts.contextWindow !== undefined ||
    facts.contextPct !== undefined ||
    facts.effort !== undefined;
  const usage = tokens[0];
  if (!hasFacts && usage === undefined) return null;

  return {
    agent,
    observedAt: event.occurredAt,
    ...(facts.liveModel === undefined ? {} : { model: facts.liveModel }),
    ...(facts.effort === undefined ? {} : { effort: facts.effort }),
    ...(facts.contextWindow === undefined
      ? {}
      : { contextWindow: facts.contextWindow }),
    ...(facts.contextPct === undefined
      ? {}
      : { contextPercent: facts.contextPct }),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            usageKey: usage.key,
            inputTokens: usage.counts.inputTokens,
            outputTokens: usage.counts.outputTokens,
            cachedInputTokens: usage.counts.cachedInputTokens,
            cacheCreationInputTokens: usage.counts.cacheCreationInputTokens,
            reasoningTokens: usage.counts.reasoningTokens,
            ...(usage.cumulative === true ? { cumulative: true } : {}),
            source: usage.source,
          },
        }),
  };
}

export async function postProtocolSessionFacts(
  report: ProtocolSessionFactsReport,
  port: number,
  fetcher: ProtocolFactsFetcher,
): Promise<void> {
  const daemon = new PaneDaemonClient({
    port,
    subject: report.agent,
    fetch: fetcher,
  });
  const response = await daemon.request("/token-usage/protocol-session-facts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) {
    throw new Error(await daemon.errorDetail(response));
  }
}

/** Fire-and-forget: a failed post must not break the pane redraw. */
export function reportProtocolSessionFacts(
  agent: string,
  event: NormalizedProviderEvent,
  port: number | undefined,
  fetcher?: ProtocolFactsFetcher,
): void {
  if (port === undefined) return;
  const report = protocolSessionFactsReport(agent, event);
  if (report === null) return;
  void postProtocolSessionFacts(report, port, fetcher ?? fetch).catch(
    () => undefined,
  );
}
