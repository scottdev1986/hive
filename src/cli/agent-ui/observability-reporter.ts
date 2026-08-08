import { randomUUID } from "node:crypto";
import type { NormalizedProviderEvent } from "../../adapters/providers/protocol/types";
import type { CapabilityProvider } from "../../schemas/capability";
import {
  type ObservabilityEvent,
  ObservabilityEventSchema,
  type ObservabilitySeverity,
  type ObservabilitySource,
} from "../../schemas/observability";
import { type NowIsoFn, systemNowIso } from "../../shared/clock";
import { isRecord } from "../../shared/is-record";
import type { PaneDaemonClient } from "./pane-daemon-client";

export interface PaneFailureFact {
  readonly severity: ObservabilitySeverity;
  readonly source: ObservabilitySource;
  readonly operation: string;
  readonly reason: string;
  readonly callId?: string | null;
  readonly toolName?: string | null;
}

export interface PaneObservabilityReporterOptions {
  readonly client: PaneDaemonClient;
  readonly subject: string;
  readonly provider: CapabilityProvider | null;
  readonly providerRunId: string;
  readonly vendorSessionId: string;
  readonly now?: NowIsoFn;
}

/** Thin pane ingress: attach session correlation, retry one idempotent event,
 * and return the daemon's canonical event for rendering. */
export class PaneObservabilityReporter {
  private readonly now: NowIsoFn;
  private readonly pending = new Set<Promise<ObservabilityEvent>>();

  constructor(private readonly options: PaneObservabilityReporterOptions) {
    this.now = options.now ?? systemNowIso;
  }

  async report(fact: PaneFailureFact): Promise<ObservabilityEvent> {
    const pending = this.send(fact);
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Records provider-runtime failures. Individual tool outcomes stay in the
   * transcript: Hive MCP failures are recorded by the daemon, while shell and
   * test failures are agent activity rather than runtime incidents. */
  async observeProviderEvent(
    event: NormalizedProviderEvent,
  ): Promise<ObservabilityEvent | null> {
    switch (event.kind) {
      case "tool-started":
      case "tool-updated":
      case "tool-finished":
        return null;
      case "turn-failed":
        return await this.report({
          severity: "error",
          source: "provider",
          operation: "provider-turn",
          reason: event.reason,
          callId: event.turnId,
        });
      case "runtime-disconnected":
        return await this.report({
          severity: "error",
          source: "provider",
          operation: "provider-runtime",
          reason: event.reason,
        });
      case "run-ended":
        if (event.exitCode === 0) return null;
        return await this.report({
          severity: "error",
          source: "provider",
          operation: "provider-process",
          reason:
            event.exitCode === null
              ? "provider process ended without an exit code"
              : `provider process exited with code ${event.exitCode}`,
        });
      case "turn-idle":
      case "interrupted":
        return null;
      default:
        return null;
    }
  }

  private async send(fact: PaneFailureFact): Promise<ObservabilityEvent> {
    const response = await this.options.client.request(
      "/observability/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          eventId: randomUUID(),
          occurredAt: this.now(),
          severity: fact.severity,
          source: fact.source,
          operation: fact.operation,
          reason: fact.reason,
          subject: this.options.subject,
          agentId: null,
          provider: this.options.provider,
          providerRunId: this.options.providerRunId,
          vendorSessionId: this.options.vendorSessionId,
          toolName: fact.toolName ?? null,
          callId: fact.callId ?? null,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(await this.options.client.errorDetail(response));
    }
    const body: unknown = await response.json();
    return ObservabilityEventSchema.parse(
      isRecord(body) ? body.event : undefined,
    );
  }
}
