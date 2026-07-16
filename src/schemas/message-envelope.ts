import { z } from "zod";
import { ControlIntentSchema, MessagePrioritySchema } from "./message";
import {
  DecimalUint64Schema,
  PositiveGenerationSchema,
  Rfc3339UtcMillisecondsSchema,
  SessionLocatorSchema,
  domainUuidV7Schema,
} from "./session-protocol";

/**
 * MessageEnvelope v2 is owned by docs/design/hive-communication.html#data-model.
 * This module deliberately does not redefine that envelope. It contains only
 * the provider/injection/receipt fields the terminal foundation must consume
 * or emit under terminal-stack-transition.html §25.
 */
export const MESSAGE_ENVELOPE_V2_OWNER =
  "docs/design/hive-communication.html#data-model" as const;

export const TERMINAL_PROVIDER_ADAPTERS = [
  "claude-tui",
  "codex-tui",
  "codex-app-server",
  "grok-tui",
] as const;

export const TERMINAL_DELIVERY_EVIDENCE = [
  "transport-written",
  "provider-observed",
  "attempt-in-doubt",
] as const;

export const TerminalDeliveryEvidenceSchema = z.enum(TERMINAL_DELIVERY_EVIDENCE);
export type TerminalDeliveryEvidence = z.infer<typeof TerminalDeliveryEvidenceSchema>;

export const PROVIDER_ADAPTER_CONTRACTS = {
  "claude-tui": {
    readiness: ["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"],
    unknownModalBlocksDelivery: true,
    strongestAutomaticReceipt: "provider-observed",
  },
  "codex-tui": {
    readiness: ["SessionStart", "UserPromptSubmit", "Stop", "PostToolUse"],
    unknownModalBlocksDelivery: true,
    strongestAutomaticReceipt: "provider-observed",
  },
  "codex-app-server": {
    readiness: ["native-session-state", "native-turn-state"],
    unknownModalBlocksDelivery: true,
    strongestAutomaticReceipt: "provider-observed",
  },
  "grok-tui": {
    readiness: ["process-health", "transcript-activity"],
    unknownModalBlocksDelivery: true,
    strongestAutomaticReceipt: "provider-observed",
  },
} as const;

export const TERMINAL_MESSAGE_LIMITS = {
  providerObservationWaitMilliseconds: 5_000,
  automatedPayloadBytes: 1024 * 1024,
} as const;

export const TerminalDeliveryAttemptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transactionId: domainUuidV7Schema("txn"),
  messageId: domainUuidV7Schema("msg"),
  locator: SessionLocatorSchema,
  recipientGeneration: PositiveGenerationSchema,
  adapter: z.enum(TERMINAL_PROVIDER_ADAPTERS),
  priority: MessagePrioritySchema,
  intent: ControlIntentSchema,
  evidence: TerminalDeliveryEvidenceSchema,
  byteRange: z.strictObject({
    start: DecimalUint64Schema,
    endExclusive: DecimalUint64Schema,
  }).nullable(),
  nativeEndpointReceipt: z.string().min(1).nullable(),
  startedAt: Rfc3339UtcMillisecondsSchema,
  completedAt: Rfc3339UtcMillisecondsSchema.nullable(),
  evidenceRefs: z.array(z.string().min(1)),
}).refine(
  ({ byteRange, nativeEndpointReceipt }) => (byteRange === null) !== (nativeEndpointReceipt === null),
  "exactly one transport receipt form is required",
).meta({ "x-hive-exactly-one-of": ["byteRange", "nativeEndpointReceipt"] });
export type TerminalDeliveryAttempt = z.infer<typeof TerminalDeliveryAttemptSchema>;

export const MESSAGE_TERMINAL_WIRE_SCHEMAS = {
  terminalDeliveryAttempt: TerminalDeliveryAttemptSchema,
} as const;

export const MESSAGE_TERMINAL_CONTRACT = {
  owner: MESSAGE_ENVELOPE_V2_OWNER,
  adapters: PROVIDER_ADAPTER_CONTRACTS,
  evidence: TERMINAL_DELIVERY_EVIDENCE,
  limits: TERMINAL_MESSAGE_LIMITS,
  blindRetryAfterCommittedOrInDoubt: false,
} as const;
