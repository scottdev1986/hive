import { randomUUID } from "node:crypto";
import {
  type CallToolResult,
  isCallToolResult,
} from "@modelcontextprotocol/server";
import { ZodError } from "zod";
import type { CapabilityProvider } from "../../schemas/capability";
import {
  type ObservabilityEvent,
  ObservabilityEventSchema,
  type ObservabilityQuery,
  ObservabilityQuerySchema,
  type ObservabilityReport,
  ObservabilityReportSchema,
  type ObservabilitySeverity,
  type ObservabilitySource,
} from "../../schemas/observability";
import type { Clock } from "../../shared/clock";
import { systemClock } from "../../shared/clock";
import type { DatabaseHost } from "../../shared/database-host";
import { errorMessage } from "../../shared/error-message";
import { isRecord } from "../../shared/is-record";
import { redactTerminalEvidence } from "../status-service/status-service";
import { ObservabilityStore } from "./observability-store";

const MAX_REASON_LENGTH = 8_192;
const EXPECTED_REFUSAL_CODES = new Set([
  "AUTHORIZATION_REFUSED",
  "HIERARCHY_CONFLICT",
  "HIERARCHY_FENCE",
  "HIERARCHY_VALIDATION",
  "MAIL_CONTROL_LANE_FULL",
  "MAIL_IDEMPOTENCY_CONFLICT",
  "MAIL_ITEM_NOT_CLAIMABLE",
  "MAIL_CONTROL_BUSY",
  "MAIL_LEASE_NOT_HELD",
  "MAIL_PAYLOAD_REJECTED",
  "MAIL_FOREIGN_SUBJECT",
  "MAIL_RECIPIENT_REFUSED",
  "MAIL_WORK_LANE_GENERATION",
  "MAIL_GENERATION_MISMATCH",
  "MAIL_SUBJECT_UNBOUND",
  "MAIL_GENERATION_REFUSED",
  "MAIL_WAKE_ACL",
  "RUN_NOT_FOUND",
  "STATUS_ASSIGNMENT_MISMATCH",
  "STATUS_INCARNATION_UNAVAILABLE",
  "STATUS_REQUEST_CONFLICT",
]);

export interface FailureFacts {
  readonly eventId?: string;
  readonly occurredAt?: string;
  readonly severity?: ObservabilitySeverity;
  readonly source: ObservabilitySource;
  readonly operation: string;
  readonly reason: string;
  readonly subject?: string | null;
  readonly agentId?: string | null;
  readonly provider?: CapabilityProvider | null;
  readonly providerRunId?: string | null;
  readonly vendorSessionId?: string | null;
  readonly toolName?: string | null;
  readonly callId?: string | null;
}

export interface McpToolFacts {
  readonly toolName: string;
  readonly subject: string;
  readonly callId: string | null;
}

export interface ObservabilityServiceOptions {
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
  readonly correlateSubject?: (subject: string) => {
    readonly agentId: string | null;
    readonly provider: CapabilityProvider | null;
    readonly providerRunId: string | null;
    readonly vendorSessionId: string | null;
  } | null;
}

export type ObservabilitySubjectDecision =
  { readonly ok: true } | { readonly ok: false; readonly response: Response };

function safeReason(value: string): string {
  const clipped = redactTerminalEvidence(value)
    .slice(0, MAX_REASON_LENGTH)
    .trim();
  return clipped === "" ? "unknown failure" : clipped;
}

