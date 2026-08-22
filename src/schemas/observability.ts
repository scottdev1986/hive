import { z } from "zod";
import { CapabilityProviderSchema } from "./capability";

export const ObservabilitySeveritySchema = z.enum(["warning", "error"]);
export type ObservabilitySeverity = z.infer<typeof ObservabilitySeveritySchema>;

export const ObservabilitySourceSchema = z.enum([
  "mcp-tool",
  "mcp-transport",
  "provider",
  "session",
  "background",
  "daemon",
]);
export type ObservabilitySource = z.infer<typeof ObservabilitySourceSchema>;

const CorrelationFields = {
  subject: z.string().min(1).max(128).nullable(),
  agentId: z.string().min(1).max(128).nullable(),
  provider: CapabilityProviderSchema.nullable(),
  providerRunId: z.string().uuid().nullable(),
  vendorSessionId: z.string().min(1).max(512).nullable(),
  toolName: z.string().min(1).max(128).nullable(),
  callId: z.string().min(1).max(512).nullable(),
} as const;

/** A failure fact submitted to the daemon. The event id makes retries
 * idempotent; callers provide correlation facts, never storage policy. */
export const ObservabilityReportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    occurredAt: z.iso.datetime({ offset: true }),
    severity: ObservabilitySeveritySchema,
    source: ObservabilitySourceSchema,
    operation: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(32_768),
    ...CorrelationFields,
  })
  .readonly();
export type ObservabilityReport = z.infer<typeof ObservabilityReportSchema>;

/** The canonical durable event returned by the daemon and rendered by thin
 * clients. `recordedAt` is daemon time; `occurredAt` remains source time. */
export const ObservabilityEventSchema = z
  .strictObject({
    ...ObservabilityReportSchema.unwrap()["shape"],
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .readonly();
export type ObservabilityEvent = z.infer<typeof ObservabilityEventSchema>;

export const ObservabilityQuerySchema = z
  .strictObject({
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    severity: ObservabilitySeveritySchema.optional(),
    source: ObservabilitySourceSchema.optional(),
    subject: z.string().min(1).max(128).optional(),
    session: z.string().min(1).max(512).optional(),
    tool: z.string().min(1).max(128).optional(),
    limit: z.number().int().positive().max(1_000).default(100),
  })
  .readonly();
export type ObservabilityQuery = z.infer<typeof ObservabilityQuerySchema>;

export const ObservabilityListSchema = z
  .strictObject({ events: z.array(ObservabilityEventSchema) })
  .readonly();