function mcpResultReason(result: CallToolResult): string {
  const text = result.content
    .filter(
      (
        item,
      ): item is Extract<(typeof result.content)[number], { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text.trim())
    .filter((item) => item !== "")
    .join("\n");
  return text === "" ? "Hive MCP tool returned an error" : text;
}

function mcpFailureSeverity(error: unknown): ObservabilitySeverity {
  if (error instanceof ZodError) return "warning";
  if (!isRecord(error) || typeof error.code !== "string") return "error";
  return EXPECTED_REFUSAL_CODES.has(error.code) ? "warning" : "error";
}

/** The daemon's single failure-audit authority. It owns normalization,
 * redaction, correlation, idempotent persistence, log mirroring, and reads. */
export class ObservabilityService {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly correlateSubject:
    NonNullable<ObservabilityServiceOptions["correlateSubject"]> | undefined;
  private readonly store: ObservabilityStore;

  constructor(
    private readonly db: DatabaseHost,
    options: ObservabilityServiceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => {});
    this.correlateSubject = options.correlateSubject;
    this.store = new ObservabilityStore(this.db);
  }

  record(facts: FailureFacts): ObservabilityEvent {
    const correlation =
      facts.subject === undefined || facts.subject === null
        ? null
        : (this.correlateSubject?.(facts.subject) ?? null);
    return this.ingest({
      schemaVersion: 1,
      eventId: facts.eventId ?? randomUUID(),
      occurredAt: facts.occurredAt ?? this.clock().toISOString(),
      severity: facts.severity ?? "error",
      source: facts.source,
      operation: facts.operation,
      reason: facts.reason,
      subject: facts.subject ?? null,
      agentId: facts.agentId ?? correlation?.agentId ?? null,
      provider: facts.provider ?? correlation?.provider ?? null,
      providerRunId: facts.providerRunId ?? correlation?.providerRunId ?? null,
      vendorSessionId:
        facts.vendorSessionId ?? correlation?.vendorSessionId ?? null,
      toolName: facts.toolName ?? null,
      callId: facts.callId ?? null,
    });
  }

  ingest(input: ObservabilityReport): ObservabilityEvent {
    const report = ObservabilityReportSchema.parse({
      ...input,
      reason: safeReason(input.reason),
    });
    const event = ObservabilityEventSchema.parse({
      ...report,
      recordedAt: this.clock().toISOString(),
    });
    if (!this.store.insert(event)) {
      return this.getRequired(event.eventId);
    }
    this.log(`[observability] ${JSON.stringify(event)}`);
    return event;
  }

  async reportEndpoint(
    request: Request,
    authorizeSubject: (subject: string) => ObservabilitySubjectDecision,
  ): Promise<Response> {
    const parsed = ObservabilityReportSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid observability report", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    if (parsed.data.subject === null) {
      return Response.json(
        { error: "Externally reported observability events require a subject" },
        { status: 400 },
      );
    }
    const authorized = authorizeSubject(parsed.data.subject);
    if (!authorized.ok) return authorized.response;
    return Response.json({ event: this.record(parsed.data) });
  }

  queryEndpoint(
    url: URL,
    scope: { readonly subject: string } | null,
  ): Response {
    const value = (key: string): string | undefined =>
      url.searchParams.get(key) ?? undefined;
    const limitText = value("limit");
    const parsed = ObservabilityQuerySchema.safeParse({
      since: value("since"),
      until: value("until"),
      severity: value("severity"),
      source: value("source"),
      subject: scope?.subject ?? value("subject"),
      session: value("session"),
      tool: value("tool"),
      ...(limitText === undefined ? {} : { limit: Number(limitText) }),
    });
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid observability query", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    return Response.json({ events: this.list(parsed.data) });
  }

  async observeMcpTool<T>(
    facts: McpToolFacts,
    invoke: () => T | Promise<T>,
  ): Promise<Awaited<T>> {
    try {
      const result = await invoke();
      if (isCallToolResult(result) && result.isError === true) {
        this.record({
          severity: "warning",
          source: "mcp-tool",
          operation: facts.toolName,
          reason: mcpResultReason(result),
          subject: facts.subject,
          toolName: facts.toolName,
          callId: facts.callId,
        });
      }
      return result;
    } catch (error) {
      this.record({
        severity: mcpFailureSeverity(error),
        source: "mcp-tool",
        operation: facts.toolName,
        reason: errorMessage(error),
        subject: facts.subject,
        toolName: facts.toolName,
        callId: facts.callId,
      });
      throw error;
    }
  }

  list(input: ObservabilityQuery): ObservabilityEvent[] {
    const query = ObservabilityQuerySchema.parse(input);
    return this.store.list(query);
  }

  private getRequired(eventId: string): ObservabilityEvent {
    const event = this.store.get(eventId);
    if (event === null) {
      throw new Error(`observability event ${eventId} was not persisted`);
    }
    return event;
  }
}
